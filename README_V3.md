# V3 异步事件驱动批量导入系统

> 基于 V2 万能导入解析系统的异步事件驱动重构

## 架构

上传(≤1s) → [Outbox + DB事务] → [Dispatcher轮询] → [BullMQ队列] → [Worker并发消费] → [批量校验+写入]

## 快速开始

### 1. 环境准备

```bash
# 复制环境变量
cp .env.example .env.local

# 编辑 .env.local 填入：
# NEXT_PUBLIC_SUPABASE_URL=你的Supabase地址
# NEXT_PUBLIC_SUPABASE_ANON_KEY=你的Supabase密钥
# REDIS_URL=redis://... (Upstash Redis)
```

### 2. 初始化数据库

在 Supabase SQL Editor 中执行 `database/v3-setup.sql`

### 3. 生成压测数据

```bash
npx tsx scripts/seed-data.ts
```
生成 20,000 条 SKU 主数据 + 10,000 行 Excel 压测文件

### 4. 启动开发服务器

```bash
npm run dev
```

### 5. 启动 Worker（另开终端）

```bash
npm run worker
```

### 6. 运行压测

```bash
npm run stress:v3
```

### 7. 运行测试

```bash
npx tsx scripts/v3-tests.ts
```

## 部署

### Vercel（Web 应用）

```bash
vercel --prod
```

### Railway（Worker 进程）

Worker 为常驻进程，部署在 Railway（无需 Redis，直接轮询 `v3_event_outbox` 表消费事件）。

1. 安装 CLI 并登录：
   ```bash
   npm install -g @railway/cli
   railway login --browserless   # 按提示在 railway.com/activate 输入激活码
   ```

2. 初始化项目并部署：
   ```bash
   railway init --name ztocc-worker
   railway up --service ztocc-worker
   ```
   `railway.json` + `nixpacks.toml` 已内置构建/启动配置（Nixpacks 构建，`npx tsx worker/local-worker.ts` 启动）。

3. 配置环境变量：
   ```bash
   railway variable set \
     NEXT_PUBLIC_SUPABASE_URL=... \
     NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
     SUPABASE_SERVICE_ROLE_KEY=...
   ```
   设置后 Railway 自动重新部署。

4. 验证：`railway logs --service ztocc-worker` 应看到 Worker 启动并轮询。

> 注意：部署前需先在 Supabase Dashboard 执行 `database/_bootstrap-exec-sql.sql`（创建 `exec_sql` RPC），
> 再执行 `database/v3-rpc-optimize.sql`（创建 `create_import_task` / `init_task_batches` / `batch_upsert_waybills`），
> 否则 Worker 会回退到逐条 SQL 写入（功能正常，性能略降）。

### Outbox 投递

Worker 进程（`npm run worker`）直接轮询 `v3_event_outbox` 表并消费事件，无需额外的 Cron 端点。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| NEXT_PUBLIC_SUPABASE_URL | 是 | Supabase 项目 URL |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | 是 | Supabase 匿名密钥 |
| SUPABASE_SERVICE_ROLE_KEY | 是 | Supabase 服务端密钥（Worker 用） |
| REDIS_URL | 否 | Redis 连接串（仅 BullMQ 模式 `worker/index.ts` 需要，Outbox 轮询模式不需要） |
| CRON_SECRET | 否 | Cron 端点鉴权密钥 |
| BASE_URL | 否 | 压测目标地址（默认 http://localhost:3333） |
| FILE_PATH | 否 | 压测文件路径（默认 test-data/10000-orders.xlsx） |

## 功能页面

| 页面 | URL | 说明 |
|---|---|---|
| 上传 | /v3 | 上传文件创建导入任务（含 V2 完整交互：编辑/校验/高亮/导出） |
| 任务详情 | /v3/tasks/:taskId | 查看进度、批次性能、错误概览、吞吐、ETA、降级标注 |
| 错误明细 | /v3/tasks/:taskId/errors | 按批次/错误码筛选查看，Popover 展示修复建议 |
| 监控看板 | /v3/monitor | 吞吐、积压、阶段耗时P50/P95/P99、错误分布、慢批次TOP10 |
| Trace检索 | /v3/traces | 多条件搜索（trace_id/task_id/文件名/批次号/行号/错误码）+ 时间线 |

## 关键文件

| 文件 | 说明 |
|---|---|
| database/v3-setup.sql | 建表脚本（7张表+3个RPC函数） |
| scripts/seed-data.ts | 压测数据生成 |
| scripts/stress-test.ts | 压测脚本 |
| scripts/v3-tests.ts | 自动化测试 |
| worker/index.ts | Worker 进程入口 |
| v3/lib/batch-processor.ts | 批次处理核心 |
| v3/lib/batch-validator.ts | 批量SKU校验 |
| v3/lib/batch-writer.ts | 批量UPSERT |

## 文档

- [架构设计](./exam-v4-v2-async-event-driven-observability.md)
- [重构假设说明](./docs/v3-refactoring-assumptions.md)

## 故障模拟与验证

### 1. SKU 校验降级模拟

**场景**：SKU 主数据查询超时（>3秒）时，系统自动进入降级模式。

**模拟方式**：
```bash
# 方式 A：临时删除 v3_sku_master 表的索引（模拟慢查询）
# 在 Supabase SQL Editor 执行：
# DROP INDEX IF EXISTS v3_sku_master_sku_code_idx;

# 方式 B：手动将任务标记为降级
# 在 Supabase SQL Editor 执行：
# UPDATE v3_import_tasks SET degraded = true WHERE id = 'task_xxx';

# 然后上传文件，观察任务详情页是否显示降级告警
```

**验证点**：
- 任务详情页显示 `⚠️ SKU 校验已降级` 告警
- Worker 日志输出 `SKU 校验降级` 信息
- 降级后仍完成入库，仅跳过 SKU 主数据校验

### 2. Worker 卡死恢复模拟

**场景**：Worker 进程在处理批次时崩溃，批次卡在 `processing` 状态。

**模拟方式**：
```bash
# 1. 启动 Worker 并上传文件
npm run worker
# 2. 在 Worker 处理批次时强制终止进程（Ctrl+C 或 kill -9）
# 3. 等待 5 分钟（recover_stuck_batches 超时阈值）
# 4. 重新启动 Worker
npm run worker
```

**验证点**：
- 卡死批次在 5 分钟后被 `recover_stuck_batches` RPC 恢复为 `pending`
- Worker 重启后自动消费恢复的批次
- 恢复时保留 `items_url`（预解析模式不丢失）
- Trace 时间线出现 `BatchRecovered` 事件

### 3. 重复消费幂等验证

**场景**：同一批次被重复投递到队列。

**模拟方式**：
```bash
# 手动复制一条 outbox 事件（模拟重复投递）
# 在 Supabase SQL Editor 执行：
# INSERT INTO v3_event_outbox (aggregate_id, event_type, payload, status, next_retry_at)
# SELECT aggregate_id, event_type, payload, 'pending', now()
# FROM v3_event_outbox WHERE id = <已完成的批次事件 id>;
```

**验证点**：
- Worker 日志输出 `批次已完成，跳过` 
- `v3_import_tasks.processed_rows` 不会重复累计
- 数据库无重复订单记录

### 4. 部分行失败验证

**场景**：上传包含错误数据的文件（SKU 不存在、电话格式错误等）。

**模拟方式**：
```bash
# 使用压测脚本生成的文件（已注入 ~2% E001 + ~1% E003 + ~1% E004 错误）
npm run stress:v3
```

**验证点**：
- 任务状态为 `partial_success`
- 成功行已入库，失败行写入 `v3_import_task_errors`
- 错误明细页可按错误码筛选，显示行号/字段/原始值/原因/修复建议
- 监控看板错误类型分布展示各错误码占比
