# V3 导入页移植 V2 完整交互（高亮/行编辑/添加行/校验）

## Context（为什么做这个改动）

用户反馈：V3 导入页面丢失了 V2 的核心交互能力——字段不符合规则高亮、双击行编辑、添加/删除行、校验规则应用、错误抽屉、导出 Excel。当前 V3 只有简陋的"选文件→选规则→直接提交"流程。

考试文档（exam-v4-v2-async-event-driven-observability.md §1.1）明确 V2 核心能力包括"在预览页面进行校验、编辑和提交"。V3 应在 V2 完整交互基础上**新增**异步处理，而非替换。

**目标**：V3 上传页 = V2 的完整预览编辑校验交互 + V3 的异步任务提交。

## 设计概要

- **前端**：重写 `app/v3/page.tsx`，从 V2（`v2/page.tsx`）移植完整的可编辑预览表格、校验、高亮、行编辑、添加/删除行、错误抽屉、导出、AI 进度弹窗。提交改为创建异步任务。
- **提交统一发 items**：无论 AI 直接解析还是已有规则，提交时都发送用户确认后的最终 `items`（含编辑结果）+ `rule_id`（记录来源）+ `file`。Worker 用预解析 items 跳过规则引擎，保留用户编辑。
- **后端泛化**：检测 `items` 是否存在（而非 `mode` 字段）决定预解析/规则引擎模式。
- **Worker 分支修正**：`if (rule_id === '__ai_direct__')` → `if (items_url)`，确保已有规则+编辑提交也走预解析路径。
- **不抽共享组件**：直接在 V3 page 内联移植 V2 代码（避免改动已冻结的 V2，降低风险）。

## 复用的 V2 模块（不重写，只 import）

| 模块 | 路径 | 作用 |
|------|------|------|
| `validateAllItems` | `@/v2/lib/llm` | 批量校验 + 重复检测，返回 itemsWithErrors/errorList |
| `checkDuplicateExternalCodes` | `@/v2/lib/database` | API 查重，返回 Set<string> |
| `executeRuleEngineAsync` | `@/v2/lib/engine` | 异步分片规则引擎（不阻塞 UI） |
| `exportToExcel` | `@/v2/lib/parser` | 导出 Excel |
| `createEmptyOrderItem` / `SYSTEM_FIELDS` / `OrderItem` / `FieldError` / `OrderField` | `@/v2/types` | 类型与常量 |
| `RuleEditor` / `loadProvider` | `@/v2/components/RuleEditor` | 规则编辑器 |
| `getAllRules` / `saveRule` / `getRuleById` | `@/v2/lib/database` | 规则 CRUD |

## 实施步骤

### Step 1: Worker 分支条件修正（`v3/lib/batch-processor.ts`）

第 270 行 `if (rule_id === '__ai_direct__')` → `if (items_url)`。

理由：用户用已有规则解析→编辑→提交时，rule_id 是真实规则 ID（非 `__ai_direct__`），但携带了 items_url。若不改为 `if (items_url)`，Worker 会走规则引擎分支重新解析文件，**丢失用户编辑**。

日志文案改为"预解析模式"。

### Step 2: 后端泛化（`app/api/v3/import-tasks/route.ts`）

- 移除 `mode` 字段逻辑，改为 `const itemsJson = formData.get('items')`; `const hasItems = !!itemsJson`
- `rule_id` 必填（真实 ID 或 `__ai_direct__`）
- `hasItems` 时：解析 JSON → 存 JSON 文件 → 设 items_url → `totalRows = items.length`
- `hasItems` 为 false 时：`totalRows = quickCountRows(file)`（压测路径，Worker 走规则引擎）
- Outbox payload 在 `hasItems && itemsUrl` 时附加 `items_url`
- task 记录 `rule_id` = 前端传来的值（真实 ID 或 `__ai_direct__`）

### Step 3: V3 上传页重写（`app/v3/page.tsx`）— 核心

#### 3a. State 替换

删除：`previewItems`、`previewLoading`、`aiDirectItemsRef`

新增（从 V2 移植）：
- `items: OrderItem[]` — 完整可编辑数据（带 errors）
- `editingCell: { row: number; field: string } | null`
- `allErrors: { row; field; fieldLabel; message }[]`
- `errorDrawerOpen: boolean`
- `aiDirectModalOpen` / `aiDirectModalStep` — AI 解析进度弹窗
- `isProcessing` / `uploadProgress` / `progressText` / `parseFailed` — 解析进度

#### 3b. 函数移植（从 `v2/page.tsx` 逐字复制，仅改 import 路径）

| 函数 | V2 行号 | 说明 |
|------|---------|------|
| `handleCellChangeRef` + `handleCellChange` | 157-202 | 单元格编辑→重新校验→检测重复→更新 errors（保留 ref 模式） |
| `addRow` / `removeRow` | 600-606 | 添加/删除行 |
| `handleExport` | 608-617 | 导出 Excel |
| `runParseWithRule` | 305-372 | executeRuleEngineAsync→查重→validateAllItems→存 items |
| `runAIDirectParse` | 501-580 | 调 direct-parse API→校验→存 items + 进度弹窗 |
| `handlePickRule` | 377-422 | 选规则→立即解析（V2 完整版，含进度展示） |
| `handleSaveRule` | 436-449 | 保存规则后立即解析 |
| `previewColumns` (useMemo) | 746-805 | 可编辑列：双击 Input、错误红字红底+Tooltip、删除按钮 |
| `getRowClassName` | 808 | `r.errors.length > 0 ? 'row-error' : ''` |

#### 3c. handleSubmit 重写

提交前校验（与 V2 一致）：items 为空→警告；有 errors→Modal.error 列出前 20 条；Modal.confirm 二次确认。

提交时 FormData：
- `file`：原始文件（审计用）
- `rule_id`：真实规则 ID 或 `__ai_direct__`
- `items`：JSON.stringify(items)（用户确认后的最终数据）

成功后 `router.push(/v3/tasks/${task_id})`。

#### 3d. handleFileSelect 调整

文件解析成功后 `setItems([])` + `setAllErrors([])` + `setEditingCell(null)`。"重新选择"按钮同样清空。

#### 3e. JSX 渲染结构

```
V3Layout
├── Alert（架构说明，保留）
├── Card Step 1: 文件上传（保留现有 Dragger + 文件信息 + 进度）
├── Card Step 2: 规则选择（保留 Select + 新建规则 + 当前规则信息 + 解析进度 + parseFailed Alert）
├── Card 数据预览 & 提交（items.length > 0，从 V2 移植）
│   ├── 头部：stats Tag（total/error/valid）+ 按钮（新增空行/导出/创建异步任务）
│   ├── 错误 Alert（errorCount>0，带"查看全部错误"按钮→Drawer）
│   └── Table（virtual + bordered + previewColumns + getRowClassName + .row-error style）
├── Card V3 能力说明（保留）
├── RuleEditor（保留）
├── Drawer 错误抽屉（从 V2 移植）
└── Modal AI 直接解析进度（从 V2 移植）
```

#### 3f. 新增 import

```typescript
import { Modal, Drawer, Tooltip, Input } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, DownloadOutlined, SendOutlined } from '@ant-design/icons';
import { executeRuleEngineAsync } from '@/v2/lib/engine';
import { validateAllItems } from '@/v2/lib/llm';
import { checkDuplicateExternalCodes } from '@/v2/lib/database';
import { exportToExcel } from '@/v2/lib/parser';
import { createEmptyOrderItem, SYSTEM_FIELDS, type OrderField, type FieldError } from '@/v2/types';
```

### Step 4: 验证

1. **手动测试 V3 页面交互**（核心）：
   - 上传 Excel → 选已有规则 → 看到完整 items 表格
   - 双击单元格编辑 → 错误字段红字红底高亮 + Tooltip
   - 添加空行 / 删除行 / 导出 Excel
   - 有错误时提交被拦截（Modal.error）
   - 修复错误后提交 → 跳转任务详情页 → 任务处理成功
2. **AI 直接解析**：选 `__ai_direct__` → 进度弹窗 → items 表格 → 编辑 → 提交
3. **Worker 验证**：确认任务状态从 pending→processing→completed，数据入库
4. **TypeScript 编译**：`npx tsc --noEmit` 无错误
5. **压测路径**：压测脚本只发 rule_id+file（无 items），Worker 走规则引擎（未破坏）

## 已知限制（不在本次范围）

- **Vercel body 限制**：10,000 行 items JSON 约 5MB，可能超 Vercel 4.5MB 请求体限制。交互式导入通常文件较小；10,000 行压测走 rule_id+file 路径（无 items），不受影响。本地/自托管部署无此限制。
- **local-worker 恢复卡死批次**：`recoverStuckBatches` 重建 payload 时缺失 items_url（及其他字段），是既有问题，本次不修。
- **编辑性能**：handleCellChange 每次全量 validateAllItems，与 V2 一致，10,000 行约 10-30ms，可接受。
