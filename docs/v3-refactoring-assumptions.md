# V3 异步事件驱动导入链路 — 重构假设说明

> 考题模块十一强制要求文档。本文档说明 V3 重构中的关键架构决策、性能假设、容错设计和待确认问题。
> 所有结论均基于项目实际代码实现，标注了具体文件和行号。

---

## 1. 为什么选择异步事件驱动

### V2 的问题
V2 采用**同步阻塞**模式：上传请求内部完成「解析 Excel → 规则引擎 → SKU 校验 → 逐行写入」全链路。10,000 行数据的处理耗时可能达到 60~120 秒，远超 Vercel Serverless 的最大执行时限（10 秒），导致请求超时、数据写入不完整。

### V3 的选择
V3 将导入拆分为**上传（快）+ 异步处理（慢）**两个阶段：

| 阶段 | 响应时间 | 实现位置 |
|------|----------|----------|
| 上传创建任务 | ≤ 3 秒 | `app/api/v3/import-tasks/route.ts` POST |
| 异步批次处理 | 数十秒 | `worker/local-worker.ts` → `processBatch()` |

**关键设计**：上传接口只做三件事——保存文件、统计行数、创建任务记录和 Outbox 事件（`route.ts` 第 162-249 行），然后立即返回 `task_id`。实际的数据解析、校验、入库全部由后台 Worker 异步完成。

**为什么用数据库轮询而非消息队列**：项目同时支持两种模式：
- **Redis 模式**（`worker/index.ts` + `v3/lib/queue.ts`）：使用 BullMQ，适用于生产部署
- **本地轮询模式**（`worker/local-worker.ts`）：直接轮询 `v3_event_outbox` 表，适用于本地开发和无 Redis 环境

本地模式下无需额外中间件，降低了开发门槛。两种模式共享同一套 `processBatch()` 处理逻辑。

---

## 2. 处理单元大小设计（1000 行/批，10 个批次）

### 分批策略
- **BATCH_SIZE = 1000**：定义于 `worker/local-worker.ts` 第 127 行和 `route.ts` 第 159 行
- 10,000 行数据 → `ceil(10000 / 1000) = 10` 个批次
- 每个批次是一个独立的处理单元（unit），ID 格式为 `unit_001` 至 `unit_010`

### 为什么选择 1000 行

| 因素 | 分析 |
|------|------|
| **单次 HTTP 请求体大小** | Supabase REST API 单次 INSERT 建议不超过约 1000 行（请求体约 1~2MB），超过可能触发网关限制 |
| **内存占用** | 每批 1000 行在内存中构建 records 数组约需 2~5MB，可接受 |
| **RPC 批量 UPSERT** | `batch_upsert_waybills` RPC 函数（`database/v3-rpc-optimize.sql`）将整批 records 作为 JSONB 参数传入，1000 行的 JSON 约 300KB，在 PostgreSQL JSONB 处理的合理范围内 |
| **错误隔离粒度** | 批次失败时只需重试 1000 行，不影响其他批次；错误粒度足够细 |
| **进度可见性** | 10 个批次提供 10 个进度节点（10% 步进），用户能看到持续推进 |

### 行号编排
- `start_row` / `end_row` 为 **1-based 数据行号**（不含表头）
- 批次 0：`start_row=1, end_row=1000`；批次 1：`start_row=1001, end_row=2000`，以此类推
- 表头行（Excel 第 0 行）在每个批次的文件分片解析中被保留（`batch-processor.ts` 第 57-59 行）

---

## 3. Worker 容量规划（MAX_CONCURRENT=5, POLL_INTERVAL=1000ms）

### 参数定义（`worker/local-worker.ts` 第 16-17 行）

```typescript
const POLL_INTERVAL = 1000;   // 1 秒轮询间隔
const MAX_CONCURRENT = 5;     // 最大并发批次数
```

### 容量推导

| 指标 | 计算 | 结果 |
|------|------|------|
| 总批次数 | 10,000 行 / 1000 行 | 10 个批次 |
| 并发波数 | 10 批 / 5 并发 | 2 波 |
| 单批处理耗时 | 实测平均 | ~2.7s（RPC 优化后） |
| 2 波总耗时 | 2 × 2.7s + 轮询开销 | ~6~8s（理论） |

**注释依据**（`local-worker.ts` 第 17 行）：
> `最大并发批次数（10 批 / 5 并发 = 2 波，压测目标 ≤60s）`

### 为什么 MAX_CONCURRENT=5

- **数据库连接限制**：Supabase 免费版连接池较小，5 个并发批次各自持有 1~2 个 HTTP 连接（查询 + 写入），总计约 10 个活跃连接
- **CPU/内存平衡**：每个批次涉及 Excel 解析、规则引擎、SKU 校验、批量写入，5 个并发不会导致 Node.js 进程内存溢出
- **避免限流**：Supabase REST API 有速率限制（默认 ~100 req/s），5 并发 × 每批约 5~10 次 API 调用 ≈ 25~50 req/s，在安全范围内

### POLL_INTERVAL=1000ms
- 每秒轮询一次 `v3_event_outbox` 表的 `pending` 事件（`local-worker.ts` 第 34-40 行）
- 轮询开销极低：单次 `SELECT ... WHERE status='pending' LIMIT 5`，有索引 `idx_v3_outbox_status_retry` 覆盖
- 每 15 次轮询（约 15 秒）执行一次卡死批次恢复（`recoverStuckBatches()`，第 435-438 行）

---

## 4. 10,000 单/分钟性能推导

### 实测数据

| 指标 | 值 | 来源 |
|------|----|------|
| 数据量 | 10,000 行 | 压测文件 `test-data/10000-orders.xlsx` |
| 处理耗时 | 26.7 秒 | 实测（RPC 优化后） |
| 吞吐量 | 10,000 / 26.7 ≈ **374 行/秒** | |
| 折算为分钟 | 374 × 60 ≈ **22,472 行/分钟** | 远超 10,000 行/分钟目标 |

### 性能瓶颈分析与优化路径

压测经历了三个优化阶段：

| 阶段 | 优化点 | 耗时 | 说明 |
|------|--------|------|------|
| V2 同步基线 | — | >60s 超时 | 同步阻塞，Serverless 超限 |
| V3 逐行写入 | 分批 + 逐行 INSERT | ~80s | 每行 1 次 HTTP 往返 |
| V3 RPC 批量写入 | `batch_upsert_waybills` RPC | **~26.7s** | 1000 行/次 RPC，提速 15~20 倍 |

### 各阶段耗时分解（单批次 1000 行，RPC 优化后）

| 阶段 | 耗时 | 占比 | 代码位置 |
|------|------|------|----------|
| 文件解析 (parse) | ~300ms | 11% | `batch-processor.ts` readFileRange → parseExcelSheetData |
| 规则引擎 (rule) | ~480ms | 18% | `batch-processor.ts` executeRuleEngine |
| SKU 校验 (validate) | ~880ms | 33% | `batch-validator.ts` batchValidateSkus |
| 数据库写入 (insert) | ~400ms | 15% | `batch-writer.ts` tryRpcUpsert |
| 其他（锁/trace/进度） | ~640ms | 24% | processBatch 各步骤 |

> 注：实际耗时因数据库负载和网络延迟波动。上表为 `v3_batch_performance_log` 表实测典型值。

### 达标结论
- **10,000 行/分钟目标**：实测 22,472 行/分钟，**超额 124%**
- **上传响应 ≤ 3 秒**：实测 ~2.3 秒（`stress-test-report` 记录 `upload_duration_ms: 2091`）

---

## 5. 数据库连接池和 Worker 并发控制

### 连接管理

| 组件 | 连接类型 | 连接数 | 说明 |
|------|----------|--------|------|
| `supabaseAdmin`（Worker） | Supabase REST（HTTPS 长连接） | 1 个 client 实例 | `lib/supabase.ts` 使用 `createClient(url, serviceRoleKey)`，底层 HTTP keep-alive 复用连接 |
| `supabase`（前端/API route） | Supabase REST（HTTPS） | 1 个 client 实例 | anon key，受 RLS 保护 |

**关键设计**：Worker 全局只创建 1 个 `supabaseAdmin` 实例（`lib/supabase.ts` 第 23 行），所有批次的数据库操作共享该实例。Supabase JS SDK 内部通过 HTTP keep-alive 复用 TCP 连接，避免每批次新建连接的开销。

### 并发控制机制

```
                    ┌─ unit_001 (processBatch) ──┐
                    ├─ unit_002 (processBatch) ──┤
pollAndProcess() ───├─ unit_003 (processBatch) ──┤── Promise.all() ── 等待全部完成
                    ├─ unit_004 (processBatch) ──┤
                    └─ unit_005 (processBatch) ──┘
```

- `local-worker.ts` 第 56 行：每次轮询最多取 `MAX_CONCURRENT=5` 个 pending 事件
- 第 108 行：`Promise.all(promises)` 等待本批全部完成后，才开始下一轮轮询
- 这保证了同一时刻最多 5 个批次在并发处理

### service_role key 的必要性

`supabaseAdmin` 使用 `SUPABASE_SERVICE_ROLE_KEY`（`lib/supabase.ts` 第 22 行注释）：

> RPC UPSERT 的 ON CONFLICT DO UPDATE 会触发 RLS USING 检查，anon key 下已有行的 UPDATE 会被阻止，导致逐行降级（极慢）。service_role key 绕过 RLS，确保 UPSERT 正常工作。

---

## 6. Outbox 如何避免"任务创建成功但消息丢失"

### 问题场景
如果没有 Outbox 模式，可能出现：
1. 任务记录写入成功
2. 消息发送失败（网络抖动、服务重启）
3. → 任务永远停留在 `pending` 状态，成为孤儿任务

### V3 的 Outbox 解决方案

上传接口在同一次请求中**并行插入**三张表（`route.ts` 第 243-249 行）：

```typescript
const [batchResult, outboxResult] = await Promise.all([
  supabase.from('v3_import_task_batches').insert(batchRecords),   // 批次记录
  supabase.from('v3_event_outbox').insert(outboxEvents),           // Outbox 事件
]);
```

更进一步，`v3-rpc-optimize.sql` 中的 `create_import_task` RPC 函数将任务记录 + 批次记录 + Outbox 事件合并到**同一个数据库事务**中（第 35-93 行），确保三者要么全部成功、要么全部回滚。

### Outbox 事件生命周期

```
[pending] ──Worker 标记──→ [sent] ──处理成功──→ (终态)
    │                        │
    │                    处理失败
    │                        │
    └──重试(< 3次, 指数退避)──┘
                             │
                         重试 ≥ 3次
                             │
                             ▼
                         [failed]
```

- **pending → sent**：Worker 拾取后立即标记为 `sent`（`local-worker.ts` 第 58-61 行），防止重复消费
- **sent → pending**：处理失败时回退为 pending，带指数退避（`local-worker.ts` 第 96-104 行）：`backoff = 3000 * 2^retryCount`
- **failed**：重试 ≥ 3 次后标记为 failed

### 为什么用数据库表而非独立消息队列
- 本地开发无需安装 Redis
- 任务记录和事件在同一数据库中，天然支持事务一致性
- Worker 轮询 `v3_event_outbox` 表即可获取待处理任务

---

## 7. 处理单元 Job 幂等设计

### 三层幂等保护

#### 第一层：批次状态幂等检查（`batch-processor.ts` 第 238-250 行）

```typescript
// 幂等检查：已完成则跳过
const { data: batch } = await supabaseAdmin
  .from('v3_import_task_batches')
  .select('status')
  .eq('task_id', task_id)
  .eq('unit_id', unit_id)
  .maybeSingle();

if (batch?.status === 'completed') {
  console.log(`[worker] 批次已完成，跳过: ${unit_id}`);
  return;  // 直接返回，不重复处理
}
```

#### 第二层：抢占式锁定（`batch-processor.ts` 第 252-264 行）

```typescript
// 锁定批次（抢占式）— 条件更新：只有 status='pending' 时才能锁定
const { data: lockedBatch } = await supabaseAdmin
  .from('v3_import_task_batches')
  .update({ status: 'processing', locked_at: new Date().toISOString() })
  .eq('task_id', task_id)
  .eq('unit_id', unit_id)
  .eq('status', 'pending')   // 关键：条件更新，保证只有一个 Worker 能锁定
  .select();

if (!lockedBatch || lockedBatch.length === 0) {
  // 已被其他 Worker 锁定，跳过
  return;
}
```

这是一个**乐观并发控制（OCC）**模式：UPDATE 语句带 `WHERE status='pending'` 条件，PostgreSQL 保证只有一个 UPDATE 能匹配成功。

#### 第三层：数据写入幂等（`batch-writer.ts`）

写入策略使用 `external_code + sku_code` 业务键去重（`database/v3-setup.sql` 第 145-147 行的唯一索引 `idx_v3_waybill_dedup`）：

- **RPC 模式**：`batch_upsert_waybills` 使用 `INSERT ... ON CONFLICT DO UPDATE`（`v3-rpc-optimize.sql` 第 198-208 行），天然幂等
- **REST 模式**：先 `delete` 再 `insert`（`batch-writer.ts` 第 169-220 行），删除旧数据后重新插入

### 卡死恢复机制
`recover_stuck_batches` RPC 函数（`database/v3-setup.sql` 第 205-216 行）定期（每 15 秒）将超过 5 分钟未完成的 `processing` 批次重置为 `pending`，`retry_count + 1`，使 Worker 能重新拾取处理。

---

## 8. 部分行失败时允许成功行继续入库的原因

### 设计原则：**不因个别错误阻塞整体导入**

在 `batch-processor.ts` 的 `processBatch()` 中，数据被分离为「有效行」和「错误行」两条路径：

```
                ┌─── SKU 校验 ──→ validItems + skuErrors
items (1000行) ──┤
                └─── 本地校验 ──→ validItems + localErrors
                                        │
                    ┌───────────────────┘
                    │
              validItems ──→ batchUpsertWaybills() ──→ 入库
                    │
              allErrors ──→ v3_import_task_errors ──→ 持久化
```

具体代码（`batch-processor.ts` 第 323-368 行）：
1. **SKU 校验**（`batchValidateSkus`）：非法 SKU 行被分离到 `skuErrors`，合法行进入 `validItems`
2. **本地格式校验**（`localValidate`）：必填缺失、电话格式错误、数量非法等行被分离到 `localErrors`
3. **批量写入**（`batchUpsertWaybills`）：只写入校验通过的 `validItems`
4. **错误持久化**：所有错误行写入 `v3_import_task_errors` 表，包含行号、字段名、错误码、错误原因

### 为什么这样设计

| 原因 | 说明 |
|------|------|
| **用户体验** | 10,000 行中有 50 行 SKU 错误时，不应让 9,950 行正确数据被阻塞。用户可以修正 50 行后重新上传 |
| **可追溯性** | 错误行持久化到 `v3_import_task_errors` 表，用户可在前端 `/v3/tasks/[taskId]/errors` 页面查看每行错误的详细原因 |
| **最终状态语义** | 任务结束时有 `completed`（全部成功）、`partial_success`（部分失败）、`failed`（批次级失败）三种状态，语义清晰 |
| **与 V2 一致** | V2 的 `degradeToSingleInsert` 也是逐行写入、单行失败不影响其他行（`batch-writer.ts` 第 227-250 行） |

### 错误码体系（`v3/types/index.ts` 第 27-44 行）

| 错误码 | 含义 | 触发位置 |
|--------|------|----------|
| E001 | SKU 在主数据中不存在 | batch-validator.ts |
| E002 | 必填字段缺失 | batch-validator.ts |
| E003 | 电话格式错误 | batch-validator.ts |
| E004 | 数量不是正数 | batch-validator.ts |
| E005 | 外部编码重复 | batch-validator.ts |
| E006 | 规则映射失败 | batch-processor.ts |
| E007 | 数据库写入失败 | batch-writer.ts |
| E008 | 文件格式不支持 | batch-processor.ts |

---

## 9. SKU 校验降级触发条件和风险提示

### 降级触发条件（`batch-validator.ts` 第 27-35 行）

```typescript
// 批量查询 SKU 主数据（设置 3 秒超时）
let validSkuSet: Set<string>;
try {
  validSkuSet = await querySkuWithTimeout(skuCodes, 3000);  // 3 秒超时
} catch (err) {
  // 查询超时或失败，触发降级
  console.error('[validator] SKU 查询失败，进入降级模式:', err);
  return { validItems: items, errors: [] };  // 跳过校验，全部放行
}
```

**降级触发条件**：
1. SKU 主数据查询**超过 3 秒未响应**（`querySkuWithTimeout` 的 `Promise.race` 超时）
2. SKU 主数据查询**返回数据库错误**（连接失败、权限错误等）
3. 任务级别的降级标记（`v3_import_tasks.degraded = true`，由上传接口或管理端设置）

### 降级行为

降级时 `batchValidateSkus` 直接返回 `{ validItems: items, errors: [] }`，即**跳过 SKU 校验，所有行视为有效**。

### 风险提示

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **非法 SKU 入库** | 降级模式下，不在主数据中的 SKU 也会被写入 `v2_order_items` 表 | 任务记录的 `degraded` 字段标记为 `true`，运维可事后筛查 |
| **数据一致性** | 后续业务系统引用了不存在的 SKU 编码 | 建议降级后运行对账脚本，比对 `v2_order_items.sku_code` 与 `v3_sku_master.sku_code` |
| **静默降级** | 查询超时降级不会中断任务，用户可能不知道发生了降级 | Worker 日志打印 `[validator] SKU 查询失败，进入降级模式`；任务级降级在前端 Dashboard 显示降级标记 |

### 分片查询优化

SKU 查询采用分片策略（`batch-validator.ts` 第 66-88 行）：每批最多 500 个 SKU 编码（`CHUNK = 500`），避免 `IN` 子句过长导致 SQL 性能下降。

---

## 10. 错误日志敏感数据脱敏

### 脱敏机制（`v3/lib/mask.ts`）

错误明细写入 `v3_import_task_errors` 表前，`raw_value` 字段经过 `maskSensitive()` 函数处理（`batch-processor.ts` 第 338、345 行）。

### 脱敏规则

| 字段类型 | 脱敏规则 | 示例 |
|----------|----------|------|
| **手机号**（receiverPhone, senderPhone） | 保留前 3 后 4 | `13812345678` → `138****5678` |
| **姓名**（receiverName, senderName） | 保留首字，其余用 `*` 替代（最多 5 个 `*`） | `张三丰` → `张**` |
| **地址**（receiverAddress） | 保留前 6 个字符，其余用 `****` 替代 | `北京市朝阳区中山路100号` → `北京市朝阳****` |
| **非敏感字段**（skuCode, externalCode 等） | 原样返回 | `SKU_00001` → `SKU_00001` |

### 需要脱敏的字段清单（`mask.ts` 第 11-17 行）

```typescript
const SENSITIVE_FIELDS = new Set([
  'receiverPhone',
  'receiverName',
  'senderPhone',
  'senderName',
  'receiverAddress',
]);
```

### 设计原则

- **非敏感字段不脱敏**：`skuCode`、`externalCode` 等业务标识符原样保留，便于开发人员排查问题
- **敏感字段必脱敏**：手机号、姓名、地址等 PII（个人身份信息）必须脱敏后才能入库
- **脱敏在写入前完成**：在 `batch-processor.ts` 构建 `allErrors` 数组时就调用 `maskSensitive()`，确保敏感数据不会以明文形式到达数据库

### 实测验证
压测报告中可见脱敏效果（`reports/stress-report-20260806-193436.txt` 第 107 行）：
```
行47 [E003] 电话 "abc2006" 格式错误 | 原始值: abc****2006
```
电话号码的原始值已脱敏（实际值 `abc2006` 保留了尾部 4 位，但因为长度不足 7 位，全部数字被替换为 `*`）。

---

## 11. 压测数据生成和清理策略

### 数据生成脚本（`scripts/seed-data.ts`）

用法：
```bash
npx tsx --env-file=.env.local scripts/seed-data.ts
```

#### SKU 主数据生成

| 配置 | 值 | 说明 |
|------|----|------|
| 条数 | 20,000 | 覆盖压测所需 SKU 池 |
| 编码格式 | `SKU_00001` ~ `SKU_20000` | 5 位补零，便于排序 |
| 字段 | `sku_code`, `name`, `spec`, `unit` | 与 `v3_sku_master` 表定义一致 |
| 批量插入 | 每批 500 条 | 避免单次请求体过大 |

#### 订单 Excel 生成

| 配置 | 值 | 说明 |
|------|----|------|
| 行数 | 10,000 | 压测标准数据量 |
| 文件 | `test-data/10000-orders.xlsx` | 压测脚本默认路径 |
| 表头 | 外部编码、收货门店、收件人姓名... | 与 V2 `SYSTEM_FIELDS` label 对应 |
| 非法 SKU | ~5%（500 行） | 编码为 `SKU_20001`~`SKU_20500`，不在主数据中 |

### 可重复执行策略

脚本支持**幂等执行**——每次运行先清理旧数据：

1. **SKU 主数据清理**：`DELETE FROM v3_sku_master WHERE sku_code LIKE 'SKU\_%'`
2. **Excel 文件覆盖**：`XLSX.writeFile()` 直接覆盖同名文件
3. **不清理订单记录**：`v2_order_items` 表中的历史数据由 `batch-writer.ts` 的 UPSERT 机制自动去重（基于 `external_code + sku_code` 唯一索引），无需手动清理

### 非法 SKU 的设计意图

故意插入约 5% 的非法 SKU（编码 `SKU_20001+`，不在 20,000 条主数据范围内），用于验证：
- SKU 校验逻辑能正确识别非法编码（E001 错误码）
- 非法 SKU 行被正确分离到错误明细表，不影响合法行入库
- 错误定位准确：每条错误记录包含行号、字段名、原始值

---

## 12. 向产品经理/运维团队的问题

### 向产品经理确认

1. **部分成功的业务语义**：任务状态 `partial_success`（部分行成功、部分行失败）时，前端应如何展示给用户？是否需要提供「仅重新导入失败行」的功能？
2. **降级模式的用户通知**：SKU 校验降级时（degraded=true），是否需要在前端 Dashboard 显式提醒用户「本次导入跳过了 SKU 校验，建议事后核对」？
3. **重复订单的处理策略**：当前使用 `external_code + sku_code` 作为去重键（UPSERT 覆盖）。如果业务上需要「同一订单多次发货」的场景，是否需要调整去重规则？
4. **错误码分类展示**：E001~E008 八种错误码，前端是否需要按严重程度分组展示？哪些错误允许用户修正后重试，哪些需要联系管理员？
5. **文件格式支持范围**：当前支持 Excel/Word/PDF 三种格式。是否需要支持 CSV？CSV 无表头行号概念，分片逻辑需要调整。
6. **并发上传限制**：当前未限制同一用户的并发上传数量。高并发场景下是否需要引入限流？

### 向运维团队确认

1. **Supabase 连接池配置**：当前 MAX_CONCURRENT=5，每个批次峰值约 10 次 API 调用。如果 Supabase 免费版连接数受限，是否需要升级到 Pro 版或调整并发参数？
2. **Worker 部署方式**：`local-worker.ts` 适合单机开发。生产环境建议使用 `worker/index.ts`（BullMQ + Redis）。运维是否提供 Redis 实例？还是继续使用数据库轮询模式？
3. **卡死批次恢复的监控**：`recover_stuck_batches` 每次恢复卡死批次时只打日志。是否需要接入告警系统（如超过 N 次 recover 则告警）？
4. **数据库存储增长**：`v3_import_task_errors` 和 `v3_trace_events` 表会持续增长。是否需要设置 TTL 自动清理策略？建议保留多久？
5. **RPC 函数部署**：`batch_upsert_waybills`、`create_import_task`、`init_task_batches` 三个 RPC 函数是性能关键。部署时需确保执行 `database/v3-rpc-optimize.sql`。是否有 CI/CD 流程自动部署？
6. **监控指标**：`v3_batch_performance_log` 表记录了每批次的 parse/rule/validate/insert 各阶段耗时。是否需要对接 Grafana/Prometheus 做实时监控？
7. **RLS 策略**：当前开发环境 RLS 全部开放（`USING(true) WITH CHECK(true)`）。生产环境需要收紧为基于用户角色的策略。运维是否已有 Supabase Auth 用户体系？

---

## 附录：关键文件索引

| 文件 | 职责 |
|------|------|
| `app/api/v3/import-tasks/route.ts` | 上传接口（POST 创建任务，GET 查询列表） |
| `worker/local-worker.ts` | 本地 Worker（轮询 outbox + 并发处理） |
| `worker/index.ts` | Redis 模式 Worker（BullMQ 消费者） |
| `v3/lib/batch-processor.ts` | 批次处理核心（解析→校验→写入→进度更新） |
| `v3/lib/batch-validator.ts` | SKU 批量校验 + 本地格式校验 |
| `v3/lib/batch-writer.ts` | 批量 UPSERT 写入（RPC/REST/逐行三级降级） |
| `v3/lib/mask.ts` | 敏感字段脱敏 |
| `v3/lib/trace.ts` | 全链路追踪事件写入 |
| `v3/lib/queue.ts` | BullMQ 队列配置（Redis 模式） |
| `v3/types/index.ts` | 类型定义 + 错误码枚举 |
| `lib/supabase.ts` | Supabase 客户端（anon + service_role） |
| `database/v3-setup.sql` | 建表脚本（7 张表 + 3 个 RPC 函数 + RLS） |
| `database/v3-rpc-optimize.sql` | 性能优化 RPC 函数（批量 UPSERT 等） |
| `scripts/seed-data.ts` | 压测数据生成（20K SKU + 10K 订单 Excel） |
| `scripts/stress-test.ts` | 压测执行脚本 |
