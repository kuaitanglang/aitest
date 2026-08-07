import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v3/import-tasks/[taskId]
 * 获取单个任务详情（含进度、状态、错误汇总）
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  try {
    if (!supabase) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { taskId } = params;
    const { data: task, error } = await supabase
      .from('v3_import_tasks')
      .select('*')
      .eq('id', taskId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    if (!task) {
      return NextResponse.json({ ok: false, error: '任务不存在' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, task });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/v3/import-tasks/[taskId]
 * 删除任务（级联删除批次、错误、性能日志）
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  try {
    if (!supabase) {
      return NextResponse.json({ ok: false, error: '数据库未配置' }, { status: 500 });
    }

    const { taskId } = params;

    // 按依赖顺序删除
    await supabase.from('v3_import_task_errors').delete().eq('task_id', taskId);
    await supabase.from('v3_batch_performance_log').delete().eq('task_id', taskId);
    await supabase.from('v3_import_task_batches').delete().eq('task_id', taskId);
    await supabase.from('v3_event_outbox').delete().eq('aggregate_id', taskId);
    await supabase.from('v3_trace_events').delete().eq('task_id', taskId);
    const { error } = await supabase.from('v3_import_tasks').delete().eq('id', taskId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
