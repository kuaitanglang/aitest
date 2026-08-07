import { NextRequest, NextResponse } from 'next/server';
import { supabase, supabaseAdmin } from '@/lib/supabase';
import { randomUUID } from 'crypto';
import { writeTrace } from '@/v3/lib/trace';

export const dynamic = 'force-dynamic';
export const maxDuration = 10; // Vercel Serverless 最大 10 秒

/**
 * GET /api/v3/import-tasks/[taskId]
 * 获取单个任务详情（含进度、状态、错误汇总）
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  try {
    if (!supabase) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { taskId } = params;
    const { data: task, error } = await supabase
      .from('v3_import_tasks')
      .select('*')
      .eq('id', taskId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    if (!task) {
      return NextResponse.json({ ok: false, error: '任务不存在' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, task });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * POST /api/v3/import-tasks/[taskId]/confirm
 * 确认任务：前端直传文件到 Storage 后调用。
 * 服务端校验文件存在 → 构造批次与 Outbox 事件 → 调用 create_import_task RPC 激活任务。
 *
 * 请求体（JSON）:
 *   { rule_id, file_path, items_path? }
 *   - file_path   必填，Storage 相对路径，如 "task_xxx.xlsx"
 *   - items_path  可选，预解析模式 items JSON 的 Storage 相对路径
 *
 * 响应: { ok, task_id, status, total_rows, total_batches }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const startTime = Date.now();
  try {
    const { taskId } = params;
    if (!supabaseAdmin) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: '请求体必须是合法 JSON' }, { status: 400 });
    }
    const { rule_id, file_path, items_path } = body || {};

    if (!rule_id) {
      return NextResponse.json({ ok: false, error: '缺少 rule_id' }, { status: 400 });
    }
    if (!file_path || typeof file_path !== 'string') {
      return NextResponse.json({ ok: false, error: '缺少 file_path（文件上传路径）' }, { status: 400 });
    }

    const storageBase = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? `${process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/import-files`
      : '';

    // 1. 校验文件已上传到 Storage
    const { data: fileInfo, error: infoErr } = await supabaseAdmin.storage
      .from('import-files')
      .info(file_path);
    if (infoErr || !fileInfo) {
      console.error('[confirm] 文件不存在或校验失败:', infoErr?.message || 'not found');
      return NextResponse.json({ ok: false, error: `文件未上传成功，请重新上传：${infoErr?.message || 'not found'}` }, { status: 400 });
    }

    // 2. 计算行数与批次（预解析模式从 items JSON 读取；否则交给 Worker initTask）
    let totalRows = 0;
    let totalBatches = 0;
    let itemsUrl = '';
    const batchRecords: any[] = [];
    const outboxEvents: any[] = [];
    const traceId = `trace_${randomUUID().slice(0, 12)}`;

    if (items_path) {
      // 预解析模式：下载 items JSON 统计行数
      const { data: itemsData, error: itemsErr } = await supabaseAdmin.storage
        .from('import-files')
        .download(items_path);
      if (itemsErr || !itemsData) {
        return NextResponse.json({ ok: false, error: `解析结果文件读取失败：${itemsErr?.message || 'not found'}` }, { status: 400 });
      }
      const items = JSON.parse(Buffer.from(await itemsData.arrayBuffer()).toString('utf-8')) as unknown[];
      if (!Array.isArray(items) || items.length === 0) {
        return NextResponse.json({ ok: false, error: 'items 解析结果为空' }, { status: 400 });
      }
      totalRows = items.length;
      totalBatches = Math.max(1, Math.ceil(totalRows / 1000));
      itemsUrl = storageBase ? `${storageBase}/${items_path}` : '';

      for (let i = 0; i < totalBatches; i++) {
        const unitId = `unit_${String(i + 1).padStart(3, '0')}`;
        const startRow = i * 1000 + 1;
        const endRow = Math.min((i + 1) * 1000, totalRows);
        batchRecords.push({ unit_id: unitId, batch_index: i, start_row: startRow, end_row: endRow });

        const batchPayload: Record<string, any> = {
          task_id: taskId, unit_id: unitId, batch_index: i,
          start_row: startRow, end_row: endRow,
          rule_id, file_url: `${storageBase}/${file_path}`,
          file_name: file_path.split('/').pop() || 'file',
          trace_id: traceId,
          items_url: itemsUrl,
        };
        outboxEvents.push({
          aggregate_id: taskId,
          event_type: 'ImportBatchCreated',
          payload: {
            event_id: `evt_${randomUUID().slice(0, 8)}`,
            event_type: 'ImportBatchCreated',
            schema_version: 1,
            aggregate_id: taskId,
            trace_id: traceId,
            occurred_at: new Date().toISOString(),
            payload: batchPayload,
          },
          status: 'pending',
          retry_count: 0,
          next_retry_at: new Date().toISOString(),
        });
      }
    } else {
      // 非预解析模式：任务创建 + ImportTaskCreated 事件，行数/批次由 Worker initTask 计算
      outboxEvents.push({
        aggregate_id: taskId,
        event_type: 'ImportTaskCreated',
        payload: {
          event_id: `evt_${randomUUID().slice(0, 8)}`,
          event_type: 'ImportTaskCreated',
          schema_version: 1,
          aggregate_id: taskId,
          trace_id: traceId,
          occurred_at: new Date().toISOString(),
          payload: {
            task_id: taskId,
            file_url: `${storageBase}/${file_path}`,
            file_name: file_path.split('/').pop() || 'file',
            rule_id,
            trace_id: traceId,
          },
        },
        status: 'pending',
        retry_count: 0,
        next_retry_at: new Date().toISOString(),
      });
    }

    // 3. 调用 create_import_task RPC（1 次 HTTP 往返：建任务 + 批次 + outbox）
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('create_import_task', {
      p_task: {
        id: taskId,
        file_name: file_path.split('/').pop() || 'file',
        file_url: `${storageBase}/${file_path}`,
        rule_id,
        status: 'pending',
        total_rows: totalRows,
        total_batches: totalBatches,
        trace_id: traceId,
      },
      p_batches: batchRecords,
      p_outbox_events: outboxEvents,
    });

    if (rpcErr || (rpcData && rpcData.ok === false)) {
      const reason = rpcErr?.message || rpcData?.error || 'RPC 失败';
      console.error('[confirm] create_import_task RPC 失败:', reason);
      return NextResponse.json({ ok: false, error: `任务激活失败：${reason}` }, { status: 500 });
    }

    await writeTrace(traceId, taskId, '', 'ImportTaskConfirmed', 'success',
      `文件已就绪并激活任务，行数: ${totalRows}, 批次: ${totalBatches}`);

    return NextResponse.json({
      ok: true,
      task_id: taskId,
      trace_id: traceId,
      status: 'pending',
      total_rows: totalRows,
      total_batches: totalBatches,
      needWorkerInit: totalBatches === 0,
      confirm_duration_ms: Date.now() - startTime,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[confirm] 异常:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  try {
    if (!supabase) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { taskId } = params;

    // 按依赖顺序删除
    await supabase.from('v3_import_task_errors').delete().eq('task_id', taskId);
    await supabase.from('v3_batch_performance_log').delete().eq('task_id', taskId);
    await supabase.from('v3_import_task_batches').delete().eq('task_id', taskId);
    await supabase.from('v3_event_outbox').delete().eq('aggregate_id', taskId);
    await supabase.from('v3_trace_events').delete().eq('task_id', taskId);
    const { error } = await supabase.from('v3_import_tasks').delete().eq('id', taskId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
