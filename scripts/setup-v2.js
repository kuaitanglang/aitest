/**
 * V2 数据库一键建表工具
 * 使用方法：在 Next.js 服务端运行，或直接在终端执行：node scripts/setup-v2.js
 */
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ 请在 .env.local 中配置 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

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
CREATE POLICY "v2_rules_all" ON v2_parse_rules FOR ALL USING (true) WITH CHECK (true);

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
CREATE POLICY "v2_items_all" ON v2_order_items FOR ALL USING (true) WITH CHECK (true);
`;

async function main() {
  console.log('⏳ 正在创建 V2 数据库表...\n');

  // 用 service_role key 建表（需要用户在 Supabase 后台获取）
  // 如果 anon key 权限不够，请换成 service_role key
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey;

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
    db: { schema: 'public' },
  });

  try {
    // 尝试通过 REST API 执行 SQL（需要 service_role key）
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'params=single-object',
      },
      body: JSON.stringify({ query: SQL }),
    });

    if (response.ok) {
      console.log('✅ V2 表创建成功！');
    } else {
      const text = await response.text();
      // 如果 REST API 不行，尝试用 rpc 方式
      console.log('⚠️ REST API 方式失败，尝试 rpc 方式...');
      
      const { error } = await supabaseAdmin.rpc('exec_sql', { sql: SQL });
      
      if (error) {
        console.log('\n❌ 自动创建失败。请手动在 Supabase SQL Editor 执行以下 SQL：');
        console.log('\n' + '='.repeat(60));
        console.log(SQL);
        console.log('='.repeat(60));
        console.log(`\n📋 打开链接: ${supabaseUrl.replace('.supabase.co', '.supabase.co/project/default/sql/new')}`);
        console.log('📋 粘贴上面的 SQL → 点击「Run」即可');
      } else {
        console.log('✅ V2 表创建成功！');
      }
    }
  } catch (err) {
    console.log('\n❌ 自动创建失败。请手动在 Supabase SQL Editor 执行以下 SQL：');
    console.log('\n' + '='.repeat(60));
    console.log(SQL);
    console.log('='.repeat(60));
    console.log(`\n📋 打开链接: ${supabaseUrl.replace('.supabase.co', '.supabase.co/project/default/sql/new')}`);
  }
}

main().catch(console.error);
