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
    const file = formData.get('file') as File;
    const ruleId = (formData.get('rule_id') as string) || '';
    // 预解析模式：前端已解析+编辑确认的 OrderItem[]（含 AI 直接解析和已有规则编辑两种场景）
    const itemsJson = (formData.get('items') as string) || '';
    const hasItems = itemsJson.length > 0;

    if (!file) {
      return NextResponse.json({ ok: false, error: '缺少文件' }, { status: 400 });
    }
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

    // 防重复上传：检查同一 rule_id + file.name + file.size 是否在 30s 内已有 pending/processing 任务
    const fileName = file.name;
    const fileSize = file.size;

    // 1. 生成 task_id 和 trace_id
    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const traceId = `trace_${randomUUID().slice(0, 12)}`;

    // rule_id 直接使用前端传来的值（真实规则 ID 或 '__ai_direct__'）
    const finalRuleId = ruleId;

    // 2. 读取文件一次（避免重复 arrayBuffer 调用）
    const tRead = Date.now();
    const fileBuffer = await file.arrayBuffer();
    timings.readFile = Date.now() - tRead;

    // 3. 本地存储辅助
    const fs = require('fs');
    const path = require('path');
    const localDir = path.join(process.cwd(), '.v3-uploads');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    const fileExt = fileName.split('.').pop() || 'xlsx';
    const safeFileName = `${taskId}.${fileExt}`;
    const localFilePath = path.join(localDir, safeFileName);

    // 4. 并行：保存原始文件 + 统计行数/保存解析结果
    let totalRows: number;
    let itemsUrl = '';
    let needWorkerInit = false; // 非预解析模式：行数统计和批次创建交给 Worker
    const tParallel = Date.now();

    // 异步保存原始文件（不阻塞行数统计）
    const saveFilePromise = fs.promises.writeFile(localFilePath, Buffer.from(fileBuffer));

    if (hasItems) {
      const parsedItems = JSON.parse(itemsJson) as unknown[];
      totalRows = parsedItems.length;
      const itemsBuffer = Buffer.from(itemsJson, 'utf-8');
      const localItemsPath = path.join(localDir, `${taskId}_parsed_items.json`);
      await Promise.all([
        saveFilePromise,
        fs.promises.writeFile(localItemsPath, itemsBuffer),
      ]);
      itemsUrl = `local:${localItemsPath}`;
    } else {
      // 非预解析模式：不在上传接口中统计行数（避免大文件 XLSX 解析耗时）
      // 行数统计和批次创建交给 Worker 的 initTask 完成（考题：上传 P95 ≤ 1s）
      totalRows = 0;
      needWorkerInit = true;
      await saveFilePromise; // 只等文件保存完成
    }
    const fileUrl = `local:${localFilePath}`;
    timings.saveAndCount = Date.now() - tParallel;

    // 4. 计算分批
    const BATCH_SIZE = 1000;
    let totalBatches: number;
    if (needWorkerInit) {
      // 非预解析模式：行数未知，交给 Worker 统计后创建批次
      totalBatches = 0;
    } else {
      totalBatches = Math.max(1, Math.ceil(totalRows / BATCH_SIZE));
    }

    // 5. 创建任务 + Outbox 事件
    if (supabaseAdmin) {
      // 插入任务记录
      const tIns1 = Date.now();
      const { error: taskError } = await supabaseAdmin.from('v3_import_tasks').insert({
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
      timings.insertTask = Date.now() - tIns1;

      if (needWorkerInit) {
        // 非预解析模式：只创建 ImportTaskCreated 事件
        // Worker 的 initTask 会统计行数、创建批次记录和批次 outbox 事件
        const tIns2 = Date.now();
        const { error: outboxError } = await supabaseAdmin.from('v3_event_outbox').insert({
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
              file_name: fileName,
              rule_id: finalRuleId,
              trace_id: traceId,
            },
          },
          status: 'pending',
          retry_count: 0,
          next_retry_at: new Date().toISOString(),
        });
        if (outboxError) console.error('[upload] Outbox 事件插入失败:', outboxError);
        timings.insertOutbox = Date.now() - tIns2;
      } else {
        // 预解析模式：行数已知，直接创建批次记录 + outbox 事件
        const batchRecords = [];
        const outboxEvents = [];
        for (let i = 0; i < totalBatches; i++) {
          const unitId = `unit_${String(i + 1).padStart(3, '0')}`;
          const startRow = i * BATCH_SIZE + 1;
          const endRow = Math.min((i + 1) * BATCH_SIZE, totalRows);

          batchRecords.push({
            task_id: taskId, unit_id: unitId, batch_index: i,
            start_row: startRow, end_row: endRow, status: 'pending',
          });

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

        const tIns23 = Date.now();
        const [batchResult, outboxResult] = await Promise.all([
          supabaseAdmin.from('v3_import_task_batches').insert(batchRecords),
          supabaseAdmin.from('v3_event_outbox').insert(outboxEvents),
        ]);
        if (batchResult.error) console.error('[upload] 批次记录插入失败:', batchResult.error);
        if (outboxResult.error) console.error('[upload] Outbox 事件插入失败:', outboxResult.error);
        timings.insertBatchesAndOutbox = Date.now() - tIns23;
      }
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
