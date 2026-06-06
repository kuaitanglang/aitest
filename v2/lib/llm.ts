import { OrderItem, OrderField, FieldError, SYSTEM_FIELDS, FIELD_ALIASES, ParseRule, FieldMapping, ExtractionRule } from '../types';

/** 单条数据校验（必填、格式、A/B 组二选一） */
export function validateOrderItem(item: OrderItem): { errors: FieldError[] } {
  const errors: FieldError[] = [];

  if (!item.skuCode?.trim()) {
    errors.push({ field: 'skuCode', message: 'SKU物品编码不能为空' });
  }

  if (!item.skuName?.trim()) {
    errors.push({ field: 'skuName', message: 'SKU物品名称不能为空' });
  }

  const qty = item.skuQuantity?.trim();
  if (!qty) {
    errors.push({ field: 'skuQuantity', message: 'SKU发货数量不能为空' });
  } else {
    const num = Number(qty);
    if (Number.isNaN(num)) {
      errors.push({ field: 'skuQuantity', message: 'SKU发货数量必须是数字' });
    } else if (num <= 0) {
      errors.push({ field: 'skuQuantity', message: 'SKU发货数量必须是正数' });
    }
  }

  const hasStore = item.storeName?.trim().length > 0;
  const hasReceiverA = item.receiverName?.trim().length > 0;
  const hasReceiverB = item.receiverPhone?.trim().length > 0;
  const hasReceiverC = item.receiverAddress?.trim().length > 0;
  const hasReceiverGroup = hasReceiverA && hasReceiverB && hasReceiverC;

  if (!hasStore && !hasReceiverGroup) {
    errors.push({
      field: 'storeName',
      message: '请填写收货门店，或填写完整的收件人姓名/电话/地址（二选一）',
    });
  }

  if (hasReceiverA || hasReceiverB || hasReceiverC) {
    if (!hasReceiverA) {
      errors.push({ field: 'receiverName', message: '收件人姓名未填写（收件人模式需三字段齐全）' });
    }
    if (!hasReceiverB) {
      errors.push({ field: 'receiverPhone', message: '收件人电话未填写（收件人模式需三字段齐全）' });
    }
    if (!hasReceiverC) {
      errors.push({ field: 'receiverAddress', message: '收件人地址未填写（收件人模式需三字段齐全）' });
    }
  }

  if (item.receiverPhone?.trim()) {
    const phone = item.receiverPhone.replace(/[\s\-]/g, '');
    if (!/^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/.test(phone)) {
      errors.push({ field: 'receiverPhone', message: '电话格式不正确' });
    }
  }

  return { errors };
}

/** 批量校验 + 重复检测 */
export function validateAllItems(items: OrderItem[]): {
  itemsWithErrors: OrderItem[];
  errorList: { row: number; field: string; fieldLabel: string; message: string }[];
  duplicateMap: Map<string, number[]>;
  hasAnyError: boolean;
} {
  const errorList: { row: number; field: string; fieldLabel: string; message: string }[] = [];
  const duplicateMap = new Map<string, number[]>();
  const itemsWithErrors: OrderItem[] = [];

  items.forEach((item, idx) => {
    const { errors } = validateOrderItem(item);
    const rowErrors = [...errors];

    if (item.externalCode?.trim()) {
      const key = item.externalCode.trim();
      if (!duplicateMap.has(key)) duplicateMap.set(key, []);
      duplicateMap.get(key)!.push(idx);
    }

    itemsWithErrors.push({ ...item, errors: rowErrors });
  });

  duplicateMap.forEach((rowIndexes, code) => {
    if (rowIndexes.length > 1) {
      rowIndexes.forEach((rowIdx) => {
        const otherRows = rowIndexes.filter((r) => r !== rowIdx).map((r) => `第${r + 1}行`).join('、');
        const existing = itemsWithErrors[rowIdx].errors;
        itemsWithErrors[rowIdx] = {
          ...itemsWithErrors[rowIdx],
          errors: [...existing, { field: 'externalCode', message: `外部编码重复（${otherRows}）` }],
        };
      });
    }
  });

  itemsWithErrors.forEach((item, idx) => {
    item.errors.forEach((e) => {
      const label = SYSTEM_FIELDS.find((f) => f.key === e.field)?.label || e.field;
      errorList.push({ row: idx + 1, field: e.field, fieldLabel: label, message: e.message });
    });
  });

  return { itemsWithErrors, errorList, duplicateMap, hasAnyError: errorList.length > 0 };
}

/** 尝试在某个字段（string）中匹配手机号 */
function looksLikePhone(s: string): boolean {
  return /\d{7,}/.test(s) || /\d{3,4}-\d{7,8}/.test(s);
}
function looksLikeQty(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s.trim());
}
function looksLikeAddress(s: string): boolean {
  return /省|市|区|县|街道|路|号|镇|乡|村|address/i.test(s);
}
function looksLikeSkuCode(s: string): boolean {
  return /^[A-Za-z0-9\-_]{4,}$/.test(s.trim()) || /SKU|编码|编号|Code/i.test(s);
}

/** 计算某个列的全部样本值的"可能语义"评分 */
function scoreSamplesForField(samples: string[], field: OrderField): number {
  const nonEmpty = samples.filter((s) => s && s.trim()).slice(0, 20);
  if (nonEmpty.length === 0) return 0;

  let score = 0;
  const s = nonEmpty.join(' ');

  switch (field) {
    case 'skuCode':
      if (nonEmpty.every(looksLikeSkuCode)) score += 2;
      if (/SKU|编码|编号|货号|code/i.test(s)) score += 1;
      break;
    case 'skuName':
      if (/[\u4e00-\u9fa5]{2,}/.test(s)) score += 1.5;
      if (nonEmpty.some((x) => x.length >= 3)) score += 0.5;
      break;
    case 'skuQuantity':
      if (nonEmpty.every(looksLikeQty)) score += 2.5;
      break;
    case 'skuSpec':
      if (/规格|型号|尺寸|大小|ml|g|kg|L|XL/i.test(s)) score += 1.5;
      break;
    case 'receiverName':
      if (nonEmpty.every((x) => x.length >= 2 && x.length <= 8 && /[\u4e00-\u9fa5]/.test(x))) score += 1.5;
      break;
    case 'receiverPhone':
      if (nonEmpty.every(looksLikePhone)) score += 2.5;
      break;
    case 'receiverAddress':
      if (nonEmpty.every(looksLikeAddress)) score += 2;
      break;
    case 'storeName':
      if (/门店|店|分店|超市|仓库|机构|单位/i.test(s)) score += 1.5;
      break;
    case 'externalCode':
      if (/单号|编号|订单|配送|PO|no/i.test(s)) score += 1;
      if (nonEmpty.every((x) => x.length <= 40)) score += 0.5;
      break;
    case 'remark':
      score += 0.2;
      break;
  }
  return score / nonEmpty.length;
}

/** 用"别名表"做列名匹配 */
function matchHeaderToField(header: string): { field: OrderField | null; score: number } {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return { field: null, score: 0 };

  let bestField: OrderField | null = null;
  let bestScore = 0;

  (Object.keys(FIELD_ALIASES) as OrderField[]).forEach((field) => {
    const aliases = FIELD_ALIASES[field];
    for (const alias of aliases) {
      const a = alias.toLowerCase();
      if (h === a) {
        if (1.0 > bestScore) { bestField = field; bestScore = 1.0; }
        break;
      }
      if (h.includes(a) || a.includes(h)) {
        const sc = Math.min(a.length, h.length) / Math.max(a.length, h.length);
        if (sc > bestScore) { bestField = field; bestScore = sc; }
      }
    }
  });
  return { field: bestField, score: bestScore };
}

/** 基于完整的二维数据 + 表头行做 AI 推荐规则 */
export function analyzeRawData(
  rows: any[][],
  headerRowIndex: number = 0
): { rule: ParseRule; sampleHeaders: string[]; columnSuggestions: { colIdx: number; header: string; suggestedField: OrderField | null; confidence: number }[] } {
  const headers = (rows[headerRowIndex] || []).map((h: any) => String(h || '').trim());
  const dataRows = rows.slice(headerRowIndex + 1).filter((r) => r && r.some((c: any) => String(c || '').trim()));

  // 对每个列：先用表头匹配，再考虑样本值特征
  const suggestions: { colIdx: number; header: string; suggestedField: OrderField | null; confidence: number }[] = [];
  const usedFields = new Set<OrderField>();

  headers.forEach((header, idx) => {
    const samples = dataRows.slice(0, 30).map((r) => String(r[idx] || ''));
    const headerMatch = matchHeaderToField(header);

    // 如果表头能匹配到 >= 0.5 分，直接用
    let field: OrderField | null = headerMatch.field;
    let conf = headerMatch.score;

    if (!field || conf < 0.4) {
      // 表头匹配失败：基于样本值做"盲推断"（对 skuQuantity / receiverPhone 等非常有效）
      let bestField: OrderField | null = null;
      let bestScore = 0;
      (Object.keys(FIELD_ALIASES) as OrderField[]).forEach((f) => {
        const sc = scoreSamplesForField(samples, f);
        if (sc > bestScore) {
          bestField = f;
          bestScore = sc;
        }
      });
      if (bestField && bestScore > 0.3) {
        field = bestField;
        conf = bestScore * 0.8;
      }
    }

    if (field && conf >= 0.45 && !usedFields.has(field)) {
      usedFields.add(field);
      suggestions.push({ colIdx: idx, header, suggestedField: field, confidence: Math.round(conf * 100) / 100 });
    } else {
      suggestions.push({ colIdx: idx, header, suggestedField: null, confidence: 0 });
    }
  });

  // 检查尾部是否有"xxx 电话：xx"这样的 footer 信息行（非表格内容）
  const footerRules: ExtractionRule[] = [];
  const bottomRows = rows.slice(Math.max(0, rows.length - 15));
  bottomRows.forEach((row) => {
    const line = row.map((c: any) => String(c || '')).join(' ');
    const phoneMatch = line.match(/(?:电话|联系方式|手机|Tel)[^0-9]{0,6}(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})/i);
    if (phoneMatch && !footerRules.some((r) => r.targetField === 'receiverPhone')) {
      footerRules.push({
        id: `ext_footer_phone_${Date.now()}`,
        name: '底部收件人电话',
        type: 'footer',
        pattern: phoneMatch[1],
        targetField: 'receiverPhone',
        regex: '(1[3-9]\\d{9}|0\\d{2,3}-?\\d{7,8})',
      });
    }
    const addrMatch = line.match(/(?:地址|收货地址|地址[:：])\s*(.{5,})/i);
    if (addrMatch && !footerRules.some((r) => r.targetField === 'receiverAddress')) {
      footerRules.push({
        id: `ext_footer_addr_${Date.now()}`,
        name: '底部收件人地址',
        type: 'footer',
        pattern: addrMatch[1].slice(0, 30),
        targetField: 'receiverAddress',
        regex: '地址[:：]?\\s*(.{5,})',
      });
    }
    const nameMatch = line.match(/(?:收件人|收货人|姓名)[^0-9]{0,6}([\u4e00-\u9fa5]{2,8})/);
    if (nameMatch && !footerRules.some((r) => r.targetField === 'receiverName')) {
      footerRules.push({
        id: `ext_footer_name_${Date.now()}`,
        name: '底部收件人姓名',
        type: 'footer',
        pattern: nameMatch[1],
        targetField: 'receiverName',
        regex: '收件人[:：]?\\s*([\u4e00-\u9fa5]{2,8})',
      });
    }
  });

  const mappings: FieldMapping[] = suggestions
    .filter((s) => s.suggestedField)
    .map((s) => ({
      sourceColumn: s.header || `第${s.colIdx + 1}列`,
      targetField: s.suggestedField!,
      mappingType: 'direct' as const,
    }));

  const confidence =
    mappings.length === 0
      ? 0
      : Math.round((suggestions.filter((s) => s.suggestedField).reduce((a, b) => a + b.confidence, 0) /
          Math.max(SYSTEM_FIELDS.length, 1)) * 100) / 100;

  return {
    sampleHeaders: headers,
    columnSuggestions: suggestions,
    rule: {
      id: `rule_ai_${Date.now()}`,
      name: `AI生成规则_${new Date().toLocaleString()}`,
      description: `AI 分析文件后自动生成的解析规则：共 ${headers.length} 列，已智能匹配 ${mappings.length} 个字段。`,
      fileType: 'excel',
      headerSkipRows: headerRowIndex + 1,
      footerSkipRows: 0,
      dataStartRow: headerRowIndex + 1,
      skipPatterns: ['合计', '总计', '小计', '合计行', '共计', 'total', 'Total', 'TOTAL'],
      aggregateBy: '',
      extractionRules: footerRules,
      fieldMappings: mappings,
      aiGenerated: true,
      aiConfidence: confidence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

/** 仅基于表头的简单规则生成（兼容旧接口） */
export function analyzeHeaders(headers: string[]): ParseRule {
  const mappings: FieldMapping[] = [];

  headers.forEach((header) => {
    const h = String(header || '').trim().toLowerCase();
    if (!h) return;

    const found = (Object.keys(FIELD_ALIASES) as OrderField[]).find((field) => {
      const aliases = FIELD_ALIASES[field];
      return aliases.some((alias) => h === alias.toLowerCase() || h.includes(alias.toLowerCase()));
    });

    if (found) {
      mappings.push({
        sourceColumn: String(header),
        targetField: found,
        mappingType: 'direct',
      });
    }
  });

  return {
    id: `rule_ai_${Date.now()}`,
    name: `AI生成规则_${new Date().toLocaleString()}`,
    description: '基于表头关键字的解析规则（建议用 analyzeRawData 获得更精准的 AI 推荐）',
    fileType: 'excel',
    headerSkipRows: 1,
    footerSkipRows: 0,
    dataStartRow: 1,
    skipPatterns: ['合计', '总计', '小计', '合计行', '共计', 'total'],
    extractionRules: [],
    fieldMappings: mappings,
    aiGenerated: true,
    aiConfidence: mappings.length > 3 ? 0.85 : 0.6,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
