#!/usr/bin/env tsx
/**
 * SQL 一键部署脚本（基于 service_role key）
 *
 * 用法:
 *   npx tsx scripts/deploy-sql.ts <sql-file>
 *
 * 示例:
 *   # 首次：在 Supabase Dashboard 手动执行 database/_bootstrap-exec-sql.sql
 *   # 之后即可用本脚本部署其他 SQL 文件：
 *   npx tsx scripts/deploy-sql.ts database/v3-rpc-optimize.sql
 *   npx tsx scripts/deploy-sql.ts database/v3-setup.sql
 *
 * 部署模式（自动选择，优先 RPC 模式）:
 *   1. RPC 模式（默认优先）—— 基于 service_role key 调用 exec_sql RPC 函数
 *      需要: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *      前提: database/_bootstrap-exec-sql.sql 已手动执行一次（创建 exec_sql 函数）
 *   2. 直连模式（备选 / 用于 bootstrap）—— 基于 pg 直连 PostgreSQL
 *      需要: DATABASE_URL（PostgreSQL 连接字符串）
 *
 * 环境变量从 .env.local 自动加载
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// 环境变量加载（从 .env.local）
// ============================================================

function loadEnv(): void {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) {
    console.warn('[deploy] 未找到 .env.local，将使用系统环境变量');
    return;
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // 去除引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 不覆盖已存在的系统环境变量
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ============================================================
// SQL 语句分割器
// ============================================================

/**
 * 将 SQL 文件内容按分号分割为独立语句
 *
 * 处理以下边界情况：
 *   - 单引号字符串内的分号（'...;...'）
 *   - 双引号标识符内的分号（"...;..."）
 *   - dollar-quoted 函数体（$$ ... $$ 或 $func$ ... $func$）
 *   - 行注释（-- ...）和块注释（slash-star ... star-slash）内的分号
 */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inDollarQuote = false;
  let dollarTag = '';
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] || '';
    const rest = sql.slice(i);

    // --- 行注释 ---
    if (!inSingleQuote && !inDoubleQuote && !inDollarQuote && !inBlockComment && !inLineComment && ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      i++;
      continue;
    }
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      current += ch;
      i++;
      continue;
    }

    // --- 块注释 ---
    if (!inSingleQuote && !inDoubleQuote && !inDollarQuote && !inBlockComment && !inLineComment && ch === '/' && next === '*') {
      inBlockComment = true;
      current += '/*';
      i += 2;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        current += '*/';
        i += 2;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // --- Dollar-quoted 字符串（PostgreSQL 函数体）---
    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && !inLineComment) {
      const dollarMatch = rest.match(/^\$[a-zA-Z0-9_]*\$/);
      if (dollarMatch) {
        const tag = dollarMatch[0];
        if (!inDollarQuote) {
          inDollarQuote = true;
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        } else if (tag === dollarTag) {
          inDollarQuote = false;
          dollarTag = '';
          current += tag;
          i += tag.length;
          continue;
        }
      }
    }
    if (inDollarQuote) {
      current += ch;
      i++;
      continue;
    }

    // --- 单引号字符串 ---
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }

    // --- 双引号标识符 ---
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    // --- 分号 = 语句结束 ---
    if (ch === ';' && !inSingleQuote && !inDoubleQuote && !inDollarQuote && !inBlockComment && !inLineComment) {
      current += ch;
      const stmt = current.trim();
      if (stmt.length > 1 && stmt !== ';') {
        statements.push(stmt);
      }
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // 处理最后一条语句（无分号结尾）
  const last = current.trim();
  if (last.length > 1 && last !== ';') {
    statements.push(last);
  }

  return statements;
}

// ============================================================
// RPC 模式：通过 service_role key 调用 exec_sql
// ============================================================

async function deployViaRpc(statements: string[]): Promise<boolean> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.log('[deploy] RPC 模式: 缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
    return false;
  }

  console.log(`[deploy] RPC 模式: ${SUPABASE_URL}`);
  console.log(`[deploy] 共 ${statements.length} 条 SQL 语句\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.slice(0, 80).replace(/\n/g, ' ').replace(/\s+/g, ' ');
    process.stdout.write(`  [${i + 1}/${statements.length}] ${preview}... `);

    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ p_sql: stmt }),
      });

      const data = await resp.json() as { ok?: boolean; error?: string; message?: string };

      if (data && data.ok === true) {
        console.log('✓');
        success++;
      } else {
        const errMsg = data?.error || data?.message || JSON.stringify(data);
        console.log(`✗ ${errMsg}`);
        // exec_sql 函数不存在 → 提示 bootstrap 并回退
        if (/does not exist|Could not find the function|PGRST202/i.test(errMsg)) {
          console.log('\n[deploy] exec_sql 函数不存在，请先在 Supabase Dashboard 手动执行:');
          console.log('  database/_bootstrap-exec-sql.sql');
          console.log('[deploy] 尝试切换到直连模式...\n');
          return false;
        }
        failed++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${msg}`);
      failed++;
    }
  }

  console.log(`\n[deploy] RPC 模式完成: 成功 ${success}, 失败 ${failed}`);
  return failed === 0;
}

// ============================================================
// 直连模式：通过 pg 直连 PostgreSQL
// ============================================================

async function deployViaPg(statements: string[]): Promise<boolean> {
  if (!DATABASE_URL) {
    console.log('[deploy] 直连模式: 缺少 DATABASE_URL');
    return false;
  }

  // 脱敏连接字符串中的密码
  const maskedUrl = DATABASE_URL.replace(/:[^:@/]+@/, ':****@');
  console.log(`[deploy] 直连模式: ${maskedUrl}`);
  console.log(`[deploy] 共 ${statements.length} 条 SQL 语句\n`);

  let pg: typeof import('pg');
  try {
    pg = require('pg');
  } catch {
    console.log('[deploy] pg 模块未安装，请运行: npm install pg');
    return false;
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    console.log('[deploy] 数据库连接成功\n');

    let success = 0;
    let failed = 0;

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const preview = stmt.slice(0, 80).replace(/\n/g, ' ').replace(/\s+/g, ' ');
      process.stdout.write(`  [${i + 1}/${statements.length}] ${preview}... `);

      try {
        await client.query(stmt);
        console.log('✓');
        success++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`✗ ${msg}`);
        failed++;
      }
    }

    console.log(`\n[deploy] 直连模式完成: 成功 ${success}, 失败 ${failed}`);
    return failed === 0;
  } finally {
    await client.end();
  }
}

// ============================================================
// 主函数
// ============================================================

async function main(): Promise<void> {
  const sqlFile = process.argv[2];

  if (!sqlFile) {
    console.log('用法: npx tsx scripts/deploy-sql.ts <sql-file>');
    console.log('示例: npx tsx scripts/deploy-sql.ts database/v3-rpc-optimize.sql');
    console.log('      npx tsx scripts/deploy-sql.ts database/_bootstrap-exec-sql.sql');
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), sqlFile);
  if (!fs.existsSync(filePath)) {
    console.error(`[deploy] 文件不存在: ${filePath}`);
    process.exit(1);
  }

  console.log('========================================');
  console.log('  SQL 一键部署工具');
  console.log('========================================');
  console.log(`文件: ${filePath}\n`);

  const sqlContent = fs.readFileSync(filePath, 'utf-8');
  const statements = splitSql(sqlContent);

  console.log(`解析出 ${statements.length} 条 SQL 语句\n`);

  if (statements.length === 0) {
    console.log('[deploy] 无 SQL 语句可执行');
    process.exit(0);
  }

  // 优先 RPC 模式，失败回退直连模式
  let ok = false;

  if (SUPABASE_URL && SERVICE_ROLE_KEY) {
    ok = await deployViaRpc(statements);
  }

  if (!ok && DATABASE_URL) {
    ok = await deployViaPg(statements);
  }

  if (!ok && !SUPABASE_URL && !SERVICE_ROLE_KEY && !DATABASE_URL) {
    console.log('\n[deploy] 错误: 未配置任何部署方式');
    console.log('[deploy] 请在 .env.local 中配置以下任一组合:');
    console.log('  RPC 模式:   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
    console.log('  直连模式:   DATABASE_URL');
    process.exit(1);
  }

  if (ok) {
    console.log('\n[deploy] 部署成功 ✓');
  } else {
    console.log('\n[deploy] 部署失败 ✗');
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[deploy] 异常:', msg);
  process.exit(1);
});
