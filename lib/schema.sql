-- Supabase 数据库表结构
-- 运行此 SQL 在 Supabase SQL Editor 中创建 orders 表

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_code TEXT,
  sender_name TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  receiver_name TEXT NOT NULL,
  receiver_phone TEXT NOT NULL,
  receiver_address TEXT NOT NULL,
  weight FLOAT NOT NULL CHECK (weight > 0),
  quantity INT NOT NULL CHECK (quantity > 0),
  temperature TEXT NOT NULL CHECK (temperature IN ('常温', '冷藏', '冷冻')),
  remark TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_orders_external_code ON orders(external_code);
CREATE INDEX IF NOT EXISTS idx_orders_receiver_name ON orders(receiver_name);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- 启用 RLS (Row Level Security)
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- 创建策略允许公开读取
CREATE POLICY "Allow public read access" ON orders
  FOR SELECT USING (true);

-- 创建策略允许插入
CREATE POLICY "Allow insert access" ON orders
  FOR INSERT WITH CHECK (true);
