-- V2 表增量迁移（不影响 V1 orders 表）
-- 在 Supabase SQL Editor 中执行

ALTER TABLE public.v2_parse_rules ADD COLUMN IF NOT EXISTS parse_mode TEXT DEFAULT 'table';
ALTER TABLE public.v2_parse_rules ADD COLUMN IF NOT EXISTS multi_sheet BOOLEAN DEFAULT false;
ALTER TABLE public.v2_parse_rules ADD COLUMN IF NOT EXISTS card_marker TEXT;

-- 若 V2 表尚未创建，请执行 database/schema.sql 中 V2 部分
