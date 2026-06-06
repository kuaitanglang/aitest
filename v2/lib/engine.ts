import {
  ParseRule,
  OrderItem,
  OrderField,
  ParseEngineInput,
  createEmptyOrderItem,
  TransposeConfig,
  FieldMapping,
} from '../types';

type Row = any[];

function setItemField(item: OrderItem, field: OrderField | string, value: string) {
  (item as unknown as Record<string, string>)[field] = value;
}

function getItemField(item: OrderItem, field: OrderField | string): string {
  return (item as unknown as Record<string, string>)[field] || '';
}

function cellStr(v: unknown): string {
  return String(v ?? '').trim();
}

function rowLine(row: Row): string {
  return row.map(cellStr).join(' ');
}

function isEmptyRow(row: Row): boolean {
  return !row || row.every((c) => !cellStr(c));
}

function shouldSkipRow(row: Row, skipPatterns: string[]): boolean {
  const line = rowLine(row);
  return skipPatterns.some((p) => p && line.includes(p));
}

function buildHeaderMap(headerRow: Row): Map<string, number> {
  const map = new Map<string, number>();
  headerRow.forEach((h, idx) => {
    const key = cellStr(h);
    if (key) map.set(key, idx);
  });
  return map;
}

/**
 * 规范化字符串用于模糊匹配：去除空格、统一标点、转小写
 */
function normalizeForMatch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:]/g, ':')
    .replace(/[\(（]/g, '(')
    .replace(/[）\)]/g, ')')
    .replace(/[-—––]/g, '-')
    .replace(/[，,]/g, ',')
    ;
}

/**
 * 解析 sourceColumn 到实际的列索引
 * 匹配优先级：
 *   1. 精确匹配（sourceColumn == header）
 *   2. 规范化后精确匹配（去除空格/标点差异后一致）
 *   3. 包含匹配（header 包含 source 或 source 包含 header）
 *   4. 规范化后包含匹配
 *   5. "第X列" 模式解析
 *   6. 复合 sourceColumn 拆分匹配（PDF 单 cell 场景：sourceColumn 含多个字段名时取最相关的）
 */
function resolveColIndex(source: string, headerMap: Map<string, number>): number | undefined {
  const s = source.trim();
  if (!s) return undefined;

  // 收集所有表头信息用于模糊匹配
  const allHeaders: Array<{ raw: string; normalized: string; idx: number }> = [];
  for (const [raw, idx] of headerMap) {
    allHeaders.push({ raw, normalized: normalizeForMatch(raw), idx });
  }
  const sNorm = normalizeForMatch(s);

  // 1. 精确匹配
  if (headerMap.has(s)) return headerMap.get(s);

  // 2. 规范化后精确匹配
  for (const h of allHeaders) {
    if (h.normalized === sNorm) return h.idx;
  }

  // 3. 原始字符串包含匹配
  for (const h of allHeaders) {
    if (h.raw === s || h.raw.includes(s) || s.includes(h.raw)) return h.idx;
  }

  // 4. 规范化后包含匹配
  for (const h of allHeaders) {
    if (h.normalized === sNorm || h.normalized.includes(sNorm) || sNorm.includes(h.normalized)) return h.idx;
  }

  // 5. "第X列"模式
  const colMatch = s.match(/^第\s*(\d+)\s*列$/);
  if (colMatch) return Number(colMatch[1]) - 1;

  // 6. 复合 sourceColumn 拆分匹配（PDF 单 cell 场景）
  // 当 AI 推测的 sourceColumn 是多个字段名的拼接时（如 "物品类别 物品编码 物品名称"），
  // 拆分为单个字段名后逐一精确/模糊匹配 virtualHeaderRow
  if (/\s/.test(s) && headerMap.size > 2) {
    const parts = s.split(/\s+/).filter(Boolean);
    let bestIdx: number | undefined;
    let bestScore = -1;
    for (const part of parts) {
      const pNorm = normalizeForMatch(part);
      if (!pNorm || pNorm.length < 2) continue;
      for (const h of allHeaders) {
        let score = 0;
        if (h.normalized === pNorm) score = 100;      // 完全匹配
        else if (h.raw === part) score = 90;           // 原始相等
        else if (h.raw.includes(part) || part.includes(h.raw)) score = 70 + Math.min(20, part.length);  // 包含匹配（越长越好）
        else if (h.normalized.includes(pNorm) || pNorm.includes(h.normalized)) score = 50 + Math.min(15, pNorm.length);  // 规范化包含
        if (score > bestScore) {
          bestScore = score;
          bestIdx = h.idx;
        }
      }
    }
    if (bestIdx !== undefined && bestScore >= 50) return bestIdx;
  }

  return undefined;
}

function applyMapping(
  item: OrderItem,
  row: Row,
  mapping: FieldMapping,
  headerMap: Map<string, number>,
  // PDF 单 cell 模式下传入 virtualHeaderRow，用于 targetField 直接匹配
  virtualHeaderRow?: string[],
): boolean {
  let colIndex: number | undefined;

  // ── PDF 单 cell 模式：优先用 targetField 直接匹配 virtualHeaderRow ──
  // AI 推测的 sourceColumn 是基于整行表头文本的复合字符串（如 "物品类别 物品编码 物品名称"），
  // 用它去匹配虚拟分列后的 headerMap 极不可靠。
  // 因此在 PDF 单 cell 模式下，直接根据 targetField（目标字段名）与 virtualHeaderRow 做语义匹配。
  if (virtualHeaderRow && virtualHeaderRow.length > 2) {
    const tf = mapping.targetField;
    const tfNorm = normalizeForMatch(tf);
    let bestIdx: number | undefined;
    let bestScore = -1;
    for (let i = 0; i < virtualHeaderRow.length; i++) {
      const h = virtualHeaderRow[i];
      const hNorm = normalizeForMatch(h);
      let score = 0;
      const semanticMap: Array<[RegExp, RegExp, number]> = [
        [/(sku|编码|code)/i, /(编码|code)/i, 100],
        [/(sku)?名称|name/i, /(名称|name|品名)/i, 100],
        [/(数量|qty|num)/i, /(数量|qty|num)/i, 100],
        [/(规格|spec|型号|model)/i, /(规格|spec|型号|model)/i, 100],
        [/(单位|unit)/i, /(单位|unit)/i, 100],
        [/(备注|note|remark|comment)/i, /(备注|note|remark|comment)/i, 100],
        [/(类别|category|品类|type)/i, /(类别|category|品类|type)/i, 100],
        [/(电话|phone|tel)/i, /(电话|phone|tel)/i, 100],
        [/(地址|addr|address)/i, /(地址|addr|address)/i, 100],
        [/(门店|店|store)/i, /(门店|店|store)/i, 100],
        [/(姓名|联系人)/i, /(姓名|联系人)/i, 100],
        [/(序号|No|\d+号)/i, /(序号|No)/i, 80],
        [/(外部编码|external)/i, /(外部编码|external)/i, 100],
      ];
      for (const [tfPat, hPat, baseScore] of semanticMap) {
        if (tfPat.test(tf) && hPat.test(h)) {
          score = Math.max(score, baseScore + (hNorm === tfNorm ? 20 : 0));
          break;
        }
      }
      if (score === 0 && (hNorm.includes(tfNorm) || tfNorm.includes(hNorm))) {
        score = 30 + Math.min(10, tfNorm.length);
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx !== undefined && bestScore >= 60) {
      colIndex = bestIdx;
    }
    // 如果匹配度不足或没匹配到，回退到 resolveColIndex
  }

  // 非 PDF 单 cell 模式（或 PDF 模式语义匹配失败时）回退到常规 sourceColumn 匹配
  if (colIndex === undefined) {
    colIndex = resolveColIndex(mapping.sourceColumn, headerMap);
  }

  if (colIndex === undefined) return false;
  let rawValue = cellStr(row[colIndex]);
  if (mapping.mappingType === 'regex' && mapping.regexPattern) {
    try {
      const m = rawValue.match(new RegExp(mapping.regexPattern));
      rawValue = m ? m[1] || rawValue : rawValue;
    } catch {
      /* keep raw */
    }
  } else if (mapping.mappingType === 'composite' && mapping.compositeFields?.length) {
    const parts = mapping.compositeFields
      .map((f) => {
        const idx = resolveColIndex(f, headerMap);
        return idx !== undefined ? cellStr(row[idx]) : '';
      })
      .filter(Boolean);
    rawValue = parts.join(mapping.separator || ' ');
  }
  if (rawValue) {
    setItemField(item, mapping.targetField, rawValue);
    return true;
  }
  return false;
}

function extractFromRegion(
  rows: Row[],
  start: number,
  end: number,
  rule: ParseRule,
  types: Array<'header' | 'footer' | 'inline'>,
  targets: Record<string, string>
): void {
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    const line = rowLine(row);
    for (const ext of rule.extractionRules || []) {
      if (!types.includes(ext.type as 'header' | 'footer' | 'inline')) continue;
      if (ext.pattern && !line.includes(ext.pattern)) continue;
      let value = ext.defaultValue || line;
      if (ext.regex) {
        try {
          const m = line.match(new RegExp(ext.regex));
          if (m?.[1]) value = m[1];
        } catch {
          /* ignore */
        }
      }
      if (value) targets[ext.targetField] = value;
    }
    // 横向 key-value：如 ["收货人","张三","收货电话","185..."]
    for (let c = 0; c < row.length - 1; c++) {
      const label = cellStr(row[c]).replace(/[：:]/g, '');
      const val = cellStr(row[c + 1]);
      if (!label || !val) continue;
      for (const mapping of rule.fieldMappings) {
        if (mapping.mappingType !== 'direct') continue;
        const src = mapping.sourceColumn.replace(/[：:]/g, '');
        if (label === src || label.includes(src) || src.includes(label)) {
          targets[mapping.targetField] = val;
        }
      }
    }
  }
}

/**
 * 自动检测表头行：当 dataStartRow 为 0 或未设置时，
 * 扫描前 N 行，找出与 fieldMappings 的 sourceColumn 匹配度最高的行作为表头。
 * 主要解决 PDF 解析后文本行中表头不在第 0 行的问题。
 */
function autoDetectHeaderRow(rows: Row[], rule: ParseRule, fallbackIdx: number): { headerIdx: number; dataBeforeHeader: boolean } {
  // 已明确指定了起始行，不自动检测
  if (rule.dataStartRow !== undefined && rule.dataStartRow > 0) return { headerIdx: fallbackIdx, dataBeforeHeader: false };
  const mappings = rule.fieldMappings?.filter(m => m.mappingType === 'direct' && m.sourceColumn) || [];
  if (mappings.length === 0 || rows.length === 0) return { headerIdx: fallbackIdx, dataBeforeHeader: false };

  // 搜索全部行（PDF 表头可能在任意位置，如页脚重复区域）
  const searchLimit = rows.length;
  let bestIdx = fallbackIdx;
  let bestScore = 0;

  const sourceNorms = mappings.map(m => normalizeForMatch(m.sourceColumn));

  for (let i = 0; i < searchLimit; i++) {
    const line = rowLine(rows[i]);
    const cells = line.split(/\s+|\t+|\s{2,}/).filter(Boolean);
    if (cells.length < 3) continue; // 表头至少应有 3 列

    let score = 0;
    for (let si = 0; si < sourceNorms.length; si++) {
      const srcNorm = sourceNorms[si];
      const srcRaw = mappings[si].sourceColumn;
      for (const cell of cells) {
        const cellNorm = normalizeForMatch(cell);
        if (cellNorm === srcNorm || cell.includes(srcRaw) || srcRaw.includes(cell)) {
          score += 2;
        } else if (cellNorm.includes(srcNorm) || srcNorm.includes(cellNorm)) {
          score += 1;
        }
      }
    }
    // 额外奖励：含典型表头关键词的行
    if (/序号|品类|编码|物品名称|规格型号|发货数量|订货单位|SKU|sku/i.test(line)) {
      score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // 判断数据是否在表头之前（如 PDF 中先出数据行再出表头行的情况）
  // 如果检测到的表头行索引 > 0 且前面的行看起来像数据行（以数字开头等）
  let dataBeforeHeader = false;
  if (bestIdx > 2 && bestScore >= 4) {
    // 检查表头前面是否有看起来像数据行的内容
    let dataLikeCount = 0;
    for (let i = 1; i < bestIdx && dataLikeCount < 3; i++) {
      const line = rowLine(rows[i]).trim();
      // 数据行特征：以 "数字 空格" 开头（如 "1 饮品类 ZBWP..."）
      if (/^\d+\s+\S/.test(line) && line.length > 10) {
        dataLikeCount++;
      }
    }
    if (dataLikeCount >= 2) dataBeforeHeader = true;
  }

  return { headerIdx: bestIdx, dataBeforeHeader };
}

function parseTableRows(rows: Row[], rule: ParseRule): OrderItem[] {
  let fallbackIdx = Math.max(0, rule.dataStartRow ?? 0);
  const { headerIdx: headerRowIndex, dataBeforeHeader } = autoDetectHeaderRow(rows, rule, fallbackIdx);

  // ── PDF 单 cell 行检测与虚拟分列 ──
  // 当每行只有 1 个 cell（linesToRows 包装的纯文本行），且表头行也是单 cell 时，
  // 需要按空格将整行文本拆分为虚拟多列，使后续 fieldMappings 能按列索引正确取值。
  let isPdfSingleCell = false;
  let virtualHeaderRow: Row = [];
  const headerRaw = rows[headerRowIndex] || [];
  if (headerRaw.length === 1 && rows.length > headerRowIndex + 1) {
    // 检查表头后的数据行是否也大多是单 cell
    let singleCellCount = 0;
    const checkLimit = Math.min(headerRowIndex + 10, rows.length);
    for (let i = headerRowIndex + 1; i < checkLimit; i++) {
      if ((rows[i] || []).length === 1) singleCellCount++;
    }
    if (singleCellCount >= Math.min(5, checkLimit - headerRowIndex - 1)) {
      isPdfSingleCell = true;
      // 将表头行的唯一 cell 按空格拆分为虚拟多列表头
      virtualHeaderRow = cellStr(headerRaw[0]).split(/\s+/).filter(Boolean);
      console.log('[parseTableRows] PDF single-cell detected!');
    }
  }

  // 如果是 PDF 单 cell 模式，构建基于表头字段名的虚拟 headerMap
  // sourceColumn（如 "SKU编码"）通过模糊匹配找到在 virtualHeaderRow 中的位置索引
  const headerMap = isPdfSingleCell
    ? buildHeaderMap(virtualHeaderRow)
    : buildHeaderMap(headerRaw);
  const endRow = rule.dataEndRow !== undefined ? Math.min(rule.dataEndRow, rows.length) : rows.length;
  const shared: Record<string, string> = {};

  extractFromRegion(rows, 0, Math.min(rule.headerSkipRows || 0, rows.length), rule, ['header'], shared);
  extractFromRegion(rows, Math.max(0, rows.length - (rule.footerSkipRows || 30)), rows.length, rule, ['footer'], shared);

  const items: OrderItem[] = [];

  // 确定数据行的遍历范围
  let dataStartIdx: number;
  let dataEndIdx: number;

  if (dataBeforeHeader) {
    // 数据在表头之前：从第 1 行到表头行（跳过标题/元信息行）
    // 需要找到实际数据起始行（第一个以数字开头的行）
    dataStartIdx = 1;
    for (; dataStartIdx < headerRowIndex; dataStartIdx++) {
      const line = rowLine(rows[dataStartIdx]).trim();
      if (/^\d+\s+\S/.test(line) && line.length > 10) break;
    }
    dataEndIdx = headerRowIndex; // 不包含表头行本身
  } else {
    // 正常模式：数据在表头之后
    dataStartIdx = headerRowIndex + 1;
    dataEndIdx = endRow;
  }

  for (let i = dataStartIdx; i < dataEndIdx; i++) {
    let row = rows[i];
    if (isEmptyRow(row) || shouldSkipRow(row, rule.skipPatterns || [])) continue;

    // PDF 单 cell 模式：将整行文本按空格拆分为虚拟多列
    let effectiveRow = row;
    if (isPdfSingleCell && row.length === 1) {
      effectiveRow = cellStr(row[0]).split(/\s+/).filter(Boolean);
    }
    const item = createEmptyOrderItem();
    item.id = `row_${Date.now()}_${i}`;
    Object.assign(item, shared);

    let hasData = false;
    for (const mapping of rule.fieldMappings) {
      const ok = applyMapping(item, effectiveRow, mapping, headerMap, isPdfSingleCell ? virtualHeaderRow : undefined);
      if (ok) hasData = true;
    }

    const line = rowLine(row);
    for (const ext of rule.extractionRules || []) {
      if (ext.type !== 'inline' || !ext.pattern || !line.includes(ext.pattern)) continue;
      let value = ext.defaultValue || line;
      if (ext.regex) {
        try {
          const m = line.match(new RegExp(ext.regex));
          if (m?.[1]) value = m[1];
        } catch {
          /* ignore */
        }
      }
      setItemField(item, ext.targetField, value);
      hasData = true;
    }

    if (hasData) items.push(item);
  }
  return items;
}

function parseCardRows(rows: Row[], rule: ParseRule): OrderItem[] {
  const marker = rule.cardMarker || '▶';
  const cardStarts: number[] = [];
  rows.forEach((row, idx) => {
    const line = rowLine(row);
    if (line.includes(marker) || rule.extractionRules.some((e) => e.type === 'card' && e.pattern && line.includes(e.pattern))) {
      cardStarts.push(idx);
    }
  });
  if (cardStarts.length === 0) return parseTableRows(rows, rule);

  const items: OrderItem[] = [];
  for (let c = 0; c < cardStarts.length; c++) {
    const start = cardStarts[c];
    const end = c + 1 < cardStarts.length ? cardStarts[c + 1] : rows.length;
    const segment = rows.slice(start, end);
    const shared: Record<string, string> = {};
    extractFromRegion(segment, 0, segment.length, rule, ['header', 'footer', 'inline'], shared);

    let tableHeaderIdx = -1;
    const skuHeader = rule.fieldMappings.find((m) => m.targetField === 'skuCode' || m.targetField === 'skuName');
    for (let i = 0; i < segment.length; i++) {
      const line = rowLine(segment[i]);
      if (skuHeader) {
        const src = skuHeader.sourceColumn.replace(/[：:*]/g, '').replace(/\*$/, '');
        if (line.includes(src)) {
          tableHeaderIdx = i;
          break;
        }
      }
    }
    if (tableHeaderIdx < 0) {
      for (let i = 0; i < segment.length; i++) {
        const line = rowLine(segment[i]);
        if (/物品编码|SKU|sku/i.test(line) && /名称|数量/.test(line)) {
          tableHeaderIdx = i;
          break;
        }
      }
    }

    for (const row of segment.slice(0, tableHeaderIdx > 0 ? tableHeaderIdx : 6)) {
      for (let col = 0; col < row.length - 1; col++) {
        const label = cellStr(row[col]).replace(/[：:]/g, '');
        const val = cellStr(row[col + 1]);
        if (!label || !val) continue;
        for (const mapping of rule.fieldMappings) {
          const src = mapping.sourceColumn.replace(/[：:*]/g, '').replace(/\*$/, '');
          if (label === src || label.includes(src) || src.includes(label)) {
            shared[mapping.targetField] = val;
          }
        }
      }
    }

    if (tableHeaderIdx < 0) continue;

    const headerMap = buildHeaderMap(segment[tableHeaderIdx]);
    for (let i = tableHeaderIdx + 1; i < segment.length; i++) {
      const row = segment[i];
      if (isEmptyRow(row) || shouldSkipRow(row, rule.skipPatterns || [])) continue;
      const item = createEmptyOrderItem();
      item.id = `card_${Date.now()}_${start}_${i}`;
      Object.assign(item, shared);
      let hasData = false;
      for (const mapping of rule.fieldMappings) {
        if (applyMapping(item, row, mapping, headerMap)) hasData = true;
      }
      if (hasData) items.push(item);
    }
  }
  return items;
}

function splitCompositeValue(value: string, config: TransposeConfig): Array<{ name: string; qty: string }> {
  const pattern = config.compositePattern || '(.+?)[x×*](\\d+)';
  const lines = value.split(config.lineSeparator || /\n|\r\n/);
  const results: Array<{ name: string; qty: string }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const m = trimmed.match(new RegExp(pattern));
      if (m) results.push({ name: m[1].trim(), qty: m[2] });
      else results.push({ name: trimmed, qty: '1' });
    } catch {
      results.push({ name: trimmed, qty: '1' });
    }
  }
  return results;
}

function parseTransposeRows(rows: Row[], rule: ParseRule): OrderItem[] {
  const config = rule.transposeConfig;
  if (!config) return parseTableRows(rows, rule);

  const colHeaderRow = config.columnHeaderRow ?? rule.dataStartRow ?? 0;
  const headerRow = rows[colHeaderRow] || [];
  const headerMap = buildHeaderMap(headerRow);

  const rowHeaderIdx = resolveColIndex(config.rowHeaderColumn, headerMap);
  if (rowHeaderIdx === undefined) return parseTableRows(rows, rule);

  const dataColStart = rowHeaderIdx + 1;
  const storeColumns: Array<{ idx: number; label: string }> = [];
  headerRow.forEach((h, idx) => {
    if (idx <= rowHeaderIdx) return;
    const label = cellStr(h);
    if (!label) return;
    if (config.columnFilter && !label.includes(config.columnFilter)) return;
    if (['合计', '总计', '小计'].some((s) => label.includes(s))) return;
    storeColumns.push({ idx, label });
  });

  const items: OrderItem[] = [];
  const startDataRow = colHeaderRow + 1;
  const endRow = rule.dataEndRow !== undefined ? Math.min(rule.dataEndRow, rows.length) : rows.length;

  for (let i = startDataRow; i < endRow; i++) {
    const row = rows[i];
    if (isEmptyRow(row) || shouldSkipRow(row, rule.skipPatterns || [])) continue;
    const rowLabel = cellStr(row[rowHeaderIdx]);
    if (!rowLabel) continue;

    for (const col of storeColumns) {
      const rawVal = cellStr(row[col.idx]);
      if (!rawVal || rawVal === '0') continue;

      if (config.type === 'double' || rawVal.includes('\n') || /[x×*]\d/.test(rawVal)) {
        const parts = splitCompositeValue(rawVal, config);
        for (const part of parts) {
          const item = createEmptyOrderItem();
          item.id = `tp_${Date.now()}_${i}_${col.idx}_${part.name}`;
          item.storeName = config.type === 'double' ? rowLabel : col.label;
          if (config.type === 'matrix') item.skuName = rowLabel;
          item.skuName = item.skuName || part.name;
          item.skuQuantity = part.qty;
          if (config.type === 'double') item.remark = `${col.label}: ${part.name}`;
          items.push(item);
        }
      } else {
        const item = createEmptyOrderItem();
        item.id = `tp_${Date.now()}_${i}_${col.idx}`;
        item.storeName = col.label;
        item.skuName = rowLabel;
        item.skuQuantity = rawVal.replace(/[^\d.]/g, '') || rawVal;
        items.push(item);
      }
    }
  }

  // 补充 fieldMappings
  return items.map((item) => {
    const copy = { ...item };
    for (const mapping of rule.fieldMappings) {
      if (getItemField(copy, mapping.targetField)) continue;
      if (mapping.targetField === 'storeName' && !copy.storeName) continue;
    }
    return copy;
  });
}

function parseTextLines(lines: string[], rule: ParseRule): OrderItem[] {
  const rows: Row[] = lines.map((l) => [l]);
  const textRule = { ...rule, parseMode: 'table' as const, dataStartRow: 0, headerSkipRows: 0 };
  const recordSeparator = rule.extractionRules.find((e) => e.type === 'card' && e.pattern)?.pattern || '━━━';
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.includes(recordSeparator)) {
      if (current.length) blocks.push(current);
      current = [];
    } else if (line.trim()) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);

  if (blocks.length <= 1) {
    const items: OrderItem[] = [];
    const shared: Record<string, string> = {};
    for (const line of lines) {
      for (const ext of rule.extractionRules) {
        if (!ext.pattern || !line.includes(ext.pattern)) continue;
        let value = ext.defaultValue || line;
        if (ext.regex) {
          try {
            const m = line.match(new RegExp(ext.regex));
            if (m?.[1]) value = m[1];
          } catch {
            /* ignore */
          }
        }
        shared[ext.targetField] = value;
      }
      // 物品行：编号. 编码 | 名称 | 规格 | 数量
      const itemMatch = line.match(/^\d+\.\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?(?:\s*\|\s*(.+))?$/);
      if (itemMatch) {
        const item = createEmptyOrderItem();
        Object.assign(item, shared);
        item.skuCode = itemMatch[1].trim();
        item.skuName = itemMatch[2].trim();
        if (itemMatch[3]) item.skuSpec = itemMatch[3].trim();
        if (itemMatch[4]) item.skuQuantity = itemMatch[4].trim().replace(/[^\d.]/g, '');
        items.push(item);
      }
    }
    return items.length ? items : parseTableRows(rows, textRule);
  }

  const items: OrderItem[] = [];
  for (const block of blocks) {
    const shared: Record<string, string> = {};
    for (const line of block) {
      for (const ext of rule.extractionRules) {
        if (!ext.pattern || !line.includes(ext.pattern)) continue;
        let value = ext.defaultValue || line;
        if (ext.regex) {
          try {
            const m = line.match(new RegExp(ext.regex));
            if (m?.[1]) value = m[1];
          } catch {
            /* ignore */
          }
        }
        shared[ext.targetField] = value;
      }
      const itemMatch = line.match(/^\d+\.\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?(?:\s*\|\s*(.+))?$/);
      if (itemMatch) {
        const item = createEmptyOrderItem();
        Object.assign(item, shared);
        item.skuCode = itemMatch[1].trim();
        item.skuName = itemMatch[2].trim();
        if (itemMatch[3]) item.skuSpec = itemMatch[3].trim();
        if (itemMatch[4]) item.skuQuantity = itemMatch[4].trim().replace(/[^\d.]/g, '');
        items.push(item);
      }
    }
  }
  return items;
}

function aggregateItems(items: OrderItem[], field: OrderField): OrderItem[] {
  const map = new Map<string, OrderItem>();
  for (const item of items) {
    const key = getItemField(item, field) || `__null_${map.size}`;
    if (!map.has(key)) {
      map.set(key, { ...item });
    } else {
      const existing = map.get(key)!;
      const exQty = Number(existing.skuQuantity) || 0;
      const addQty = Number(item.skuQuantity) || 0;
      existing.skuQuantity = String(exQty + addQty);
      for (const f of ['skuName', 'skuSpec', 'remark'] as OrderField[]) {
        if (!getItemField(existing, f) && getItemField(item, f)) {
          setItemField(existing, f, getItemField(item, f));
        }
      }
    }
  }
  return Array.from(map.values());
}

function sheetContext(rows: Row[], sheetName: string): Record<string, string> {
  const ctx: Record<string, string> = {};
  const title = rowLine(rows[0] || []);
  const m = title.match(/[（(]([^）)]+)[）)]/);
  if (m) ctx.storeName = m[1];
  else if (sheetName && !/^sheet\d*$/i.test(sheetName)) ctx.storeName = sheetName;
  return ctx;
}

function parseSingleSheet(rows: Row[], rule: ParseRule, extraShared: Record<string, string> = {}): OrderItem[] {
  const mode = rule.parseMode || (rule.transposeConfig ? 'transpose' : 'table');
  let items: OrderItem[];
  switch (mode) {
    case 'card':
      items = parseCardRows(rows, rule);
      break;
    case 'transpose':
      items = parseTransposeRows(rows, rule);
      break;
    case 'text':
      items = parseTextLines(rows.map((r) => cellStr(r[0]) || rowLine(r)).filter(Boolean), rule);
      break;
    default:
      items = parseTableRows(rows, rule);
  }
  if (Object.keys(extraShared).length) {
    items = items.map((it) => ({ ...it, ...extraShared }));
  }
  return items;
}

/** 统一规则引擎入口 */
export function executeRuleEngine(input: ParseEngineInput): OrderItem[] {
  const { rule, onProgress } = input;
  let allItems: OrderItem[] = [];

  if (rule.multiSheet && input.sheetData && Object.keys(input.sheetData).length > 0) {
    const entries = Object.entries(input.sheetData).filter(([name]) => !name.startsWith('~$'));
    entries.forEach(([sheetName, rows], idx) => {
      onProgress?.(idx + 1, entries.length);
      if (!rows?.length) return;
      const ctx = sheetContext(rows, sheetName);
      allItems = allItems.concat(parseSingleSheet(rows, rule, ctx));
    });
  } else if (input.textLines?.length) {
    onProgress?.(1, 1);
    allItems = parseTextLines(input.textLines, rule);
  } else if (input.rows?.length) {
    onProgress?.(1, 1);
    allItems = parseSingleSheet(input.rows, rule);
  }

  if (rule.aggregateBy?.trim()) {
    allItems = aggregateItems(allItems, rule.aggregateBy as OrderField);
  }

  return allItems;
}

/**
 * 异步分片版本：每处理 CHUNK_SIZE 行后让出主线程，避免阻塞 UI
 * @param input 解析引擎输入参数
 * @param chunkSize 每批处理的行数，默认 200
 */
export async function executeRuleEngineAsync(input: ParseEngineInput, chunkSize: number = 200): Promise<OrderItem[]> {
  const { rule, onProgress } = input;
  let allItems: OrderItem[] = [];

  if (rule.multiSheet && input.sheetData && Object.keys(input.sheetData).length > 0) {
    const entries = Object.entries(input.sheetData).filter(([name]) => !name.startsWith('~$'));

    for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
      const [sheetName, rows] = entries[entryIdx];
      onProgress?.(entryIdx + 1, entries.length);
      if (!rows?.length) continue;

      const ctx = sheetContext(rows, sheetName);

      // 分片处理单表数据
      const mode = rule.parseMode || (rule.transposeConfig ? 'transpose' : 'table');
      let processedCount = 0;

      if (mode === 'card') {
        // 卡片模式需要特殊处理
        const items = parseCardRows(rows, rule);
        if (Object.keys(ctx).length) {
          items.forEach((it) => Object.assign(it, ctx));
        }
        allItems = allItems.concat(items);
      } else if (mode === 'transpose') {
        // 转置模式
        const items = parseTransposeRows(rows, rule);
        if (Object.keys(ctx).length) {
          items.forEach((it) => Object.assign(it, ctx));
        }
        allItems = allItems.concat(items);
      } else if (mode === 'text' && input.textLines?.length) {
        // 文本模式
        const items = parseTextLines(input.textLines, rule);
        allItems = allItems.concat(items);
      } else {
        // 表格模式 - 可以分片处理
        let fallbackIdx = Math.max(0, rule.dataStartRow ?? 0);
        const { headerIdx: headerRowIndex, dataBeforeHeader } = autoDetectHeaderRow(rows, rule, fallbackIdx);

        // ── PDF 单 cell 行检测与虚拟分列（与 parseTableRows 保持一致）──
        let isPdfSingleCell = false;
        const headerRawAsync = rows[headerRowIndex] || [];
        let virtualHeaderRowAsync: Row = [];
        if (headerRawAsync.length === 1 && rows.length > headerRowIndex + 1) {
          let singleCellCount = 0;
          const checkLimit = Math.min(headerRowIndex + 10, rows.length);
          for (let i = headerRowIndex + 1; i < checkLimit; i++) {
            if ((rows[i] || []).length === 1) singleCellCount++;
          }
          if (singleCellCount >= Math.min(5, checkLimit - headerRowIndex - 1)) {
            isPdfSingleCell = true;
            virtualHeaderRowAsync = cellStr(headerRawAsync[0]).split(/\s+/).filter(Boolean);
          }
        }

        const headerMap = isPdfSingleCell
          ? buildHeaderMap(virtualHeaderRowAsync)
          : buildHeaderMap(headerRawAsync);
        const endRow = rule.dataEndRow !== undefined ? Math.min(rule.dataEndRow, rows.length) : rows.length;
        const shared: Record<string, string> = {};

        extractFromRegion(rows, 0, Math.min(rule.headerSkipRows || 0, rows.length), rule, ['header'], shared);
        extractFromRegion(rows, Math.max(0, rows.length - (rule.footerSkipRows || 30)), rows.length, rule, ['footer'], shared);

        // 确定数据行遍历范围（支持数据在表头之前的 PDF 布局）
        let dataStartIdx: number;
        let dataEndIdx: number;
        if (dataBeforeHeader) {
          dataStartIdx = 1;
          for (; dataStartIdx < headerRowIndex; dataStartIdx++) {
            if (/^\d+\s+\S/.test(rowLine(rows[dataStartIdx]).trim()) && rowLine(rows[dataStartIdx]).trim().length > 10) break;
          }
          dataEndIdx = headerRowIndex;
        } else {
          dataStartIdx = headerRowIndex + 1;
          dataEndIdx = endRow;
        }

        for (let i = dataStartIdx; i < dataEndIdx; i++) {
          let row = rows[i];
          if (isEmptyRow(row) || shouldSkipRow(row, rule.skipPatterns || [])) continue;

          // PDF 单 cell 模式：虚拟分列
          let effectiveRow = row;
          if (isPdfSingleCell && row.length === 1) {
            effectiveRow = cellStr(row[0]).split(/\s+/).filter(Boolean);
          }

          const item = createEmptyOrderItem();
          item.id = `row_${Date.now()}_${i}`;
          Object.assign(item, shared);

          let hasData = false;
          for (const mapping of rule.fieldMappings) {
            if (applyMapping(item, effectiveRow, mapping, headerMap, isPdfSingleCell ? virtualHeaderRowAsync : undefined)) hasData = true;
          }

          const line = rowLine(row);
          for (const ext of rule.extractionRules || []) {
            if (ext.type !== 'inline' || !ext.pattern || !line.includes(ext.pattern)) continue;
            let value = ext.defaultValue || line;
            if (ext.regex) {
              try {
                const m = line.match(new RegExp(ext.regex));
                if (m?.[1]) value = m[1];
              } catch {
                /* ignore */
              }
            }
            setItemField(item, ext.targetField, value);
            hasData = true;
          }

          if (hasData) allItems.push(item);

          // 每处理 chunkSize 行后让出主线程
          processedCount++;
          if (processedCount % chunkSize === 0) {
            await new Promise(resolve => setTimeout(resolve, 0)); // 让出主线程
          }
        }

        if (Object.keys(shared).length) {
          allItems = allItems.map((it) => ({ ...it, ...shared }));
        }
      }
    }
  } else if (input.textLines?.length) {
    onProgress?.(1, 1);
    allItems = parseTextLines(input.textLines, rule);
  } else if (input.rows?.length) {
    onProgress?.(1, 1);

    // 分片处理单表数据
    const mode = rule.parseMode || (rule.transposeConfig ? 'transpose' : 'table');

    if (mode === 'card') {
      allItems = parseCardRows(input.rows, rule);
    } else if (mode === 'transpose') {
      allItems = parseTransposeRows(input.rows, rule);
    } else if (mode === 'text') {
      allItems = parseTextLines(input.rows.map((r) => cellStr(r[0]) || rowLine(r)).filter(Boolean), rule);
    } else {
      // 表格模式 - 分片处理
      const rows = input.rows;
      let fallbackIdx = Math.max(0, rule.dataStartRow ?? 0);
      const { headerIdx: headerRowIndex, dataBeforeHeader } = autoDetectHeaderRow(rows, rule, fallbackIdx);
      const headerMap = buildHeaderMap(rows[headerRowIndex] || []);
      const endRow = rule.dataEndRow !== undefined ? Math.min(rule.dataEndRow, rows.length) : rows.length;
      const shared: Record<string, string> = {};

      extractFromRegion(rows, 0, Math.min(rule.headerSkipRows || 0, rows.length), rule, ['header'], shared);
      extractFromRegion(rows, Math.max(0, rows.length - (rule.footerSkipRows || 30)), rows.length, rule, ['footer'], shared);

      // 确定数据行遍历范围（支持数据在表头之前的 PDF 布局）
      let dataStartIdx: number;
      let dataEndIdx: number;
      if (dataBeforeHeader) {
        dataStartIdx = 1;
        for (; dataStartIdx < headerRowIndex; dataStartIdx++) {
          if (/^\d+\s+\S/.test(rowLine(rows[dataStartIdx]).trim()) && rowLine(rows[dataStartIdx]).trim().length > 10) break;
        }
        dataEndIdx = headerRowIndex;
      } else {
        dataStartIdx = headerRowIndex + 1;
        dataEndIdx = endRow;
      }

      let processedCount = 0;
      for (let i = dataStartIdx; i < dataEndIdx; i++) {
        const row = rows[i];
        if (isEmptyRow(row) || shouldSkipRow(row, rule.skipPatterns || [])) continue;

        const item = createEmptyOrderItem();
        item.id = `row_${Date.now()}_${i}`;
        Object.assign(item, shared);

        let hasData = false;
        for (const mapping of rule.fieldMappings) {
          if (applyMapping(item, row, mapping, headerMap)) hasData = true;
        }

        const line = rowLine(row);
        for (const ext of rule.extractionRules || []) {
          if (ext.type !== 'inline' || !ext.pattern || !line.includes(ext.pattern)) continue;
          let value = ext.defaultValue || line;
          if (ext.regex) {
            try {
              const m = line.match(new RegExp(ext.regex));
              if (m?.[1]) value = m[1];
            } catch {
              /* ignore */
            }
          }
          setItemField(item, ext.targetField, value);
          hasData = true;
        }

        if (hasData) allItems.push(item);

        // 每处理 chunkSize 行后让出主线程
        processedCount++;
        if (processedCount % chunkSize === 0) {
          await new Promise(resolve => setTimeout(resolve, 0)); // 让出主线程
        }
      }

      if (Object.keys(shared).length) {
        allItems = allItems.map((it) => ({ ...it, ...shared }));
      }
    }
  }

  if (rule.aggregateBy?.trim()) {
    allItems = aggregateItems(allItems, rule.aggregateBy as OrderField);
  }

  return allItems;
}

export { parseTableRows, parseCardRows, parseTransposeRows, parseTextLines };
