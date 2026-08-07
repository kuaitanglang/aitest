import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getTraceEvents } from '@/v3/lib/trace';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v3/traces/[traceId]
 * 获取某条链路的所有事件（按时间正序）
 *
 * 返回: { ok, trace_id, events: [{ id, trace_id, task_id, unit_id, event_type, status, message, created_at }] }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    if (!supabase) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { traceId } = params;
    const events = await getTraceEvents(traceId);

    return NextResponse.json({
      ok: true,
      trace_id: traceId,
      events,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
