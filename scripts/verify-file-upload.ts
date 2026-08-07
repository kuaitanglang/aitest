// 本地验证 V3 两段式上传流程（模拟前端新逻辑）：
//   1. POST /api/v3/import-tasks          —— 创建任务（无文件）
//   2. gzip 压缩 items JSON
//   3. POST /api/v3/import-tasks/[id]/file —— items_gzip=1 上传压缩数据激活任务
// 用法: npx tsx scripts/verify-file-upload.ts
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';

const BASE = 'http://localhost:3333';
const N = 2000; // 2000 行

function makeItem(i: number): any {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    externalCode: `EXTERNAL-${String(i).padStart(6, '0')}`,
    storeName: `店铺${(i % 50) + 1}`,
    receiverName: `收货人${i}`,
    receiverPhone: `1380000${String(i % 10000000).padStart(7, '0')}`,
    receiverAddress: `上海市浦东新区测试路${(i % 999) + 1}号${(i % 20) + 1}室`,
    skuCode: `SKU-${String(i % 200).padStart(4, '0')}`,
    skuName: `测试商品${(i % 200) + 1}`,
    skuQuantity: String((i % 9) + 1),
    skuSpec: '件',
    remark: '',
    errors: [],
  };
}

async function main(): Promise<void> {
  // 1. 创建任务
  console.log('[1] 创建任务...');
  const createResp = await fetch(`${BASE}/api/v3/import-tasks`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData();
      fd.append('rule_id', 'test-gzip-verify');
      return fd;
    })(),
  });
  const createData = await createResp.json();
  console.log('    create ->', JSON.stringify(createData));
  if (!createData.ok || !createData.task_id) throw new Error('创建任务失败: ' + JSON.stringify(createData));
  const taskId = createData.task_id;

  // 2. gzip 压缩 items
  console.log(`[2] gzip 压缩 ${N} 条 items...`);
  const items = Array.from({ length: N }, (_, i) => makeItem(i));
  const jsonStr = JSON.stringify(items);
  const gz = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'));
  const rawSize = Buffer.byteLength(jsonStr);
  console.log(`    原始 ${(rawSize / 1024 / 1024).toFixed(2)}MB -> gzip ${(gz.length / 1024 / 1024).toFixed(2)}MB (压缩率 ${(100 * (1 - gz.length / rawSize)).toFixed(0)}%)`);

  // 保存 gzip 文件供 curl 备用
  fs.writeFileSync(path.join(process.cwd(), 'test-data', 'items-gzip-verify.json.gz'), gz);

  // 3. 上传激活任务
  console.log('[3] 上传 gzip items 激活任务...');
  const t0 = Date.now();
  const fd = new FormData();
  fd.append('items', new Blob([gz], { type: 'application/gzip' }), 'items.json.gz');
  fd.append('items_gzip', '1');
  fd.append('rule_id', 'test-gzip-verify');
  fd.append('file_name', 'verify-2000rows.xlsx');
  const uploadResp = await fetch(`${BASE}/api/v3/import-tasks/${taskId}/file`, { method: 'POST', body: fd });
  const uploadData = await uploadResp.json();
  console.log(`    upload -> ${JSON.stringify(uploadData)} (${Date.now() - t0}ms)`);

  if (uploadData.ok) {
    console.log(`\n验证通过 ✓ task=${taskId}`);
    console.log(`请到 Worker 日志或任务详情确认处理: http://localhost:3333/v3/tasks/${taskId}`);
  } else {
    console.log(`\n验证失败 ✗ ${uploadData.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('异常:', e);
  process.exitCode = 1;
});
