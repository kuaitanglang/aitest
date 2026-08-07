/**
 * 补写历史任务的 trace 事件
 *
 * 原因：writeTrace 之前字段名错误（event_type/status/created_at vs 实际的
 * event_name/event_status/occurred_at），导致所有历史任务的 trace 事件从未成功写入。
 * 此脚本根据 v3_import_tasks 和 v3_import_task_batches 的数据为已完成任务补写 trace 事件。
 *
 * 幂等：已存在 trace 事件的任务会被跳过。
 *
 * 用法: npx tsx --env-file=.env.local scripts/backfill-traces.ts
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('缺少环境变量 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  console.error('请确保 .env.local 文件存在且包含这两个变量');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

interface TaskRow {
  id: string;
  trace_id: string;
  status: string;
  total_rows: number;
  success_rows: number;
  failed_rows: number;
  created_at: string;
  completed_at: string | null;
}

interface BatchRow {
  unit_id: string;
  batch_index: number;
  status: string;
  locked_at: string | null;
  completed_at: string | null;
}

async function backfill() {
  // 1. 查询所有已完成的任务
  const { data: tasks, error } = await supabaseAdmin
    .from('v3_import_tasks')
    .select('id, trace_id, status, total_rows, success_rows, failed_rows, created_at, completed_at')
    .in('status', ['completed', 'partial_success', 'failed'])
    .order('created_at', { ascending: true });

  if (error) {
    console.error('查询任务失败:', error.message);
    process.exit(1);
  }

  console.log(`找到 ${(tasks as TaskRow[]).length} 个已完成任务，开始补写 trace 事件...\n`);

  let totalEvents = 0;
  let skipped = 0;

  for (const task of tasks as TaskRow[]) {
    // 幂等：检查是否已有 trace 事件
    const { data: existing } = await supabaseAdmin
      .from('v3_trace_events')
      .select('id')
      .eq('task_id', task.id)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[跳过] ${task.id} 已有 trace 事件`);
      skipped++;
      continue;
    }

    // 查询批次数据
    const { data: batches } = await supabaseAdmin
      .from('v3_import_task_batches')
      .select('unit_id, batch_index, status, locked_at, completed_at')
      .eq('task_id', task.id)
      .order('batch_index', { ascending: true });

    const batchList = (batches || []) as BatchRow[];
    const events: Array<Record<string, unknown>> = [];

    // TaskCreated
    events.push({
      trace_id: task.trace_id,
      task_id: task.id,
      unit_id: '',
      event_name: 'TaskCreated',
      event_status: 'success',
      message: `任务创建: ${task.total_rows} 行`,
      occurred_at: task.created_at,
    });

    // TaskInitialized
    events.push({
      trace_id: task.trace_id,
      task_id: task.id,
      unit_id: '',
      event_name: 'TaskInitialized',
      event_status: 'success',
      message: `初始化 ${batchList.length} 个批次`,
      occurred_at: task.created_at,
    });

    // 批次事件
    for (const batch of batchList) {
      const label = `批次 ${batch.batch_index}`;

      // BatchStarted
      events.push({
        trace_id: task.trace_id,
        task_id: task.id,
        unit_id: batch.unit_id,
        event_name: 'BatchStarted',
        event_status: 'success',
        message: `${label} 开始处理`,
        occurred_at: batch.locked_at || task.created_at,
      });

      // BatchSucceeded / BatchFailed
      if (batch.status === 'completed') {
        events.push({
          trace_id: task.trace_id,
          task_id: task.id,
          unit_id: batch.unit_id,
          event_name: 'BatchSucceeded',
          event_status: 'success',
          message: `${label} 完成`,
          occurred_at: batch.completed_at || task.completed_at,
        });
      } else if (batch.status === 'failed') {
        events.push({
          trace_id: task.trace_id,
          task_id: task.id,
          unit_id: batch.unit_id,
          event_name: 'BatchFailed',
          event_status: 'failed',
          message: `${label} 失败`,
          occurred_at: batch.completed_at || task.completed_at,
        });
      }
    }

    // ImportTaskCompleted
    const statusLabel =
      task.status === 'completed' ? '已完成' :
      task.status === 'partial_success' ? '部分成功' : '失败';
    events.push({
      trace_id: task.trace_id,
      task_id: task.id,
      unit_id: '',
      event_name: 'ImportTaskCompleted',
      event_status: task.status === 'failed' ? 'failed' : 'success',
      message: `任务${statusLabel}: 成功 ${task.success_rows} 行, 失败 ${task.failed_rows} 行`,
      occurred_at: task.completed_at,
    });

    // 批量插入
    const { error: insertError } = await supabaseAdmin
      .from('v3_trace_events')
      .insert(events);

    if (insertError) {
      console.error(`[失败] ${task.id}: ${insertError.message}`);
    } else {
      console.log(`[成功] ${task.id}: 补写 ${events.length} 条事件`);
      totalEvents += events.length;
    }
  }

  console.log(`\n完成! 补写 ${totalEvents} 条事件, 跳过 ${skipped} 个已有事件的任务`);
}

backfill().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
