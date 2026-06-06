import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { ParsedFileData } from '../types';

function linesToRows(lines: string[]): any[][] {
  return lines.filter((l) => l.trim()).map((line) => [line]);
}

export async function parseExcelFile(file: File): Promise<ParsedFileData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      // 使用 setTimeout(0) 将解析操作放到下一个事件循环，避免阻塞 UI
      setTimeout(() => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });

          const sheetData: Record<string, any[][]> = {};
          const allData: any[][] = [];
          let allHeaders: string[] = [];
          const MAX_PREVIEW_ROWS = 10000; // 限制最大读取行数，防止超大文件卡死

          for (const sheetName of workbook.SheetNames) {
            const worksheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][];

            // 对于大文件，只取前 MAX_PREVIEW_ROWS 行用于预览
            const limitedJson = json.length > MAX_PREVIEW_ROWS ? json.slice(0, MAX_PREVIEW_ROWS) : json;

            sheetData[sheetName] = limitedJson;
            if (limitedJson.length > 0 && !allHeaders.length) {
              allHeaders = limitedJson[0].map((h: unknown) => String(h || '').trim());
            }
            allData.push(...limitedJson);
          }

          resolve({
            headers: allHeaders,
            data: allData,
            sheets: workbook.SheetNames.filter((n) => !n.startsWith('~$')),
            sheetData,
            fileType: 'excel',
            // 标记是否被截断，供上层提示用户
            truncated: allData.length >= MAX_PREVIEW_ROWS,
          });
        } catch (error) {
          reject(error);
        }
      }, 0);
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export async function parseWordFile(file: File): Promise<ParsedFileData> {
  const buffer = await file.arrayBuffer();
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    const lines = result.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const data = linesToRows(lines);
    return {
      headers: ['内容行'],
      data,
      sheets: ['document'],
      sheetData: { document: data },
      fileType: 'word',
      textLines: lines,
    };
  } catch (err) {
    throw new Error(`Word 文件解析失败：${err instanceof Error ? err.message : err}`);
  }
}

export async function parsePdfFile(file: File): Promise<ParsedFileData> {
  const buffer = await file.arrayBuffer();
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // 使用本地 public 目录下的 worker 文件，避免 CDN 加载失败
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

    const pdf = await pdfjs.getDocument({ data: buffer }).promise;
    const lines: string[] = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let lastY: number | null = null;
      let line = '';
      for (const item of content.items as Array<{ str: string; transform: number[] }>) {
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 4) {
          if (line.trim()) lines.push(line.trim());
          line = item.str;
        } else {
          line += (line ? ' ' : '') + item.str;
        }
        lastY = y;
      }
      if (line.trim()) lines.push(line.trim());
      if (p < pdf.numPages) lines.push('---PAGE---');
    }

    const data = linesToRows(lines);
    return {
      headers: ['内容行'],
      data,
      sheets: ['pdf'],
      sheetData: { pdf: data },
      fileType: 'pdf',
      textLines: lines,
    };
  } catch (err) {
    throw new Error(`PDF 文件解析失败：${err instanceof Error ? err.message : err}`);
  }
}

export async function parseFileByType(file: File): Promise<ParsedFileData> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return parseExcelFile(file);
  if (name.endsWith('.docx') || name.endsWith('.doc')) return parseWordFile(file);
  if (name.endsWith('.pdf')) return parsePdfFile(file);
  throw new Error('不支持的文件格式，请上传 Excel (.xlsx/.xls)、Word (.docx) 或 PDF');
}

export function exportToExcel(items: import('../types').OrderItem[]): Blob {
  const headers = [
    '外部编码', '收货门店', '收件人姓名', '收件人电话', '收件人地址',
    'SKU物品编码', 'SKU物品名称', 'SKU发货数量', 'SKU规格型号', '备注',
  ];
  const fields = [
    'externalCode', 'storeName', 'receiverName', 'receiverPhone', 'receiverAddress',
    'skuCode', 'skuName', 'skuQuantity', 'skuSpec', 'remark',
  ] as const;

  const data = items.map((item) => fields.map((field) => (item as unknown as Record<string, string>)[field] || ''));
  data.unshift(headers);

  const worksheet = XLSX.utils.aoa_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '运单数据');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
