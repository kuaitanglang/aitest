/**
 * V3 本地 Worker（无需 Redis）
 *
 * 直接轮询 v3_event_outbox 表，处理 pending 事件。
 * 用于本地开发和无需 Redis 的部署场景。
 *
 * 用法: npx tsx worker/local-worker.ts
 */
import { supabaseAdmin } from '../lib/supabase';
import { processBatch } from '../v3/lib/batch-processor';
import { writeTrace } from '../v3/lib/trace';
import type { ImportBatchPayload } from '../v3/types';
import * as XLSX from 'xlsx';
import * as fs from 'fs';

const POLL_INTERVAL = 1000; // 1 秒轮询（加快批次拾取）
const MAX_CONCURRENT = 5; // 最大并发批次数（10 批 / 5 并发 = 2 波，压测目标 ≤60s）

console.log('========================================');
console.log('  V3 本地 Worker（无 Redis 模式）');
console.log('========================================');
console.log(`轮询间隔: ${POLL_INTERVAL}ms`);
console.log(`最大并发: ${MAX_CONCURRENT}`);
console.log('');

if (!supabaseAdmin) {
  console.error('[worker] Supabase 未配置，请检查 .env.local');
  process.exit(1);
}

async function pollAndProcess(): Promise<void> {
  try {
    // 1. 查询 pending 的 outbox 事件
    const { data: events, error } = await supabaseAdmin!
      .from('v3_event_outbox')
      .select('*')
      .eq('status', 'pending')
      .lte('next_retry_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(MAX_CONCURRENT);

    if (error) {
      console.error('[worker] 查询 outbox 失败:', error.message);
      // 即使 outbox 查询失败，也尝试兜底更新任务状态
      await checkTaskCompletion();
      return;
    }

    if (!events || events.length === 0) {
      // 无待处理事件，但仍需检查是否有任务状态需要兜底更新
      await checkTaskCompletion();
      return;
    }

    // 2. 并发处理
    const promises = events.map(async (evt) => {
      // 标记为 sent（防止重复处理）
      await supabaseAdmin!
        .from('v3_event_outbox')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', evt.id);

      const payload = evt.payload?.payload || evt.payload;
      const eventType = payload.event_type || evt.event_type;

      try {
        if (eventType === 'ImportTaskCreated') {
          // 任务初始化：解析文件计算行数 → 创建批次记录 + 批次 outbox 事件
          console.log(`[worker] 任务初始化: task=${payload.task_id}`);
          await initTask(payload);
          console.log(`[worker] 任务初始化完成: task=${payload.task_id}`);
        } else {
          // 批次处理：ImportBatchCreated / ImportBatchRetry
          const batchPayload: ImportBatchPayload = {
            task_id: payload.task_id,
            unit_id: payload.unit_id,
            batch_index: payload.batch_index,
            start_row: payload.start_row,
            end_row: payload.end_row,
            trace_id: payload.trace_id,
            rule_id: payload.rule_id,
            file_url: payload.file_url,
            file_name: payload.file_name,
            // AI 直接解析模式：预解析结果 JSON 文件 URL
            items_url: payload.items_url,
          };
          console.log(`[worker] 开始处理: task=${batchPayload.task_id}, unit=${batchPayload.unit_id}, rows=${batchPayload.start_row}-${batchPayload.end_row}`);
          await processBatch(batchPayload);
          console.log(`[worker] 完成: ${batchPayload.unit_id}`);
        }
      } catch (err: any) {
        console.error(`[worker] 失败: ${eventType}`, err.message);
        // 回退 outbox 状态为 pending（带重试计数）
        const newRetry = (evt.retry_count || 0) + 1;
        if (newRetry >= 3) {
          await supabaseAdmin!.from('v3_event_outbox').update({ status: 'failed', retry_count: newRetry }).eq('id', evt.id);
        } else {
          const backoff = 3000 * Math.pow(2, newRetry);
          await supabaseAdmin!.from('v3_event_outbox').update({
            status: 'pending',
            retry_count: newRetry,
            next_retry_at: new Date(Date.now() + backoff).toISOString(),
          }).eq('id', evt.id);
        }
      }
    });

    await Promise.all(promises);

    // 兜底：检查是否有任务所有批次已完成但状态仍为 pending/processing
    await checkTaskCompletion();
  } catch (err: any) {
    console.error('[worker] 轮询异常:', err.message);
  }
}

/**
 * 任务初始化：解析文件计算行数 → 创建批次记录 + 批次 outbox 事件
 *
 * 上传时不再解析 Excel（quickCountRows 延迟到此处），由 Worker 在后台完成：
 *   1. 读取 items JSON 或解析 Excel 统计行数
 *   2. 按 BATCH_SIZE 计算批次
 *   3. 调用 RPC init_task_batches（1 次 HTTP 往返：更新任务 + 创建批次 + 创建 outbox 事件）
 */
async function initTask(payload: any): Promise<void> {
  const { task_id, file_url, file_name, rule_id, trace_id, items_url, total_rows } = payload;
  const BATCH_SIZE = 1000;

  // 1. 计算总行数
  let totalRows: number;
  const tCount = Date.now();

  if (items_url) {
    // 预解析模式：读取 items JSON 的数组长度（无需解析 Excel）
    totalRows = await countItemsJson(items_url);
  } else if (total_rows && total_rows > 0) {
    // 上传时已知的行数（预解析模式兜底）
    totalRows = total_rows;
  } else {
    // 异步解析模式：读取 Excel 统计行数（原 quickCountRows 逻辑，移到 Worker）
    totalRows = await countFileRows(file_url, file_name);
  }
  console.log(`[worker] 任务初始化行数统计: ${totalRows} 行 (耗时 ${Date.now() - tCount}ms)`);

  if (totalRows === 0) {
    // 空文件：直接标记任务完成
    await supabaseAdmin!
      .from('v3_import_tasks')
      .update({ total_rows: 0, total_batches: 0, status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', task_id);
    await writeTrace(trace_id, task_id, '', 'ImportTaskCompleted', 'success', '空文件，无数据处理');
    return;
  }

  // 2. 计算批次
  const totalBatches = Math.max(1, Math.ceil(totalRows / BATCH_SIZE));

  // 3. 构建批次记录和 outbox 事件
  const batches: any[] = [];
  const outboxEvents: any[] = [];
  for (let i = 0; i < totalBatches; i++) {
    const unitId = `unit_${String(i + 1).padStart(3, '0')}`;
    const startRow = i * BATCH_SIZE + 1; // 1-based，跳过表头
    const endRow = Math.min((i + 1) * BATCH_SIZE, totalRows);

    batches.push({ unit_id: unitId, batch_index: i, start_row: startRow, end_row: endRow });

    const batchPayload: Record<string, any> = {
      task_id, unit_id: unitId, batch_index: i,
      start_row: startRow, end_row: endRow,
      rule_id, file_url, file_name, trace_id,
    };
    if (items_url) batchPayload.items_url = items_url;

    outboxEvents.push({
      event_type: 'ImportBatchCreated',
      aggregate_id: task_id,
      trace_id,
      occurred_at: new Date().toISOString(),
      payload: batchPayload,
    });
  }

  // 4. 调用 RPC init_task_batches（1 次 HTTP 往返：更新任务 + 创建批次 + 创建 outbox 事件）
  const tRpc = Date.now();
  const { error: rpcError } = await supabaseAdmin!.rpc('init_task_batches', {
    p_task_id: task_id,
    p_total_rows: totalRows,
    p_total_batches: totalBatches,
    p_batches: batches,
    p_outbox_events: outboxEvents,
  });
  console.log(`[worker] init_task_batches RPC: ${Date.now() - tRpc}ms ${rpcError ? '(失败: ' + rpcError.message + ')' : '(成功)'}`);

  if (rpcError) {
    // 回退：逐次 SQL 操作
    console.warn('[worker] RPC init_task_batches 失败，回退到逐次 SQL');
    await supabaseAdmin!
      .from('v3_import_tasks')
      .update({ total_rows: totalRows, total_batches: totalBatches, status: 'processing' })
      .eq('id', task_id);

    const batchRecords = batches.map(b => ({
      task_id, unit_id: b.unit_id, batch_index: b.batch_index,
      start_row: b.start_row, end_row: b.end_row, status: 'pending',
    }));
    await supabaseAdmin!.from('v3_import_task_batches').insert(batchRecords);

    const outboxRecords = outboxEvents.map(e => ({
      aggregate_id: task_id, event_type: 'ImportBatchCreated',
      payload: e, status: 'pending', retry_count: 0,
      next_retry_at: new Date().toISOString(),
    }));
    await supabaseAdmin!.from('v3_event_outbox').insert(outboxRecords);
  }

  await writeTrace(trace_id, task_id, '', 'TaskInitialized', 'success',
    `行数: ${totalRows}, 批次: ${totalBatches}`);
}

/**
 * 读取 items JSON 文件并返回数组长度
 */
async function countItemsJson(itemsUrl: string): Promise<number> {
  let buffer: Buffer;
  if (itemsUrl.startsWith('local:')) {
    buffer = fs.readFileSync(itemsUrl.slice(6));
  } else if (supabaseAdmin) {
    const pathMatch = itemsUrl.match(/\/object\/public\/import-files\/(.+)$/);
    const storagePath = pathMatch ? pathMatch[1] : itemsUrl.split('/').slice(-2).join('/');
    const { data, error } = await supabaseAdmin.storage.from('import-files').download(storagePath);
    if (error || !data) throw new Error(`items JSON 下载失败: ${error?.message}`);
    buffer = Buffer.from(await data.arrayBuffer());
  } else {
    throw new Error('无法读取 items JSON');
  }
  const items = JSON.parse(buffer.toString('utf-8'));
  return Array.isArray(items) ? items.length : 0;
}

/**
 * 读取 Excel 文件并统计数据行数（不含表头）
 * 原 quickCountRows 逻辑，从上传接口移到 Worker
 */
async function countFileRows(fileUrl: string, fileName: string): Promise<number> {
  let buffer: Buffer;
  if (fileUrl.startsWith('local:')) {
    buffer = fs.readFileSync(fileUrl.slice(6));
  } else if (supabaseAdmin) {
    const pathMatch = fileUrl.match(/\/object\/public\/import-files\/(.+)$/);
    const storagePath = pathMatch ? pathMatch[1] : fileUrl.split('/').slice(-2).join('/');
    const { data, error } = await supabaseAdmin.storage.from('import-files').download(storagePath);
    if (error || !data) throw new Error(`文件下载失败: ${error?.message}`);
    buffer = Buffer.from(await data.arrayBuffer());
  } else {
    throw new Error('无法读取文件');
  }

  const name = (fileName || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    let totalRows = 0;
    for (const sheetName of workbook.SheetNames) {
      if (sheetName.startsWith('~$')) continue;
      const ws = workbook.Sheets[sheetName];
      const ref = ws['!ref'];
      if (ref) {
        const range = XLSX.utils.decode_range(ref);
        totalRows += range.e.r - range.s.r; // 减去表头行
      }
    }
    return Math.max(0, totalRows);
  }

  // Word/PDF: 返回 0，由 processBatch 动态处理
  return 0;
}

/**
 * 兜底任务状态更新
 *
 * 从数据库重新计算任务进度（不依赖 completed_batches 字段）：
 * 1. 查询所有 pending/processing 状态的任务
 * 2. 直接从 v3_import_task_batches 统计已完成批次数
 * 3. 从 v3_batch_performance_log 汇总成功/失败行数
 * 4. 如果所有批次都已完成，更新任务状态
 */
async function checkTaskCompletion(): Promise<void> {
  try {
    const { data: activeTasks } = await supabaseAdmin!
      .from('v3_import_tasks')
      .select('id, total_batches, trace_id')
      .in('status', ['pending', 'processing']);

    if (!activeTasks || activeTasks.length === 0) return;

    for (const task of activeTasks) {
      // 直接从数据库统计批次状态
      const { count: completedCount } = await supabaseAdmin!
        .from('v3_import_task_batches')
        .select('*', { count: 'exact', head: true })
        .eq('task_id', task.id)
        .eq('status', 'completed');

      const { count: pendingCount } = await supabaseAdmin!
        .from('v3_import_task_batches')
        .select('*', { count: 'exact', head: true })
        .eq('task_id', task.id)
        .in('status', ['pending', 'processing']);

      // 所有批次都已完成
      if ((pendingCount || 0) === 0 && (completedCount || 0) >= task.total_batches) {
        // 从性能日志汇总成功/失败行数
        const { data: perfLogs } = await supabaseAdmin!
          .from('v3_batch_performance_log')
          .select('rows_success, rows_failed')
          .eq('task_id', task.id);

        const totalSuccess = (perfLogs || []).reduce((sum: number, l: any) => sum + (l.rows_success || 0), 0);
        const totalFailed = (perfLogs || []).reduce((sum: number, l: any) => sum + (l.rows_failed || 0), 0);
        const totalProcessed = totalSuccess + totalFailed;
        const newStatus = totalFailed > 0 ? 'partial_success' : 'completed';

        console.log(`[worker] 兜底更新任务状态: ${task.id} → ${newStatus} (批次=${completedCount}/${task.total_batches}, 成功=${totalSuccess}, 失败=${totalFailed})`);

        await supabaseAdmin!
          .from('v3_import_tasks')
          .update({
            status: newStatus,
            processed_rows: totalProcessed,
            success_rows: totalSuccess,
            failed_rows: totalFailed,
            completed_batches: completedCount || task.total_batches,
            completed_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        await writeTrace(task.trace_id, task.id, '', 'ImportTaskCompleted', 'success',
          `任务完成: 成功 ${totalSuccess} 行, 失败 ${totalFailed} 行`);
      }
    }
  } catch (err: any) {
    console.error('[worker] checkTaskCompletion 异常:', err?.message || err);
  }
}

// 恢复卡死批次
async function recoverStuckBatches(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin!.rpc('recover_stuck_batches', { p_timeout_minutes: 5 });
    if (error) return;
    if (data && data.length > 0) {
      console.log(`[worker] 恢复了 ${data.length} 个卡死批次`);
      // 为恢复的批次重新创建 outbox 事件
      for (const row of data) {
        // 查询批次信息重建 payload
        const { data: batch } = await supabaseAdmin!
          .from('v3_import_task_batches')
          .select('*')
          .eq('task_id', row.recovered_task_id)
          .eq('unit_id', row.recovered_unit_id)
          .maybeSingle();

        const { data: task } = await supabaseAdmin!
          .from('v3_import_tasks')
          .select('*')
          .eq('id', row.recovered_task_id)
          .maybeSingle();

        if (batch && task) {
          // 从原始 outbox 事件中恢复 items_url（预解析模式的关键字段）
          // 原始事件可能已被标记为 sent，但仍保留 payload
          let itemsUrl = '';
          const { data: origEvents } = await supabaseAdmin!
            .from('v3_event_outbox')
            .select('payload')
            .eq('aggregate_id', task.id);
          if (origEvents) {
            for (const evt of origEvents) {
              const p = evt.payload?.payload || evt.payload;
              if (p?.unit_id === batch.unit_id && p?.items_url) {
                itemsUrl = p.items_url;
                break;
              }
            }
          }

          const recoveredPayload: Record<string, any> = {
            task_id: task.id,
            unit_id: batch.unit_id,
            batch_index: batch.batch_index,
            start_row: batch.start_row,
            end_row: batch.end_row,
            rule_id: task.rule_id,
            file_url: task.file_url,
            file_name: task.file_name,
            trace_id: task.trace_id,
          };
          if (itemsUrl) {
            recoveredPayload.items_url = itemsUrl;
          }

          await supabaseAdmin!.from('v3_event_outbox').insert({
            aggregate_id: task.id,
            event_type: 'ImportBatchRetry',
            payload: {
              event_type: 'ImportBatchRetry',
              aggregate_id: task.id,
              trace_id: task.trace_id,
              occurred_at: new Date().toISOString(),
              payload: recoveredPayload,
            },
            status: 'pending',
            next_retry_at: new Date().toISOString(),
          });
        }
      }
    }
  } catch (err: any) {
    console.error('[worker] recoverStuckBatches 异常:', err?.message || err);
  }
}

// 主循环
let running = true;
let recoverCounter = 0;

async function mainLoop() {
  console.log('[worker] Worker 已启动，等待任务...\n');

  while (running) {
    await pollAndProcess();

    // 每 30 秒执行一次卡死恢复
    recoverCounter++;
    if (recoverCounter >= 15) {
      recoverCounter = 0;
      await recoverStuckBatches();
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

// 优雅关闭
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

mainLoop();
