import { NextRequest, NextResponse } from 'next/server';
import { dbDeleteRule, dbGetRuleById } from '@/lib/v2-supabase';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const rule = await dbGetRuleById(params.id);
    if (!rule) return NextResponse.json({ ok: false, error: '规则不存在' }, { status: 404 });
    return NextResponse.json({ ok: true, rule });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await dbDeleteRule(params.id);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
