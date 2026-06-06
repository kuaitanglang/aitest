/**
 * POST /api/v2/ai/suggest-rule
 * -----------------------------
 * 把"上传文件 raw 数据 + 用户提示 + LLM 供应商配置"发给大模型，
 * 返回解析规则（ParseRule 形态，可直接喂给前端 RuleEditor）。
 *
 * 请求体：
 *   {
 *     rows: any[][];              // 二维数组（含表头）
 *     headerRowIndex?: number;    // 表头在第几行，默认 0
 *     userHint?: string;          // 用户补充提示
 *     provider: {
 *       baseUrl?: string;         // 默认 https://api.deepseek.com
 *       apiKey: string;           // 必填
 *       model?: string;           // 默认 deepseek-chat
 *       temperature?: number;
 *       maxTokens?: number;
 *       sampleRowLimit?: number;  // 传给大模型多少行样本，默认 15
 *     };
 *   }
 *
 * 响应（200）：
 *   {
 *     ok: true,
 *     rule: ParseRule,             // 前端可直接 setState
 *     totalChars: number,          // 本次 prompt 字符数（粗略 token 指示）
 *     rawResponse: string,         // 大模型原始输出，便于调试
 *   }
 *
 * 响应（4xx/5xx）：
 *   { ok: false, error: string }
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  suggestRuleWithLLM,
  aiRuleToParseRule,
  AIProviderConfig,
} from '@/v2/lib/ai';

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

  const rows: any[][] = body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'rows 为空或不是二维数组' },
      { status: 400 }
    );
  }

  const provider: AIProviderConfig = body?.provider;
  if (!provider || typeof provider !== 'object' || !provider.apiKey) {
    return NextResponse.json(
      { ok: false, error: '缺少 provider.apiKey，请先在页面右上角配置 API Key' },
      { status: 400 }
    );
  }

  try {
    console.log('[suggest-rule] 开始调用 LLM, rows=', rows.length);
    const { rule: aiRule, totalChars, rawResponse, detectedHeaderRow, validationPassed } = await suggestRuleWithLLM({
      rows,
      // 不再传入 headerRowIndex，由 AI 层自动检测
      userHint: typeof body.userHint === 'string' ? body.userHint : '',
      provider,
    });

    const parseRule = aiRuleToParseRule(aiRule);
    console.log('[suggest-rule] 成功, name=', parseRule.name, 'mappings=', parseRule.fieldMappings.length,
      'detectedHeaderRow=', detectedHeaderRow, 'validationPassed=', validationPassed);

    return NextResponse.json({
      ok: true,
      rule: parseRule,
      totalChars,
      rawResponse,
      detectedHeaderRow,
      validationPassed,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[suggest-rule] 失败:', msg.slice(0, 500));
    // 用 502 表示"上游（大模型）出问题"，前端据此给出明确提示
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
