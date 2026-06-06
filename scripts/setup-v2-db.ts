/**
 * 创建 V2 Supabase 表
 * 支持三种方式（按优先级）：
 * 1. SUPABASE_ACCESS_TOKEN + Management API
 * 2. DATABASE_URL 或 SUPABASE_DB_PASSWORD 直连 PostgreSQL
 * 3. 命令行参数传入数据库密码
 */
import { readFileSync } from 'fs';
import path from 'path';
import pg from 'pg';

const PROJECT_REF = 'otfzlxuvpsnhaxxqdbvw';

function loadEnvLocal() {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    } catch { /* ignore */ }
  }
}

loadEnvLocal();

const password = process.argv[2] || process.env.SUPABASE_DB_PASSWORD;
const databaseUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

const sql = readFileSync(path.join('database', 'v2-setup.sql'), 'utf8');

async function viaManagementApi(): Promise<boolean> {
  if (!accessToken) return false;
  console.log('使用 Supabase Management API 执行 SQL...');
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${text.slice(0, 500)}`);
  }
  console.log('✅ Management API 执行成功');
  if (text.trim()) console.log(text.slice(0, 300));
  return true;
}

async function viaPostgres(): Promise<boolean> {
  const hosts = [
    databaseUrl,
    password && `postgresql://postgres:${encodeURIComponent(password)}@db.${PROJECT_REF}.supabase.co:5432/postgres`,
    password && `postgresql://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
    password && `postgresql://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`,
    password && `postgresql://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@aws-0-ap-east-1.pooler.supabase.com:6543/postgres`,
  ].filter(Boolean) as string[];

  if (!hosts.length) return false;

  let lastErr: Error | null = null;
  for (const connectionString of hosts) {
    const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
    try {
      console.log(`尝试连接: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
      await client.connect();
      console.log('连接成功，执行 V2 建表 SQL...');
      await client.query(sql);
      const verify = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('v2_parse_rules', 'v2_order_items')
        ORDER BY table_name
      `);
      console.log('✅ 建表完成:', verify.rows.map((r) => r.table_name).join(', '));
      await client.end();
      return true;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      try { await client.end(); } catch { /* ignore */ }
    }
  }
  if (lastErr) throw lastErr;
  return false;
}

async function main() {
  if (await viaManagementApi().catch((e) => { console.warn(String(e.message)); return false; })) return;
  if (await viaPostgres().catch((e) => { console.warn(String(e.message)); return false; })) return;

  console.error('\n❌ 无法连接数据库。请任选一种方式配置后重试：\n');
  console.error('方式1 - Access Token（推荐）:');
  console.error('  1. 打开 https://supabase.com/dashboard/account/tokens 创建 Access Token');
  console.error('  2. 在 .env.local 添加: SUPABASE_ACCESS_TOKEN=sbp_xxx');
  console.error('  3. 运行: npm run setup:v2-db\n');
  console.error('方式2 - 数据库密码:');
  console.error('  1. Supabase Dashboard → Project Settings → Database → Database password');
  console.error('  2. 运行: npm run setup:v2-db -- <你的数据库密码>\n');
  process.exit(1);
}

main().catch((err) => {
  console.error('❌ 失败:', err.message);
  process.exit(1);
});
