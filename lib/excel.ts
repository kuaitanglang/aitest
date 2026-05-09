import * as XLSX from 'xlsx';
import { OrderItem, SYSTEM_FIELDS, COLUMN_ALIASES, TemplateRule, REQUIRED_FIELDS, TEMPERATURE_OPTIONS, FieldError, OrderItemField, ColumnMapping } from '@/types';
import { supabase } from '@/lib/supabase';

function isHeaderRow(row: string[]): boolean {
  const headerKeywords = [
    '外部编码', '发件人', '收件人', '重量', '件数', '温层', '备注',
    'external', 'sender', 'receiver', 'weight', 'quantity', 'temperature',
    '客户单号', '发货人', '收货人', '数量', '温度要求', '附言',
    'Ref Code', 'Qty'
  ];
  const rowStr = row.join(' ').toLowerCase();

  const matchCount = headerKeywords.filter(keyword => rowStr.includes(keyword.toLowerCase())).length;

  return matchCount >= 2;
}

function isGroupHeaderRow(row: string[]): boolean {
  const groupKeywords = ['信息', '货物', '发件方', '收件方', '寄件方'];
  const filledCells = row.filter(c => c && c.trim()).length;
  const totalCells = row.filter(c => c !== undefined).length;
  const hasGroupLabel = row.some(c => groupKeywords.some(k => c?.includes(k)));

  return hasGroupLabel && filledCells < totalCells * 0.4;
}

function findHeaderRow(worksheet: XLSX.WorkSheet, range: XLSX.Range): number {
  for (let r = range.s.r; r <= Math.min(range.s.r + 15, range.e.r); r++) {
    const rowValues: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r, c })];
      rowValues.push((cell?.v || '').toString().trim());
    }

    if (isGroupHeaderRow(rowValues)) {
      continue;
    }

    if (isHeaderRow(rowValues)) {
      return r;
    }
  }

  return 0;
}

function expandMergedCells(worksheet: XLSX.WorkSheet, range: XLSX.Range): void {
  if (!worksheet['!merges']) {
    return;
  }

  const merges: XLSX.Range[] = worksheet['!merges'];

  merges.forEach((mergeRange) => {
    const topLeftCell = worksheet[XLSX.utils.encode_cell({ r: mergeRange.s.r, c: mergeRange.s.c })];

    if (!topLeftCell) {
      return;
    }

    const topLeftValue = topLeftCell.v;

    for (let r = mergeRange.s.r; r <= mergeRange.e.r; r++) {
      for (let c = mergeRange.s.c; c <= mergeRange.e.c; c++) {
        if (r === mergeRange.s.r && c === mergeRange.s.c) {
          continue;
        }

        const cellRef = XLSX.utils.encode_cell({ r, c });
        if (!worksheet[cellRef]) {
          worksheet[cellRef] = { t: topLeftCell.t || 's', v: topLeftValue };
        } else {
          worksheet[cellRef].v = topLeftValue;
        }
      }
    }
  });
}

export function parseExcelFile(file: File): Promise<{ headers: string[]; data: Record<string, string>[][] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        if (!workbook.SheetNames.length) {
          reject(new Error('Excel文件中没有工作表'));
          return;
        }

        let sheetName = workbook.SheetNames[0];
        for (const name of workbook.SheetNames) {
          const nameStr = (name || '').trim();
          if (!nameStr.includes('说明') && !nameStr.includes('使用') && !nameStr.includes('help') && !nameStr.includes('Help')) {
            sheetName = name;
            break;
          }
        }

        const worksheet = workbook.Sheets[sheetName];

        if (!worksheet['!ref']) {
          reject(new Error('Excel文件为空'));
          return;
        }

        const range = XLSX.utils.decode_range(worksheet['!ref']);

        expandMergedCells(worksheet, range);

        const headerRowIndex = findHeaderRow(worksheet, range);

        const headers: string[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = worksheet[XLSX.utils.encode_cell({ r: headerRowIndex, c })];
          let headerValue = (cell?.v || '').toString().trim();

          if (!headerValue) {
            let searchR = headerRowIndex - 1;
            while (searchR >= Math.max(0, headerRowIndex - 4)) {
              const aboveCell = worksheet[XLSX.utils.encode_cell({ r: searchR, c })];
              if (aboveCell?.v) {
                headerValue = aboveCell.v.toString().trim();
                if (!isGroupHeaderRow([headerValue])) {
                  break;
                }
              }
              searchR--;
            }
          }

          headers.push(headerValue || `列${c + 1}`);
        }

        const filteredHeaders = headers.filter(h => h && !h.match(/^列\d+$/));

        if (filteredHeaders.length < 2) {
          reject(new Error('无法识别表头，请检查Excel格式（确保包含"发件人"、"收件人"、"重量"等字段）'));
          return;
        }

        const dataRows: Record<string, string>[][] = [];
        for (let r = headerRowIndex + 1; r <= range.e.r; r++) {
          const row: Record<string, string>[] = [];
          let hasData = false;

          for (let c = range.s.c; c <= range.e.c; c++) {
            let cell = worksheet[XLSX.utils.encode_cell({ r, c })];

            if (!cell || !cell.v) {
              let searchR = r - 1;
              while (searchR > headerRowIndex) {
                const aboveCell = worksheet[XLSX.utils.encode_cell({ r: searchR, c })];
                if (aboveCell?.v) {
                  cell = aboveCell;
                  break;
                }
                searchR--;
              }
            }

            const value = (cell?.v || '').toString().trim();
            if (value) hasData = true;
            row.push({ [headers[c] || `column_${c}`]: value });
          }

          if (!hasData) continue;

          const isNoteRow = row.length > 0 && Object.values(row[0])[0]?.includes('说明');

          if (!isNoteRow) {
            dataRows.push(row);
          }
        }

        if (dataRows.length === 0) {
          reject(new Error('Excel文件中没有有效数据（表头下方没有数据行）'));
          return;
        }

        resolve({ headers, data: dataRows });
      } catch (error) {
        console.error('Parse Excel error:', error);
        reject(error instanceof Error ? error : new Error('Excel文件解析失败'));
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsArrayBuffer(file);
  });
}

export function generateHeaderFingerprint(headers: string[]): string {
  return headers.map((h) => h.toLowerCase().replace(/\s/g, '')).sort().join('|');
}

export function findMatchingField(header: string): OrderItemField | null {
  const normalizedHeader = header.toLowerCase().trim()
    .replace(/[_\-\s]+/g, '')  // 移除下划线、连字符、空格
    .replace(/（/g, '(')       // 中文括号转英文
    .replace(/）/g, ')');
  
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (field === 'id' || field === 'errors') continue;
    
    const exactMatch = aliases.some((alias) => 
      alias.toLowerCase() === normalizedHeader ||
      alias.toLowerCase().replace(/[_\-\s]+/g, '') === normalizedHeader
    );
    
    if (exactMatch) {
      return field as OrderItemField;
    }
  }
  
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (field === 'id' || field === 'errors') continue;
    
    const partialMatch = aliases.some((alias) => {
      const normalizedAlias = alias.toLowerCase().replace(/[_\-\s]+/g, '');
      
      return normalizedHeader.includes(normalizedAlias) || 
             normalizedAlias.includes(normalizedHeader) ||
             calculateSimilarity(normalizedHeader, normalizedAlias) > 0.7;
    });
    
    if (partialMatch) {
      return field as OrderItemField;
    }
  }
  
  return null;
}

function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  
  let matches = 0;
  const shorter = str1.length < str2.length ? str1 : str2;
  const longer = str1.length < str2.length ? str2 : str1;
  
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] === shorter[j]) {
        matchCount++;
      }
    }
    matches = Math.max(matches, matchCount);
  }
  
  return matches / longer.length;
}

export function autoDetectMappings(headers: string[]): ColumnMapping[] {
  const mappings: ColumnMapping[] = [];
  
  for (const header of headers) {
    if (!header) continue;
    const field = findMatchingField(header);
    if (field) {
      mappings.push({ excelColumn: header, systemField: field });
    }
  }
  
  return mappings;
}

export function loadTemplateRules(): TemplateRule[] {
  try {
    const stored = localStorage.getItem('template_rules');
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function saveTemplateRule(mappings: ColumnMapping[]): void {
  const rules = loadTemplateRules();
  const fingerprint = generateHeaderFingerprint(mappings.map((m) => m.excelColumn));
  
  const existingIndex = rules.findIndex((r) => r.headerFingerprint === fingerprint);
  
  const rule: TemplateRule = {
    id: Date.now().toString(),
    name: `模板 ${rules.length + 1}`,
    headerFingerprint: fingerprint,
    mappings,
    createdAt: Date.now(),
  };
  
  if (existingIndex >= 0) {
    rules[existingIndex] = rule;
  } else {
    rules.push(rule);
  }
  
  localStorage.setItem('template_rules', JSON.stringify(rules));
}

export function findMatchingTemplate(headers: string[]): TemplateRule | null {
  const rules = loadTemplateRules();
  const fingerprint = generateHeaderFingerprint(headers.filter((h) => h));
  
  for (const rule of rules) {
    const ruleHeaders = rule.mappings.map((m) => m.excelColumn);
    const ruleFingerprint = generateHeaderFingerprint(ruleHeaders);
    
    if (ruleFingerprint === fingerprint) {
      return rule;
    }
  }
  
  const headersSet = new Set(headers.filter((h) => h).map((h) => h.toLowerCase()));
  for (const rule of rules) {
    const ruleHeadersSet = new Set(rule.mappings.map((m) => m.excelColumn.toLowerCase()));
    const intersection = [...headersSet].filter((h) => ruleHeadersSet.has(h));
    if (intersection.length >= Math.min(headersSet.size, ruleHeadersSet.size) * 0.7) {
      return rule;
    }
  }
  
  return null;
}

export function validateOrderItem(item: OrderItem): FieldError[] {
  const errors: FieldError[] = [];

  if (!item.senderName || !item.senderName.trim()) {
    errors.push({ field: 'senderName', message: '发件人姓名不能为空' });
  }
  
  if (!item.senderPhone || !item.senderPhone.trim()) {
    errors.push({ field: 'senderPhone', message: '发件人电话不能为空' });
  } else if (!/^1[3-9]\d{9}$/.test(item.senderPhone.replace(/\s/g, ''))) {
    errors.push({ field: 'senderPhone', message: '发件人电话格式错误（需为11位手机号）' });
  }
  
  if (!item.senderAddress || !item.senderAddress.trim()) {
    errors.push({ field: 'senderAddress', message: '发件人地址不能为空' });
  }

  if (!item.receiverName || !item.receiverName.trim()) {
    errors.push({ field: 'receiverName', message: '收件人姓名不能为空' });
  }

  if (!item.receiverPhone || !item.receiverPhone.trim()) {
    errors.push({ field: 'receiverPhone', message: '收件人电话不能为空' });
  } else if (!/^1[3-9]\d{9}$/.test(item.receiverPhone.replace(/\s/g, ''))) {
    errors.push({ field: 'receiverPhone', message: '收件人电话格式错误（需为11位手机号）' });
  }
  
  if (!item.receiverAddress || !item.receiverAddress.trim()) {
    errors.push({ field: 'receiverAddress', message: '收件人地址不能为空' });
  }

  if (!item.weight || !item.weight.trim()) {
    errors.push({ field: 'weight', message: '重量不能为空' });
  } else {
    const weight = parseFloat(item.weight);
    if (isNaN(weight) || weight <= 0) {
      errors.push({ field: 'weight', message: '重量必须为正数' });
    }
  }
  
  if (!item.quantity || !item.quantity.trim()) {
    errors.push({ field: 'quantity', message: '件数不能为空' });
  } else {
    const quantity = parseInt(item.quantity, 10);
    if (isNaN(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      errors.push({ field: 'quantity', message: '件数必须为正整数' });
    }
  }
  
  if (!item.temperature || !item.temperature.trim()) {
    errors.push({ field: 'temperature', message: '温层不能为空' });
  } else if (!TEMPERATURE_OPTIONS.includes(item.temperature.trim())) {
    errors.push({ field: 'temperature', message: `温层必须是：${TEMPERATURE_OPTIONS.join('、')}之一` });
  }
  
  return errors;
}

export function convertToOrderItems(
  data: Record<string, string>[][],
  mappings: { excelColumn: string; systemField: OrderItemField }[]
): OrderItem[] {
  const mappingLookup = new Map<string, OrderItemField>();
  for (const mapping of mappings) {
    if (mapping.excelColumn) {
      mappingLookup.set(mapping.excelColumn, mapping.systemField);
    }
  }

  const defaultFields: OrderItemField[] = ['externalCode', 'senderName', 'senderPhone', 'senderAddress', 'receiverName', 'receiverPhone', 'receiverAddress', 'weight', 'quantity', 'temperature', 'remark'];

  return data.map((row, index) => {
    const item: OrderItem = {
      id: `row_${index + 1}`,
      externalCode: '',
      senderName: '',
      senderPhone: '',
      senderAddress: '',
      receiverName: '',
      receiverPhone: '',
      receiverAddress: '',
      weight: '',
      quantity: '',
      temperature: '',
      remark: '',
      errors: [],
    };

    for (const cell of row) {
      const cellKey = Object.keys(cell)[0];
      if (!cellKey) continue;

      const field = mappingLookup.get(cellKey);
      if (field) {
        item[field] = cell[cellKey] || '';
      }
    }

    item.errors = validateOrderItem(item);
    return item;
  });
}

export function findDuplicateExternalCodes(items: OrderItem[]): Map<string, number[]> {
  const codeMap = new Map<string, number[]>();

  items.forEach((item, index) => {
    if (item.externalCode && item.externalCode.trim()) {
      const code = item.externalCode.trim();
      if (!codeMap.has(code)) {
        codeMap.set(code, []);
      }
      codeMap.get(code)!.push(index);
    }
  });

  return new Map([...codeMap].filter(([, indices]) => indices.length > 1));
}

export function findAllDuplicates(items: OrderItem[]): { field: OrderItemField; duplicates: Map<string, number[]> }[] {
  const results: { field: OrderItemField; duplicates: Map<string, number[]> }[] = [];

  // 只有外部编码需要去重
  const externalCodeDuplicates = findDuplicateExternalCodes(items);
  if (externalCodeDuplicates.size > 0) {
    results.push({ field: 'externalCode', duplicates: externalCodeDuplicates });
  }

  return results;
}

export function applyDuplicateValidation(items: OrderItem[], dbDuplicates?: Set<string>): OrderItem[] {
  const allDuplicates = findAllDuplicates(items);

  return items.map((item, index) => {
    const newErrors = [...item.errors];

    allDuplicates.forEach(({ field, duplicates }) => {
      let value = '';
      if (field === 'externalCode') value = (item.externalCode || '').trim();

      if (value && duplicates.has(value)) {
        const indices = duplicates.get(value)!;
        if (indices.indexOf(index) > 0) {
          const firstRow = indices[0] + 1;
          newErrors.push({
            field,
            message: `外部编码重复（与第${firstRow}行重复）`
          });
        }
      }
    });

    if (dbDuplicates && item.externalCode && item.externalCode.trim() && dbDuplicates.has(item.externalCode.trim())) {
      newErrors.push({
        field: 'externalCode',
        message: '外部编码已存在于数据库中'
      });
    }

    return { ...item, errors: newErrors };
  });
}

export async function checkDuplicatesInDatabase(externalCodes: string[]): Promise<Set<string>> {
  const existingCodes = new Set<string>();

  if (externalCodes.length === 0) {
    return existingCodes;
  }

  if (!supabase) {
    return existingCodes;
  }

  try {
    const validCodes = externalCodes.filter(code => code && code.trim()).map(code => code.trim());

    if (validCodes.length === 0) {
      return existingCodes;
    }

    const { data, error } = await supabase
      .from('orders')
      .select('external_code')
      .in('external_code', validCodes);

    if (error) {
      console.warn('检查数据库重复时出错:', error.message);
      return existingCodes;
    }

    if (data && data.length > 0) {
      data.forEach((d: any) => {
        if (d.external_code?.trim()) {
          existingCodes.add(d.external_code.trim());
        }
      });
    }
  } catch (error) {
    console.warn('无法检查数据库重复:', error);
  }

  return existingCodes;
}

export async function checkSingleExternalCodeExists(externalCode: string): Promise<boolean> {
  if (!externalCode || !externalCode.trim()) {
    return false;
  }

  if (!supabase) {
    return false;
  }

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id')
      .eq('external_code', externalCode.trim())
      .limit(1);

    if (error) {
      console.warn('检查外部编码存在性时出错:', error.message);
      return false;
    }

    return data && data.length > 0;
  } catch (error) {
    console.warn('无法检查外部编码:', error);
    return false;
  }
}

export function exportToExcel(items: OrderItem[]): Blob {
  const headers = SYSTEM_FIELDS;
  const data = items.map((item) =>
    headers.map((h) => item[h.key])
  );
  
  const worksheet = XLSX.utils.aoa_to_sheet([headers.map((h) => h.label), ...data]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '运单数据');
  
  const arrayBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}