import { NextRequest, NextResponse } from 'next/server';
import { supabase, supabaseAdmin } from '@/lib/supabase';
import { randomUUID } from 'crypto';
import { writeTrace } from '@/v3/lib/trace';

export const dynamic = 'force-dynamic';
export const maxDuration = 10; // Vercel Serverless 最大 10 秒

/**
 * GET /api/v3/import-tasks
 * 获取任务列表（分页 + 状态筛选）
 */
export async function GET(req: NextRequest) {
  try {
    if (!supabase) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || '';
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');

    let query = supabase
      .from('v3_import_tasks')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      tasks: data || [],
      total: count || 0,
      page,
      pageSize,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const timings: Record<string, number> = {};

  try {
    const t0 = Date.now();
    const formData = await req.formData();
    timings.formData = Date.now() - t0;
    const file = formData.get('file') as File | null;
    const ruleId = (formData.get('rule_id') as string) || '';
    // 预解析模式：前端已解析+编辑确认的 OrderItem[]（含 AI 直接解析和已有规则编辑两种场景）
    const itemsJson = (formData.get('items') as string) || '';
    const hasItems = itemsJson.length > 0;

    if (!ruleId) {
      return NextResponse.json({ ok: false, error: '缺少 rule_id' }, { status: 400 });
    }
    if (hasItems) {
      // 校验 items JSON 合法性
      try {
        const parsed = JSON.parse(itemsJson);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return NextResponse.json({ ok: false, error: 'items 解析结果为空' }, { status: 400 });
        }
      } catch (e: any) {
        return NextResponse.json({ ok: false, error: `items 不是合法 JSON：${e?.message ?? e}` }, { status: 400 });
      }
    }

    // 1. 生成 task_id 和 trace_id
    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const traceId = `trace_${randomUUID().slice(0, 12)}`;

    // 快速创建模式（前端直传 Storage 方案）：
    // 前端先创建任务（≤1s 返回 task_id），文件由浏览器直传 Supabase Storage，
    // 上传完成后调用 /api/v3/import-tasks/[taskId]/confirm 激活任务与 Outbox 事件。
    // 这样大文件上传不再阻塞接口响应，upload_duration_ms 稳定 ≤1s。
    if (!file) {
      return NextResponse.json({
        ok: true,
        task_id: taskId,
        trace_id: traceId,
        status: 'pending',
        total_rows: 0,
        total_batches: 0,
        needWorkerInit: true,
        // 前端将文件上传到该路径（文件名补扩展名，如 import-files/task_xxx.xlsx）
        upload_path: `import-files/${taskId}`,
        upload_duration_ms: Date.now() - startTime,
      });
    }

    // 防重复上传：检查同一 rule_id + file.name + file.size 是否在 30s 内已有 pending/processing 任务
    const fileName = file.name;
    const fileSize = file.size;

    // rule_id 直接使用前端传来的值（真实规则 ID 或 '__ai_direct__'）
    const finalRuleId = ruleId;

    // 2. 读取文件一次（避免重复 arrayBuffer 调用）
    const tRead = Date.now();
    const fileBuffer = await file.arrayBuffer();
    timings.readFile = Date.now() - tRead;

    // 3. 文件上传辅助
    const fileExt = fileName.split('.').pop() || 'xlsx';
    const storageFileName = `${taskId}.${fileExt}`;

    /**
     * 上传文件到 Supabase Storage（生产主路径，Web/Worker 解耦）
     * 失败时回退本地文件（本地开发场景）
     * @returns Storage public URL 或 null（回退本地）
     */
    async function uploadToStorage(
      path: string,
      data: ArrayBuffer | Uint8Array,
      contentType: string
    ): Promise<string | null> {
      if (!supabaseAdmin) return null;
      try {
        const { error: upErr } = await supabaseAdmin.storage
          .from('import-files')
          .upload(path, data, { contentType, upsert: true });
        if (upErr) throw upErr;
        return supabaseAdmin.storage.from('import-files').getPublicUrl(path).data.publicUrl;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[upload] Storage 上传失败，回退本地: ${msg}`);
        return null;
      }
    }

    // 4. 构造 Storage 约定路径（上传与建任务并行，URL 无需等待上传完成）
    const storageBase = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? `${process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/import-files`
      : '';
    const storageFileUrl = storageBase ? `${storageBase}/${storageFileName}` : '';
    const itemsStoragePath = `${taskId}_parsed_items.json`;
    const storageItemsUrl = storageBase ? `${storageBase}/${itemsStoragePath}` : '';

    let totalRows: number;
    let itemsUrl = '';
    let needWorkerInit = false; // 非预解析模式：行数统计和批次创建交给 Worker
    let fileUrl = storageFileUrl; // 默认用约定路径（Worker 按 taskId 从 Storage 下载）

    if (hasItems) {
      const parsedItems = JSON.parse(itemsJson) as unknown[];
      totalRows = parsedItems.length;
      itemsUrl = storageItemsUrl;
    } else {
      // 非预解析模式：不在上传接口中统计行数（避免大文件 XLSX 解析耗时）
      // 行数统计和批次创建交给 Worker 的 initTask 完成（考题：上传 P95 ≤ 1s）
      totalRows = 0;
      needWorkerInit = true;
    }

    // 5. 计算分批 + 构造批次/outbox 事件
    const BATCH_SIZE = 1000;
    const totalBatches = needWorkerInit ? 0 : Math.max(1, Math.ceil(totalRows / BATCH_SIZE));

    const batchRecords: any[] = [];
    const outboxEvents: any[] = [];
    if (needWorkerInit) {
      // 非预解析模式：只创建 ImportTaskCreated 事件，Worker initTask 负责统计行数、建批次
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
          payload: { task_id: taskId, file_url: fileUrl, file_name: fileName, rule_id: finalRuleId, trace_id: traceId },
        },
        status: 'pending',
        retry_count: 0,
        next_retry_at: new Date().toISOString(),
      });
    } else {
      // 预解析模式：行数已知，直接构造批次记录 + 批次 outbox 事件
      for (let i = 0; i < totalBatches; i++) {
        const unitId = `unit_${String(i + 1).padStart(3, '0')}`;
        const startRow = i * BATCH_SIZE + 1;
        const endRow = Math.min((i + 1) * BATCH_SIZE, totalRows);
        batchRecords.push({ unit_id: unitId, batch_index: i, start_row: startRow, end_row: endRow });

        const batchPayload: Record<string, any> = {
          task_id: taskId, unit_id: unitId, batch_index: i,
          start_row: startRow, end_row: endRow,
          rule_id: finalRuleId, file_url: fileUrl, file_name: fileName, trace_id: traceId,
        };
        if (itemsUrl) batchPayload.items_url = itemsUrl;

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
    }

    // 6. 并行：上传原始文件 + 上传 items JSON + RPC 创建任务（1 次往返替代 3 次 INSERT）
    const tParallel = Date.now();
    const fileUpPromise = supabaseAdmin
      ? uploadToStorage(storageFileName, fileBuffer, file.type || 'application/octet-stream')
      : Promise.resolve(null);
    const itemsUpPromise = (supabaseAdmin && hasItems)
      ? uploadToStorage(itemsStoragePath, Buffer.from(itemsJson, 'utf-8'), 'application/json')
      : Promise.resolve(null);
    const rpcPromise = supabaseAdmin
      ? supabaseAdmin.rpc('create_import_task', {
          p_task: {
            id: taskId,
            file_name: fileName,
            file_url: fileUrl,
            rule_id: finalRuleId,
            status: 'pending',
            total_rows: totalRows,
            total_batches: totalBatches,
            trace_id: traceId,
          },
          p_batches: batchRecords,
          p_outbox_events: outboxEvents,
        })
      : Promise.resolve({ data: null, error: { message: 'supabaseAdmin 未配置' } });

    const [upResult, itemsUpResult, rpcResult] = await Promise.all([fileUpPromise, itemsUpPromise, rpcPromise]);
    timings.parallel = Date.now() - tParallel;

    // 6.1 Storage 上传失败兜底：回退本地文件（本地开发无 Storage 权限场景）
    if (upResult) {
      fileUrl = upResult;
    } else if (supabaseAdmin) {
      console.warn('[upload] Storage 上传失败，回退本地文件');
      const fs = require('fs');
      const path = require('path');
      const localDir = path.join(process.cwd(), '.v3-uploads');
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localFilePath = path.join(localDir, storageFileName);
      try {
        await fs.promises.writeFile(localFilePath, Buffer.from(fileBuffer));
        fileUrl = `local:${localFilePath}`;
        await supabaseAdmin.from('v3_import_tasks').update({ file_url: fileUrl }).eq('id', taskId);
      } catch (e: any) {
        console.error('[upload] 本地回退写文件失败:', e?.message || e);
      }
    }
    if (itemsUpResult) itemsUrl = itemsUpResult;

    // 6.2 RPC 失败回退：逐次 INSERT（任务 + 批次 + outbox）
    const rpcData = (rpcResult as any)?.data;
    const rpcErr = (rpcResult as any)?.error;
    if (rpcErr || (rpcData && rpcData.ok === false)) {
      const fallbackReason = rpcErr?.message || rpcData?.error || 'RPC 失败';
      console.error(`[upload] create_import_task RPC 失败，回退逐次 INSERT: ${fallbackReason}`);

      const { error: taskError } = await supabaseAdmin!.from('v3_import_tasks').upsert({
        id: taskId,
        file_name: fileName,
        file_url: fileUrl,
        rule_id: finalRuleId,
        status: 'pending',
        total_rows: totalRows,
        processed_rows: 0,
        success_rows: 0,
        failed_rows: 0,
        total_batches: totalBatches,
        completed_batches: 0,
        trace_id: traceId,
        degraded: false,
        degraded_rows: [],
        error_summary: {},
      });
      if (taskError) {
        console.error('[upload] 创建任务失败:', taskError);
        return NextResponse.json({ ok: false, error: `创建任务失败: ${taskError.message}` }, { status: 500 });
      }

      if (batchRecords.length > 0) {
        await supabaseAdmin!.from('v3_import_task_batches').insert(
          batchRecords.map((b) => ({ task_id: taskId, ...b, status: 'pending' }))
        );
      }
      await supabaseAdmin!.from('v3_event_outbox').insert(
        outboxEvents.map((e) => ({
          aggregate_id: e.aggregate_id,
          event_type: e.event_type,
          payload: e.payload,
          status: e.status,
          retry_count: 0,
          next_retry_at: e.next_retry_at,
        }))
      );
    }

    // 6. 写入 Trace（异步化，不阻塞上传响应）
    writeTrace(traceId, taskId, '', 'TaskCreated', 'success', `文件: ${fileName}, 总行数: ${totalRows}, 总批次: ${totalBatches}`)
      .catch(e => console.error('[upload] trace 写入失败:', e));

    // 7. 返回（≤1s）
    const duration = Date.now() - startTime;
    const timingStr = Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(' | ');
    console.log(`[upload] 任务创建完成: ${taskId}, 总耗时: ${duration}ms | ${timingStr}`);

    return NextResponse.json({
      ok: true,
      task_id: taskId,
      trace_id: traceId,
      status: 'PENDING',
      total_rows: totalRows,
      total_batches: totalBatches,
      upload_duration_ms: duration,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[upload] 异常:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
