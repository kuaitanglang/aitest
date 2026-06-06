/**
 * V2 功能验证脚本 — 模拟各场景数据结构测试解析能力
 */
import * as XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 简化版 parseWithRule（与 preview-rule/route.ts 一致）
function parseWithRule(rawRows, rule) {
  const headerRowIndex = Math.max(0, rule.dataStartRow ?? 0);
  const headerCell = (rawRows[headerRowIndex] || []).map((h) => String(h || '').trim());
  const colIndexByHeader = new Map();
  headerCell.forEach((h, idx) => { if (h) colIndexByHeader.set(h, idx); });

  const endRow = rule.dataEndRow !== undefined ? Math.min(rule.dataEndRow, rawRows.length) : rawRows.length;
  const footerTargets = {};

  for (let i = Math.max(0, rawRows.length - 30); i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;
    for (const ext of rule.extractionRules || []) {
      if (ext.type !== 'footer') continue;
      const line = row.map((c) => String(c || '')).join(' ');
      if (ext.pattern && line.includes(ext.pattern)) {
        if (ext.regex) {
          const m = line.match(new RegExp(ext.regex));
          if (m && m[1]) footerTargets[ext.targetField] = (footerTargets[ext.targetField] || '') + m[1];
        }
      }
    }
  }

  const parsedItems = [];
  const startRow = headerRowIndex + 1;

  for (let i = startRow; i < endRow; i++) {
    const row = rawRows[i];
    if (!row || row.length === 0) continue;
    if (row.every((cell) => !String(cell || '').trim())) continue;
    const line = row.map((c) => String(c || '')).join(' ');
    if (rule.skipPatterns?.some((p) => line.includes(p))) continue;

    const item = { externalCode: '', storeName: '', receiverName: '', receiverPhone: '', receiverAddress: '', skuCode: '', skuName: '', skuQuantity: '' };
    Object.assign(item, footerTargets);

    let hasAnyData = false;
    for (const mapping of rule.fieldMappings || []) {
      const source = String(mapping.sourceColumn || '').trim();
      if (!source) continue;
      let colIndex = colIndexByHeader.get(source);
      if (colIndex === undefined) continue;
      let rawValue = String(row[colIndex] || '').trim();
      item[mapping.targetField] = rawValue;
      if (rawValue) hasAnyData = true;
    }
    if (hasAnyData) parsedItems.push(item);
  }
  return parsedItems;
}

const results = [];

function test(name, fn) {
  try {
    const r = fn();
    results.push({ name, pass: r.pass, detail: r.detail });
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
  }
}

// 1. 标准表格
test('标准 Excel 表格解析', () => {
  const rows = [
    ['配送单号', 'SKU编码', 'SKU名称', '数量', '收货门店'],
    ['PS001', 'A001', '商品A', '10', '银泰店'],
    ['PS001', 'A002', '商品B', '5', '银泰店'],
  ];
  const rule = {
    dataStartRow: 0,
    skipPatterns: ['合计'],
    fieldMappings: [
      { sourceColumn: '配送单号', targetField: 'externalCode' },
      { sourceColumn: 'SKU编码', targetField: 'skuCode' },
      { sourceColumn: 'SKU名称', targetField: 'skuName' },
      { sourceColumn: '数量', targetField: 'skuQuantity' },
      { sourceColumn: '收货门店', targetField: 'storeName' },
    ],
    extractionRules: [],
  };
  const items = parseWithRule(rows, rule);
  return { pass: items.length === 2 && items[0].skuCode === 'A001', detail: `解析 ${items.length} 条` };
});

// 2. 尾部信息提取
test('尾部收货人信息提取', () => {
  const rows = [
    ['SKU编码', 'SKU名称', '数量'],
    ['A001', '商品A', '10'],
    ['合计', '', '10'],
    ['', '', ''],
    ['收件人：张三  电话：13800138001  地址：北京市朝阳区'],
  ];
  const rule = {
    dataStartRow: 0,
    skipPatterns: ['合计'],
    fieldMappings: [
      { sourceColumn: 'SKU编码', targetField: 'skuCode' },
      { sourceColumn: 'SKU名称', targetField: 'skuName' },
      { sourceColumn: '数量', targetField: 'skuQuantity' },
    ],
    extractionRules: [
      { type: 'footer', pattern: '收件人', targetField: 'receiverName', regex: '收件人[：:]\\s*([\\u4e00-\\u9fa5]{2,8})' },
      { type: 'footer', pattern: '电话', targetField: 'receiverPhone', regex: '(1[3-9]\\d{9})' },
    ],
  };
  const items = parseWithRule(rows, rule);
  return { pass: items.length === 1 && items[0].receiverName === '张三' && items[0].receiverPhone === '13800138001', detail: JSON.stringify(items[0]) };
});

// 3. 矩阵转置 — 引擎是否支持？
test('矩阵转置（SKU×门店）', () => {
  const hasTranspose = existsSync(join(root, 'v2/page.tsx')) &&
    readFileSync(join(root, 'v2/page.tsx'), 'utf8').includes('transposeConfig');
  const usedInParser = readFileSync(join(root, 'v2/page.tsx'), 'utf8').match(/transposeConfig/g)?.length > 1;
  return { pass: false, detail: `类型定义存在 transposeConfig，但解析逻辑${usedInParser ? '有' : '未'}使用 — 矩阵转置未实现` };
});

// 4. 卡片式
test('卡片式拆分', () => {
  const code = readFileSync(join(root, 'v2/page.tsx'), 'utf8');
  const hasCardLogic = code.includes("ext.type !== 'card'") || code.includes("type === 'card'");
  return { pass: false, detail: hasCardLogic ? '有部分 card 类型定义' : 'card 类型提取规则未在解析引擎中实现' };
});

// 5. 复合单元格
test('复合单元格拆分', () => {
  const code = readFileSync(join(root, 'v2/page.tsx'), 'utf8');
  const hasComposite = code.includes('composite') && code.includes('mappingType');
  const implementsComposite = code.includes('compositeFields') || code.includes('splitComposite');
  return { pass: false, detail: hasComposite && !implementsComposite ? 'composite 映射类型在 UI 中存在但未在解析逻辑中实现' : '未实现' };
});

// 6. Word/PDF 解析
test('Word/PDF 真实解析', () => {
  const parser = readFileSync(join(root, 'v2/lib/parser.ts'), 'utf8');
  const usesTextOnly = parser.includes('readAsText') && !parser.includes('mammoth') && !parser.includes('pdf-parse') && !parser.includes('pdfjs');
  return { pass: !usesTextOnly, detail: usesTextOnly ? 'Word/PDF 使用 readAsText 读取二进制文件，无法正确解析' : 'OK' };
});

// 7. 数据库存储
test('服务端数据库持久化', () => {
  const db = readFileSync(join(root, 'v2/lib/database.ts'), 'utf8');
  const usesLocalStorage = db.includes('localStorage');
  return { pass: !usesLocalStorage, detail: usesLocalStorage ? 'V2 规则和订单均存储在 localStorage，未接入 Supabase/Neon' : 'OK' };
});

// 8. 虚拟列表/性能
test('大列表虚拟滚动', () => {
  const page = readFileSync(join(root, 'v2/page.tsx'), 'utf8');
  const hasVirtual = page.includes('virtual') || page.includes('VirtualList') || page.includes('react-window');
  const rendersAll = page.includes('pagination={false}') && page.includes('dataSource={items}');
  return { pass: hasVirtual, detail: rendersAll ? '预览表格 pagination=false，1000行将全部渲染，无虚拟列表' : 'OK' };
});

// 9. 提交进度条
test('提交上传进度条', () => {
  const page = readFileSync(join(root, 'v2/page.tsx'), 'utf8');
  const hasSubmitProgress = page.includes('submitProgress') || (page.match(/handleSubmit[\s\S]{0,800}Progress/g)?.length > 0);
  return { pass: hasSubmitProgress, detail: hasSubmitProgress ? '有提交进度' : '提交时无 Progress 进度条' };
});

// 10. 导入进度（条数/总数）
test('导入进度显示条数/总数', () => {
  const page = readFileSync(join(root, 'v2/page.tsx'), 'utf8');
  const hasCountProgress = page.includes('current') && page.includes('total') && page.includes('uploadProgress');
  return { pass: hasCountProgress, detail: hasCountProgress ? '有条数进度' : '仅有百分比进度，无 当前条数/总条数' };
});

// 11. API 试解析
test('preview-rule API 可达性', async () => {
  try {
    const res = await fetch('http://localhost:3333/api/v2/ai/preview-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: [['SKU编码', '数量'], ['A001', '5']],
        rule: { dataStartRow: 0, fieldMappings: [{ sourceColumn: 'SKU编码', targetField: 'skuCode' }, { sourceColumn: '数量', targetField: 'skuQuantity' }], extractionRules: [], skipPatterns: [] },
      }),
    });
    const data = await res.json();
    return { pass: data.ok && data.items.length === 1, detail: `API 返回 ${data.items?.length} 条` };
  } catch (e) {
    return { pass: false, detail: `API 不可达: ${e.message}` };
  }
});

// Run async tests
for (const t of results) {
  console.log(`${t.pass ? '✅' : '❌'} ${t.name}: ${t.detail}`);
}

// Async test
try {
  const res = await fetch('http://localhost:3333/api/v2/ai/preview-rule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: [['SKU编码', '数量'], ['A001', '5']],
      rule: { dataStartRow: 0, fieldMappings: [{ sourceColumn: 'SKU编码', targetField: 'skuCode' }, { sourceColumn: '数量', targetField: 'skuQuantity' }], extractionRules: [], skipPatterns: [] },
    }),
  });
  const data = await res.json();
  console.log(`${data.ok ? '✅' : '❌'} preview-rule API: ${data.ok ? `解析 ${data.items.length} 条` : data.error}`);
} catch (e) {
  console.log(`❌ preview-rule API: ${e.message}`);
}

// Generate 1000 row excel and test parse speed
const bigRows = [['外部编码', 'SKU编码', 'SKU名称', '数量', '收货门店']];
for (let i = 1; i <= 1000; i++) {
  bigRows.push([`ORD${i}`, `SKU${i}`, `商品${i}`, String(i % 50 + 1), `门店${i % 10}`]);
}
const rule = {
  dataStartRow: 0, skipPatterns: ['合计'],
  fieldMappings: [
    { sourceColumn: '外部编码', targetField: 'externalCode' },
    { sourceColumn: 'SKU编码', targetField: 'skuCode' },
    { sourceColumn: 'SKU名称', targetField: 'skuName' },
    { sourceColumn: '数量', targetField: 'skuQuantity' },
    { sourceColumn: '收货门店', targetField: 'storeName' },
  ],
  extractionRules: [],
};
const t0 = performance.now();
const bigItems = parseWithRule(bigRows, rule);
const t1 = performance.now();
console.log(`${bigItems.length === 1000 ? '✅' : '❌'} 1000行解析性能: ${(t1 - t0).toFixed(1)}ms, 解析 ${bigItems.length} 条`);

const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log(`\n汇总: ${passed} 通过 / ${failed} 未通过 (共 ${results.length} 项静态检查)`);
