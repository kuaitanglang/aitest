import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v3/import-monitor/summary
 * 导入监控汇总（用于监控看板）
 *
 * 考题模块八要求的 4 个核心区域：
 *   1. 实时吞吐量
 *   2. 队列积压深度（pending outbox 事件数 + pending 行数）
 *   3. 阶段耗时分布 P50/P95/P99
 *   4. 错误类型分布
 */
export async function GET(_req: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    // 按状态分组统计任务数
    const { data: tasks, error: statusErr } = await supabaseAdmin
      .from('v3_import_tasks')
      .select('status, total_rows, success_rows, failed_rows, completed_at, created_at');

    if (statusErr) {
      return NextResponse.json({ ok: false, error: statusErr.message }, { status: 500 });
    }

    const summary: Record<string, number> = {
      total: tasks.length,
      pending: 0,
      processing: 0,
      completed: 0,
      partial_success: 0,
      failed: 0,
    };

    let totalRows = 0;
    let successRows = 0;
    let failedRows = 0;
    const durations: number[] = [];

    for (const t of tasks) {
      const st = (t as any).status as string;
      if (summary[st] !== undefined) summary[st]++;
      totalRows += (t as any).total_rows || 0;
      successRows += (t as any).success_rows || 0;
      failedRows += (t as any).failed_rows || 0;

      const created = (t as any).created_at;
      const completed = (t as any).completed_at;
      if (created && completed) {
        const dur = new Date(completed).getTime() - new Date(created).getTime();
        if (dur > 0 && dur < 600000) durations.push(dur);
      }
    }

    const avgDurationMs = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    // === 2. 队列积压深度 ===
    const { count: pendingOutboxCount } = await supabaseAdmin
      .from('v3_event_outbox')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    const { count: pendingBatchCount } = await supabaseAdmin
      .from('v3_import_task_batches')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    // === 3. 阶段耗时分布 P50/P95/P99 ===
    const { data: perfLogs } = await supabaseAdmin
      .from('v3_batch_performance_log')
      .select('parse_duration_ms, rule_duration_ms, validate_duration_ms, insert_duration_ms, total_duration_ms')
      .order('created_at', { ascending: false })
      .limit(500);

    const stageMetrics = calcStagePercentiles(perfLogs || []);

    // === 4. 错误类型分布 ===
    const { data: errorDist } = await supabaseAdmin
      .from('v3_import_task_errors')
      .select('error_code')
      .limit(10000);

    const errorDistribution: Record<string, number> = {};
    for (const e of errorDist || []) {
      const code = (e as any).error_code;
      if (code) errorDistribution[code] = (errorDistribution[code] || 0) + 1;
    }

    const res = NextResponse.json({
      ok: true,
      summary: {
        ...summary,
        total_rows: totalRows,
        success_rows: successRows,
        failed_rows: failedRows,
        avg_duration_ms: avgDurationMs,
        throughput_rows_per_sec: avgDurationMs > 0
          ? Math.round((successRows + failedRows) / (avgDurationMs / 1000))
          : 0,
        // 队列积压
        pending_outbox: pendingOutboxCount || 0,
        pending_batches: pendingBatchCount || 0,
        // 阶段耗时分位数
        stage_metrics: stageMetrics,
        // 错误分布
        error_distribution: errorDistribution,
      },
    });
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * 计算各阶段耗时的 P50/P95/P99
 */
function calcStagePercentiles(logs: any[]) {
  const stages = ['parse_duration_ms', 'rule_duration_ms', 'validate_duration_ms', 'insert_duration_ms', 'total_duration_ms'];
  const result: Record<string, { p50: number; p95: number; p99: number }> = {};

  for (const stage of stages) {
    const values = logs.map(l => l[stage] || 0).filter(v => v > 0).sort((a, b) => a - b);
    if (values.length === 0) {
      result[stage] = { p50: 0, p95: 0, p99: 0 };
    } else {
      result[stage] = {
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
      };
    }
  }

  return result;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))];
}
