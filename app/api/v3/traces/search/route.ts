import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v3/traces/search?task_id=xxx&event_name=xxx&event_status=xxx&limit=50
 * 搜索 trace 事件（支持按 task_id / event_name / event_status 过滤）
 *
 * 使用 supabaseAdmin（service_role key）绕过 RLS，确保读取到 Worker 写入的数据。
 * 字段名以 database/v3-setup.sql 为准：event_name / event_status / occurred_at
 *
 * 返回: { ok, events: [...] }
 */
export async function GET(req: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('task_id') || '';
    const traceId = searchParams.get('trace_id') || '';
    // 兼容旧参数名 event_type/status（前端可能仍传）
    const eventName = searchParams.get('event_name') || searchParams.get('event_type') || '';
    const eventStatus = searchParams.get('event_status') || searchParams.get('status') || '';
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 500);

    let query = supabaseAdmin
      .from('v3_trace_events')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (taskId) query = query.eq('task_id', taskId);
    if (traceId) query = query.eq('trace_id', traceId);
    if (eventName) query = query.eq('event_name', eventName);
    if (eventStatus) query = query.eq('event_status', eventStatus);

    const { data: events, error } = await query;

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const res = NextResponse.json({ ok: true, events: events || [] });
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
