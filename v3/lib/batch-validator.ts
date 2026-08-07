import { supabase, supabaseAdmin } from '@/lib/supabase';
import type { OrderItem } from '@/v2/types';
import { SYSTEM_FIELDS } from '@/v2/types';
import { ERROR_CODES } from '../types';

/**
 * 批量 SKU 校验：一次 IN 查询全部 SKU 编码
 * 禁止逐行查询
 */
export async function batchValidateSkus(
  items: OrderItem[],
  degraded: boolean
): Promise<{ validItems: OrderItem[]; errors: Array<{ item: OrderItem; code: string; reason: string }>; degraded: boolean }> {
  // 收集所有 SKU 编码
  const skuCodes = [...new Set(items.map(i => i.skuCode?.trim()).filter(Boolean))];

  if (skuCodes.length === 0) {
    return { validItems: items, errors: [], degraded: false };
  }

  // 降级模式：跳过 SKU 主数据校验
  if (degraded) {
    console.warn('[validator] 降级模式：跳过 SKU 主数据校验');
    return { validItems: items, errors: [], degraded: true };
  }

  // 批量查询 SKU 主数据（设置 3 秒超时）
  let validSkuSet: Set<string>;
  try {
    validSkuSet = await querySkuWithTimeout(skuCodes, 3000);
  } catch (err) {
    // 查询超时或失败，触发降级
    console.error('[validator] SKU 查询失败，进入降级模式:', err);
    return { validItems: items, errors: [], degraded: true };
  }

  // 分离有效和无效
  const validItems: OrderItem[] = [];
  const errors: Array<{ item: OrderItem; code: string; reason: string }> = [];

  for (const item of items) {
    const skuCode = item.skuCode?.trim();
    if (skuCode && !validSkuSet.has(skuCode)) {
      errors.push({
        item,
        code: ERROR_CODES.SKU_NOT_FOUND,
        reason: `SKU 编码 "${skuCode}" 在主数据中不存在`,
      });
    } else {
      validItems.push(item);
    }
  }

  return { validItems, errors, degraded: false };
}

/**
 * 带超时的 SKU 查询
 */
async function querySkuWithTimeout(skuCodes: string[], timeoutMs: number): Promise<Set<string>> {
  if (!supabaseAdmin) {
    // 无数据库时，假设全部有效（用于本地开发）
    return new Set(skuCodes);
  }

  // 分片查询（每片最多 500 个 SKU，避免 IN 查询过长）
  const CHUNK = 500;
  const validSet = new Set<string>();

  const queryPromise = (async () => {
    for (let i = 0; i < skuCodes.length; i += CHUNK) {
      const chunk = skuCodes.slice(i, i + CHUNK);
      const { data, error } = await supabaseAdmin
        .from('v3_sku_master')
        .select('sku_code')
        .in('sku_code', chunk);
      if (error) throw error;
      (data || []).forEach(r => validSet.add(r.sku_code));
    }
    return validSet;
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`SKU 查询超时 (${timeoutMs}ms)`)), timeoutMs);
  });

  return Promise.race([queryPromise, timeoutPromise]);
}

/**
 * 本地格式校验（不依赖数据库）
 *
 * 必填字段定义完全基于 V2 的 SYSTEM_FIELDS（types/index.ts 第 114-130 行）
 * 不硬编码字段名，而是遍历 SYSTEM_FIELDS 中 required=true 的字段
 */
export function localValidate(
  items: OrderItem[],
  existingCodes: Set<string> = new Set()
): { validItems: OrderItem[]; errors: Array<{ item: OrderItem; field: string; rawValue: string; code: string; reason: string }> } {
  const validItems: OrderItem[] = [];
  const errors: Array<{ item: OrderItem; field: string; rawValue: string; code: string; reason: string }> = [];
  const seenExternalCodes = new Set<string>(existingCodes);

  // 从 V2 SYSTEM_FIELDS 提取必填字段和标签（不硬编码）
  const requiredFields = SYSTEM_FIELDS.filter(f => f.required);

  for (const item of items) {
    let hasError = false;

    // E002: 必填字段缺失（基于 V2 SYSTEM_FIELDS 的 required 定义）
    for (const field of requiredFields) {
      const val = (item as unknown as Record<string, string>)[field.key]?.trim();
      if (!val) {
        errors.push({
          item,
          field: field.key,
          rawValue: '',
          code: ERROR_CODES.REQUIRED_MISSING,
          reason: `${field.label}为必填字段`,
        });
        hasError = true;
      }
    }

    // E004: 数量不是正数（V2 SYSTEM_FIELDS 中 skuQuantity 字段）
    const skuQuantityField = SYSTEM_FIELDS.find(f => f.key === 'skuQuantity');
    if (skuQuantityField) {
      const qtyVal = (item as unknown as Record<string, string>)[skuQuantityField.key]?.trim();
      if (qtyVal) {
        const qty = Number(qtyVal);
        if (isNaN(qty) || qty <= 0) {
          errors.push({
            item,
            field: skuQuantityField.key,
            rawValue: qtyVal,
            code: ERROR_CODES.QUANTITY_INVALID,
            reason: `数量 "${qtyVal}" 不是正数`,
          });
          hasError = true;
        }
      }
    }

    // E003: 电话格式错误（非必填，但有值时校验格式）
    const phoneField = SYSTEM_FIELDS.find(f => f.key === 'receiverPhone');
    if (phoneField) {
      const phoneVal = (item as unknown as Record<string, string>)[phoneField.key]?.trim();
      if (phoneVal && !/^1[3-9]\d{9}$/.test(phoneVal)) {
        errors.push({
          item,
          field: phoneField.key,
          rawValue: phoneVal,
          code: ERROR_CODES.PHONE_FORMAT,
          reason: `电话 "${phoneVal}" 格式错误，应为 11 位手机号`,
        });
        hasError = true;
      }
    }

    // E005: 外部编码重复
    const extCodeField = SYSTEM_FIELDS.find(f => f.key === 'externalCode');
    if (extCodeField) {
      const extCode = (item as unknown as Record<string, string>)[extCodeField.key]?.trim();
      if (extCode) {
        if (seenExternalCodes.has(extCode)) {
          errors.push({
            item,
            field: extCodeField.key,
            rawValue: extCode,
            code: ERROR_CODES.EXTERNAL_CODE_DUPLICATE,
            reason: `外部编码 "${extCode}" 在当前批次中重复`,
          });
          hasError = true;
        } else {
          seenExternalCodes.add(extCode);
        }
      }
    }

    if (!hasError) {
      validItems.push(item);
    }
  }

  return { validItems, errors };
}
