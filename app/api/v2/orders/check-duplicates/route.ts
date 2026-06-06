import { NextRequest, NextResponse } from 'next/server';
import { dbCheckDuplicateExternalCodes } from '@/lib/v2-supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const codes = (body.codes || []) as string[];
    const dupSet = await dbCheckDuplicateExternalCodes(codes);
    return NextResponse.json({ ok: true, duplicates: [...dupSet] });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
