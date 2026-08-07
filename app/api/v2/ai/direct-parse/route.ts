/**
 * POST /api/v2/ai/direct-parse
 * -------------------------------
 * AI 直接解析文件：把原始文本/行数据发给大模型，
 * 让大模型直接输出符合 OrderItem 结构的 JSON 数组。
 *
 * 与 suggest-rule 的区别：
 *   - suggest-rule: AI 输出"映射规则" → 本地引擎按规则取值
 *   - direct-parse:  AI 直接输出解析结果（OrderItem[]）→ 轻量校验后入库
 *
 * 请求体：
 *   {
 *     textLines?: string[];       // PDF/Word 原始文本行
 *     rows?: any[][];             // Excel 二维数组
 *     fileType: 'excel'|'word'|'pdf';
 *     userHint?: string;
 *     provider: { baseUrl, apiKey, model?, temperature? };
 *   }
 *
 * 响应（200）：
 *   {
 *     ok: true,
 *     items: OrderItem[],          // 可直接喂给前端表格
 *     explanation: string,         // AI 的解析说明
 *     confidence: number,
 *     totalChars: number,
 *     rawResponse: string,
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  parseWithAIDirect,
  AIDirectParseInput,
} from '@/v2/lib/ai';
import { createEmptyOrderItem } from '@/v2/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: `请求体不是合法 JSON：${err?.message ?? err}` },
      { status: 400 }
    );
  }

  const hasTextLines = Array.isArray(body.textLines) && body.textLines.length > 0;
  const hasRows = Array.isArray(body.rows) && body.rows.length > 0;

  if (!hasTextLines && !hasRows) {
    return NextResponse.json(
      { ok: false, error: '需要提供 textLines 或 rows 至少一个' },
      { status: 400 }
    );
  }

  const provider = body?.provider;
  if (!provider || typeof provider !== 'object' || !provider.apiKey) {
    return NextResponse.json(
      { ok: false, error: '缺少 provider.apiKey，请先配置 API Key' },
      { status: 400 }
    );
  }

  try {
    console.log('[direct-parse] 开始调用 LLM, fileType=', body.fileType,
      'textLines=', body.textLines?.length, 'rows=', body.rows?.length);

    const { result, totalChars, rawResponse } = await parseWithAIDirect({
      textLines: body.textLines,
      rows: body.rows,
      fileType: body.fileType || 'excel',
      userHint: typeof body.userHint === 'string' ? body.userHint : '',
      provider,
    });

    // 将 AI 输出转换为前端可用的 OrderItem 格式
    const items = result.items.map((item, idx) => {
      const orderItem = createEmptyOrderItem();
      orderItem.id = `ai_${Date.now()}_${idx}`;
      orderItem.externalCode = item.externalCode || '';
      orderItem.storeName = item.storeName || '';
      orderItem.receiverName = item.receiverName || '';
      orderItem.receiverPhone = item.receiverPhone || '';
      orderItem.receiverAddress = item.receiverAddress || '';
      orderItem.skuCode = item.skuCode || '';
      orderItem.skuName = item.skuName || '';
      orderItem.skuQuantity = String(item.skuQuantity || '');
      orderItem.skuSpec = item.skuSpec || '';
      orderItem.remark = item.remark || '';
      return orderItem;
    });

    console.log('[direct-parse] 成功, items=', items.length, 'confidence=', result.confidence);

    return NextResponse.json({
      ok: true,
      items,
      explanation: result.explanation,
      confidence: result.confidence,
      totalChars,
      rawResponse,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const cause = err?.cause?.message || '';
    console.error('[direct-parse] 失败:', msg.slice(0, 500), cause ? `cause: ${cause}` : '');

    // 提供更友好的错误提示
    let userFriendlyError = msg;
    if (msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
      userFriendlyError = `无法连接到 AI 服务，请检查 API Base URL 配置是否正确。${cause ? `（原因：${cause}）` : ''}`;
    } else if (msg.includes('timeout') || msg.includes('Timeout')) {
      userFriendlyError = 'AI 解析超时（超过 120 秒），请尝试减少数据量或更换更快的模型。';
    } else if (msg.includes('401') || msg.includes('403')) {
      userFriendlyError = 'AI API Key 无效或无权限，请检查 API Key 配置。';
    } else if (msg.includes('429')) {
      userFriendlyError = 'AI API 请求频率超限，请稍后再试。';
    }

    return NextResponse.json({ ok: false, error: userFriendlyError, detail: msg }, { status: 502 });
  }
}
