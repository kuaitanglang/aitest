/**
 * 初始化 Supabase Storage bucket：import-files（公开读，供 Web/Worker 共享文件）
 *
 * 用法: npx tsx --env-file=.env.local scripts/setup-storage.ts
 */
import { supabaseAdmin } from '../lib/supabase';

const BUCKET = 'import-files';

async function main() {
  if (!supabaseAdmin) {
    console.error('[setup-storage] supabaseAdmin 未配置，请检查 .env.local');
    process.exit(1);
  }

  // 1. 检查 bucket 是否已存在
  const { data: buckets, error: listErr } = await supabaseAdmin.storage.listBuckets();
  if (listErr) {
    console.error('[setup-storage] 查询 bucket 失败:', listErr.message);
    process.exit(1);
  }

  const exists = (buckets || []).some((b) => b.name === BUCKET);
  if (exists) {
    console.log(`[setup-storage] bucket "${BUCKET}" 已存在，更新 allowed_mime_types 允许 JSON`);
    const { error: updErr } = await supabaseAdmin.storage.updateBucket(BUCKET, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024,
      allowedMimeTypes: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/pdf',
        'application/json',
        'application/octet-stream', // 脚本/压测 Blob 无类型时兜底
      ],
    });
    if (updErr) {
      console.error('[setup-storage] 更新 bucket 失败:', updErr.message);
      process.exit(1);
    }
    console.log('[setup-storage] bucket 配置已更新（允许 application/json）');
  } else {
    const { error: createErr } = await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true, // 公开读：Worker 下载无需鉴权
      fileSizeLimit: 50 * 1024 * 1024, // 50MB
    });
    if (createErr) {
      console.error('[setup-storage] 创建 bucket 失败:', createErr.message);
      process.exit(1);
    }
    console.log(`[setup-storage] bucket "${BUCKET}" 创建成功（public）`);
  }

  // 2. 验证：上传一个测试文件再删除
  const testPath = '.setup-test.txt';
  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(testPath, Buffer.from('ok'), { contentType: 'application/json', upsert: true });
  if (upErr) {
    console.error('[setup-storage] 测试上传失败:', upErr.message);
    process.exit(1);
  }
  const { data: publicUrl } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(testPath);
  console.log('[setup-storage] 测试上传成功, public URL:', publicUrl.publicUrl);

  const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove([testPath]);
  if (rmErr) {
    console.error('[setup-storage] 测试文件删除失败（可忽略）:', rmErr.message);
  } else {
    console.log('[setup-storage] 测试文件已清理');
  }

  console.log('[setup-storage] 完成');
}

main();
