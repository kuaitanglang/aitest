-- V2 数据库表结构（与 V1 orders 表独立）
-- 运行此 SQL 在 Supabase SQL Editor 中创建 V2 所需的表

-- 1. 解析规则表
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

CREATE INDEX IF NOT EXISTS idx_v2_parse_rules_updated ON v2_parse_rules(updated_at DESC);

ALTER TABLE v2_parse_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access" ON v2_parse_rules FOR SELECT USING (true);
CREATE POLICY "Allow insert access" ON v2_parse_rules FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update access" ON v2_parse_rules FOR UPDATE USING (true);
CREATE POLICY "Allow delete access" ON v2_parse_rules FOR DELETE USING (true);

-- 2. 订单/运单明细表
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

CREATE INDEX IF NOT EXISTS idx_v2_order_items_external_code ON v2_order_items(external_code);
CREATE INDEX IF NOT EXISTS idx_v2_order_items_store_name ON v2_order_items(store_name);
CREATE INDEX IF NOT EXISTS idx_v2_order_items_sku_code ON v2_order_items(sku_code);
CREATE INDEX IF NOT EXISTS idx_v2_order_items_created_at ON v2_order_items(created_at DESC);

ALTER TABLE v2_order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access" ON v2_order_items FOR SELECT USING (true);
CREATE POLICY "Allow insert access" ON v2_order_items FOR INSERT WITH CHECK (true);
