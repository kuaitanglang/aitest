import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { randomUUID } from 'crypto';
import { writeTrace } from '@/v3/lib/trace';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // 大文件上传走 Vercel 转发，允许 30 秒

/**
 * POST /api/v3/import-tasks/[taskId]/file
 * 上传文件并激活任务（服务端转发到 Supabase Storage）。
 *
 * 背景：前端直连 Supabase Storage 在国内网络极慢（4.3MB 需 80s+），
 * 改为经 Vercel 转发（Vercel CDN 对国内访问更稳定），同时保持
 * "创建任务接口 0-1ms"的快速架构不变。
 *
 * 请求体（multipart/form-data）:
 *   file   必填，原始文件（Excel/Word/PDF）
 *   rule_id 必填，解析规则 ID
 *   items  可选，预解析模式最终数据 JSON（AI 直接解析 / 已有规则编辑结果）
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

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const ruleId = (formData.get('rule_id') as string) || '';
    const itemsJson = (formData.get('items') as string) || '';

    if (!file) {
      return NextResponse.json({ ok: false, error: '缺少文件' }, { status: 400 });
    }
    if (!ruleId) {
      return NextResponse.json({ ok: false, error: '缺少 rule_id' }, { status: 400 });
    }

    const hasItems = itemsJson.length > 0;
    if (hasItems) {
      try {
        const parsed = JSON.parse(itemsJson);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return NextResponse.json({ ok: false, error: 'items 解析结果为空' }, { status: 400 });
        }
      } catch (e: any) {
        return NextResponse.json({ ok: false, error: `items 不是合法 JSON：${e?.message ?? e}` }, { status: 400 });
      }
    }

    /**
     * 上传文件到 Supabase Storage（服务端转发，Vercel → Supabase 高速网络）
     */
    async function uploadToStorage(
      path: string,
      data: ArrayBuffer | Uint8Array,
      contentType: string
    ): Promise<string | null> {
      try {
        const { error: upErr } = await supabaseAdmin!.storage
          .from('import-files')
          .upload(path, data, { contentType, upsert: true });
        if (upErr) throw upErr;
        return supabaseAdmin!.storage.from('import-files').getPublicUrl(path).data.publicUrl;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[upload-file] Storage 上传失败: ${msg}`);
        return null;
      }
    }

    // 1. 上传原始文件
    const ext = (file.name.split('.').pop() || 'xlsx').toLowerCase();
    const filePath = `${taskId}.${ext}`;
    const fileBuffer = await file.arrayBuffer();
    const fileUrl = await uploadToStorage(filePath, fileBuffer, file.type || 'application/octet-stream');
    if (!fileUrl) {
      return NextResponse.json({ ok: false, error: '文件上传到存储失败，请重试' }, { status: 500 });
    }

    const traceId = `trace_${randomUUID().slice(0, 12)}`;
    const storageBase = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? `${process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/import-files`
      : '';

    // 2. 计算行数与批次（预解析模式从 items 计算；否则交给 Worker initTask）
    let totalRows = 0;
    let totalBatches = 0;
    let itemsUrl = '';
    const batchRecords: any[] = [];
    const outboxEvents: any[] = [];

    if (hasItems) {
      const items = JSON.parse(itemsJson) as unknown[];
      totalRows = items.length;
      totalBatches = Math.max(1, Math.ceil(totalRows / 1000));

      // 上传 items JSON（供 Worker 读取，避免重复解析）
      const itemsPath = `${taskId}_parsed_items.json`;
      const upItemsUrl = await uploadToStorage(itemsPath, Buffer.from(itemsJson, 'utf-8'), 'application/json');
      if (!upItemsUrl) {
        return NextResponse.json({ ok: false, error: '解析结果上传失败，请重试' }, { status: 500 });
      }
      itemsUrl = upItemsUrl;

      for (let i = 0; i < totalBatches; i++) {
        const unitId = `unit_${String(i + 1).padStart(3, '0')}`;
        const startRow = i * 1000 + 1;
        const endRow = Math.min((i + 1) * 1000, totalRows);
        batchRecords.push({ unit_id: unitId, batch_index: i, start_row: startRow, end_row: endRow });

        const batchPayload: Record<string, any> = {
          task_id: taskId, unit_id: unitId, batch_index: i,
          start_row: startRow, end_row: endRow,
          rule_id: ruleId, file_url: fileUrl, file_name: file.name, trace_id: traceId,
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
            file_url: fileUrl,
            file_name: file.name,
            rule_id: ruleId,
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
        file_name: file.name,
        file_url: fileUrl,
        rule_id: ruleId,
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
      console.error('[upload-file] create_import_task RPC 失败:', reason);
      return NextResponse.json({ ok: false, error: `任务激活失败：${reason}` }, { status: 500 });
    }

    await writeTrace(traceId, taskId, '', 'ImportTaskActivated', 'success',
      `文件上传并激活任务，行数: ${totalRows}, 批次: ${totalBatches}`);

    return NextResponse.json({
      ok: true,
      task_id: taskId,
      trace_id: traceId,
      status: 'pending',
      total_rows: totalRows,
      total_batches: totalBatches,
      needWorkerInit: totalBatches === 0,
      storage_base: storageBase,
      upload_duration_ms: Date.now() - startTime,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[upload-file] 异常:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
