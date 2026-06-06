import { NextRequest, NextResponse } from 'next/server';
import { dbGetOrders, dbSaveOrderItems } from '@/lib/v2-supabase';
import type { OrderItem } from '@/v2/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Number(searchParams.get('page') || 1);
    const pageSize = Number(searchParams.get('pageSize') || 10);
    const searchTerm = searchParams.get('searchTerm') || '';
    const searchField = searchParams.get('searchField') || '';
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';
    const { list, total } = await dbGetOrders(page, pageSize, searchTerm, searchField, startDate, endDate);
    return NextResponse.json({ ok: true, list, total });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items = (body.items || []) as OrderItem[];
    const result = await dbSaveOrderItems(items);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
