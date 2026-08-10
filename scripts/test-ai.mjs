/**
 * 测试 AI 推荐的脚本
 * 用真实文件数据测试 /api/v2/ai/suggest-rule 接口
 * 运行: node scripts/test-ai.mjs
 */
import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = 'C:/Users/xiangzhian/Downloads/AI考试附件/demos';

const files = [
  '12.25海口龙湖天街-配送发货单PS2512220005001(1).xlsx',
  '多门店分Sheet出库单.xlsx',
  '欢乐牧场模板0430.xlsx',
  '湖南仓.xlsx',
  '门店调拨单-卡片式.xlsx',
];

async function parseExcel(path) {
  const buf = readFileSync(path);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  return { data, sheetName: wb.SheetNames[0], allSheets: wb.SheetNames };
}

async function testFile(fileName) {
  console.log(`\n========== 测试: ${fileName} ==========`);
  const filePath = join(DEMO_DIR, fileName);
  try {
    const { data, sheetName, allSheets } = await parseExcel(filePath);
    console.log(`  行数: ${data.length}, 列数: ${data[0]?.length || 0}, Sheet: ${sheetName}`);

    const body = {
      rows: data,
      headerRowIndex: 0,
      userHint: '',
      provider: {
        baseUrl: 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_KEY || '',
        model: 'deepseek-chat',
        temperature: 0.2,
        sampleRowLimit: 50,
      },
    };

    console.log(`  请求中... (样本 ${Math.min(50, data.length)} 行)`);
    const start = Date.now();
    const res = await fetch('http://localhost:3333/api/v2/ai/suggest-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - start;
    const result = await res.json();

    if (result.ok) {
      console.log(`  ✅ 成功 (${elapsed}ms)`);
      console.log(`  规则名: ${result.rule.name}`);
      console.log(`  字段映射: ${result.rule.fieldMappings.length} 个`);
    } else {
      console.log(`  ❌ 失败 (${elapsed}ms): ${result.error?.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`  ❌ 异常: ${err.message}`);
  }
}

async function main() {
  console.log('开始测试 AI 推荐接口...\n');
  for (const f of files) {
    await testFile(f);
  }
}

main().catch(console.error);
