-- ============================================================
-- Bootstrap: 创建 exec_sql / exec_sql_query RPC 函数
-- ============================================================
-- 用途：
--   后续 SQL 部署脚本（scripts/deploy-sql.ts）通过 service_role key
--   调用 exec_sql RPC 函数来执行任意 SQL，避免手动复制粘贴到 Dashboard。
--
-- 部署方式：
--   在 Supabase Dashboard → SQL Editor 中手动执行一次本文件（仅此一次需要手动）。
--   执行后，即可用以下命令部署其他 SQL 文件：
--     npx tsx scripts/deploy-sql.ts database/v3-rpc-optimize.sql
--
-- 安全说明：
--   exec_sql / exec_sql_query 使用 SECURITY DEFINER，以 postgres 权限执行，
--   仅授予 service_role，anon / authenticated 无法调用，确保安全。
-- ============================================================

-- ============================================================
-- exec_sql: 执行非查询 SQL（DDL / DML），返回 {ok: true/false}
-- ============================================================
-- 用于部署建表语句、创建函数、索引等 DDL，以及 INSERT/UPDATE/DELETE 等 DML。
-- 返回 JSONB: {"ok": true} 或 {"ok": false, "error": "...", "sqlstate": "..."}
CREATE OR REPLACE FUNCTION exec_sql(p_sql TEXT) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE p_sql;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- ============================================================
-- exec_sql_query: 执行查询 SQL，返回结果集（JSON 数组）
-- ============================================================
-- 用于 SELECT 查询，返回 {"ok": true, "data": [...]} 或错误。
-- data 为行对象的 JSON 数组，空结果返回 []。
CREATE OR REPLACE FUNCTION exec_sql_query(p_sql TEXT) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  EXECUTE 'SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (' || p_sql || ') t' INTO result;
  RETURN jsonb_build_object('ok', true, 'data', result);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- ============================================================
-- 权限收敛：仅 service_role 可调用
-- ============================================================
-- exec_sql / exec_sql_query 能执行任意 SQL，权限极大，
-- 必须严格限制为 service_role，禁止 anon / authenticated 调用。
REVOKE EXECUTE ON FUNCTION exec_sql(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION exec_sql(TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION exec_sql_query(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION exec_sql_query(TEXT) TO service_role;

-- ============================================================
-- 验证
-- ============================================================
-- 执行以下查询确认部署成功：
--   SELECT exec_sql('SELECT 1');
--   应返回 {"ok": true}
--
--   SELECT exec_sql_query('SELECT 1 AS test');
--   应返回 {"ok": true, "data": [{"test": 1}]}
