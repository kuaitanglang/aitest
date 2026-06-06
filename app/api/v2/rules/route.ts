import { NextRequest, NextResponse } from 'next/server';
import { dbGetAllRules, dbSaveRule } from '@/lib/v2-supabase';
import type { ParseRule } from '@/v2/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rules = await dbGetAllRules();
    return NextResponse.json({ ok: true, rules });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const rule = (await req.json()) as ParseRule;
    await dbSaveRule(rule);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
