# V3 异步导入系统 - 接口文档

本文档覆盖考题《提交物清单》第 8 项要求的全部接口：**上传、任务查询、错误查询、批次性能、Trace 搜索、监控聚合**。

所有接口均位于 `/api/v3/` 前缀，返回 JSON。错误统一返回 `{ "ok": false, "error": "错误信息" }`。

---

## 1. 上传接口

### POST /api/v3/import-tasks

创建导入任务，返回 `task_id` 与 `trace_id`（异步处理，立即返回）。

**请求体**（`multipart/form-data`）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | Excel 文件（.xlsx/.xls） |
| rule_id | string | 是 | 解析规则 ID |
| taskName | string | 否 | 任务名称（默认取文件名） |

**响应示例**：

```json
{
  "ok": true,
  "task_id": "task_1786073049946_aff01e8f",
  "trace_id": "trace_41a85f75-9ba",
  "status": "pending",
  "total_rows": 10000,
  "total_batches": 10,
  "needWorkerInit": true
}
```

**说明**：
- 上传接口仅负责解析文件、创建任务与 Outbox 事件，**不阻塞等待处理完成**；
- `needWorkerInit=true` 表示批次由 Worker 初始化（非预解析模式，降低上传耗时）；
- 使用 `create_import_task` PostgreSQL RPC 一次完成任务创建 + Outbox 写入，减少 HTTP 往返。

---

## 2. 任务查询

### GET /api/v3/import-tasks?page=1&pageSize=20

查询任务列表（支持分页）。

**响应**：

```json
{
  "ok": true,
  "tasks": [
    {
      "id": "task_1786073049946_aff01e8f",
      "status": "partial_success",
      "total_rows": 10000,
      "processed_rows": 10000,
      "success_rows": 9509,
      "failed_rows": 491,
      "total_batches": 10,
      "completed_batches": 10,
      "degraded": false,
      "file_name": "10000-orders.xlsx",
      "created_at": "2026-08-07T02:00:00.000Z",
      "completed_at": "2026-08-07T02:00:26.7Z"
    }
  ],
  "total": 5,
  "page": 1,
  "page_size": 20
}
```

### GET /api/v3/import-tasks/:taskId

查询单个任务详情（含进度、状态）。

**状态枚举**：`pending`（等待处理）→ `processing`（处理中）→ `completed`（完成）| `partial_success`（部分成功）| `failed`（失败）。

### DELETE /api/v3/import-tasks/:taskId

删除任务（级联删除批次、错误、性能日志、Outbox、Trace 事件）。

---

## 3. 错误明细查询

### GET /api/v3/import-tasks/:taskId/errors?batch=4&error_code=E001&page=1&page_size=50

按批次、错误码筛选，分页返回错误明细。

**查询参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| batch | number | 批次索引（可选） |
| error_code | string | 错误码，如 E001/E002（可选，兼容旧参数名 `code`） |
| page | number | 页码，默认 1 |
| page_size | number | 每页条数，默认 50 |

**响应**：

```json
{
  "ok": true,
  "errors": [
    {
      "id": "...",
      "task_id": "task_...",
      "batch_index": 4,
      "row_number": 1523,
      "error_code": "E001",
      "error_message": "SKU 编码 SKU_99999 不存在",
      "raw_data": { "外部编码": "ORD_0001523", "skuCode": "SKU_99999" },
      "created_at": "2026-08-07T02:00:10.000Z"
    }
  ],
  "total": 221,
  "page": 1,
  "page_size": 50,
  "error_summary": { "E001": 221, "E002": 270 }
}
```

---

## 4. 批次性能查询

### GET /api/v3/import-tasks/:taskId/batches

获取任务下所有批次的状态与性能日志（解析/规则/校验/写入各阶段耗时）。

**响应**：

```json
{
  "ok": true,
  "batches": [
    {
      "unit_id": "unit_1",
      "batch_index": 0,
      "start_row": 1,
      "end_row": 1000,
      "status": "completed",
      "locked_at": "2026-08-07T02:00:02.000Z",
      "completed_at": "2026-08-07T02:00:08.5Z",
      "parse_duration_ms": 25,
      "rule_duration_ms": 918,
      "validate_duration_ms": 2372,
      "insert_duration_ms": 5860,
      "total_duration_ms": 5860,
      "rows_processed": 1000,
      "rows_success": 953,
      "rows_failed": 47
    }
  ]
}
```

---

## 5. Trace 搜索

### GET /api/v3/traces/search?task_id=xxx&trace_id=xxx&event_name=xxx&limit=50

按任务、Trace ID、事件名搜索全链路事件。

**查询参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| task_id | string | 按任务 ID 过滤（可选） |
| trace_id | string | 按 Trace ID 过滤（可选） |
| event_name | string | 按事件名过滤（可选） |
| limit | number | 返回条数上限，默认 50 |

**事件流**：`ImportTaskCreated` → `TaskInitialized` → `BatchStarted` → `BatchSucceeded`/`BatchFailed` → `ImportTaskCompleted`。

**响应**：

```json
{
  "ok": true,
  "events": [
    {
      "id": "...",
      "trace_id": "trace_41a85f75-9ba",
      "task_id": "task_...",
      "unit_id": "unit_1",
      "event_name": "BatchStarted",
      "event_status": "success",
      "message": "批次 0 开始处理",
      "occurred_at": "2026-08-07T02:00:02.000Z"
    }
  ],
  "total": 23
}
```

### GET /api/v3/traces/:traceId

按 Trace ID 查询完整链路事件。

---

## 6. 监控聚合

### GET /api/v3/import-monitor/summary

返回监控看板 4 个核心区域的聚合指标。

**响应**：

```json
{
  "ok": true,
  "summary": {
    "total": 5,
    "pending": 0,
    "processing": 0,
    "completed": 2,
    "partial_success": 3,
    "failed": 0,
    "total_rows": 50000,
    "success_rows": 47545,
    "failed_rows": 2455,
    "avg_duration_ms": 26700,
    "throughput_rows_per_sec": 375,
    "pending_outbox": 0,
    "pending_batches": 0,
    "stage_metrics": {
      "parse_duration_ms": { "p50": 28, "p95": 41, "p99": 45 },
      "rule_duration_ms": { "p50": 920, "p95": 1740, "p99": 2100 },
      "validate_duration_ms": { "p50": 2050, "p95": 3100, "p99": 3400 },
      "insert_duration_ms": { "p50": 3027, "p95": 9883, "p99": 11200 },
      "total_duration_ms": { "p50": 3050, "p95": 9900, "p99": 11500 }
    },
    "error_distribution": { "E001": 221, "E002": 270 }
  }
}
```

**指标说明**：
- **吞吐量** `throughput_rows_per_sec`：成功+失败行数 / 平均任务耗时；
- **队列积压** `pending_outbox` / `pending_batches`：等待处理的 Outbox 事件数与批次行数；
- **阶段耗时** `stage_metrics`：解析/规则/校验/写入各阶段 P50/P95/P99；
- **错误分布** `error_distribution`：各错误码出现次数。

---

## 错误码约定

| 错误码 | 含义 |
|--------|------|
| E001 | SKU 编码不存在（主数据缺失） |
| E002 | 必填字段为空 |
| E003 | 数据格式错误 |

## 通用约定

- 所有响应含 `Cache-Control: no-store`，保证实时性；
- 服务端使用 `supabaseAdmin`（service_role）查询，绕过 RLS 限制；
- 时间戳均为 ISO 8601 UTC 格式。
