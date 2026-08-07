/**
 * V2 数据库层 — 优先使用 Supabase，表不存在时自动降级为本地 JSON 文件存储
 */
import { supabase } from '@/lib/supabase';
import type { ParseRule, OrderItem } from '@/v2/types';

const isServer = typeof window === 'undefined';

/* ========== JSON 文件降级存储（开发环境可用） ========== */
function getStorageDir(): string {
  return require('path').join(process.cwd(), '.v2-data');
}

function readJson<T>(name: string): T[] {
  try {
    const fs = require('fs');
    const p = require('path').join(getStorageDir(), `${name}.json`);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return []; }
}

function writeJson<T>(name: string, data: T[]): void {
  try {
    const fs = require('fs');
    const p = require('path').join(getStorageDir(), `${name}.json`);
    if (!fs.existsSync(getStorageDir())) fs.mkdirSync(getStorageDir(), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

let _supabaseAvailable: boolean | null = null;

async function checkSupabase(): Promise<boolean> {
  if (_supabaseAvailable !== null) return _supabaseAvailable;
  if (!supabase) { _supabaseAvailable = false; return false; }
  try {
    const { error } = await supabase.from('v2_parse_rules').select('id', { count: 'exact', head: true }).limit(1);
    _supabaseAvailable = !error;
    if (error) console.warn('[v2-db] Supabase 表不可用，降级为本地文件存储：', error.message);
    return _supabaseAvailable;
  } catch {
    _supabaseAvailable = false;
    return false;
  }
}

/* ========== 规则 CRUD ========== */

export async function dbGetAllRules(): Promise<ParseRule[]> {
  if (await checkSupabase()) {
    const { data, error } = await supabase!.from('v2_parse_rules').select('*').order('updated_at', { ascending: false });
    if (!error) return (data || []).map(ruleFromDb);
  }
  return readJson<ParseRule>('rules');
}

export async function dbGetRuleById(id: string): Promise<ParseRule | null> {
  if (await checkSupabase()) {
    const { data, error } = await supabase!.from('v2_parse_rules').select('*').eq('id', id).maybeSingle();
    if (!error && data) return ruleFromDb(data);
  }
  const rules = readJson<ParseRule>('rules');
  return rules.find((r) => r.id === id) || null;
}

export async function dbSaveRule(rule: ParseRule): Promise<void> {
  if (await checkSupabase()) {
    const payload = ruleToDb(rule);
    const existing = await dbGetRuleById(rule.id);
    if (existing) {
      const { error } = await supabase!.from('v2_parse_rules').update(payload).eq('id', rule.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase!.from('v2_parse_rules').insert({ ...payload, created_at: rule.createdAt || new Date().toISOString() });
      if (error) throw new Error(error.message);
    }
    return;
  }
  const rules = readJson<ParseRule>('rules');
  const idx = rules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) rules[idx] = rule;
  else rules.push(rule);
  writeJson('rules', rules);
}

export async function dbDeleteRule(id: string): Promise<void> {
  if (await checkSupabase()) {
    const { error } = await supabase!.from('v2_parse_rules').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const rules = readJson<ParseRule>('rules').filter((r) => r.id !== id);
  writeJson('rules', rules);
}

/* ========== 订单 CRUD ========== */

export async function dbGetOrders(
  page = 1, pageSize = 10, searchTerm = '', searchField = '',
  startDate = '', endDate = ''
): Promise<{ list: OrderItem[]; total: number }> {
  if (await checkSupabase()) {
    let query = supabase!.from('v2_order_items').select('*', { count: 'exact' });
    if (searchTerm) {
      const term = `%${searchTerm}%`;
      const field = searchField || 'externalCode';
      const colMap: Record<string, string> = { externalCode: 'external_code', receiverName: 'receiver_name', storeName: 'store_name', skuCode: 'sku_code', skuName: 'sku_name' };
      const col = colMap[field] || 'external_code';
      query = query.ilike(col, term);
    }
    if (startDate) query = query.gte('created_at', `${startDate}T00:00:00`);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59`);
    const from = (page - 1) * pageSize;
    const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);
    if (!error) return { list: (data || []).map(orderFromDb), total: count || 0 };
  }
  let items = readJson<OrderItem>('orders');
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    items = items.filter((i) =>
      i.externalCode.toLowerCase().includes(term) ||
      i.receiverName.toLowerCase().includes(term) ||
      i.storeName.toLowerCase().includes(term) ||
      i.skuCode.toLowerCase().includes(term) ||
      i.skuName.toLowerCase().includes(term)
    );
  }
  const total = items.length;
  const list = items.slice((page - 1) * pageSize, page * pageSize);
  return { list, total };
}

export async function dbSaveOrderItems(items: OrderItem[]): Promise<{ success: number; failed: number; duplicates: number }> {
  console.log(`[dbSaveOrderItems] 总条数: ${items.length}, 有errors: ${items.filter(i => i.errors?.length).length}, 无externalCode: ${items.filter(i => !i.externalCode?.trim()).length}`);

  if (await checkSupabase()) {
    // 批量查重：一次查询所有 external_code，而非逐条查询
    const validItems = items.filter((item) => !item.errors?.length).map((item) => {
      // 若无 externalCode，自动生成唯一编码
      if (!item.externalCode?.trim()) {
        item.externalCode = `AUTO_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      }
      return item;
    });
    const codes = [...new Set(validItems.map((i) => i.externalCode!.trim()))];
    let dupCodes = new Set<string>();
    if (codes.length > 0) {
      const { data } = await supabase!.from('v2_order_items').select('external_code').in('external_code', codes);
      dupCodes = new Set((data || []).map((r) => String(r.external_code)));
    }

    // 过滤重复项和错误项
    const toInsert = validItems.filter((i) => !dupCodes.has(i.externalCode!.trim()));
    let success = 0, failed = 0;
    if (toInsert.length > 0) {
      // 批量插入：一次请求写入所有行
      const { error } = await supabase!.from('v2_order_items').insert(toInsert.map(orderToDb));
      if (error) {
        console.error('[dbSaveOrderItems] 批量插入失败:', error.message);
        failed = toInsert.length;
      } else {
        success = toInsert.length;
      }
    }
    const result = { success, failed, duplicates: validItems.length - toInsert.length };
    console.log(`[dbSaveOrderItems] Supabase结果:`, result);
    return result;
  }
  // 降级：本地文件（内存操作本身很快）
  let existing = readJson<OrderItem>('orders');
  let success = 0, failed = 0, duplicates = 0;
  for (const item of items) {
    if (item.errors?.length) { failed++; continue; }
    // 若无 externalCode，自动生成唯一编码
    if (!item.externalCode?.trim()) {
      item.externalCode = `AUTO_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    if (existing.some((e) => e.externalCode === item.externalCode.trim())) {
      duplicates++; continue;
    }
    existing.push({ ...item, createdAt: new Date().toISOString() });
    success++;
  }
  writeJson('orders', existing);
  const result = { success, failed, duplicates };
  console.log(`[dbSaveOrderItems] 本地文件结果:`, result);
  return result;
}

export async function dbCheckDuplicateExternalCodes(codes: string[]): Promise<Set<string>> {
  const unique = [...new Set(codes.filter(Boolean))];
  if (!unique.length) return new Set();
  if (await checkSupabase()) {
    const { data, error } = await supabase!.from('v2_order_items').select('external_code').in('external_code', unique);
    if (!error) return new Set((data || []).map((r) => String(r.external_code)));
  }
  const items = readJson<OrderItem>('orders');
  return new Set(items.filter((i) => unique.includes(i.externalCode)).map((i) => i.externalCode));
}

/* ========== 数据转换 ========== */

function ruleFromDb(row: Record<string, unknown>): ParseRule {
  return {
    id: String(row.id),
    name: String(row.name || ''),
    description: String(row.description || ''),
    fileType: (row.file_type as ParseRule['fileType']) || 'excel',
    parseMode: (row.parse_mode as ParseRule['parseMode']) || 'table',
    multiSheet: Boolean(row.multi_sheet),
    cardMarker: row.card_marker ? String(row.card_marker) : undefined,
    headerSkipRows: Number(row.header_skip_rows) || 0,
    footerSkipRows: Number(row.footer_skip_rows) || 0,
    dataStartRow: Number(row.data_start_row) || 0,
    dataEndRow: row.data_end_row != null ? Number(row.data_end_row) : undefined,
    skipPatterns: Array.isArray(row.skip_patterns) ? row.skip_patterns.map(String) : [],
    aggregateBy: row.aggregate_by ? String(row.aggregate_by) : '',
    transposeConfig: row.transpose_config as ParseRule['transposeConfig'],
    extractionRules: Array.isArray(row.extraction_rules) ? row.extraction_rules : [],
    fieldMappings: Array.isArray(row.field_mappings) ? row.field_mappings : [],
    aiGenerated: Boolean(row.ai_generated),
    aiConfidence: row.ai_confidence != null ? Number(row.ai_confidence) : undefined,
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function ruleToDb(rule: ParseRule): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    file_type: rule.fileType,
    parse_mode: rule.parseMode || 'table',
    multi_sheet: Boolean(rule.multiSheet),
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
    updated_at: new Date().toISOString(),
  };
}

function orderFromDb(row: Record<string, unknown>): OrderItem {
  return {
    id: String(row.id),
    externalCode: String(row.external_code || ''),
    storeName: String(row.store_name || ''),
    receiverName: String(row.receiver_name || ''),
    receiverPhone: String(row.receiver_phone || ''),
    receiverAddress: String(row.receiver_address || ''),
    skuCode: String(row.sku_code || ''),
    skuName: String(row.sku_name || ''),
    skuQuantity: String(row.sku_quantity || ''),
    skuSpec: String(row.sku_spec || ''),
    remark: String(row.remark || ''),
    errors: [],
    createdAt: String(row.created_at || ''),
  };
}

export function orderToDb(item: OrderItem): Record<string, unknown> {
  return {
    external_code: item.externalCode?.trim() || null,
    store_name: item.storeName?.trim() || null,
    receiver_name: item.receiverName?.trim() || null,
    receiver_phone: item.receiverPhone?.trim() || null,
    receiver_address: item.receiverAddress?.trim() || null,
    sku_code: item.skuCode?.trim() || '',
    sku_name: item.skuName?.trim() || '',
    sku_quantity: item.skuQuantity?.trim() || '',
    sku_spec: item.skuSpec?.trim() || null,
    remark: item.remark?.trim() || null,
  };
}
