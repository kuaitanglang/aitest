-- V2 独立建表脚本（不影响 V1 orders 表）
-- 可重复执行

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language plpgsql;

CREATE TABLE IF NOT EXISTS public.v2_parse_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  file_type TEXT NOT NULL CHECK (file_type IN ('excel', 'word', 'pdf')),
  header_skip_rows INTEGER DEFAULT 0,
  footer_skip_rows INTEGER DEFAULT 0,
  data_start_row INTEGER DEFAULT 0,
  data_end_row INTEGER,
  skip_patterns TEXT[],
  aggregate_by TEXT,
  transpose_config JSONB,
  parse_mode TEXT DEFAULT 'table',
  multi_sheet BOOLEAN DEFAULT false,
  card_marker TEXT,
  extraction_rules JSONB,
  field_mappings JSONB,
  ai_generated BOOLEAN DEFAULT false,
  ai_confidence NUMERIC,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.v2_order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  external_code TEXT,
  store_name TEXT,
  receiver_name TEXT,
  receiver_phone TEXT,
  receiver_address TEXT,
  sku_code TEXT NOT NULL,
  sku_name TEXT NOT NULL,
  sku_quantity TEXT NOT NULL,
  sku_spec TEXT,
  remark TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.v2_parse_rules ADD COLUMN IF NOT EXISTS parse_mode TEXT DEFAULT 'table';
ALTER TABLE public.v2_parse_rules ADD COLUMN IF NOT EXISTS multi_sheet BOOLEAN DEFAULT false;
ALTER TABLE public.v2_parse_rules ADD COLUMN IF NOT EXISTS card_marker TEXT;

CREATE INDEX IF NOT EXISTS idx_v2_rules_name ON public.v2_parse_rules(name);
CREATE INDEX IF NOT EXISTS idx_v2_rules_updated_at ON public.v2_parse_rules(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_v2_order_items_external_code ON public.v2_order_items(external_code);
CREATE INDEX IF NOT EXISTS idx_v2_order_items_created_at ON public.v2_order_items(created_at DESC);

ALTER TABLE public.v2_parse_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v2_order_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'V2规则允许公开读取' AND tablename = 'v2_parse_rules') THEN
    CREATE POLICY "V2规则允许公开读取" ON public.v2_parse_rules FOR SELECT USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'V2规则允许插入' AND tablename = 'v2_parse_rules') THEN
    CREATE POLICY "V2规则允许插入" ON public.v2_parse_rules FOR INSERT WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'V2规则允许更新' AND tablename = 'v2_parse_rules') THEN
    CREATE POLICY "V2规则允许更新" ON public.v2_parse_rules FOR UPDATE USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'V2规则允许删除' AND tablename = 'v2_parse_rules') THEN
    CREATE POLICY "V2规则允许删除" ON public.v2_parse_rules FOR DELETE USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'V2订单允许公开读取' AND tablename = 'v2_order_items') THEN
    CREATE POLICY "V2订单允许公开读取" ON public.v2_order_items FOR SELECT USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'V2订单允许插入' AND tablename = 'v2_order_items') THEN
    CREATE POLICY "V2订单允许插入" ON public.v2_order_items FOR INSERT WITH CHECK (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_v2_rules_updated_at ON public.v2_parse_rules;
CREATE TRIGGER update_v2_rules_updated_at
    BEFORE UPDATE ON public.v2_parse_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
