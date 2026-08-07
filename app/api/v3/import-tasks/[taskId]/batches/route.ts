import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v3/import-tasks/[taskId]/batches
 * 获取任务下所有批次的状态和性能日志
 *
 * 使用 supabaseAdmin（service_role key）绕过 RLS，确保读取到 Worker 写入的最新数据。
 *
 * 返回结构（与压测脚本 stress-test.ts 约定一致）:
 *   { ok, batches: [{ batch_index, status, parse_duration_ms, rule_duration_ms,
 *                     validate_duration_ms, insert_duration_ms, total_duration_ms,
 *                     rows_processed, rows_success, rows_failed }] }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { taskId } = params;

    // 查询批次状态
    const { data: batches, error: batchErr } = await supabaseAdmin
      .from('v3_import_task_batches')
      .select('unit_id, batch_index, start_row, end_row, status, locked_at, completed_at')
      .eq('task_id', taskId)
      .order('batch_index', { ascending: true });

    if (batchErr) {
      return NextResponse.json({ ok: false, error: batchErr.message }, { status: 500 });
    }

    // 查询性能日志
    const { data: perfLogs, error: perfErr } = await supabaseAdmin
      .from('v3_batch_performance_log')
      .select('*')
      .eq('task_id', taskId)
      .order('batch_index', { ascending: true });

    if (perfErr) {
      return NextResponse.json({ ok: false, error: perfErr.message }, { status: 500 });
    }

    // 合并批次状态与性能日志
    const perfMap = new Map<number, any>();
    for (const p of perfLogs || []) {
      perfMap.set(p.batch_index, p);
    }

    const result = (batches || []).map((b: any) => {
      const p = perfMap.get(b.batch_index) || {};
      return {
        unit_id: b.unit_id,
        batch_index: b.batch_index,
        start_row: b.start_row,
        end_row: b.end_row,
        status: b.status,
        locked_at: b.locked_at,
        completed_at: b.completed_at,
        parse_duration_ms: p.parse_duration_ms ?? 0,
        rule_duration_ms: p.rule_duration_ms ?? 0,
        validate_duration_ms: p.validate_duration_ms ?? 0,
        insert_duration_ms: p.insert_duration_ms ?? 0,
        total_duration_ms: p.total_duration_ms ?? 0,
        rows_processed: p.rows_processed ?? 0,
        rows_success: p.rows_success ?? 0,
        rows_failed: p.rows_failed ?? 0,
      };
    });

    // 添加 no-store 响应头，避免任何中间层缓存
    const res = NextResponse.json({ ok: true, batches: result });
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
