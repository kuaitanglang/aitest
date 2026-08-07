import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

/**
 * 自定义 fetch：强制 no-store，避免 Next.js 缓存 Supabase 查询结果
 *
 * Next.js 13+ 对 fetch() 有缓存机制，即使 route handler 设了 force-dynamic，
 * Supabase JS 内部发出的 fetch 仍可能被缓存，导致读到旧数据。
 */
const noStoreFetch = (url: any, options: any) =>
  fetch(url, { ...options, cache: 'no-store' as RequestCache })

/**
 * 前端客户端（anon key，受 RLS 策略保护）
 * 用于客户端组件、API route 的查询等场景
 */
export const supabase = (supabaseUrl && supabaseKey && supabaseUrl.startsWith('http'))
  ? createClient(supabaseUrl, supabaseKey, { global: { fetch: noStoreFetch } })
  : null;

/**
 * 后端管理客户端（service_role key，绕过 RLS）
 * 用于 Worker、batch-writer、batch-processor 等后端写入场景
 *
 * 关键：RPC UPSERT 的 ON CONFLICT DO UPDATE 会触发 RLS USING 检查，
 * anon key 下已有行的 UPDATE 会被阻止，导致逐行降级（极慢）。
 * service_role key 绕过 RLS，确保 UPSERT 正常工作。
 */
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const supabaseAdmin = (supabaseUrl && supabaseServiceKey && supabaseUrl.startsWith('http'))
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
      global: { fetch: noStoreFetch },
    })
  : supabase; // 降级到普通客户端（本地无 service_role key 时）