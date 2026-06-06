-- 运单导入系统 - 数据库表结构
-- 在 Supabase SQL Editor 中执行此脚本

-- 创建 orders 表
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  external_code VARCHAR(100),                    -- 外部编码（可选）
  sender_name VARCHAR(100) NOT NULL,             -- 发件人姓名
  sender_phone VARCHAR(20) NOT NULL,              -- 发件人电话
  sender_address TEXT NOT NULL,                  -- 发件人地址
  receiver_name VARCHAR(100) NOT NULL,            -- 收件人姓名
  receiver_phone VARCHAR(20) NOT NULL,            -- 收件人电话
  receiver_address TEXT NOT NULL,                -- 收件人地址
  weight DECIMAL(10,2) NOT NULL DEFAULT 0,       -- 重量(kg)
  quantity INTEGER NOT NULL DEFAULT 0,           -- 件数
  temperature VARCHAR(20) NOT NULL,               -- 温层：常温/冷藏/冷冻
  remark TEXT,                                  -- 备注
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引以优化查询性能
CREATE INDEX IF NOT EXISTS idx_orders_external_code ON public.orders(external_code);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_sender_name ON public.orders(sender_name);
CREATE INDEX IF NOT EXISTS idx_orders_receiver_name ON public.orders(receiver_name);

-- 启用行级安全策略（Row Level Security）
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- 创建策略：允许所有读取操作
CREATE POLICY "允许公开读取" ON public.orders FOR SELECT USING (true);

-- 创建策略：允许通过API插入数据
CREATE POLICY "允许API插入" ON public.orders FOR INSERT WITH CHECK (true);

-- 创建更新时间戳触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language plpgsql;

-- 应用触发器
DROP TRIGGER IF EXISTS update_orders_updated_at ON public.orders;
CREATE TRIGGER update_orders_updated_at
    BEFORE UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 添加注释
COMMENT ON TABLE public.orders IS '运单导入系统 - 运单数据表';
COMMENT ON COLUMN public.orders.id IS '主键ID';
COMMENT ON COLUMN public.orders.external_code IS '外部系统订单唯一编号，用于去重';
COMMENT ON COLUMN public.orders.sender_name IS '寄件人姓名';
COMMENT ON COLUMN public.orders.sender_phone IS '寄件人联系方式（手机号）';
COMMENT ON COLUMN public.orders.sender_address IS '寄件人完整地址';
COMMENT ON COLUMN public.orders.receiver_name IS '收货人姓名';
COMMENT ON COLUMN public.orders.receiver_phone IS '收货人联系方式（手机号）';
COMMENT ON COLUMN public.orders.receiver_address IS '收货人完整地址';
COMMENT ON COLUMN public.orders.weight IS '货物重量（单位：kg）';
COMMENT ON COLUMN public.orders.quantity IS '包裹数量';
COMMENT ON COLUMN public.orders.temperature IS '温层要求：常温/冷藏/冷冻';
COMMENT ON COLUMN public.orders.remark IS '附加说明或备注信息';

-- 验证表是否创建成功
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'orders' 
ORDER BY ordinal_position;

-- ==============================================
-- V2 版本表结构（万能导入 V2）
-- ==============================================

-- 创建 V2 解析规则表
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

-- 创建 V2 订单表
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

-- V2 表索引
CREATE INDEX IF NOT EXISTS idx_v2_rules_name ON public.v2_parse_rules(name);
CREATE INDEX IF NOT EXISTS idx_v2_rules_updated_at ON public.v2_parse_rules(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_v2_order_items_external_code ON public.v2_order_items(external_code);
CREATE INDEX IF NOT EXISTS idx_v2_order_items_created_at ON public.v2_order_items(created_at DESC);

-- V2 表行级安全策略
ALTER TABLE public.v2_parse_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v2_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "V2规则允许公开读取" ON public.v2_parse_rules FOR SELECT USING (true);
CREATE POLICY "V2规则允许插入" ON public.v2_parse_rules FOR INSERT WITH CHECK (true);
CREATE POLICY "V2规则允许更新" ON public.v2_parse_rules FOR UPDATE USING (true);
CREATE POLICY "V2规则允许删除" ON public.v2_parse_rules FOR DELETE USING (true);

CREATE POLICY "V2订单允许公开读取" ON public.v2_order_items FOR SELECT USING (true);
CREATE POLICY "V2订单允许插入" ON public.v2_order_items FOR INSERT WITH CHECK (true);

-- V2 规则表更新时间戳触发器
DROP TRIGGER IF EXISTS update_v2_rules_updated_at ON public.v2_parse_rules;
CREATE TRIGGER update_v2_rules_updated_at
    BEFORE UPDATE ON public.v2_parse_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 验证 V2 表是否创建成功
SELECT 'v2_parse_rules' AS table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'v2_parse_rules'
UNION ALL
SELECT 'v2_order_items' AS table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'v2_order_items'
ORDER BY table_name, ordinal_position;