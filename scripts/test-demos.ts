import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { executeRuleEngine } from '../v2/lib/engine';
import type { ParseRule } from '../v2/types';

const demoDir = 'C:/Users/xiangzhian/Downloads/AI考试附件/demos';

const PRESET_RULES: Record<string, ParseRule> = {
  limingtun: {
    id: 'demo_limingtun', name: '黎明屯配送发货单', description: '', fileType: 'excel',
    parseMode: 'table', dataStartRow: 3, dataEndRow: 6, headerSkipRows: 3, footerSkipRows: 5,
    skipPatterns: ['合计'], fieldMappings: [
      { sourceColumn: '物品编码', targetField: 'skuCode', mappingType: 'direct' },
      { sourceColumn: '物品名称', targetField: 'skuName', mappingType: 'direct' },
      { sourceColumn: '原订货数量', targetField: 'skuQuantity', mappingType: 'direct' },
      { sourceColumn: '规格型号', targetField: 'skuSpec', mappingType: 'direct' },
      { sourceColumn: '单据号', targetField: 'externalCode', mappingType: 'direct' },
      { sourceColumn: '收货人', targetField: 'receiverName', mappingType: 'direct' },
      { sourceColumn: '收货电话', targetField: 'receiverPhone', mappingType: 'direct' },
      { sourceColumn: '收货机构', targetField: 'storeName', mappingType: 'direct' },
    ], extractionRules: [], aiGenerated: false, createdAt: '', updatedAt: '',
  },
  hunan: {
    id: 'demo_hunan', name: '湖南仓', description: '', fileType: 'excel',
    parseMode: 'table', dataStartRow: 1, headerSkipRows: 1, footerSkipRows: 0,
    skipPatterns: ['合计'], fieldMappings: [
      { sourceColumn: '配送单号', targetField: 'externalCode', mappingType: 'direct' },
      { sourceColumn: '收货机构', targetField: 'storeName', mappingType: 'direct' },
      { sourceColumn: '物品编码*', targetField: 'skuCode', mappingType: 'direct' },
      { sourceColumn: '物品名称', targetField: 'skuName', mappingType: 'direct' },
      { sourceColumn: '发货数量*', targetField: 'skuQuantity', mappingType: 'direct' },
      { sourceColumn: '规格型号', targetField: 'skuSpec', mappingType: 'direct' },
      { sourceColumn: '收货人', targetField: 'receiverName', mappingType: 'direct' },
      { sourceColumn: '收货电话', targetField: 'receiverPhone', mappingType: 'direct' },
      { sourceColumn: '收货地址', targetField: 'receiverAddress', mappingType: 'direct' },
    ], extractionRules: [], aiGenerated: false, createdAt: '', updatedAt: '',
  },
  multisheet: {
    id: 'demo_multisheet', name: '多Sheet', description: '', fileType: 'excel',
    parseMode: 'table', multiSheet: true, dataStartRow: 3, headerSkipRows: 3, footerSkipRows: 5,
    skipPatterns: ['合计', '制单人'], fieldMappings: [
      { sourceColumn: '物品编码', targetField: 'skuCode', mappingType: 'direct' },
      { sourceColumn: '物品名称', targetField: 'skuName', mappingType: 'direct' },
      { sourceColumn: '出库数量', targetField: 'skuQuantity', mappingType: 'direct' },
      { sourceColumn: '规格型号', targetField: 'skuSpec', mappingType: 'direct' },
      { sourceColumn: '联系电话', targetField: 'receiverPhone', mappingType: 'direct' },
      { sourceColumn: '收货地址', targetField: 'receiverAddress', mappingType: 'direct' },
    ], extractionRules: [], aiGenerated: false, createdAt: '', updatedAt: '',
  },
  card: {
    id: 'demo_card', name: '卡片式', description: '', fileType: 'excel',
    parseMode: 'card', cardMarker: '▶', dataStartRow: 0, headerSkipRows: 0, footerSkipRows: 0,
    skipPatterns: ['合计'], fieldMappings: [
      { sourceColumn: '调入门店', targetField: 'storeName', mappingType: 'direct' },
      { sourceColumn: '收货人', targetField: 'receiverName', mappingType: 'direct' },
      { sourceColumn: '电话', targetField: 'receiverPhone', mappingType: 'direct' },
      { sourceColumn: '收货地址', targetField: 'receiverAddress', mappingType: 'direct' },
      { sourceColumn: '物品编码', targetField: 'skuCode', mappingType: 'direct' },
      { sourceColumn: '物品名称', targetField: 'skuName', mappingType: 'direct' },
      { sourceColumn: '数量', targetField: 'skuQuantity', mappingType: 'direct' },
      { sourceColumn: '规格', targetField: 'skuSpec', mappingType: 'direct' },
    ], extractionRules: [], aiGenerated: false, createdAt: '', updatedAt: '',
  },
};

function loadExcel(filePath: string) {
  const wb = XLSX.read(fs.readFileSync(filePath));
  const sheetData: Record<string, unknown[][]> = {};
  for (const sn of wb.SheetNames) {
    sheetData[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' }) as unknown[][];
  }
  return { sheetData, data: Object.values(sheetData).flat() as unknown[][] };
}

const tests = [
  { file: '12.25海口龙湖天街-配送发货单PS2512220005001(1).xlsx', rule: PRESET_RULES.limingtun, min: 2 },
  { file: '湖南仓.xlsx', rule: PRESET_RULES.hunan, min: 100 },
  { file: '多门店分Sheet出库单.xlsx', rule: PRESET_RULES.multisheet, min: 10 },
  { file: '门店调拨单-卡片式.xlsx', rule: PRESET_RULES.card, min: 6 },
];

for (const t of tests) {
  const fp = path.join(demoDir, t.file);
  if (!fs.existsSync(fp)) { console.log(`⏭ ${t.file}`); continue; }
  const { sheetData, data } = loadExcel(fp);
  const items = executeRuleEngine({
    rows: data,
    sheetData: t.rule.multiSheet ? sheetData : undefined,
    rule: t.rule,
  });
  console.log(`${items.length >= t.min ? '✅' : '❌'} ${t.file}: ${items.length} 条`, items[0] ? `| ${items[0].skuName} | ${items[0].storeName || items[0].receiverName}` : '');
}
