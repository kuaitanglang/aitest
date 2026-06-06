/**
 * 将 demo 预设规则写入 Supabase v2_parse_rules 表
 * 用法: npx tsx scripts/seed-v2-rules.ts
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import type { ParseRule } from '../v2/types';

function loadEnv() {
  try {
    const raw = readFileSync('.env.local', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    }
  } catch { /* ignore */ }
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('请配置 .env.local 中的 Supabase 环境变量');
  process.exit(1);
}

const sb = createClient(url, key);

const rules: ParseRule[] = [
  {
    id: 'preset_limingtun', name: '黎明屯配送发货单', description: '干扰头部+尾部横向收货信息', fileType: 'excel',
    parseMode: 'table', dataStartRow: 3, dataEndRow: 6, headerSkipRows: 3, footerSkipRows: 5,
    skipPatterns: ['合计', '总计'], fieldMappings: [
      { sourceColumn: '物品编码', targetField: 'skuCode', mappingType: 'direct' },
      { sourceColumn: '物品名称', targetField: 'skuName', mappingType: 'direct' },
      { sourceColumn: '原订货数量', targetField: 'skuQuantity', mappingType: 'direct' },
      { sourceColumn: '规格型号', targetField: 'skuSpec', mappingType: 'direct' },
      { sourceColumn: '单据号', targetField: 'externalCode', mappingType: 'direct' },
      { sourceColumn: '收货人', targetField: 'receiverName', mappingType: 'direct' },
      { sourceColumn: '收货电话', targetField: 'receiverPhone', mappingType: 'direct' },
      { sourceColumn: '收货机构', targetField: 'storeName', mappingType: 'direct' },
    ], extractionRules: [], aiGenerated: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: 'preset_hunan', name: '湖南仓发货明细', description: '标准表格+每行收货信息', fileType: 'excel',
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
    ], extractionRules: [], aiGenerated: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: 'preset_multisheet', name: '多门店分Sheet出库单', description: '多Sheet独立解析+底部收货信息', fileType: 'excel',
    parseMode: 'table', multiSheet: true, dataStartRow: 3, headerSkipRows: 3, footerSkipRows: 5,
    skipPatterns: ['合计', '制单人'], fieldMappings: [
      { sourceColumn: '物品编码', targetField: 'skuCode', mappingType: 'direct' },
      { sourceColumn: '物品名称', targetField: 'skuName', mappingType: 'direct' },
      { sourceColumn: '出库数量', targetField: 'skuQuantity', mappingType: 'direct' },
      { sourceColumn: '规格型号', targetField: 'skuSpec', mappingType: 'direct' },
      { sourceColumn: '联系电话', targetField: 'receiverPhone', mappingType: 'direct' },
      { sourceColumn: '收货地址', targetField: 'receiverAddress', mappingType: 'direct' },
    ], extractionRules: [], aiGenerated: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: 'preset_card', name: '门店调拨单-卡片式', description: '卡片边界识别', fileType: 'excel',
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
    ], extractionRules: [], aiGenerated: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
];

async function main() {
for (const rule of rules) {
  const row = {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    file_type: rule.fileType,
    parse_mode: rule.parseMode,
    multi_sheet: rule.multiSheet || false,
    card_marker: rule.cardMarker || null,
    header_skip_rows: rule.headerSkipRows,
    footer_skip_rows: rule.footerSkipRows,
    data_start_row: rule.dataStartRow,
    data_end_row: rule.dataEndRow ?? null,
    skip_patterns: rule.skipPatterns,
    aggregate_by: rule.aggregateBy || null,
    transpose_config: rule.transposeConfig ?? null,
    extraction_rules: rule.extractionRules,
    field_mappings: rule.fieldMappings,
    ai_generated: rule.aiGenerated,
    ai_confidence: rule.aiConfidence ?? null,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  };
  const { error } = await sb.from('v2_parse_rules').upsert(row);
  console.log(error ? `❌ ${rule.name}: ${error.message}` : `✅ ${rule.name}`);
}
}

main().catch(console.error);
