/**
 * V3 压测脚本
 *
 * 用法: npx tsx --env-file=.env.local scripts/stress-test.ts
 *
 * 流程:
 * 1. 获取可用规则
 * 2. 上传 10000 行 Excel 文件，记录上传耗时
 * 3. 轮询任务状态直到完成
 * 4. 生成压测报告（保存到项目根目录）
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3333';
const FILE_PATH = process.env.FILE_PATH || 'test-data/10000-orders.xlsx';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMs(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  console.log('============================================');
  console.log('V3 压测脚本');
  console.log('============================================');
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`FILE_PATH: ${FILE_PATH}`);

  // 检查文件是否存在
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`\n❌ 压测文件不存在: ${FILE_PATH}`);
    console.error('   请先运行 npm run seed:v3-data 生成压测数据');
    process.exit(1);
  }

  const fileSize = fs.statSync(FILE_PATH).size;
  console.log(`FILE_SIZE: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

  // 1. 获取可用规则
  console.log('\n--- 步骤 1: 获取可用规则 ---');
  const rulesResp = await fetch(`${BASE_URL}/api/v2/rules`);
  const rulesData = await rulesResp.json();
  if (!rulesData.rules || rulesData.rules.length === 0) {
    console.error('❌ 无可用解析规则');
    process.exit(1);
  }
  const ruleId = rulesData.rules[0].id;
  const ruleName = rulesData.rules[0].name;
  console.log(`✓ 使用规则: ${ruleId} (${ruleName})`);

  // 2. 上传文件
  console.log('\n--- 步骤 2: 上传文件 ---');
  const fileBuffer = fs.readFileSync(FILE_PATH);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), path.basename(FILE_PATH));
  formData.append('rule_id', ruleId);

  const uploadStart = Date.now();
  const uploadResp = await fetch(`${BASE_URL}/api/v3/import-tasks`, {
    method: 'POST',
    body: formData,
  });
  const uploadDuration = Date.now() - uploadStart;
  const uploadData = await uploadResp.json();

  if (!uploadResp.ok || !uploadData.ok) {
    console.error(`❌ 上传失败: ${uploadData.error || uploadResp.status}`);
    process.exit(1);
  }

  const taskId = uploadData.task_id;
  const traceId = uploadData.trace_id;
  console.log(`✓ 上传成功`);
  console.log(`  task_id: ${taskId}`);
  console.log(`  trace_id: ${traceId}`);
  console.log(`  total_rows: ${uploadData.total_rows}`);
  console.log(`  total_batches: ${uploadData.total_batches}`);
  console.log(`  ⏱ 上传耗时: ${formatMs(uploadDuration)}`);

  // 3. 轮询任务状态
  console.log('\n--- 步骤 3: 等待任务完成 ---');
  const pollStart = Date.now();
  let taskData: any = null;
  let lastStatus = '';
  const maxWaitMs = 180_000; // 最长等待 3 分钟
  const pollInterval = 2000;

  while (Date.now() - pollStart < maxWaitMs) {
    await sleep(pollInterval);
    const statusResp = await fetch(`${BASE_URL}/api/v3/import-tasks/${taskId}`);
    if (!statusResp.ok) {
      console.log(`  查询状态失败: ${statusResp.status}`);
      continue;
    }
    taskData = await statusResp.json();
    const status = taskData.task?.status || 'unknown';
    const processed = taskData.task?.processed_rows || 0;
    const total = taskData.task?.total_rows || 0;
    const completedBatches = taskData.task?.completed_batches || 0;
    const totalBatches = taskData.task?.total_batches || 0;

    if (status !== lastStatus) {
      console.log(`  [${formatMs(Date.now() - pollStart)}] 状态: ${status} | 进度: ${processed}/${total} 行 | 批次: ${completedBatches}/${totalBatches}`);
      lastStatus = status;
    } else if (processed > 0 && processed % 1000 === 0) {
      console.log(`  [${formatMs(Date.now() - pollStart)}] 进度: ${processed}/${total} 行 | 批次: ${completedBatches}/${totalBatches}`);
    }

    // 终态判断
    if (['completed', 'partial_success', 'failed', 'degraded'].includes(status)) {
      break;
    }
  }

  const totalDuration = Date.now() - uploadStart;
  const processingDuration = Date.now() - pollStart;

  if (!taskData || !taskData.task) {
    console.error('❌ 无法获取任务状态');
    process.exit(1);
  }

  const task = taskData.task;
  const finalStatus = task.status;

  // 4. 输出报告
  console.log('\n============================================');
  console.log('压测报告');
  console.log('============================================');
  console.log(`任务 ID:        ${taskId}`);
  console.log(`Trace ID:       ${traceId}`);
  console.log(`最终状态:       ${finalStatus}`);
  console.log(`总行数:         ${task.total_rows}`);
  console.log(`已处理行数:     ${task.processed_rows}`);
  console.log(`成功行数:       ${task.success_rows}`);
  console.log(`失败行数:       ${task.failed_rows}`);
  console.log(`总批次数:       ${task.total_batches}`);
  console.log(`已完成批次:     ${task.completed_batches}`);
  console.log(`降级模式:       ${task.degraded ? '是' : '否'}`);
  console.log('--------------------------------------------');
  console.log(`⏱ 上传耗时:     ${formatMs(uploadDuration)}`);
  console.log(`⏱ 处理耗时:     ${formatMs(processingDuration)}`);
  console.log(`⏱ 总耗时:       ${formatMs(totalDuration)}`);
  if (task.total_rows > 0) {
    console.log(`⏱ 每行耗时:     ${formatMs(totalDuration / task.total_rows)}`);
    console.log(`📊 吞吐量:       ${Math.round(task.total_rows / (totalDuration / 1000))} 行/秒`);
  }
  console.log('============================================');

  // 5. 保存报告到文件
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(process.cwd(), `stress-test-report-${timestamp}.md`);
  const report = `# V3 压测报告

**时间**: ${new Date().toISOString()}
**任务 ID**: ${taskId}
**Trace ID**: ${traceId}

## 结果摘要

| 指标 | 值 |
|------|-----|
| 最终状态 | ${finalStatus} |
| 总行数 | ${task.total_rows} |
| 成功行数 | ${task.success_rows} |
| 失败行数 | ${task.failed_rows} |
| 总批次 | ${task.total_batches} |
| 已完成批次 | ${task.completed_batches} |
| 降级模式 | ${task.degraded ? '是' : '否'} |

## 性能指标

| 指标 | 值 |
|------|-----|
| 上传耗时 | ${formatMs(uploadDuration)} |
| 处理耗时 | ${formatMs(processingDuration)} |
| 总耗时 | ${formatMs(totalDuration)} |
| 每行耗时 | ${task.total_rows > 0 ? formatMs(totalDuration / task.total_rows) : '-'} |
| 吞吐量 | ${task.total_rows > 0 ? Math.round(task.total_rows / (totalDuration / 1000)) + ' 行/秒' : '-'} |

## 上传接口返回

\`\`\`json
${JSON.stringify(uploadData, null, 2)}
\`\`\`
`;
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`\n📄 报告已保存: ${reportPath}`);

  // 退出码
  if (finalStatus === 'failed') {
    console.error('\n❌ 任务失败！');
    process.exit(1);
  }
  console.log('\n✅ 压测完成');
}

main().catch((err) => {
  console.error('压测脚本异常:', err);
  process.exit(1);
});
