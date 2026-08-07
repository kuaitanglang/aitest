/**
 * V3 BullMQ 队列配置
 *
 * 用于 Redis 模式（worker/index.ts）。本地无 Redis 时用 local-worker.ts。
 *
 * 环境变量:
 *   REDIS_URL            - 完整连接字符串（优先），如 redis://:pwd@host:port
 *   REDIS_HOST / REDIS_PORT / REDIS_PASSWORD - 分项配置
 */
import { Queue } from 'bullmq';

/** 导入队列名称 */
export const IMPORT_QUEUE_NAME = 'v3-import-queue';

/** 解析 Redis 连接配置 */
function resolveRedisConnection() {
  // 优先解析 REDIS_URL
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      return {
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        password: url.password || undefined,
        username: url.username || undefined,
      };
    } catch {
      // URL 解析失败，回退到分项配置
    }
  }

  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

/** Redis 连接配置（BullMQ ConnectionConfig） */
export const redisConnection = resolveRedisConnection();

/** 导入队列（用于提交批次处理任务） */
export const importQueue = new Queue(IMPORT_QUEUE_NAME, {
  connection: redisConnection,
});

/**
 * 向队列添加一个批次处理任务
 */
export async function enqueueBatch(payload: ImportBatchPayloadLike): Promise<string> {
  const job = await importQueue.add(
    `batch-${payload.unit_id}`,
    payload,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    }
  );
  return job?.id || '';
}

/** 批次 payload 类型（避免循环依赖，这里局部定义，与 v3/types 的 ImportBatchPayload 结构一致） */
interface ImportBatchPayloadLike {
  task_id: string;
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  trace_id: string;
  rule_id: string;
  file_url: string;
  file_name: string;
  items_url?: string;
}
