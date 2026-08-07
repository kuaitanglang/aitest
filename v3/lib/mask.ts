/**
 * 敏感字段脱敏
 *
 * 用于错误明细中的 raw_value 字段，避免把手机号、姓名等
 * 敏感信息原样写入 v3_import_task_errors 表。
 *
 * 非敏感字段（如 skuCode、externalCode）原样返回，便于排查问题。
 */

/** 需要脱敏的字段 key（与 V2 SYSTEM_FIELDS 的 key 对应） */
const SENSITIVE_FIELDS = new Set([
  'receiverPhone',
  'receiverName',
  'senderPhone',
  'senderName',
  'receiverAddress',
]);

/**
 * 对敏感字段值进行脱敏
 *
 * @param value     原始值
 * @param fieldName 字段 key（用于判断是否需要脱敏）
 * @returns 脱敏后的值；非敏感字段原样返回
 */
export function maskSensitive(value: unknown, fieldName: string): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (!s) return '';

  // 非敏感字段原样返回
  if (!SENSITIVE_FIELDS.has(fieldName)) return s;

  // 手机号：保留前 3 后 4
  if (fieldName.toLowerCase().includes('phone')) {
    if (s.length <= 7) return s.replace(/\d/g, '*');
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  // 地址：保留前 6 个字符
  if (fieldName === 'receiverAddress') {
    if (s.length <= 6) return '*'.repeat(s.length);
    return s.slice(0, 6) + '****';
  }

  // 姓名：保留首字
  if (s.length <= 1) return s;
  return s[0] + '*'.repeat(Math.min(s.length - 1, 5));
}
