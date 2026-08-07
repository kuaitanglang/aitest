/**
 * V3 类型定义
 *
 * 所有 V3 模块共享的类型、枚举、接口定义。
 */

/** 任务状态 */
export type TaskStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'partial_success'
  | 'failed';

/** 批次状态 */
export type BatchStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** Trace 事件状态 */
export type TraceStatus = 'success' | 'failed' | 'warning';

/**
 * 错误码枚举
 *
 * 与 v3_import_task_errors.error_code 字段对应。
 * 编号规则：E0xx，便于前端按码分类展示。
 */
export const ERROR_CODES = {
  /** E001: SKU 在主数据中不存在 */
  SKU_NOT_FOUND: 'E001',
  /** E002: 必填字段缺失（基于 V2 SYSTEM_FIELDS.required） */
  REQUIRED_MISSING: 'E002',
  /** E003: 电话格式错误（非 11 位手机号） */
  PHONE_FORMAT: 'E003',
  /** E004: 数量不是正数 */
  QUANTITY_INVALID: 'E004',
  /** E005: 外部编码在当前批次中重复 */
  EXTERNAL_CODE_DUPLICATE: 'E005',
  /** E006: 规则映射失败 */
  RULE_MAPPING_FAILED: 'E006',
  /** E007: 数据库写入失败 */
  DB_WRITE_FAILED: 'E007',
  /** E008: 文件格式不支持 */
  FILE_FORMAT_UNSUPPORTED: 'E008',
} as const;

/**
 * 错误码 → 描述信息映射
 * 每个错误码都必须有对应的描述（v3-tests.ts 会校验完整性）
 */
export const ERROR_MESSAGES: Record<string, string> = {
  [ERROR_CODES.SKU_NOT_FOUND]: 'SKU 在主数据中不存在',
  [ERROR_CODES.REQUIRED_MISSING]: '必填字段缺失',
  [ERROR_CODES.PHONE_FORMAT]: '电话格式错误，应为 11 位手机号',
  [ERROR_CODES.QUANTITY_INVALID]: '数量不是正数',
  [ERROR_CODES.EXTERNAL_CODE_DUPLICATE]: '外部编码在当前批次中重复',
  [ERROR_CODES.RULE_MAPPING_FAILED]: '规则映射失败，无法解析该字段',
  [ERROR_CODES.DB_WRITE_FAILED]: '数据库写入失败',
  [ERROR_CODES.FILE_FORMAT_UNSUPPORTED]: '文件格式不支持',
};

/** 错误码类型 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * 批次处理 payload
 *
 * 从 outbox 事件传递给 Worker，包含处理单个批次所需的全部信息。
 * 字段口径与 v3_import_task_batches 表 + outbox 事件 payload 一致。
 */
export interface ImportBatchPayload {
  task_id: string;
  unit_id: string;
  batch_index: number;
  /** 1-based 起始行（不含表头） */
  start_row: number;
  /** 1-based 结束行（不含表头） */
  end_row: number;
  trace_id: string;
  rule_id: string;
  file_url: string;
  file_name: string;
  /** AI 直接解析模式的预解析结果 JSON URL（规则引擎模式为空） */
  items_url?: string;
}

/**
 * 导入错误记录（对应 v3_import_task_errors 表）
 */
export interface ImportError {
  task_id: string;
  unit_id: string;
  batch_index: number;
  row_number: number;
  field_name: string;
  raw_value: string;
  error_code: string;
  error_reason: string;
  trace_id: string;
}

/**
 * 批次性能日志（对应 v3_batch_performance_log 表）
 */
export interface BatchPerformanceLog {
  task_id: string;
  unit_id: string;
  batch_index: number;
  parse_duration_ms: number;
  rule_duration_ms: number;
  validate_duration_ms: number;
  insert_duration_ms: number;
  total_duration_ms: number;
  rows_processed: number;
  rows_success: number;
  rows_failed: number;
  status: string;
  trace_id: string;
}

/**
 * 导入任务（对应 v3_import_tasks 表）
 */
export interface ImportTask {
  id: string;
  file_name: string;
  file_url: string;
  rule_id: string;
  status: TaskStatus;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  trace_id: string;
  degraded: boolean;
  degraded_rows: string[];
  error_summary: Record<string, number>;
  created_at?: string;
  completed_at?: string | null;
}

/**
 * 批次记录（对应 v3_import_task_batches 表）
 */
export interface ImportBatch {
  task_id: string;
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  status: BatchStatus;
  locked_at?: string | null;
  completed_at?: string | null;
}

/**
 * Trace 事件（对应 v3_trace_events 表）
 */
export interface TraceEvent {
  trace_id: string;
  task_id: string;
  unit_id: string;
  event_type: string;
  status: string;
  message: string;
  created_at?: string;
}

/**
 * outbox 事件信封
 */
export interface OutboxEnvelope<T = Record<string, unknown>> {
  event_type: string;
  aggregate_id: string;
  trace_id: string;
  occurred_at: string;
  payload: T;
}
