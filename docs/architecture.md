# V3 异步导入系统 - 架构设计文档

> 覆盖考题《提交物清单》第 6 项：**异步任务流程图、Outbox 模式、批量处理策略**。

---

## 1. 系统概览

V3 系统将 V2 的同步下单导入链路重构为**异步事件驱动**架构，核心目标：

- **上传接口 P95 ≤ 1s**：上传只做文件解析与任务创建，不阻塞等待全量处理；
- **10,000 行总耗时 ≤ 60s**：通过分批、并行、批量写库实现高吞吐；
- **失败可恢复**：Outbox + 幂等 + Worker 心跳保证任务不丢失、可重试；
- **可观测**：Trace 全链路事件 + 监控看板阶段耗时分布。

**技术栈**：Next.js 14（API + 前端）、Supabase/PostgreSQL（存储 + RPC）、Worker 进程（本地常驻 / 可选 Redis 队列）。

---

## 2. 异步任务流程图

```
┌────────────┐    ①POST /api/v3/import-tasks      ┌─────────────────────────────┐
│  浏览器/前端 │ ──────────────────────────────────▶ │ 上传接口 route.ts             │
│  上传页面    │                                     │  - 保存文件（临时目录）         │
└────────────┘                                     │  - 统计行数（并行，非阻塞）     │
                                                   │  - create_import_task RPC     │
                                                   │    · 写入 v3_import_tasks     │
                                                   │    · 写入 v3_event_outbox     │
                                                   │    (ImportTaskCreated 事件)   │
                                                   └────────────┬────────────────┘
                                                       ②返回立即  │ task_id + trace_id
                                                       响应(P95<1s) │
                                                                    ▼
                                                   ┌─────────────────────────────┐
                                                   │ v3_event_outbox（事务性Outbox）│
                                                   │  - 保证"任务创建"与"事件写入"    │
                                                   │    在同一事务，不会丢失         │
                                                   └────────────┬────────────────┘
                                                                │ ③轮询领取 pending 事件
                                                                ▼
                                                   ┌─────────────────────────────┐
                                                   │ Worker（local-worker.ts）     │
                                                   │  - 轮询间隔 1000ms             │
                                                   │  - 并发 MAX_CONCURRENT=5      │
                                                   │  - init_task_batches RPC      │
                                                   │    初始化 10 个批次 + 出队事件   │
                                                   └────────────┬────────────────┘
                                                                │ ④并行处理批次
                                    ┌───────────────────────────┼───────────────────────────┐
                                    ▼                           ▼                           ▼
                        ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
                        │ batch-processor #1  │   │ batch-processor #2  │   │ batch-processor #5  │
                        │  - 读取文件行片段     │   │  (MAX_CONCURRENT=5) │   │                     │
                        │  - 应用解析规则       │   │                     │   │                     │
                        │  - 校验字段          │   │                     │   │                     │
                        │  - 批量写库           │   │                     │   │                     │
                        │  - 写 Trace 事件      │   │                     │   │                     │
                        └──────────┬──────────┘   └──────────┬──────────┘   └──────────┬──────────┘
                                   ▼                          ▼                          ▼
                        ┌─────────────────────────────────────────────────────────────┐
                        │ 批量写入（batch-writer.ts 三级降级策略）                        │
                        │  ① batch_upsert_waybills RPC（首选，减少 HTTP 往返）           │
                        │  ② bulk INSERT（RPC 失败时降级）                              │
                        │  ③ 分块 delete+insert（兜底）                                 │
                        └─────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                        ┌─────────────────────────────┐
                        │ 批次完成后更新状态 + 写事件：   │
                        │  BatchSucceeded/BatchFailed  │
                        │  → ImportTaskCompleted        │
                        └─────────────────────────────┘
```

### 关键链路说明

| 步骤 | 说明 |
|------|------|
| ① 上传 | 创建任务 + Outbox 事件（同事务），立即返回，**不等待处理** |
| ② 响应 | 上传接口耗时仅包含：表单解析 + 文件保存 + RPC 调用 |
| ③ Worker 领取 | 轮询 `v3_event_outbox` 中 pending 事件，初始化批次 |
| ④ 并行处理 | 5 个批次并发执行，每个批次独立：解析 → 规则 → 校验 → 写入 |
| ⑤ 批量写入 | RPC 优先 → bulk insert → delete+insert 三级降级 |

---

## 3. 事务性 Outbox 模式

### 3.1 为什么需要 Outbox

Worker 是独立进程，若直接通过 WebSocket/HTTP 通知 Worker，会面临：

1. **消息丢失**：Worker 重启 / 网络抖动导致事件未送达；
2. **一致性**：任务已写入但"通知"失败，任务永远处于 pending。

**Outbox 模式**将"业务写入"与"事件发布"放在**同一数据库事务**中，Worker 主动轮询领取，天然可靠。

### 3.2 表结构

```sql
CREATE TABLE v3_event_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id  TEXT NOT NULL,          -- 任务 ID
  event_type    TEXT NOT NULL,          -- ImportTaskCreated / ImportBatchCreated ...
  payload       JSONB NOT NULL,         -- 事件数据
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending / processing / done / failed
  retry_count   INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.3 消费流程

```
轮询 pending 事件（status=pending AND next_retry_at<=now()）
  → 抢占：UPDATE ... SET status='processing' WHERE id=? AND status='pending'
  → 处理业务逻辑
  → 成功：UPDATE status='done'
  → 失败：retry_count+1，重试 5 次后标记 failed
```

**抢占式更新保证多 Worker 并发不重复消费**（CAS 语义：`WHERE status='pending'`）。

---

## 4. 批量处理策略

### 4.1 分片设计

| 参数 | 值 | 依据 |
|------|-----|------|
| 批次数 | 10 | 与 `MAX_CONCURRENT=5` 匹配，2 轮处理完成 |
| 每批行数 | 1000 | 单批内存占用可控，失败影响粒度适中 |
| 并发数 | 5 | Worker 容量推导：见 §5 |

### 4.2 批处理流水线（单批）

```
BatchStarted(Trace)
  → 按 start_row/end_row 读取文件行
  → 应用解析规则（外部编码/SKU/收件人字段映射）
  → 校验（SKU 存在性、必填字段、格式）
  → 批量写入 v2_order_items
  → 记录 v3_batch_performance_log（各阶段耗时）
  → 写错误明细 v3_import_task_errors
BatchSucceeded / BatchFailed(Trace)
```

### 4.3 批量写入三级降级策略

| 级别 | 策略 | 场景 |
|------|------|------|
| ① | `batch_upsert_waybills` RPC | 首选。一次 RPC 写入整批，减少 HTTP 往返，性能最优 |
| ② | 单条 bulk INSERT 循环 | RPC 不可用时降级（如 RLS 阻断） |
| ③ | 分块 delete+insert | 存在重复键冲突时，清理后分块写入兜底 |

> 压测实测：RPC 方案将写入阶段从 44.6s 降至约 18s（性能提升 58%）。

### 4.4 部分失败处理

**成功行先入库**，失败行记录错误明细：

- 逐行校验，失败行写入 `v3_import_task_errors`（含 `row_number`、`error_code`、`raw_data`）；
- 成功行批量写入，不整体回滚；
- 任务终态为 `partial_success`，进度 = 成功+失败 / 总数。

---

## 5. Worker 容量规划与性能推导

### 5.1 容量参数

| 参数 | 值 | 说明 |
|------|-----|------|
| MAX_CONCURRENT | 5 | 同时处理的批次数量 |
| POLL_INTERVAL | 1000ms | 轮询间隔 |
| 单批行数 | 1000 | 每批 1000 行 |

### 5.2 吞吐推导

```
总行数 10,000 ÷ 10 批 = 1,000 行/批
单批总耗时（实测中位数）≈ 6s（写入阶段为主要瓶颈）
5 并发 → 每轮 5 批，2 轮完成
预期总耗时 ≈ 2 轮 × 6s + 初始化 ≈ 13s
```

**实测结果**（10000 行，含 5% 非法数据）：

| 指标 | 实测值 |
|------|--------|
| 总耗时 | 26.7s（含轮询间隔，< 60s 达标） |
| 吞吐量 | 375 行/秒 |
| 成功行 | 9509 |
| 失败行 | 491 |

### 5.3 数据库连接池控制

Worker 使用 `supabaseAdmin` 客户端池化 HTTP 连接；RPC 调用合并多条 SQL 减少连接占用。

---

## 6. 幂等设计

### 6.1 为什么"业务幂等"优于"消息只投递一次"

Outbox 的 `processing` 状态在 Worker 崩溃时会回退为 `pending` 重试，事件可能被处理多次。因此业务侧必须幂等：

| 层 | 幂等策略 |
|----|----------|
| 批次状态更新 | `UPDATE ... SET status='processing' WHERE id=? AND status='pending'`（CAS） |
| 订单写入 | 按 `external_order_no` 唯一约束；存在冲突时降级 delete+insert |
| 任务状态 | 幂等合并更新（`completed_at` 只写一次） |

### 6.2 故障恢复

- Worker 崩溃 → 批次 `locked_at` 超时（30s）→ 重置为 pending 重新领取；
- 事件处理失败 → `retry_count+1`，指数退避重试（最多 5 次）；
- 任务卡 pending → 手动 reset 脚本恢复。

---

## 7. 可观测性设计

### 7.1 Trace 全链路

`v3_trace_events` 表记录事件流，每个任务一个 `trace_id`：

```
ImportTaskCreated → TaskInitialized → BatchStarted×N
  → BatchSucceeded/BatchFailed×N → ImportTaskCompleted
```

事件含 `unit_id`、`event_name`、`event_status`、`occurred_at`，可在 Trace 检索页按 task_id/trace_id 查询。

### 7.2 监控看板（4 核心区域）

| 区域 | 指标 | 数据来源 |
|------|------|----------|
| 实时吞吐 | 行/秒 | `v3_import_tasks` 耗时聚合 |
| 队列积压 | pending Outbox/批次 | `v3_event_outbox`、`v3_import_task_batches` |
| 阶段耗时 | P50/P95/P99 | `v3_batch_performance_log` |
| 错误分布 | 错误码计数 | `v3_import_task_errors` |

### 7.3 数据模型

核心表：`v3_import_tasks`（任务）、`v3_import_task_batches`（批次）、`v3_event_outbox`（Outbox）、`v3_batch_performance_log`（性能）、`v3_import_task_errors`（错误）、`v3_trace_events`（Trace）、`v2_order_items`（订单明细）、`v3_sku_master`（SKU 主数据）。
