/**
 * 补写单个任务的缺失 trace 事件
 *
 * 与 backfill-traces.ts 不同，此脚本不会因为有 1 条事件就跳过，
 * 而是检查每个必需事件是否存在，只补写缺失的。
 *
 * 用法: npx tsx --env-file=.env.local scripts/backfill-single.ts <task_id>
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

async function main() {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error('用法: npx tsx --env-file=.env.local scripts/backfill-single.ts <task_id>');
    process.exit(1);
  }

  // 查任务
  const { data: task } = await sb
    .from('v3_import_tasks')
    .select('id, trace_id, status, total_rows, success_rows, failed_rows, created_at, completed_at')
    .eq('id', taskId)
    .maybeSingle() as any;

  if (!task) {
    console.error(`任务 ${taskId} 不存在`);
    process.exit(1);
  }

  console.log(`任务: ${task.id}`);
  console.log(`  trace_id: ${task.trace_id}`);
  console.log(`  status: ${task.status}`);
  console.log(`  rows: ${task.success_rows} 成功 / ${task.failed_rows} 失败`);

  // 查已有 trace 事件
  const { data: existing } = await sb
    .from('v3_trace_events')
    .select('event_name, unit_id')
    .eq('task_id', taskId);
  const existingEvents = new Set((existing || []).map((e: any) => `${e.event_name}:${e.unit_id || ''}`));
  console.log(`  已有 trace 事件: ${existing?.length || 0} 条`);

  // 查批次
  const { data: batches } = await sb
    .from('v3_import_task_batches')
    .select('unit_id, batch_index, status, locked_at, completed_at')
    .eq('task_id', taskId)
    .order('batch_index') as any;

  const events: any[] = [];

  // TaskInitialized（如果没有）
  if (!existingEvents.has(`TaskInitialized:`)) {
    events.push({
      trace_id: task.trace_id, task_id: taskId, unit_id: '',
      event_name: 'TaskInitialized', event_status: 'success',
      message: `初始化 ${batches?.length || 0} 个批次`,
      occurred_at: task.created_at,
    });
  }

  // 批次事件
  for (const batch of batches || []) {
    const label = `批次 ${batch.batch_index}`;

    if (!existingEvents.has(`BatchStarted:${batch.unit_id}`)) {
      events.push({
        trace_id: task.trace_id, task_id: taskId, unit_id: batch.unit_id,
        event_name: 'BatchStarted', event_status: 'success',
        message: `${label} 开始处理`,
        occurred_at: batch.locked_at || task.created_at,
      });
    }

    if (batch.status === 'completed' && !existingEvents.has(`BatchSucceeded:${batch.unit_id}`)) {
      events.push({
        trace_id: task.trace_id, task_id: taskId, unit_id: batch.unit_id,
        event_name: 'BatchSucceeded', event_status: 'success',
        message: `${label} 完成`,
        occurred_at: batch.completed_at || task.completed_at,
      });
    } else if (batch.status === 'failed' && !existingEvents.has(`BatchFailed:${batch.unit_id}`)) {
      events.push({
        trace_id: task.trace_id, task_id: taskId, unit_id: batch.unit_id,
        event_name: 'BatchFailed', event_status: 'failed',
        message: `${label} 失败`,
        occurred_at: batch.completed_at || task.completed_at,
      });
    }
  }

  // ImportTaskCompleted
  if (!existingEvents.has(`ImportTaskCompleted:`)) {
    const statusLabel = task.status === 'completed' ? '已完成' :
      task.status === 'partial_success' ? '部分成功' : '失败';
    events.push({
      trace_id: task.trace_id, task_id: taskId, unit_id: '',
      event_name: 'ImportTaskCompleted', event_status: task.status === 'failed' ? 'failed' : 'success',
      message: `任务${statusLabel}: 成功 ${task.success_rows} 行, 失败 ${task.failed_rows} 行`,
      occurred_at: task.completed_at,
    });
  }

  if (events.length === 0) {
    console.log('所有事件已存在，无需补写');
    return;
  }

  console.log(`\n补写 ${events.length} 条事件...`);
  const { error } = await sb.from('v3_trace_events').insert(events);
  if (error) {
    console.error('补写失败:', error.message);
  } else {
    console.log('补写成功!');
  }
}

main().catch(console.error);
