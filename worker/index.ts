/**
 * V3 Import Worker 进程入口
 *
 * 部署方式:
 *   - Railway: railway run node worker/index.js (编译后)
 *   - 本地: npx tsx worker/index.ts
 *
 * 环境变量:
 *   REDIS_URL 或 REDIS_HOST + REDIS_PORT + REDIS_PASSWORD
 *   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
 */
import { Worker } from 'bullmq';
import { IMPORT_QUEUE_NAME, redisConnection } from '../v3/lib/queue';
import { processBatch } from '../v3/lib/batch-processor';
import { writeTrace } from '../v3/lib/trace';
import type { ImportBatchPayload } from '../v3/types';
import { supabase } from '../lib/supabase';

console.log('[worker] V3 导入 Worker 启动中...');
console.log('[worker] Redis 连接:', JSON.stringify(redisConnection));

// 创建 Worker
const worker = new Worker<ImportBatchPayload>(
  IMPORT_QUEUE_NAME,
  async (job) => {
    console.log(`[worker] 收到任务: ${job.id}, task=${job.data.task_id}, unit=${job.data.unit_id}`);
    await processBatch(job.data);
    return { ok: true };
  },
  {
    connection: redisConnection,
    concurrency: 2, // 单 Worker 并发 2 个 Job
  }
);

worker.on('completed', (job) => {
  console.log(`[worker] 任务完成: ${job.id}`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] 任务失败: ${job?.id}`, err.message);
});

worker.on('error', (err) => {
  console.error('[worker] Worker 错误:', err);
});

/* ================================================================
 * 卡死批次恢复（DB 级保护，与 local-worker 一致）
 *
 * BullMQ 自身重试能覆盖 Job 失败场景，但如果 Worker 进程崩溃
 * 导致批次已锁定（processing）但 Job 丢失，需要 DB 级恢复。
 * 每 30 秒扫描一次超时的 processing 批次，重建 outbox 事件。
 * ================================================================ */
async function recoverStuckBatches(): Promise<void> {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.rpc('recover_stuck_batches', { p_timeout_minutes: 5 });
    if (error) {
      console.error('[worker] recover_stuck_batches RPC 失败:', error.message);
      return;
    }
    if (data && data.length > 0) {
      console.log(`[worker] 恢复了 ${data.length} 个卡死批次`);
      for (const row of data) {
        const { data: batch } = await supabase
          .from('v3_import_task_batches')
          .select('*')
          .eq('task_id', row.recovered_task_id)
          .eq('unit_id', row.recovered_unit_id)
          .maybeSingle();

        const { data: task } = await supabase
          .from('v3_import_tasks')
          .select('*')
          .eq('id', row.recovered_task_id)
          .maybeSingle();

        if (batch && task) {
          // 从原始 outbox 事件恢复 items_url
          let itemsUrl = '';
          const { data: origEvents } = await supabase
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
          if (itemsUrl) recoveredPayload.items_url = itemsUrl;

          await supabase.from('v3_event_outbox').insert({
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

          await writeTrace(task.trace_id, task.id, batch.unit_id, 'BatchRecovered', 'success',
            `批次 ${batch.unit_id} 卡死恢复，已重建 outbox 事件`);
        }
      }
    }
  } catch (err: any) {
    console.error('[worker] recoverStuckBatches 异常:', err?.message || err);
  }
}

// 定时执行卡死恢复（每 30 秒）
const recoverTimer = setInterval(recoverStuckBatches, 30000);

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('[worker] 收到 SIGTERM，优雅关闭...');
  clearInterval(recoverTimer);
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[worker] 收到 SIGINT，优雅关闭...');
  clearInterval(recoverTimer);
  await worker.close();
  process.exit(0);
});

console.log('[worker] Worker 已启动，等待任务...');
