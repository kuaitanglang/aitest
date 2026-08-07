import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * 查询任务错误明细（支持按批次、错误码筛选和分页）
 * GET /api/v3/import-tasks/:taskId/errors?batch=4&error_code=E001&page=1&page_size=50
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  try {
    const taskId = params.taskId;
    const { searchParams } = new URL(req.url);
    const batchIndex = searchParams.get('batch');
    const errorCode = searchParams.get('error_code') || searchParams.get('code');
    const page = Number(searchParams.get('page') || 1);
    const pageSize = Number(searchParams.get('page_size') || 50);

    if (!supabaseAdmin) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    let query = supabaseAdmin
      .from('v3_import_task_errors')
      .select('*', { count: 'exact' })
      .eq('task_id', taskId);

    if (batchIndex !== null && batchIndex !== '') {
      query = query.eq('batch_index', Number(batchIndex));
    }
    if (errorCode) {
      query = query.eq('error_code', errorCode);
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    query = query.order('row_number', { ascending: true }).range(from, to);

    const { data: errors, count, error } = await query;

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // 按错误码聚合统计
    const { data: summary } = await supabaseAdmin
      .from('v3_import_task_errors')
      .select('error_code')
      .eq('task_id', taskId);

    const errorSummary: Record<string, number> = {};
    (summary || []).forEach((e: any) => {
      errorSummary[e.error_code] = (errorSummary[e.error_code] || 0) + 1;
    });

    const res = NextResponse.json({
      ok: true,
      errors: errors || [],
      total: count || 0,
      page,
      page_size: pageSize,
      error_summary: errorSummary,
    });
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
