/**
 * 大模型（LLM）接入层
 * ---------------------
 * 设计目标：
 *   - 与 OpenAI Chat Completions 接口**完全兼容**，从而天然支持：
 *       DeepSeek / SiliconFlow / 通义千问 (Qwen) / 智谱 GLM / 月之暗面 Kimi /
 *       Anthropic Claude (通过兼容代理) / Ollama (openai 兼容模式) / 本地 vLLM 等
 *   - 参数 (baseUrl/apiKey/model) 来自 runtime 请求体（前端 localStorage 或 .env），
 *     不做硬编码，便于直接在页面里切换服务商。
 *   - 对大文件做"截断采样"，防止超出 token 限制；
 *   - 返回的 JSON 结果通过 zod 做一次 schema 校验，便于前端直接消费。
 *
 * 使用：
 *   import { suggestRuleWithLLM, AISuggestRuleInput } from '@/v2/lib/ai';
 *   const result = await suggestRuleWithLLM({ rows, headers, userHint, provider });
 */

import { z } from 'zod';

/**
 * 自动检测表头所在行索引
 * 策略：寻找同时包含多个"疑似列名关键词"的行
 * 常见表头特征：序号、编号、SKU、商品、物品、名称、规格、数量、单位、单价、金额、备注、门店、收货人、电话、地址、日期
 */
export function detectHeaderRow(rows: any[][]): number {
  if (!rows || rows.length === 0) return 0;

  const HEADER_KEYWORDS = [
    '序号', '编号', 'NO', 'no.', '#',
    'SKU', 'sku', '物品', '商品', '货品', '物料', '产品', '编码', '代码', '条码',
    '名称', '品名', '规格', '型号', '单位',
    '数量', '件数', 'qty', '数量\\(', '应发', '实发', '在库', '可用',
    '单价', '金额', '小计', '合计', '总价',
    '备注', '说明', '备注信息', '附加',
    '门店', '店铺', '机构', '收货方', '调入',
    '收货人', '收件人', '联系人', '收方',
    '电话', '手机', '联系方式', '联系电话',
    '地址', '详细地址', '收货地址',
    '日期', '时间', '单号', '订单', '订单', '配送', '外部',
    '外部编码', '外部订单', '客户单号', '配送汇总', '单据号',
    '物品类别', '物品编码', '物品名称', '规格型号', '订货单位', '发货数量',
  ];

  // 对每一行计算"表头特征得分"——搜索全部行（PDF 表头可能在任意位置，如数据中间或页脚区域）
  let bestRow = 0;
  let bestScore = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const line = row.map((cell: any) => String(cell ?? '').trim()).join(' ');
    // 跳过太短的行
    if (line.length < 6) continue;
    const nonEmptyCells = row.filter((c: any) => String(c ?? '').trim());
    // PDF 模式：每行可能只有 1 个 cell 但包含完整表头文本，不能按 cell 数量过滤
    // 只在多 cell 模式下跳过明显非表头的短行
    // PDF 模式：每行可能只有 1 个 cell 但包含完整表头文本，不要按 cell 数量跳过
    // 只在多 cell(>=3) 模式下，跳过没有数字的短行（标题行）
    if (nonEmptyCells.length >= 3 && line.length < 15 && !/\d/.test(line)) continue;

    let score = 0;
    for (const keyword of HEADER_KEYWORDS) {
      try {
        const regex = new RegExp(keyword, 'i');
        if (regex.test(line)) score++;
      } catch { /* skip */ }
    }
    // 多单元格加分
    if (nonEmptyCells.length >= 4) score += 2;
    if (nonEmptyCells.length >= 6) score += 3;
    // 强信号：同时包含 PDF 表格典型列名中的多个（高权重区分真正的表头行）
    const strongSignals = ['物品类别', '物品编码', '物品名称', '规格型号', '发货数量', '订货单位'];
    let strongCount = 0;
    for (const s of strongSignals) {
      if (line.includes(s)) strongCount++;
    }
    score += strongCount * 3; // 每个强信号 +3 分

    // 惩罚：包含大量中文冒号的行通常是元信息/键值对（如"单据编号：xxx"），不是表头
    const colonCount = (line.match(/：/g) || []).length;
    if (colonCount >= 2 && strongCount === 0) {
      score -= colonCount * 2; // 每个冒号 -2 分（强信号行不受影响）
    }

    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }

  // 如果最佳得分太低（<2），可能文件结构特殊，回退到第0行或第1行
  if (bestScore < 2) {
    // 尝试找第一个有>=3个非空单元格的行
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const nonEmpty = (rows[i] || []).filter((c: any) => String(c ?? '').trim());
      if (nonEmpty.length >= 3) return i;
    }
  }

  return bestRow;
}

/**
 * 清理 baseUrl：移除首尾空格、反引号、单/双引号
 */
function cleanUrl(raw: string): string {
  return raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
}

/** 允许前端传入的供应商配置 */
export const AIProviderSchema = z.object({
  baseUrl: z.string().default('https://api.deepseek.com'),
  apiKey: z.string().min(1, '请先配置 API Key'),
  model: z.string().optional().default('deepseek-chat'),
  temperature: z.number().min(0).max(2).optional().default(0.2),
  /** 上传给模型的样本行数 */
  sampleRowLimit: z.number().int().positive().optional().default(100),
});

export type AIProviderConfig = z.infer<typeof AIProviderSchema>;

/** 单个字段映射的输出结构 */
const FieldMappingOutputSchema = z.object({
  sourceColumn: z.string().min(1, '源列名不能为空'),
  targetField: z.enum([
    'externalCode', 'storeName', 'receiverName', 'receiverPhone', 'receiverAddress',
    'skuCode', 'skuName', 'skuQuantity', 'skuSpec', 'remark',
  ]),
  mappingType: z.enum(['direct', 'regex', 'composite']).default('direct'),
  regexPattern: z.string().optional(),
  speculative: z.boolean().optional(),
});

/** 提取规则（对应 "页眉/尾部 信息"，如"收件人电话：XXX"） */
const ExtractionRuleOutputSchema = z.object({
  name: z.string().optional().default(''),
  pattern: z.string().optional().default(''),
  targetField: z.enum([
    'externalCode', 'storeName', 'receiverName', 'receiverPhone', 'receiverAddress',
    'skuCode', 'skuName', 'skuQuantity', 'skuSpec', 'remark',
  ]).optional(),
  regex: z.string().optional(),
  defaultValue: z.string().optional(),
});

const TransposeConfigSchema = z.object({
  type: z.enum(['matrix', 'double']).default('matrix'),
  rowHeaderColumn: z.string().default(''),
  columnHeaderRow: z.number().int().min(0).default(0),
  valueColumn: z.string().optional(),
  lineSeparator: z.string().optional(),
  compositePattern: z.string().optional(),
}).optional();

export const AISuggestRuleOutputSchema = z.object({
  name: z.string().min(1, '请提供规则名'),
  description: z.string().default(''),
  parseMode: z.enum(['table', 'card', 'transpose', 'text']).default('table'),
  multiSheet: z.boolean().default(false),
  cardMarker: z.string().optional(),
  headerSkipRows: z.number().int().min(0).default(0),
  footerSkipRows: z.number().int().min(0).default(30),
  dataStartRow: z.number().int().min(0).default(0),
  dataEndRow: z.number().int().min(0).optional(),
  skipPatterns: z.array(z.string()).default([]),
  aggregateBy: z.string().optional(),
  transposeConfig: TransposeConfigSchema,
  fieldMappings: z.array(FieldMappingOutputSchema).min(1, '至少识别出一个字段映射'),
  extractionRules: z.array(ExtractionRuleOutputSchema).default([]),
  aiConfidence: z.number().min(0).max(1).default(0.7),
});

export type AISuggestRuleOutput = z.infer<typeof AISuggestRuleOutputSchema>;

/** 输入参数：原始二维数据 + 表头索引 + 用户提示 + 供应商 */
export interface AISuggestRuleInput {
  rows: any[][];
  /** 表头所在行索引（通常为 0）。解析器会从此行读取 sourceColumn 名称 */
  headerRowIndex?: number;
  /** 用户在 UI 上填写的补充信息：如"这是一份电商订单 Excel，收货门店在 A 列" */
  userHint?: string;
  /** API 提供者配置 */
  provider: AIProviderConfig;
}

/** 聊天消息类型（与 OpenAI 一致） */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/* ========================================================================
 * Prompt 构造 —— 这里是核心"能力"所在：把业务意图写清楚
 * ====================================================================== */

function buildPrompt(input: AISuggestRuleInput): {
  messages: ChatMessage[];
  totalChars: number;
  detectedHeaderRow: number;
} {
  const { rows, userHint } = input;

  // 自动检测表头行（不再依赖外部传入的 headerRowIndex）
  const detectedHeaderRow = detectHeaderRow(rows);
  const headerRowIndex = detectedHeaderRow;

  const headers: string[] =
    (rows[headerRowIndex] || []).map((h: any) =>
      typeof h === 'string' ? h.trim() : String(h ?? '').trim()
    ) || [];

  // 样本数据：取表头下 sampleRowLimit 行，每列只保留前 80 字，控制 token
  const sampleRowLimit = Math.min(input.provider.sampleRowLimit ?? 100, Math.max(1, rows.length - 1));
  const sampleRows: any[][] = [];
  for (let i = headerRowIndex + 1; i < Math.min(rows.length, headerRowIndex + 1 + sampleRowLimit); i++) {
    if (!rows[i]) continue;
    sampleRows.push(rows[i].map((cell: any) => {
      const s = String(cell ?? '').trim();
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    }));
  }

  // 表头前的行（用于识别标题行、页眉信息）
  const preHeaderRows: any[][] = [];
  for (let i = 0; i < headerRowIndex; i++) {
    if (!rows[i]) continue;
    preHeaderRows.push(rows[i].map((cell: any) => {
      const s = String(cell ?? '').trim();
      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    }));
  }

  const totalRows = rows.length;
  const tailStart = Math.max(headerRowIndex + sampleRows.length + 1, totalRows - 6);
  const tailRows: any[][] = [];
  for (let i = tailStart; i < totalRows; i++) {
    if (!rows[i]) continue;
    tailRows.push(rows[i].map((cell: any) => {
      const s = String(cell ?? '').trim();
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    }));
  }

  // 分析文件结构特征
  const structureAnalysis = analyzeFileStructure(rows, headerRowIndex, headers);

  const systemPrompt = [
    `你是一个"Excel/表格文件解析规则生成专家"。你的任务是把用户上传的订单/发货/入库 Excel 表格，`,
    `转换成一套**精确可执行**的结构化解析规则。`,
    ``,
    `## 目标系统字段（targetField 枚举）`,
    `- externalCode  : 订单/订单/单据的外部编号（如"订单号"、"订单号"、"配送单号"）`,
    `- storeName     : 收货门店 / 机构名称 / 店铺名称`,
    `- receiverName  : 收件人姓名 / 联系人`,
    `- receiverPhone : 收件人电话（手机号 / 座机）`,
    `- receiverAddress: 收件人地址 / 详细地址`,
    `- skuCode       : SKU 编码 / 商品编码 / 物料编号 / 物品编码`,
    `- skuName       : SKU 名称 / 商品名称 / 物品名称 / 品名`,
    `- skuQuantity   : 发货数量（必须是正数数字。如果值是"1件""2箱"，提取数字部分）`,
    `- skuSpec       : SKU 规格 / 型号 / 规格型号`,
    `- remark        : 备注 / 说明 / 附加信息`,
    ``,
    `## 解析模式判断（parseMode）— 必须正确选择！`,
    `- "table"（标准表格）：最常见的格式，每行是一条数据记录，第一行是表头。`,
    `  适用：90% 的订单/发货单 Excel 文件。`,
    `- "card"（卡片式）：一个文件包含多张"卡片"，每张卡片是一个独立订单。`,
    `  特征：有分隔标记（如 ▶、或"订单号："开头），每个区块有自己的表头+数据。`,
    `  适用：门店调拨单、多个订单合在一个 sheet 的场景。`,
    `- "transpose"（矩阵转置）：行是 SKU，列是门店/日期，单元格是数量。`,
    `  特征：表头行第一个单元格是空的或写着"商品/SKU"，后续列是门店名；数据行首列是 SKU 名。`,
    `- "text"（纯文本）：不是标准表格，而是自由格式的文本行。`,
    ``,
    `## 结构分析要求 — 最重要！`,
    ``,
    `### 第一步：确定真正的表头位置`,
    `- 我已经帮你检测到：第 ${headerRowIndex + 1} 行（索引 ${headerRowIndex}）最可能是表头行。`,
    `- 表头前的 ${preHeaderRows.length} 行是标题/页眉区域（可能是文件标题、日期、单号等信息）。`,
    `- 你必须基于第 ${headerRowIndex + 1} 行的表头来设置 sourceColumn！`,
    ``,
    `### 第二步：设置正确的行参数`,
    `- headerSkipRows = ${headerRowIndex}（表头前有多少行需要跳过，即标题行数）`,
    `- dataStartRow = ${headerRowIndex}（表头本身所在的行索引，从0开始）`,
    `- 如果表头下面紧跟着就是数据行，不需要额外调整`,
    `- 如果表头和数据之间有空行/合并行，dataStartRow 保持为 ${headerRowIndex} 即可（引擎会自动处理）`,
    ``,
    `### 第三步：精确匹配 sourceColumn`,
    `- sourceColumn 必须和下面的「表头样本」中的文字完全一致！`,
    `- 包括空格、全角/半角符号、括号等所有字符`,
    `- 如果表头是 "商品名称(必填)"，sourceColumn 就必须写 "商品名称(必填)"，不能简写成 "商品名称"`,
    `- 如果你不确定某个列的确切名称，宁可不要放入 fieldMappings，也不要猜！`,
    ``,
    `### 第四步：验证映射合理性`,
    `- 检查每个 sourceColumn 在表头样本中确实存在`,
    `- 检查数据样本中对应列的内容与 targetField 的语义一致`,
    `- 例如 skuQuantity 对应的列应该包含数字，skuName 对应的列应该包含文字名称`,
    ``,
    structureAnalysis,
    ``,
    `## 输出格式（严格 JSON，不要 markdown 代码块，不要注释）`,
    `{`,
    `  "name": "短规则名，如：XX发货单规则",`,
    `  "description": "2-3句话说明适用文件特征和字段映射",`,
    `  "parseMode": "table|card|transpose|text（根据上面分析选择正确的模式）",`,
    `  "headerSkipRows": ${headerRowIndex},`,
    `  "dataStartRow": ${headerRowIndex},`,
    `  "skipPatterns": ["合计","小计","总计","共计","Total","本页合计"],`,
    `  "aggregateBy": "",`,
    `  "aiConfidence": 0.8,`,
    `  "fieldMappings": [`,
    `     { "sourceColumn": "和表头样本完全一致的列名", "targetField": "目标枚举值", "mappingType": "direct" },`,
    `     ...至少要有 skuCode/skuName/skuQuantity 三个必填字段的映射`,
    `  ],`,
    `  "extractionRules": [`,
    `     仅当表头前的区域有明显键值对信息时才添加，如 "配送单号：PS2512220005001"`,
    `     不要凭空捏造！`,
    `  ]`,
    `}`,
    ``,
    `## 最终检查清单（输出前必须逐条确认）`,
    `1. parseMode 是否与文件结构匹配？`,
    `2. headerSkipRows 和 dataStartRow 是否指向正确的表头行？`,
    `3. 每个 sourceColumn 是否在表头样本中能找到完全一致的匹配？`,
    `4. 是否包含了 skuCode、skuName、skuQuantity 这三个必填字段的映射？`,
    `5. extractionRules 中的 pattern 是否真的出现在文件的页眉/页脚区域？`,
    `6. 整体输出是否是合法 JSON（无注释、无尾逗号、无未转义字符）？`,
  ].join('\n');

  const userPrompt = [
    `## 文件基本信息`,
    `- 总行数（含表头）：${totalRows}`,
    `- 总列数（按表头计）：${headers.length}`,
    `- 自动检测到的表头行：第 ${headerRowIndex + 1} 行（索引 ${headerRowIndex}）`,
    '',
    preHeaderRows.length > 0 ? (
      `## 表头前的区域（${preHeaderRows.length} 行，可能含标题/单号/日期等页眉信息）\n` +
      preHeaderRows.map((row, idx) => `  [行${idx}] ${row.map((c) => JSON.stringify(c)).join(' | ')}`).join('\n') +
      '\n'
    ) : '',
    `## 表头样本（第 ${headerRowIndex + 1} 行，共 ${headers.length} 列）`,
    headers.map((h, idx) => `  列${idx + 1}: [${JSON.stringify(h)}]`).join('\n'),
    '',
    `## 数据样本（表头后的前 ${sampleRows.length} 行数据）`,
    sampleRows.map((row, idx) => `  [行${headerRowIndex + 1 + idx}] ${row.map((c) => JSON.stringify(c)).join(' | ')}`).join('\n'),
    '',
    tailRows.length > 0 ? (
      `## 文件尾部样本（最后 ${tailRows.length} 行，便于识别合计行/页脚信息）\n` +
      tailRows.map((row) => `  - ${row.map((c) => JSON.stringify(c)).join(' | ')}`).join('\n') +
      '\n'
    ) : '',
    userHint ? `## 用户补充提示\n${userHint}\n` : '',
    `请严格按系统提示的 JSON schema 输出解析规则。确保 sourceColumn 与上面的表头样本完全一致。`,
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const totalChars = systemPrompt.length + userPrompt.length;
  return { messages, totalChars, detectedHeaderRow: headerRowIndex };
}

/**
 * 分析文件结构特征，生成一段描述性文本插入到 prompt 中
 */
function analyzeFileStructure(rows: any[][], headerIdx: number, headers: string[]): string {
  const lines: string[] = ['', '## 文件结构特征分析'];

  // 表头前行分析
  if (headerIdx > 0) {
    lines.push(`- 检测到表头前有 ${headerIdx} 行非数据内容（可能是标题行、合并单元格标题、日期、单号等）`);
    for (let i = 0; i < Math.min(headerIdx, 5); i++) {
      const rowText = (rows[i] || []).map((c: any) => String(c ?? '').trim()).filter(Boolean).join(' | ');
      lines.push(`  · 行${i + 1}: "${rowText.slice(0, 100)}${rowText.length > 100 ? '...' : ''}"`);
    }
  } else {
    lines.push('- 第1行即为表头（无前置标题行）');
  }

  // 表头宽度分析
  const nonEmptyHeaders = headers.filter((h) => h.trim());
  lines.push(`- 表头有效列数: ${nonEmptyHeaders.length}/${headers.length}`);

  // 数据行初步检查
  let dataRowCount = 0;
  let emptyRowCount = 0;
  let skipCandidateCount = 0;
  const SKIP_KEYWORDS = ['合计', '小计', '总计', '共计', 'Total', '本页合计', '汇总'];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const line = row.map((c: any) => String(c ?? '').trim()).join('');
    if (!line) { emptyRowCount++; continue; }
    dataRowCount++;
    if (SKIP_KEYWORDS.some((k) => line.includes(k))) skipCandidateCount++;
  }
  lines.push(`- 表头后数据区: 约 ${dataRowCount} 行有效数据, ${emptyRowCount} 行空行`);
  if (skipCandidateCount > 0) {
    lines.push(`- 检测到约 ${skipCandidateCount} 行疑似汇总/合计行（应加入 skipPatterns）`);
  }

  // 判断可能的解析模式
  const firstDataLine = headerIdx + 1 < rows.length
    ? (rows[headerIdx + 1] || []).map((c: any) => String(c ?? '').trim()).join(' ')
    : '';
  if (firstDataLine.includes('▶') || firstDataLine.includes('━━━')) {
    lines.push('- ⚠️ 检测到卡片分隔符 → 建议 parseMode = "card"');
  }
  // 矩阵转置检测：第一列是名称，后面很多列都是数字
  const matrixLikely = headerIdx + 1 < rows.length && (rows[headerIdx + 1] || []).length >= 4;
  if (matrixLikely) {
    const firstDataRow = rows[headerIdx + 1] || [];
    const nonEmptyInFirstData = firstDataRow.filter((c: any) => String(c ?? '').trim());
    if (nonEmptyInFirstData.length >= 4) {
      const numericCount = firstDataRow.slice(1).filter((c: any) => /^[\d.]+$/.test(String(c ?? '').trim())).length;
      if (numericCount >= Math.max(2, firstDataRow.length * 0.5)) {
        lines.push('- ⚠️ 检测到矩阵结构（首列文本+后续多列为数字）→ 建议 parseMode = "transpose"');
      }
    }
  }

  return lines.join('\n');
}

/* ========================================================================
 * API 调用层
 * ====================================================================== */

/** 通用 OpenAI Chat Completions 请求体 */
interface OpenAIRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

/** 最小化的响应结构（忽略其他字段，只取 content） */
interface OpenAIResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  error?: { message: string; code?: string };
}

/**
 * 调用 LLM 并解析成 AISuggestRuleOutput。
 * 会做：
 *   1) 自动检测表头行位置（不再依赖外部传入 headerRowIndex）
 *   2) Prompt 构造 + 采样行截断
 *   3) 请求 body 组装（兼容 OpenAI Chat Completions）
 *   4) 响应体 JSON 提取 + zod schema 校验
 *   5) 生成后自验证：用规则试解析样本数据，如果结果为空则尝试自动修正
 */
export async function suggestRuleWithLLM(input: AISuggestRuleInput): Promise<{
  rule: AISuggestRuleOutput;
  totalChars: number;
  rawResponse: string;
  detectedHeaderRow: number;
  validationPassed: boolean;
}> {
  const provider = AIProviderSchema.parse(input.provider);

  // 规范化 baseUrl：移除空格、反引号、引号等干扰字符
  let baseUrl = (provider.baseUrl || '')
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim()
    .replace(/\/+$/, '');

  // 如果用户直接给了"站点域名"，补全到 v1；若用户已明确指定到 chat/completions 则跳过
  if (!/chat\/completions$/.test(baseUrl)) {
    baseUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  }

  const { messages, totalChars, detectedHeaderRow } = buildPrompt(input);

  const body: OpenAIRequest = {
    model: provider.model!,
    messages,
    temperature: provider.temperature,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        'Accept-Encoding': 'identity',
      },
      body: JSON.stringify(body),
      // Node 环境下 fetch 不会自动超时，这里手工设 60s
      signal: AbortSignal.timeout ? AbortSignal.timeout(60_000) : undefined,
    } as RequestInit);
  } catch (err: any) {
    throw new Error(`调用大模型 API 失败：${err?.message ?? err}`);
  }

  if (!response.ok) {
    let text = '';
    try { text = await response.text(); } catch { /* ignore */ }
    throw new Error(`大模型 API 返回 ${response.status}：${text.slice(0, 400) || response.statusText}`);
  }

  let data: OpenAIResponse;
  try {
    data = (await response.json()) as OpenAIResponse;
  } catch (err: any) {
    throw new Error(`大模型 API 返回的不是合法 JSON：${err?.message ?? err}`);
  }

  if (data.error?.message) {
    throw new Error(`大模型 API 报错：${data.error.message}（code=${data.error.code ?? '—'}）`);
  }

  const rawResponse = data.choices?.[0]?.message?.content ?? '';

  if (!rawResponse.trim()) {
    throw new Error('大模型返回了空内容');
  }

  // 预清理：移除 BOM、零宽字符、控制字符（保留换行和制表符）
  // 并修复模型常见的无效转义符（如 \x \s 等）
  const cleaned = rawResponse
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\uFEFF]/g, '')
    // 修复单反斜杠后面跟着非法转义字符的情况（合法转义: \" \\ \/ \b \f \n \r \t \u）
    .replace(/\\([^"'\\\/bfnrtu]|u(?![\da-fA-F]{4}))/g, '\\\\$1')
    .trim();

  if (!cleaned) {
    throw new Error('大模型返回内容清理后为空');
  }

  // 多级 JSON 解析策略：逐级降级尝试（Level 0 → Level 4）
  let parsed: any = null;
  let parseError = '';
  const tryParse = (text: string) => {
    try { return JSON.parse(text); } catch (e: any) { parseError = e?.message || String(e); return null; }
  };

  // Level 0: 直接解析清理后的文本
  parsed = tryParse(cleaned);

  // Level 1: 提取 ```json ... ``` 代码块后再清理
  if (!parsed) {
    const codeMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeMatch) {
      const inner = codeMatch[1]
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\uFEFF]/g, '')
        .replace(/\\([^"'\\\/bfnrtu]|u(?![\da-fA-F]{4}))/g, '\\\\$1');
      parsed = tryParse(inner);
    }
  }

  // Level 2: 提取第一个 {...} 对象
  if (!parsed) {
    const firstObj = cleaned.indexOf('{');
    const lastObj = cleaned.lastIndexOf('}');
    if (firstObj >= 0 && lastObj > firstObj) {
      parsed = tryParse(cleaned.slice(firstObj, lastObj + 1));
    }
  }

  // Level 3: 激进清理 — 移除所有不在合法JSON转义序列中的反斜杠
  if (!parsed) {
    const aggressive = cleaned
      .replace(/\\(?!["\\/bfnrtu])/g, '')
      .replace(/[\u0000-\u001F\u200B-\u200F\uFEFF]/g, '');
    const aFirst = aggressive.indexOf('{');
    const aLast = aggressive.lastIndexOf('}');
    if (aFirst >= 0 && aLast > aFirst) {
      parsed = tryParse(aggressive.slice(aFirst, aLast + 1));
    }
  }

  // Level 4: 根据错误位置精确定位修复（针对 Bad escaped character）
  if (!parsed && parseError.includes('Bad escaped')) {
    const posMatch = parseError.match(/position\s+(\d+)/);
    const errPos = posMatch ? Number(posMatch[1]) : -1;
    if (errPos >= 0 && errPos < cleaned.length) {
      let fixed = cleaned.slice(0, errPos) + cleaned.slice(errPos + 1);
      for (let attempt = 0; attempt < 10; attempt++) {
        parsed = tryParse(fixed);
        if (parsed) break;
        const bsIdx = fixed.indexOf('\\', Math.max(0, errPos - 20));
        if (bsIdx >= 0 && bsIdx < fixed.length - 1) {
          const nextChar = fixed.charAt(bsIdx + 1);
          if (!'"\\/bfnrtu'.includes(nextChar)) {
            fixed = fixed.slice(0, bsIdx) + fixed.slice(bsIdx + 1);
          } else {
            fixed = fixed.slice(0, bsIdx + 1) + fixed.slice(bsIdx + 2);
          }
        } else { break; }
      }
      if (!parsed) {
        const fO = fixed.indexOf('{');
        const lO = fixed.lastIndexOf('}');
        if (fO >= 0 && lO > fO) parsed = tryParse(fixed.slice(fO, lO + 1));
      }
    }
  }

  if (!parsed) {
    const preview = cleaned.slice(0, 500).replace(/\n/g, '\\n');
    throw new Error(
      `JSON 解析失败(${parseError})，前500字符：\n${preview}${cleaned.length > 500 ? '...' : ''}`
    );
  }
  const validated = AISuggestRuleOutputSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`大模型返回 JSON 不合规：\n${issues}`);
  }

  const rule = validated.data;

  // ========== 生成后自验证 ==========
  // 用生成的规则对原始数据做一次快速校验，检查 sourceColumn 是否能匹配到实际表头
  const validationPassed = validateGeneratedRule(rule, input.rows, detectedHeaderRow);

  return { rule, totalChars, rawResponse, detectedHeaderRow, validationPassed };
}

/**
 * 验证生成的规则是否能正确匹配原始数据的表头
 * 返回 true 表示验证通过（sourceColumn 都能在表头中找到）
 */
function validateGeneratedRule(
  rule: AISuggestRuleOutput,
  rows: any[][],
  headerRowIndex: number
): boolean {
  const headerRow = rows[headerRowIndex];
  if (!headerRow || !Array.isArray(headerRow)) return false;

  // 构建实际表头的规范化集合（用于模糊匹配）
  const actualHeaders: string[] = headerRow.map((h: any) => String(h ?? '').trim());
  const normalizedHeaders = actualHeaders.map((h) => normalizeForMatch(h));

  let matchCount = 0;
  let totalCount = rule.fieldMappings.length;

  for (const mapping of rule.fieldMappings) {
    const src = mapping.sourceColumn?.trim() || '';
    if (!src) continue;
    const srcNormalized = normalizeForMatch(src);

    // 精确匹配
    if (actualHeaders.includes(src)) { matchCount++; continue; }
    // 规范化后匹配
    if (normalizedHeaders.includes(srcNormalized)) { matchCount++; continue; }
    // 包含匹配
    if (actualHeaders.some((h) => h === src || h.includes(src) || src.includes(h))) {
      matchCount++; continue;
    }
    // 规范化后的包含匹配
    if (normalizedHeaders.some((h) => h === srcNormalized || h.includes(srcNormalized) || srcNormalized.includes(h))) {
      matchCount++; continue;
    }
  }

  // 如果超过一半的映射能匹配上，认为验证通过
  const passRate = totalCount > 0 ? matchCount / totalCount : 0;
  return passRate >= 0.5 && matchCount >= 2; // 至少2个映射且50%以上匹配
}

/**
 * 规范化字符串用于模糊匹配：去除空格、统一标点、转小写
 */
export function normalizeForMatch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:]/g, ':')
    .replace(/[\(（]/g, '(')
    .replace(/[）\)]/g, ')')
    .replace(/[-—–]/g, '-')
    .replace(/[，,]/g, ',')
    ;
}

/** 把一条 AISuggestRuleOutput 转成 UI 已有的 ParseRule/FieldMapping/ExtractionRule 形状 */
import type { ParseRule, FieldMapping, ExtractionRule } from '../types';

export function aiRuleToParseRule(ai: AISuggestRuleOutput): ParseRule {
  const fieldMappings: FieldMapping[] = ai.fieldMappings.map((m) => ({
    sourceColumn: m.sourceColumn,
    targetField: m.targetField,
    mappingType: m.mappingType,
    regexPattern: m.regexPattern,
    speculative: m.speculative ?? true,
  }));
  const extractionRules: ExtractionRule[] = (ai.extractionRules || [])
    .filter((e) => (e.name && e.name.trim()) || (e.pattern && e.pattern.trim()) || e.targetField)
    .map((e, idx) => ({
    id: `ext_ai_${Date.now()}_${idx}`,
    name: e.name || '提取规则',
    // 为了兼容现有解析逻辑：默认把"页眉/尾部"识别出来的规则放在 footer 类型
    // （实际在 v2/page.tsx 的 runParse 里 header/footer 都会扫描）
    type: 'footer',
    pattern: e.pattern,
    targetField: e.targetField || 'remark',
    regex: e.regex,
    defaultValue: e.defaultValue,
  }));

  return {
    id: `rule_ai_${Date.now()}`,
    name: ai.name,
    description: ai.description,
    fileType: 'excel',
    parseMode: ai.parseMode || 'table',
    multiSheet: ai.multiSheet || false,
    cardMarker: ai.cardMarker || '▶',
    headerSkipRows: ai.headerSkipRows,
    footerSkipRows: ai.footerSkipRows ?? 30,
    dataStartRow: ai.dataStartRow,
    dataEndRow: ai.dataEndRow,
    skipPatterns: Array.isArray(ai.skipPatterns) ? ai.skipPatterns : [],
    aggregateBy: typeof ai.aggregateBy === 'string' ? ai.aggregateBy : '',
    transposeConfig: ai.transposeConfig,
    fieldMappings,
    extractionRules,
    aiGenerated: true,
    aiConfidence: ai.aiConfidence,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/* ========================================================================
 * AI 直接解析（新架构）
 * ========================================================================
 *
 * 核心变化：不再让 AI 生成"映射规则"，而是让 AI 直接理解文件内容，
 * 输出符合 OrderItem 结构的 JSON 数组。
 *
 * 优势：
 *   - 收件人/电话/地址等非表格信息，AI 能从页眉/元信息行中自动提取
 *   - PDF 等无结构文件的列切分问题彻底消失
 *   - 不再依赖 sourceColumn→targetField 映射的脆弱链路
 *
 * 使用：
 *   import { parseWithAIDirect, AIDirectParseInput } from '@/v2/lib/ai';
 *   const result = await parseWithAIDirect({ textLines, rows, provider });
 */

/** 单个物品行的输出 */
const AIDirectItemSchema = z.object({
  externalCode: z.string().default(''),
  storeName: z.string().default(''),
  receiverName: z.string().default(''),
  receiverPhone: z.string().default(''),
  receiverAddress: z.string().default(''),
  skuCode: z.string().default(''),
  skuName: z.string().default(''),
  skuQuantity: z.string().default(''),
  skuSpec: z.string().default(''),
  remark: z.string().default(''),
});

/** AI 直接解析的完整输出 */
const AIDirectParseOutputSchema = z.object({
  /** 解析出的订单项列表，每项对应一行物品数据 */
  items: z.array(AIDirectItemSchema).min(1, '至少要解析出一条物品数据'),
  /** AI 对解析结果的置信度说明 */
  confidence: z.number().min(0).max(1).default(0.8),
  /** AI 的解析说明（哪些字段从哪里提取的、哪些字段找不到） */
  explanation: z.string().default(''),
});

export type AIDirectParseOutput = z.infer<typeof AIDirectParseOutputSchema>;

export interface AIDirectParseInput {
  /** 文件的原始文本行（PDF/Word 用这个，最完整） */
  textLines?: string[];
  /** 文件的二维数组形式（Excel 用这个） */
  rows?: any[][];
  /** 文件类型 */
  fileType?: 'excel' | 'word' | 'pdf';
  /** 用户补充提示 */
  userHint?: string;
  /** API 提供者配置 */
  provider: AIProviderConfig;
}

/**
 * 构建 AI 直接解析的 prompt
 * 关键：把完整文件文本交给 AI，让它直接输出 OrderItem[]
 */
function buildDirectParsePrompt(input: AIDirectParseInput): {
  messages: ChatMessage[];
  totalChars: number;
} {
  const { textLines, rows, fileType, userHint } = input;

  // 决定用哪种形式的原始数据
  // PDF/Word：textLines 最完整（保留原文换行和格式）
  // Excel：rows 二维数组更结构化
  const useTextMode = !!textLines && textLines.length > 0 && (fileType === 'pdf' || fileType === 'word');

  let fileContentText: string;
  let lineCount: number;

  if (useTextMode) {
    // 文本模式：把所有行拼成一段文本，控制总长度
    // 优先保留头部（含收件人信息）和表格区域
    const maxChars = 15000; // 控制 token 消耗
    let content = textLines.join('\n');
    if (content.length > maxChars) {
      // 超长截断：保留前 80%（标题+表头+部分数据）+ 后 20%（可能含合计/备注）
      const headLen = Math.floor(maxChars * 0.8);
      const tailLen = maxChars - headLen;
      content = content.slice(0, headLen) + '\n\n... [中间数据已省略] ...\n\n' + content.slice(-tailLen);
    }
    fileContentText = content;
    lineCount = textLines.length;
  } else {
    // Excel 模式：把二维数组转为文本展示（限制行数避免 AI 输出超出 token 上限）
    const displayRows = (rows || []).slice(0, 100); // 最多 100 行
    fileContentText = displayRows.map((row, idx) => {
      const cells = (row || []).map((c: any) => {
        const s = String(c ?? '').trim();
        return s.length > 60 ? s.slice(0, 60) + '…' : s;
      });
      return `[行${idx + 1}] ${cells.join(' | ')}`;
    }).join('\n');
    lineCount = displayRows.length;
    if ((rows || []).length > 100) {
      fileContentText += `\n... (共 ${(rows || []).length} 行，已截断显示前 100 行)`;
    }
  }

  const systemPrompt = [
    `你是一个"订单/发货单/入库单文件解析专家"。你的任务是：直接理解用户上传的文件内容，`,
    `提取出其中的订单数据，输出为结构化 JSON。`,
    ``,
    `═══════════════════════════════════════════════════════════`,
    `【第一部分】你需要输出的数据结构`,
    `═══════════════════════════════════════════════════════════`,
    `对于文件中的每一行物品/商品数据，输出一条记录（JSON 对象），包含以下字段：`,
    ``,
    `  字段名        含义                     示例值`,
    `  ────────────────────────────────────────────────────────`,
    `  externalCode  外部编码/订单号/订单号     "PH20240606001" 或 ""`,
    `  storeName     收货门店/机构名称          "黔寨寨贵州烙锅（鞍山店）" 或 ""`,
    `  receiverName  收件人姓名/联系人         "张三" 或 ""`,
    `  receiverPhone 收件人电话/手机           "13800138000" 或 ""`,
    `  receiverAddress 收件人地址              "辽宁省鞍山市铁东区xx路xx号" 或 ""`,
    `  skuCode       物品编码/SKU编号          "ZBWP0001" （这是关键字段！）`,
    `  skuName       物品名称/商品名称          "可口可乐330ml" （这是关键字段！）`,
    `  skuQuantity   发货数量（纯数字）        "2" （不是 "2瓶"，只取数字）`,
    `  skuSpec       规格型号                   "330ml*24" 或 ""`,
    `  remark        备注                       ""`,
    ``,
    `═══════════════════════════════════════════════════════════`,
    `【第二部分】如何解析表格数据（最重要！仔细读！）`,
    `═══════════════════════════════════════════════════════════`,
    ``,
    `### PDF 文件的表格特点`,
    `PDF 文件中的表格每一行是纯文本，用空格分隔各个单元格。例如：`,
    ``,
    `  原始文本行: "饮品类  ZBWP0001  可乐  330ml瓶  2"`,
    `  解析结果:   品类=饮品类, SKU编码=ZBWP0001, 名称=可乐, 规格=330ml瓶, 数量=2`,
    ``,
    `### 你必须按以下步骤解析：`,
    ``,
    `**步骤1：找到表头行**`,
    `- 在文件中找到包含 "SKU编码"、"物品名称"、"数量"、"规格" 等关键词的行，这就是表头。`,
    `- 表头行也是空格分隔的，通过表头你能知道每列的含义和顺序。`,
    ``,
    `**步骤2：按列位置逐行解析数据**`,
    `- 根据表头的列顺序，把每个数据行的对应位置的字段取出来。`,
    `- 例如表头是: "物品类别  物品编码  物品名称  规格型号  发货数量  备注"`,,
    `- 那么数据行 "饮品类  ZBWP0001  可乐  330ml瓶  2" 应该解析为：`,,
    `  - 第1列(物品类别)→ 这是分类信息，不是 skuCode/skuName！跳过或放入 remark`,
    `  - 第2列(物品编码)→ skuCode = "ZBWP0001"`,
    `  - 第3列(物品名称)→ skuName = "可乐"`,
    `  - 第4列(规格型号)→ skuSpec = "330ml瓶"`,
    `  - 第5列(发货数量)→ skuQuantity = "2"`,
    ``,
    `**步骤3：绝对不能犯的错误 ❌**`,
    `- ❌ 不能把 "饮品类" 当作 skuCode —— 它是分类，不是编码`,
    `- ❌ 不能把 "饮品类" 当作 skuName —— 它是分类，不是名称`,
    `- ❌ 不能把同一行的第一个词复制到所有字段`,
    `- ✅ skuCode 必须看起来像编码（字母+数字组合，如 ZBWP0001、SP001）`,
    `- ✅ skuName 必须是具体的商品名称（如 可乐、雪碧、矿泉水）`,
    `- ✅ skuQuantity 必须是数字`,
    ``,
    `═══════════════════════════════════════════════════════════`,
    `【第三部分】非表格字段的全文搜索`,
    `═══════════════════════════════════════════════════════════`,
    `以下字段通常不在表格列中，而是散落在文件的标题区、页眉、页脚或元信息行中。`,
    `你必须在整个文件内容中搜索这些信息：`,
    ``,
    `- **storeName（收货门店）**：搜索 "门店"、"店铺"、"机构"、"店名"、"配送至" 等关键词附近`,
    `- **receiverName（收件人）**：搜索 "收件人"、"收货人"、"联系人"、"客户" 等关键词附近`,
    `- **receiverPhone（电话）**：搜索手机号（1开头11位数字）、"电话"、"联系方式"、"手机" 等`,
    `- **receiverAddress（地址）**：搜索 "地址"、"详细地址"、"配送地址" 等关键词附近的长文本`,
    `- **externalCode（外部编码）**：搜索 "单号"、"订单号"、"订单号"、"配送单号"、"单据编号" 等`,
    ``,
    `⚠️ 搜索不到就留空字符串 ""，不要编造数据。`,
    ``,
    `═══════════════════════════════════════════════════════════`,
    `【第四部分】输出格式`,
    `═══════════════════════════════════════════════════════════`,
    `输出严格 JSON 格式（不要 markdown 代码块，不要注释）：`,
    ``,
    `{`,
    `  "items": [`,
    `    {`,
    `      "externalCode": "",`,
    `      "storeName": "从文件标题/页眉中提取的门店名",`,
    `      "receiverName": "从文件中搜索到的收件人",`,
    `      "receiverPhone": "从文件中搜索到的电话",`,
    `      "receiverAddress": "从文件中搜索到的地址",`,
    `      "skuCode": "ZBWP0001",`,
    `      "skuName": "可口可乐",`,
    `      "skuQuantity": "2",`,
    `      "skuSpec": "330ml*24",`,
    `      "remark": ""`,
    `    }`,
    `  ],`,
    `  "confidence": 0.9,`,
    `  "explanation": "说明：表头在哪行、每列含义、非表格字段从哪里提取的"`,
    `}`,
    ``,
    `## 最终检查清单（输出前逐一确认）：`,
    `1. skuCode 是真正的编码（含字母数字），不是品类名？ ✅`,
    `2. skuName 是具体商品名，不是品类名？ ✅`,
    `3. skuQuantity 是纯数字？ ✅`,
    `4. 没有把同一词复制到多个字段？ ✅`,
    `5. storeName/receiverName/phone/address 已从全文搜索？ ✅`,
  ].join('\n');

  const userPrompt = [
    `## 文件信息`,
    `- 文件类型: ${fileType || 'unknown'}`,
    `- 总行数: ${lineCount}`,
    ``,
    `## 文件完整内容`,
    '```',
    fileContentText,
    '```',
    ``,
    userHint ? `## 用户补充提示\n${userHint}\n` : '',
    `请分析上面的文件内容，直接输出解析后的订单数据 JSON。`,
    `注意：输出紧凑格式的JSON（不要多余的空格和换行），确保items数组完整不被截断。`,
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const totalChars = systemPrompt.length + userPrompt.length;
  return { messages, totalChars };
}

/**
 * AI 直接解析主函数
 * 输入文件原始内容 → AI 输出 OrderItem[]
 */
export async function parseWithAIDirect(input: AIDirectParseInput): Promise<{
  result: AIDirectParseOutput;
  totalChars: number;
  rawResponse: string;
}> {
  const provider = AIProviderSchema.parse(input.provider);

  let baseUrl = (provider.baseUrl || '')
    .trim()
    .replace(/^[`'"']+|[`'"']+$/g, '')
    .trim()
    .replace(/\/+$/, '');

  if (!/chat\/completions$/.test(baseUrl)) {
    baseUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  }

  const { messages, totalChars } = buildDirectParsePrompt(input);

  const body: OpenAIRequest = {
    model: provider.model!,
    messages,
    temperature: provider.temperature,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        'Accept-Encoding': 'identity',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(120_000) : undefined, // AI直接解析给更多时间
    } as RequestInit);
  } catch (err: any) {
    throw new Error(`调用大模型 API 失败：${err?.message ?? err}`);
  }

  if (!response.ok) {
    let text = '';
    try { text = await response.text(); } catch { /* ignore */ }
    throw new Error(`大模型 API 返回 ${response.status}：${text.slice(0, 400) || response.statusText}`);
  }

  let data: OpenAIResponse;
  try {
    data = (await response.json()) as OpenAIResponse;
  } catch (err: any) {
    throw new Error(`大模型 API 返回的不是合法 JSON：${err?.message ?? err}`);
  }

  if (data.error?.message) {
    throw new Error(`大模型 API 报错：${data.error.message}（code=${data.error.code ?? '—'}）`);
  }

  const rawResponse = data.choices?.[0]?.message?.content ?? '';
  if (!rawResponse.trim()) {
    throw new Error('大模型返回了空内容');
  }

  // 清理 + 多级 JSON 解析（复用与 suggestRuleWithLLM 相同的逻辑）
  const cleaned = rawResponse
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\uFEFF]/g, '')
    .replace(/\\([^"'\\\\/bfnrtu]|u(?![\da-fA-F]{4}))/g, '\\\\$1')
    .trim();

  if (!cleaned) throw new Error('大模型返回内容清理后为空');

  let parsed: any = null;
  let parseError = '';
  const tryParse = (text: string) => { try { return JSON.parse(text); } catch (e: any) { parseError = e?.message || String(e); return null; } };

  // Level 0: 直接解析
  parsed = tryParse(cleaned);
  // Level 1: 提取代码块
  if (!parsed) {
    const codeMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeMatch) parsed = tryParse(codeMatch[1]);
  }
  // Level 2: 提取第一个 {...}
  if (!parsed) {
    const firstObj = cleaned.indexOf('{');
    const lastObj = cleaned.lastIndexOf('}');
    if (firstObj >= 0 && lastObj > firstObj) parsed = tryParse(cleaned.slice(firstObj, lastObj + 1));
  }
  // Level 3: 激进清理
  if (!parsed) {
    const aggressive = cleaned.replace(/\\(?!["\\\\/bfnrtu])/g, '').replace(/[\u0000-\u001F\u200B-\u200F\uFEFF]/g, '');
    const aF = aggressive.indexOf('{');
    const aL = aggressive.lastIndexOf('}');
    if (aF >= 0 && aL > aF) parsed = tryParse(aggressive.slice(aF, aL + 1));
  }
  // Level 4: 截断修复 — AI 输出超 token 限制导致 JSON 被截断
  if (!parsed) {
    // 找到最后一个完整对象（以 } 结尾），截断后面的不完整内容
    const lastComplete = cleaned.lastIndexOf('}');
    if (lastComplete > 0) {
      let truncated = cleaned.slice(0, lastComplete + 1);
      // 统计未闭合的括号
      const opens = (truncated.match(/{/g) || []).length;
      const closes = (truncated.match(/}/g) || []).length;
      const arrOpens = (truncated.match(/\[/g) || []).length;
      const arrCloses = (truncated.match(/\]/g) || []).length;
      // 补齐缺失的闭合符号
      truncated += ']'.repeat(Math.max(0, arrOpens - arrCloses));
      truncated += '}'.repeat(Math.max(0, opens - closes));
      // 尾随逗号清理
      truncated = truncated.replace(/,\s*([}\]])/g, '$1').replace(/,\s*}/g, '}');
      try { parsed = JSON.parse(truncated); } catch { /* still failed */ }
    }
  }

  if (!parsed) {
    const preview = cleaned.slice(0, 500).replace(/\n/g, '\\n');
    throw new Error(`JSON 解析失败(${parseError})，前500字符：\n${preview}${cleaned.length > 500 ? '...' : ''}`);
  }

  // Zod schema 校验
  const validated = AIDirectParseOutputSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => `  - ${i.path.join('.')} : ${i.message}`).join('\n');
    throw new Error(`AI 返回数据不符合 OrderItem 结构：\n${issues}`);
  }

  return { result: validated.data, totalChars, rawResponse };
}
