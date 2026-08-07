-- ============================================================
-- V3 异步事件驱动导入链路 - 数据库建表脚本
-- 在 Supabase SQL Editor 中执行，可重复执行
-- ============================================================

-- 扩展：gen_random_uuid() 需要 pg_crypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. SKU 主数据表（压测校验基准）
-- ============================================================
CREATE TABLE IF NOT EXISTS v3_sku_master (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_code    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  spec        TEXT DEFAULT '',
  unit        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_sku_code ON v3_sku_master(sku_code);

-- ============================================================
-- 2. 导入任务主表
-- ============================================================
CREATE TABLE IF NOT EXISTS v3_import_tasks (
  id              TEXT PRIMARY KEY,
  file_name       TEXT NOT NULL DEFAULT '',
  file_url        TEXT NOT NULL DEFAULT '',
  rule_id         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',
  total_rows      INTEGER DEFAULT 0,
  processed_rows  INTEGER DEFAULT 0,
  success_rows    INTEGER DEFAULT 0,
  failed_rows     INTEGER DEFAULT 0,
  total_batches   INTEGER DEFAULT 0,
  completed_batches INTEGER DEFAULT 0,
  trace_id        TEXT NOT NULL DEFAULT '',
  degraded        BOOLEAN DEFAULT FALSE,
  degraded_rows   JSONB DEFAULT '[]',
  error_summary   JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_v3_tasks_status_created ON v3_import_tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v3_tasks_trace ON v3_import_tasks(trace_id);

-- ============================================================
-- 3. 处理单元状态表（批次追踪）
-- ============================================================
CREATE TABLE IF NOT EXISTS v3_import_task_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       TEXT NOT NULL REFERENCES v3_import_tasks(id) ON DELETE CASCADE,
  unit_id       TEXT NOT NULL,
  batch_index   INTEGER NOT NULL,
  start_row     INTEGER NOT NULL,
  end_row       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  retry_count   INTEGER DEFAULT 0,
  locked_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  UNIQUE(task_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_v3_batches_task ON v3_import_task_batches(task_id, batch_index);
CREATE INDEX IF NOT EXISTS idx_v3_batches_status ON v3_import_task_batches(status);

-- ============================================================
-- 4. 行级错误明细表
-- ============================================================
CREATE TABLE IF NOT EXISTS v3_import_task_errors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       TEXT NOT NULL REFERENCES v3_import_tasks(id) ON DELETE CASCADE,
  unit_id       TEXT NOT NULL DEFAULT '',
  batch_index   INTEGER NOT NULL DEFAULT 0,
  row_number    INTEGER NOT NULL,
  field_name    TEXT DEFAULT '',
  raw_value     TEXT DEFAULT '',
  error_code    TEXT NOT NULL,
  error_reason  TEXT NOT NULL DEFAULT '',
  trace_id      TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_errors_task_unit ON v3_import_task_errors(task_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_v3_errors_code ON v3_import_task_errors(error_code);
CREATE INDEX IF NOT EXISTS idx_v3_errors_task_row ON v3_import_task_errors(task_id, row_number);

-- ============================================================
-- 5. Transactional Outbox 表
-- ============================================================
CREATE TABLE IF NOT EXISTS v3_event_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id  TEXT NOT NULL DEFAULT '',
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',
  retry_count   INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_v3_outbox_status_retry ON v3_event_outbox(status, next_retry_at);

-- ============================================================
-- 6. 批次性能日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS v3_batch_performance_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             TEXT NOT NULL DEFAULT '',
  unit_id             TEXT NOT NULL DEFAULT '',
  batch_index         INTEGER NOT NULL DEFAULT 0,
  parse_duration_ms   INTEGER DEFAULT 0,
  rule_duration_ms    INTEGER DEFAULT 0,
  validate_duration_ms INTEGER DEFAULT 0,
  insert_duration_ms  INTEGER DEFAULT 0,
  total_duration_ms   INTEGER DEFAULT 0,
  rows_processed      INTEGER DEFAULT 0,
  rows_success        INTEGER DEFAULT 0,
  rows_failed         INTEGER DEFAULT 0,
  status              TEXT DEFAULT '',
  trace_id            TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_perf_task_unit ON v3_batch_performance_log(task_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_v3_perf_created ON v3_batch_performance_log(created_at DESC);

-- ============================================================
-- 7. 链路时间线事件表
-- ============================================================
CREATE TABLE IF NOT EXISTS v3_trace_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id      TEXT NOT NULL DEFAULT '',
  task_id       TEXT DEFAULT '',
  unit_id       TEXT DEFAULT '',
  event_name    TEXT NOT NULL,
  event_status  TEXT DEFAULT '',
  message       TEXT DEFAULT '',
  occurred_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_trace_id_time ON v3_trace_events(trace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_v3_trace_task ON v3_trace_events(task_id);

-- ============================================================
-- 8. 运单去重唯一索引（复用 V2 的 v2_order_items 表）
-- ============================================================
-- 基于业务键 external_code + sku_code 去重
CREATE UNIQUE INDEX IF NOT EXISTS idx_v3_waybill_dedup
  ON v2_order_items(external_code, sku_code)
  WHERE external_code IS NOT NULL AND external_code != '';

-- ============================================================
-- RPC 函数：原子更新任务进度（幂等保证）
-- ============================================================
CREATE OR REPLACE FUNCTION atomic_update_progress(
  p_task_id TEXT,
  p_unit_id TEXT,
  p_success INTEGER,
  p_failed INTEGER
) RETURNS VOID AS $$
BEGIN
  -- 只有 batch 从 processing → completed 时才更新进度（幂等）
  UPDATE v3_import_task_batches
    SET status = 'completed', completed_at = NOW()
    WHERE task_id = p_task_id AND unit_id = p_unit_id AND status = 'processing';

  IF FOUND THEN
    UPDATE v3_import_tasks
      SET processed_rows = processed_rows + p_success + p_failed,
          success_rows = success_rows + p_success,
          failed_rows = failed_rows + p_failed,
          completed_batches = completed_batches + 1,
          status = CASE
            WHEN completed_batches + 1 >= total_batches THEN
              CASE WHEN failed_rows + p_failed > 0 THEN 'partial_success' ELSE 'completed' END
            ELSE 'processing'
          END,
          completed_at = CASE
            WHEN completed_batches + 1 >= total_batches THEN NOW()
            ELSE completed_at
          END
      WHERE id = p_task_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC 函数：锁定批次（抢占式）
-- ============================================================
CREATE OR REPLACE FUNCTION lock_batch(
  p_task_id TEXT,
  p_unit_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE v3_import_task_batches
    SET status = 'processing', locked_at = NOW()
    WHERE task_id = p_task_id AND unit_id = p_unit_id AND status = 'pending';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC 函数：恢复卡死批次（超过 5 分钟未完成的 processing 批次）
-- ============================================================
CREATE OR REPLACE FUNCTION recover_stuck_batches(
  p_timeout_minutes INTEGER DEFAULT 5
) RETURNS TABLE(recovered_task_id TEXT, recovered_unit_id TEXT) AS $$
BEGIN
  RETURN QUERY
    UPDATE v3_import_task_batches
      SET status = 'pending', locked_at = NULL, retry_count = retry_count + 1
      WHERE status = 'processing'
        AND locked_at < NOW() - (p_timeout_minutes || ' minutes')::INTERVAL
      RETURNING task_id, unit_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RLS 策略（开发环境开放，生产环境应收紧）
-- ============================================================
ALTER TABLE v3_sku_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE v3_import_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE v3_import_task_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE v3_import_task_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE v3_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE v3_batch_performance_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE v3_trace_events ENABLE ROW LEVEL SECURITY;

-- 通用策略创建函数
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['v3_sku_master','v3_import_tasks','v3_import_task_batches','v3_import_task_errors','v3_event_outbox','v3_batch_performance_log','v3_trace_events'])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "v3_%s_read" ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS "v3_%s_write" ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY "v3_%s_read" ON %I FOR SELECT USING (true)', tbl, tbl);
    EXECUTE format('CREATE POLICY "v3_%s_write" ON %I FOR ALL USING (true) WITH CHECK (true)', tbl, tbl);
  END LOOP;
END $$;
