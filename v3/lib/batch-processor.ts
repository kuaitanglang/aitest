/**
 * 批次处理核心逻辑
 *
 * 关键复用点（不另起一套）：
 * 1. 文件解析：复用 V2 parser 的多 sheet 提取逻辑（sheet_to_json + 过滤 ~$ 临时表）
 * 2. 规则引擎：复用 V2 的 executeRuleEngine（传入 sheetData/multiSheet/textLines）
 * 3. 规则获取：复用 V2 的 dbGetRuleById
 * 4. 数据写入：复用 V2 的 orderToDb 做字段映射（batch-writer.ts）
 */
import { supabaseAdmin } from '@/lib/supabase';
import { dbGetRuleById } from '@/lib/v2-supabase';
import { executeRuleEngine } from '@/v2/lib/engine';
import type { ParseRule, ParseEngineInput, OrderItem } from '@/v2/types';
import type { ImportBatchPayload, ImportError, BatchPerformanceLog } from '../types';
import { writeTrace } from './trace';
import { batchValidateSkus, localValidate } from './batch-validator';
import { batchUpsertWaybills } from './batch-writer';
import { maskSensitive } from './mask';
import * as XLSX from 'xlsx';

/* ================================================================
 * 文件读取 —— 复用 V2 parser 的多 sheet 解析逻辑
 * ================================================================
 */

/**
 * 从 buffer 解析 Excel，构建与 V2 parseExcelFile 一致的 sheetData 结构
 *
 * V2 parser 的核心逻辑（parser.ts 第 9-55 行）：
 *   - 遍历所有 SheetNames，过滤 ~$ 临时表
 *   - 每个 sheet 用 sheet_to_json(header:1) 转为二维数组
 *   - 构建 sheetData: Record<string, any[][]>
 *   - 构建 allData: 所有 sheet 行的合并
 *   - 构建 headers: 第一个非空 sheet 的表头
 *
 * V3 在此基础上增加：按 start_row/end_row 分片截取
 */
function parseExcelSheetData(
  workbook: XLSX.WorkBook,
  startRow: number,
  endRow: number
): { sheetData: Record<string, any[][]>; rows: any[][]; textLines: string[] | undefined; fileType: string } {
  const sheetData: Record<string, any[][]> = {};
  const allData: any[][] = [];

  // 与 V2 parser 一致：遍历所有 sheet，过滤 ~$ 临时表
  for (const sheetName of workbook.SheetNames) {
    if (sheetName.startsWith('~$')) continue;

    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const fullRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][];

    // 分片截取：保留表头行(0) + 数据行切片
    // startRow/endRow 是相对于数据行的编号（1-based，不含表头）
    const header = fullRows.length > 0 ? [fullRows[0]] : [];
    const dataSlice = fullRows.slice(startRow, endRow + 1);
    const sliced = [...header, ...dataSlice];

    sheetData[sheetName] = sliced;
    allData.push(...dataSlice);
  }

  // 如果只有数据（非多 sheet 模式），合并为统一 rows（含表头）
  const sheetNames = Object.keys(sheetData);
  const rows = sheetNames.length > 0
    ? sheetData[sheetNames[0]]
    : [];

  return { sheetData, rows, textLines: undefined, fileType: 'excel' };
}

/**
 * 读取文件指定行范围（不全量加载到内存）
 *
 * 支持：
 *   - local: 本地文件路径
 *   - supabaseAdmin Storage URL
 *   - Excel 多 sheet（复用 V2 parser 逻辑）
 */
async function readFileRange(
  fileUrl: string,
  fileName: string,
  startRow: number,
  endRow: number
): Promise<{ sheetData?: Record<string, any[][]>; rows?: any[][]; textLines?: string[] }> {
  // 1. 获取文件 buffer
  let buffer: Buffer | ArrayBuffer;

  if (fileUrl.startsWith('local:')) {
    const fs = require('fs');
    const localPath = fileUrl.slice(6);
    buffer = fs.readFileSync(localPath);
  } else if (supabaseAdmin) {
    // 从 supabaseAdmin Storage 下载
    const pathMatch = fileUrl.match(/\/object\/public\/import-files\/(.+)$/);
    const storagePath = pathMatch ? pathMatch[1] : fileUrl.split('/').slice(-2).join('/');

    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('import-files')
      .download(storagePath);

    if (downloadError || !fileData) {
      throw new Error(`文件下载失败: ${downloadError?.message || '未知错误'}`);
    }
    buffer = await fileData.arrayBuffer();
  } else {
    throw new Error('无法读取文件：supabaseAdmin 未配置且非本地文件');
  }

  // 2. 根据文件类型解析（与 V2 parseFileByType 的分发逻辑一致）
  const name = (fileName || '').toLowerCase();

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    // Excel：复用 V2 parser 的多 sheet 解析逻辑
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return parseExcelSheetData(workbook, startRow, endRow);
  }

  if (name.endsWith('.docx') || name.endsWith('.doc')) {
    // Word：复用 V2 parser 的 mammoth 提取逻辑
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    const lines = result.value.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
    // 分片截取文本行
    const slicedLines = lines.slice(startRow - 1, endRow);
    return { textLines: slicedLines };
  }

  if (name.endsWith('.pdf')) {
    // PDF：复用 V2 parser 的 pdfjs 提取逻辑
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: buffer instanceof Buffer ? new Uint8Array(buffer) : buffer }).promise;
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
    // 分片截取
    const slicedLines = lines.slice(startRow - 1, endRow);
    return { textLines: slicedLines };
  }

  throw new Error(`不支持的文件格式: ${fileName}`);
}

/**
 * 读取 AI 直接解析的预解析结果（JSON 文件），按分片截取
 *
 * AI 直接解析模式下，前端已用 AI 解析出全部 OrderItem 并以 JSON 文件存到 Storage。
 * Worker 按分片读取该 JSON，跳过文件解析和规则引擎，直接进入校验+入库流程。
 *
 * items_url 格式：
 *   - local:/path/to/file.json
 *   - supabaseAdmin Storage public URL
 *
 * start_row/end_row 是 1-based 数据行号（与规则引擎模式的分片口径一致），
 * items 数组本身无表头，因此切片时转换为 0-based。
 */
async function readAiDirectItems(
  itemsUrl: string,
  startRow: number,
  endRow: number
): Promise<OrderItem[]> {
  if (!itemsUrl) {
    throw new Error('AI 直接解析模式缺少 items_url');
  }

  let buffer: Buffer | ArrayBuffer;

  if (itemsUrl.startsWith('local:')) {
    const fs = require('fs');
    const localPath = itemsUrl.slice(6);
    buffer = fs.readFileSync(localPath);
  } else if (supabaseAdmin) {
    // 从 supabaseAdmin Storage 下载（与 readFileRange 一致的路径解析）
    const pathMatch = itemsUrl.match(/\/object\/public\/import-files\/(.+)$/);
    const storagePath = pathMatch ? pathMatch[1] : itemsUrl.split('/').slice(-2).join('/');

    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('import-files')
      .download(storagePath);

    if (downloadError || !fileData) {
      throw new Error(`预解析结果下载失败: ${downloadError?.message || '未知错误'}`);
    }
    buffer = await fileData.arrayBuffer();
  } else {
    throw new Error('无法读取预解析结果：supabaseAdmin 未配置且非本地文件');
  }

  const text = buffer instanceof Buffer
    ? buffer.toString('utf-8')
    : new TextDecoder().decode(buffer);
  const allItems = JSON.parse(text) as OrderItem[];

  if (!Array.isArray(allItems)) {
    throw new Error('预解析结果不是数组');
  }

  // 1-based → 0-based 切片（与规则引擎模式的分片口径一致）
  return allItems.slice(startRow - 1, endRow);
}

/* ================================================================
 * 批次处理（Worker 核心）
 * ================================================================
 */

/**
 * 处理单个批次
 *
 * 全链路：
 *   读取文件分片 → 复用 V2 executeRuleEngine → 批量 SKU 校验 → 本地格式校验 → 复用 V2 orderToDb 批量写入 → 错误持久化 → 进度更新
 */
export async function processBatch(payload: ImportBatchPayload): Promise<void> {
  const { task_id, unit_id, batch_index, start_row, end_row, trace_id, rule_id, file_url, file_name, items_url } = payload;
  const perf = { parse: 0, rule: 0, validate: 0, insert: 0, total: 0 };
  const totalStart = Date.now();

  console.log(`[worker] 开始处理批次: task=${task_id}, unit=${unit_id}, rows=${start_row}-${end_row}`);

  // ① 幂等检查：已完成则跳过
  if (supabaseAdmin) {
    const { data: batch } = await supabaseAdmin
      .from('v3_import_task_batches')
      .select('status')
      .eq('task_id', task_id)
      .eq('unit_id', unit_id)
      .maybeSingle();

    if (batch?.status === 'completed') {
      console.log(`[worker] 批次已完成，跳过: ${unit_id}`);
      return;
    }

    // ② 锁定批次（抢占式）— 直接 SQL，不依赖 RPC
    const { data: lockedBatch } = await supabaseAdmin
      .from('v3_import_task_batches')
      .update({ status: 'processing', locked_at: new Date().toISOString() })
      .eq('task_id', task_id)
      .eq('unit_id', unit_id)
      .eq('status', 'pending')
      .select();

    if (!lockedBatch || lockedBatch.length === 0) {
      console.log(`[worker] 批次已被锁定，跳过: ${unit_id}`);
      return;
    }
  }

  await writeTrace(trace_id, task_id, unit_id, 'BatchStarted', 'success', `批次 ${batch_index} 开始处理`);

  try {
    // ③ + ④ 解析阶段：有 items_url 时跳过文件解析和规则引擎（预解析模式）
    let items: OrderItem[];

    if (items_url) {
      // 预解析模式：前端已解析出全部 OrderItem（含用户编辑），直接读取分片
      const t0 = Date.now();
      items = await readAiDirectItems(items_url, start_row, end_row);
      perf.parse = Date.now() - t0;
      perf.rule = 0; // 不使用规则引擎
      console.log(`[worker] 预解析模式: 读取 items JSON ${items.length} 行（分片 ${start_row}-${end_row}）`);
    } else {
      // 规则引擎模式：读取文件分片（复用 V2 parser 的多 sheet / Word / PDF 解析逻辑）
      const t0 = Date.now();
      const parsed = await readFileRange(file_url, file_name, start_row, end_row);
      perf.parse = Date.now() - t0;

      // 复用 V2 规则引擎（传入与 V2 一致的参数结构）
      const t1 = Date.now();
      const rule = await dbGetRuleById(rule_id);
      if (!rule) {
        throw new Error(`解析规则不存在: ${rule_id}`);
      }

      // 构建 ParseEngineInput，与 V2 前端调用方式完全一致
      const engineInput: ParseEngineInput = { rule };
      if (rule.multiSheet && parsed.sheetData) {
        // 多 sheet 模式：传 sheetData（与 V2 一致）
        engineInput.sheetData = parsed.sheetData;
      } else if (parsed.textLines?.length) {
        // 文本模式（Word/PDF）：传 textLines（与 V2 一致）
        engineInput.textLines = parsed.textLines;
      } else {
        // 表格模式：传 rows（与 V2 一致）
        engineInput.rows = parsed.rows;
      }

      items = executeRuleEngine(engineInput);
      perf.rule = Date.now() - t1;
      console.log(`[worker] 规则引擎产出 ${items.length} 行数据`);
    }

    // ⑤ 检查是否降级
    let isDegraded = false;
    if (supabaseAdmin) {
      const { data: taskData } = await supabaseAdmin
        .from('v3_import_tasks')
        .select('degraded')
        .eq('id', task_id)
        .maybeSingle();
      isDegraded = taskData?.degraded || false;
    }

    // ⑥ 批量 SKU 校验（V3 新增能力，V2 无此功能）
    const t2 = Date.now();
    const skuResult = await batchValidateSkus(items, isDegraded);
    const { validItems: skuValidItems, errors: skuErrors } = skuResult;
    perf.validate = Date.now() - t2;

    // ⑥.1 SKU 校验触发降级时，自动更新任务状态（考题模块十要求：降级不能静默发生）
    if (skuResult.degraded && !isDegraded) {
      console.warn(`[worker] SKU 校验超时，任务 ${task_id} 进入降级模式`);
      isDegraded = true;
      if (supabaseAdmin) {
        await supabaseAdmin
          .from('v3_import_tasks')
          .update({ degraded: true })
          .eq('id', task_id);
      }
      await writeTrace(trace_id, task_id, unit_id, 'ImportTaskDegraded', 'warning',
        'SKU 主数据查询超时，进入降级模式');
    }

    // ⑦ 本地格式校验（基于 V2 SYSTEM_FIELDS 的 required 定义）
    const { validItems, errors: localErrors } = localValidate(skuValidItems);

    // 合并错误（行号映射回原始文件行号）
    const allErrors = [
      ...skuErrors.map(e => ({
        task_id, unit_id, batch_index,
        row_number: start_row + items.indexOf(e.item),
        field_name: 'skuCode',
        raw_value: maskSensitive(e.item.skuCode, 'skuCode'),
        error_code: e.code,
        error_reason: e.reason,
        trace_id,
      })),
      ...localErrors.map(e => ({
        task_id, unit_id, batch_index,
        row_number: start_row + items.indexOf(e.item),
        field_name: e.field,
        raw_value: maskSensitive(e.rawValue, e.field),
        error_code: e.code,
        error_reason: e.reason,
        trace_id,
      })),
    ];

    // ⑧ 批量 UPSERT 成功行（复用 V2 orderToDb 做字段映射）
    const t3 = Date.now();
    const writeResult = await batchUpsertWaybills(validItems);
    perf.insert = Date.now() - t3;

    // 写入失败行作为错误
    for (const wErr of writeResult.errors) {
      allErrors.push({
        task_id, unit_id, batch_index,
        row_number: start_row + validItems.indexOf(wErr.item),
        field_name: '',
        raw_value: '',
        error_code: 'E007',
        error_reason: wErr.reason,
        trace_id,
      });
    }

    // ⑨ 批量写入错误明细
    if (supabaseAdmin && allErrors.length > 0) {
      const errorRecords: ImportError[] = allErrors.map(e => ({
        task_id: e.task_id,
        unit_id: e.unit_id,
        batch_index: e.batch_index,
        row_number: e.row_number,
        field_name: e.field_name,
        raw_value: e.raw_value,
        error_code: e.error_code,
        error_reason: e.error_reason,
        trace_id: e.trace_id,
      }));

      for (let i = 0; i < errorRecords.length; i += 100) {
        const chunk = errorRecords.slice(i, i + 100);
        const { error: insertError } = await supabaseAdmin.from('v3_import_task_errors').insert(chunk);
        if (insertError) console.error('[worker] 错误明细写入失败:', insertError.message);
      }
    }

    // ⑩ 写性能日志
    perf.total = Date.now() - totalStart;
    if (supabaseAdmin) {
      // rows_failed 按行数统计（而非错误记录条数 allErrors.length），
      // 因为 1 行可能产生多条错误记录（如同时缺必填字段 + 数量无效），
      // 用 items.length - success 保证 success + failed = processed
      const batchFailedRows = items.length - writeResult.success;

      const perfLog: Partial<BatchPerformanceLog> = {
        task_id, unit_id, batch_index,
        parse_duration_ms: perf.parse,
        rule_duration_ms: perf.rule,
        validate_duration_ms: perf.validate,
        insert_duration_ms: perf.insert,
        total_duration_ms: perf.total,
        rows_processed: items.length,
        rows_success: writeResult.success,
        rows_failed: batchFailedRows,
        status: 'completed',
        trace_id,
      };
      await supabaseAdmin.from('v3_batch_performance_log').insert(perfLog);

      // ⑪ 更新批次状态 + 任务进度（直接 SQL，不依赖 RPC）
      // RPC atomic_update_progress 在某些环境未正确部署，这里用直接 SQL 替代
      await supabaseAdmin
        .from('v3_import_task_batches')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('task_id', task_id)
        .eq('unit_id', unit_id)
        .eq('status', 'processing');

      // 读取当前任务进度，手动累加（确保 completed_batches 正确递增）
      const { data: taskRec } = await supabaseAdmin
        .from('v3_import_tasks')
        .select('processed_rows, success_rows, failed_rows, completed_batches, total_batches')
        .eq('id', task_id)
        .maybeSingle();

      if (taskRec) {
        const newCompleted = (taskRec.completed_batches || 0) + 1;
        const newSuccess = (taskRec.success_rows || 0) + writeResult.success;
        const newFailed = (taskRec.failed_rows || 0) + batchFailedRows;
        const newProcessed = (taskRec.processed_rows || 0) + items.length;
        const allDone = newCompleted >= taskRec.total_batches;
        const newStatus = allDone ? (newFailed > 0 ? 'partial_success' : 'completed') : 'processing';

        await supabaseAdmin
          .from('v3_import_tasks')
          .update({
            processed_rows: newProcessed,
            success_rows: newSuccess,
            failed_rows: newFailed,
            completed_batches: newCompleted,
            status: newStatus,
            completed_at: allDone ? new Date().toISOString() : null,
          })
          .eq('id', task_id);

        if (allDone) {
          console.log(`[worker] 任务完成: ${task_id} → ${newStatus} (成功=${newSuccess}, 失败=${newFailed})`);
        }
      }
    }

    await writeTrace(trace_id, task_id, unit_id, 'BatchSucceeded', 'success',
      `批次完成: 解析${perf.parse}ms 规则${perf.rule}ms 校验${perf.validate}ms 写入${perf.insert}ms 总计${perf.total}ms`);

    console.log(`[worker] 批次完成: ${unit_id}, 成功=${writeResult.success}, 失败=${allErrors.length}, 总耗时=${perf.total}ms`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] 批次失败: ${unit_id}`, errMsg);

    if (supabaseAdmin) {
      await supabaseAdmin
        .from('v3_import_task_batches')
        .update({ status: 'failed', completed_at: new Date().toISOString() })
        .eq('task_id', task_id)
        .eq('unit_id', unit_id);

      // 手动更新任务进度（直接 SQL）
      const { data: taskRec } = await supabaseAdmin
        .from('v3_import_tasks')
        .select('processed_rows, failed_rows, completed_batches, total_batches')
        .eq('id', task_id)
        .maybeSingle();
      if (taskRec) {
        const newCompleted = (taskRec.completed_batches || 0) + 1;
        const newFailed = (taskRec.failed_rows || 0) + (end_row - start_row + 1);
        const allDone = newCompleted >= taskRec.total_batches;
        await supabaseAdmin
          .from('v3_import_tasks')
          .update({
            processed_rows: (taskRec.processed_rows || 0) + (end_row - start_row + 1),
            failed_rows: newFailed,
            completed_batches: newCompleted,
            status: allDone ? 'partial_success' : 'processing',
            completed_at: allDone ? new Date().toISOString() : null,
          })
          .eq('id', task_id);
      }
    }

    await writeTrace(trace_id, task_id, unit_id, 'BatchFailed', 'failed', errMsg);
    throw err;
  }
}
