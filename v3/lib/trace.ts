/**
 * V3 全链路追踪
 *
 * writeTrace 将事件写入 v3_trace_events 表，用于全链路可观测性。
 * Trace 是辅助功能，失败时仅记录日志，不抛异常、不阻塞主流程。
 *
 * 表结构（见 database/v3-setup.sql）:
 *   v3_trace_events(id, trace_id, task_id, unit_id, event_name, event_status, message, occurred_at)
 *
 * 注意：字段名与早期代码注释不同，以 database/v3-setup.sql 为准：
 *   - event_name（非 event_type）
 *   - event_status（非 status）
 *   - occurred_at（非 created_at）
 *
 * 事件类型约定:
 *   - TaskCreated / TaskInitialized / ImportTaskCompleted
 *   - BatchStarted / BatchSucceeded / BatchFailed / BatchRecovered
 */
import { supabaseAdmin } from '@/lib/supabase';

/**
 * 写入一条 trace 事件
 *
 * @param traceId  链路 ID
 * @param taskId   任务 ID
 * @param unitId   批次 ID（任务级事件传空串）
 * @param eventType 事件类型（如 'BatchSucceeded'）→ 写入 event_name 字段
 * @param status   事件状态（'success' / 'failed' / 'warning'）→ 写入 event_status 字段
 * @param message  事件描述
 */
export async function writeTrace(
  traceId: string,
  taskId: string,
  unitId: string,
  eventType: string,
  status: string,
  message: string
): Promise<void> {
  if (!supabaseAdmin || !traceId) return;
  try {
    const { error } = await supabaseAdmin.from('v3_trace_events').insert({
      trace_id: traceId,
      task_id: taskId,
      unit_id: unitId,
      event_name: eventType,
      event_status: status,
      message,
    });
    if (error) {
      console.error('[trace] 写入失败:', error.message);
    }
  } catch (err) {
    // trace 写入失败不影响主流程，仅记录日志
    console.error(
      '[trace] 写入失败:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 查询某条链路的所有事件（按时间正序）
 */
export async function getTraceEvents(traceId: string) {
  if (!supabaseAdmin || !traceId) return [];
  const { data, error } = await supabaseAdmin
    .from('v3_trace_events')
    .select('*')
    .eq('trace_id', traceId)
    .order('occurred_at', { ascending: true });
  if (error) {
    console.error('[trace] 查询失败:', error.message);
    return [];
  }
  return data || [];
}
