import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { randomUUID } from 'crypto';
import { gunzipSync } from 'zlib';
import { writeTrace } from '@/v3/lib/trace';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // 允许 30 秒（items 较大时解压 + 上传 Storage）

/**
 * POST /api/v3/import-tasks/[taskId]/file
 * 上传解析结果并激活任务（服务端转发到 Supabase Storage）。
 *
 * 背景：
 *   1. 前端直连 Supabase Storage 在国内网络极慢（4.3MB 需 80s+），改为经 Vercel 转发。
 *   2. Vercel Serverless 请求体限制 4.5MB：若同时传原始文件（1-5MB）+ items JSON（10000 条约 3-6MB）
 *      会超限导致上传失败。因此：
 *      - 原始文件改为可选（预解析模式下 Worker 使用 items，不读取原文件，无需上传）
 *      - items 在前端 gzip 压缩后传输（10000 条约压缩到 <1MB）
 *
 * 请求体（multipart/form-data）:
 *   items      必填，解析后的 OrderItem[]（JSON 字符串；若 items_gzip=1 则为 gzip 压缩 Blob）
 *   rule_id    必填，解析规则 ID
 *   file       可选，原始文件（仅作存档，预解析模式 Worker 不读取）
 *   file_name  可选，原始文件名（用于任务展示）
 *   items_gzip 可选，'1' 表示 items 是 gzip 压缩数据
 *
 * 响应: { ok, task_id, status, total_rows, total_batches, needWorkerInit }
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
    const itemsGzip = formData.get('items_gzip') === '1';
    let itemsJson = (formData.get('items') as string) || '';
    const sourceFileName = (formData.get('file_name') as string) || '';

    if (!ruleId) {
      return NextResponse.json({ ok: false, error: '缺少 rule_id' }, { status: 400 });
    }

    // 解压 gzip 压缩的 items（前端 CompressionStream 压缩）
    if (itemsGzip) {
      const itemsFile = formData.get('items') as File | null;
      if (!itemsFile) {
        return NextResponse.json({ ok: false, error: '缺少 items 压缩数据' }, { status: 400 });
      }
      try {
        const buf = Buffer.from(await itemsFile.arrayBuffer());
        itemsJson = gunzipSync(buf).toString('utf-8');
      } catch (e: any) {
        return NextResponse.json({ ok: false, error: `items 解压失败：${e?.message ?? e}` }, { status: 400 });
      }
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

    if (!hasItems && !file) {
      return NextResponse.json({ ok: false, error: '缺少数据：请提供 items（解析结果）或 file（原始文件）' }, { status: 400 });
    }

    /**
     * 上传到 Supabase Storage（服务端转发，Vercel → Supabase 高速网络）
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

    const traceId = `trace_${randomUUID().slice(0, 12)}`;

    // 1. 上传 items JSON（预解析模式必需，Worker 读取该文件处理）
    let totalRows = 0;
    let totalBatches = 0;
    let itemsUrl = '';
    const batchRecords: any[] = [];
    const outboxEvents: any[] = [];

    if (hasItems) {
      const items = JSON.parse(itemsJson) as unknown[];
      totalRows = items.length;
      totalBatches = Math.max(1, Math.ceil(totalRows / 1000));

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
          rule_id: ruleId, items_url: itemsUrl, trace_id: traceId,
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
      // 无 items（纯文件模式）：任务创建 + ImportTaskCreated 事件，行数/批次由 Worker initTask 计算
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
            file_url: '',
            file_name: sourceFileName || file?.name || 'file',
            rule_id: ruleId,
            trace_id: traceId,
          },
        },
        status: 'pending',
        retry_count: 0,
        next_retry_at: new Date().toISOString(),
      });
    }

    // 2. 可选上传原始文件（仅存档；预解析模式 Worker 不读取）
    let fileUrl = '';
    let fileName = sourceFileName || '数据文件';
    if (file) {
      const ext = (file.name.split('.').pop() || 'xlsx').toLowerCase();
      const filePath = `${taskId}.${ext}`;
      fileName = file.name;
      const upFileUrl = await uploadToStorage(filePath, await file.arrayBuffer(), file.type || 'application/octet-stream');
      if (!upFileUrl) {
        return NextResponse.json({ ok: false, error: '文件上传到存储失败，请重试' }, { status: 500 });
      }
      fileUrl = upFileUrl;
    } else if (hasItems) {
      // 预解析模式无原文件：任务详情中的 file_url 指向解析结果，便于查看
      fileUrl = itemsUrl;
    }

    // 3. 调用 create_import_task RPC（1 次 HTTP 往返：建任务 + 批次 + outbox）
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('create_import_task', {
      p_task: {
        id: taskId,
        file_name: fileName,
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
      `解析结果上传并激活任务，行数: ${totalRows}, 批次: ${totalBatches}`);

    return NextResponse.json({
      ok: true,
      task_id: taskId,
      trace_id: traceId,
      status: 'pending',
      total_rows: totalRows,
      total_batches: totalBatches,
      needWorkerInit: totalBatches === 0,
      upload_duration_ms: Date.now() - startTime,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[upload-file] 异常:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
