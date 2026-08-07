/**
 * 上传测试：验证 Vercel 生产环境上传接口是否生成 Storage URL
 * 用法: npx tsx scripts/upload-prod-test.ts
 */
import * as fs from 'fs';

const BASE_URL = process.env.BASE_URL || 'https://ztocc-ai-work.vercel.app';
const FILE_PATH = 'test-data/small-upload-test.xlsx';
const RULE_ID = 'rule_1786016318813';

async function main() {
  const fileBuffer = fs.readFileSync(FILE_PATH);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), 'small-upload-test.xlsx');
  formData.append('rule_id', RULE_ID);

  const start = Date.now();
  const resp = await fetch(`${BASE_URL}/api/v3/import-tasks`, {
    method: 'POST',
    body: formData,
  });
  const duration = Date.now() - start;
  const data = await resp.json();
  console.log(`[upload] HTTP ${resp.status} | 耗时 ${duration}ms`);
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error('上传失败:', e?.message || e);
  process.exit(1);
});
