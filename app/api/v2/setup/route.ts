/**
 * POST /api/v2/setup
 * 一键创建 V2 所需的数据库表
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SQL = `
CREATE TABLE IF NOT EXISTS v2_parse_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  file_type TEXT DEFAULT 'excel',
  parse_mode TEXT DEFAULT 'table',
  multi_sheet BOOLEAN DEFAULT FALSE,
  card_marker TEXT,
  header_skip_rows INT DEFAULT 0,
  footer_skip_rows INT DEFAULT 0,
  data_start_row INT DEFAULT 0,
  data_end_row INT,
  skip_patterns JSONB DEFAULT '[]',
  aggregate_by TEXT DEFAULT '',
  transpose_config JSONB,
  extraction_rules JSONB DEFAULT '[]',
  field_mappings JSONB DEFAULT '[]',
  ai_generated BOOLEAN DEFAULT FALSE,
  ai_confidence FLOAT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE v2_parse_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "v2_rules_public_select" ON v2_parse_rules;
DROP POLICY IF EXISTS "v2_rules_public_insert" ON v2_parse_rules;
DROP POLICY IF EXISTS "v2_rules_public_update" ON v2_parse_rules;
DROP POLICY IF EXISTS "v2_rules_public_delete" ON v2_parse_rules;
CREATE POLICY "v2_rules_public_select" ON v2_parse_rules FOR SELECT USING (true);
CREATE POLICY "v2_rules_public_insert" ON v2_parse_rules FOR INSERT WITH CHECK (true);
CREATE POLICY "v2_rules_public_update" ON v2_parse_rules FOR UPDATE USING (true);
CREATE POLICY "v2_rules_public_delete" ON v2_parse_rules FOR DELETE USING (true);

CREATE TABLE IF NOT EXISTS v2_order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_code TEXT DEFAULT '',
  store_name TEXT DEFAULT '',
  receiver_name TEXT DEFAULT '',
  receiver_phone TEXT DEFAULT '',
  receiver_address TEXT DEFAULT '',
  sku_code TEXT DEFAULT '',
  sku_name TEXT DEFAULT '',
  sku_quantity TEXT DEFAULT '',
  sku_spec TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE v2_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "v2_items_public_select" ON v2_order_items;
DROP POLICY IF EXISTS "v2_items_public_insert" ON v2_order_items;
CREATE POLICY "v2_items_public_select" ON v2_order_items FOR SELECT USING (true);
CREATE POLICY "v2_items_public_insert" ON v2_order_items FOR INSERT WITH CHECK (true);
`;

export async function POST() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ ok: false, error: 'Supabase 未配置' }, { status: 500 });
  }

  try {
    // 通过 Supabase REST API 的 /rest/v1/ 执行 SQL
    const url = `${supabaseUrl}/rest/v1/rpc/`;
    
    // 先尝试直接通过 SQL 查询创建（需要 service_role key）
    // 因 anon key 权限不够，改用另一种方式：逐条尝试行级操作来判断表是否存在
    const testResp = await fetch(`${supabaseUrl}/rest/v1/v2_parse_rules?select=id&limit=1`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });

    if (testResp.ok) {
      return NextResponse.json({ ok: true, message: 'V2 表已存在，无需创建' });
    }

    // 表不存在，提示用户去 Supabase 控制台执行 SQL
    return NextResponse.json({
      ok: false,
      error: 'Supabase anon key 无权创建表。请在 Supabase SQL Editor 中执行以下 SQL：',
      sql: SQL,
      hint: `打开 ${supabaseUrl.replace('.supabase.co', '.supabase.co/project/default/sql/new')}`,
    }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
