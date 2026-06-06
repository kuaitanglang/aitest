/**
 * POST /api/v2/ai/preview-rule — 使用统一规则引擎试解析
 */
import { NextRequest, NextResponse } from 'next/server';
import type { ParseRule } from '@/v2/types';
import { executeRuleEngine } from '@/v2/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `请求体不是合法 JSON：${msg}` }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const rows = b.rows as unknown[][];
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'rows 为空或不是二维数组' }, { status: 400 });
  }

  const rule = b.rule as ParseRule;
  if (!rule || typeof rule !== 'object') {
    return NextResponse.json({ ok: false, error: '缺少 rule 参数' }, { status: 400 });
  }

  try {
    const items = executeRuleEngine({
      rows,
      sheetData: b.sheetData as Record<string, unknown[][]> | undefined,
      textLines: b.textLines as string[] | undefined,
      rule,
    });
    return NextResponse.json({ ok: true, items, total: items.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
