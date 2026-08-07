'use client';

/**
 * V3 异步导入上传页面
 *
 * 设计原则（重新审题后的正确理解）：
 *   V3 = V2 的完整预览编辑校验交互 + V3 的异步任务提交
 *   即在 V2 基础上【新增】异步处理能力，而非替换 V2 的交互。
 *
 * 完整移植 V2 的交互能力：
 *   - 可编辑预览表格（双击单元格编辑、错误字段红字红底高亮 + Tooltip）
 *   - 添加 / 删除行
 *   - 校验规则应用（validateAllItems + 数据库查重 + 错误 Drawer）
 *   - 导出 Excel
 *   - 提交前校验（空数据阻断 / 有错误时警告提示但不阻断 / 二次确认）
 *   - AI 直接解析进度弹窗
 *
 * V3 在此基础上新增：
 *   - 提交改为创建异步任务（POST /api/v3/import-tasks），上传 ≤1s 返回
 *   - 提交时统一发送 items（含用户编辑结果）+ rule_id + file
 *   - 跳转到任务详情页查看异步处理进度
 *
 * 复用的 V2 模块（不重写，只 import）：
 *   - parseFileByType / exportToExcel (v2/lib/parser)
 *   - executeRuleEngineAsync (v2/lib/engine)
 *   - validateAllItems (v2/lib/llm)
 *   - checkDuplicateExternalCodes / getAllRules / saveRule / getRuleById (v2/lib/database)
 *   - RuleEditor / loadProvider (v2/components/RuleEditor)
 *   - createEmptyOrderItem / SYSTEM_FIELDS / OrderItem / FieldError / OrderField (v2/types)
 */

import { useState, useCallback, useRef, Suspense, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Button, Card, Select, Upload, message, Alert, Typography, Tag, Space,
  Progress, Table, Modal, Drawer, Tooltip, Input,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  InboxOutlined, ThunderboltOutlined, DatabaseOutlined, SafetyCertificateOutlined,
  PlusOutlined, FileExcelOutlined, FileTextOutlined,
  DeleteOutlined, DownloadOutlined, SendOutlined,
} from '@ant-design/icons';
import V3Layout from '@/v3/components/V3Layout';
import RuleEditor, { loadProvider } from '@/v2/components/RuleEditor';
import { parseFileByType, exportToExcel } from '@/v2/lib/parser';
import { executeRuleEngineAsync } from '@/v2/lib/engine';
import { validateAllItems } from '@/v2/lib/llm';
import { getAllRules, saveRule, getRuleById, checkDuplicateExternalCodes } from '@/v2/lib/database';
import type { ParseRule, OrderItem } from '@/v2/types';
import { SYSTEM_FIELDS, createEmptyOrderItem } from '@/v2/types';

const { Dragger } = Upload;
const { Text } = Typography;

function UploadPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  /* ---------- Step 1: 文件状态 ---------- */
  const [fileObj, setFileObj] = useState<File | null>(null);
  const [rawRows, setRawRows] = useState<any[][] | null>(null);
  const [sheetData, setSheetData] = useState<Record<string, any[][]> | null>(null);
  const [textLines, setTextLines] = useState<string[] | null>(null);
  const [parsedFile, setParsedFile] = useState<{ fileType: string } | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState<string>('');

  /* ---------- 解析进度（与 V2 一致） ---------- */
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [parseFailed, setParseFailed] = useState(false);

  /* ---------- Step 2: 规则状态 ---------- */
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string>('');
  const [currentRule, setCurrentRule] = useState<ParseRule | null>(null);
  const [ruleEditorOpen, setRuleEditorOpen] = useState(false);
  const [ruleEditorMode, setRuleEditorMode] = useState<'create' | 'edit'>('create');
  const [editingRule, setEditingRule] = useState<ParseRule | null>(null);

  /* ---------- 解析结果（完整可编辑，从 V2 移植） ---------- */
  const [items, setItems] = useState<OrderItem[]>([]);
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);
  const [allErrors, setAllErrors] = useState<{ row: number; field: string; fieldLabel: string; message: string }[]>([]);
  const [errorDrawerOpen, setErrorDrawerOpen] = useState(false);

  /* ---------- AI 直接解析进度弹窗（从 V2 移植） ---------- */
  const [aiDirectModalOpen, setAiDirectModalOpen] = useState(false);
  const [aiDirectModalStep, setAiDirectModalStep] = useState('');

  /* ---------- Step 3: 提交状态 ---------- */
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // 使用 ref 存储 handleCellChange 的最新引用，避免 previewColumns 中的闭包问题（与 V2 一致）
  const handleCellChangeRef = useRef<(rowIndex: number, field: keyof OrderItem, value: string) => void>();
  handleCellChangeRef.current = useCallback(
    (rowIndex: number, field: keyof OrderItem, value: string) => {
      setItems((prev) => {
        const next = [...prev];
        const updated: OrderItem = { ...next[rowIndex], [field]: value } as OrderItem;
        const { itemsWithErrors, errorList } = validateAllItems(next.map((it, i) => (i === rowIndex ? updated : it)));
        setAllErrors(errorList);
        next[rowIndex] = itemsWithErrors[rowIndex] || updated;

        // 本地重复检测（与 V2 一致）
        const codeMap = new Map<string, number[]>();
        next.forEach((it, idx) => {
          const code = it.externalCode?.trim();
          if (code) {
            if (!codeMap.has(code)) codeMap.set(code, []);
            codeMap.get(code)!.push(idx);
          }
        });
        codeMap.forEach((indexes) => {
          if (indexes.length > 1) {
            indexes.forEach((idx) => {
              const it = next[idx];
              const dupErr = it.errors.find((e) => e.field === 'externalCode' && e.message.includes('重复'));
              if (!dupErr) {
                it.errors = [
                  ...it.errors,
                  { field: 'externalCode', message: `外部编码重复（行：${indexes.map((x) => x + 1).join(',')}）` },
                ];
              }
            });
          }
        });
        return next;
      });
      setEditingCell(null);
    },
    []
  );

  /* ---------- 文件改变时重解析：跳过首次挂载 + 用 ref 避免依赖循环（与 V2 一致） ---------- */
  const isInitialMount = useRef(true);
  const selectedRuleIdRef = useRef(selectedRuleId);
  selectedRuleIdRef.current = selectedRuleId;
  const handlePickRuleRef = useRef<((ruleId: string) => void) | null>(null);

  /* ---------- 初始化：加载规则列表 ---------- */
  useEffect(() => {
    loadRules();
    const ruleId = searchParams.get('rule_id');
    if (ruleId) setSelectedRuleId(ruleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRules = useCallback(async () => {
    try {
      const list = await getAllRules();
      setRules(list);
    } catch (err) {
      console.error('加载规则失败:', err);
    }
  }, []);

  /* ================================================================
   * Step 1: 文件选择（复用 V2 parseFileByType，与 V2 逻辑一致）
   * ================================================================ */
  const handleFileSelect = useCallback(async (file: File) => {
    setIsProcessing(true);
    setUploadProgress(10);
    setProgressText('正在读取文件...');
    setParseFailed(false);
    // 清空上一次解析结果
    setItems([]);
    setAllErrors([]);
    setEditingCell(null);
    setSelectedRuleId('');
    setCurrentRule(null);

    try {
      setUploadProgress(30);
      const parsed = await parseFileByType(file);
      setUploadProgress(70);

      if (!parsed.data || parsed.data.length === 0) {
        message.error('文件内容为空，或无法解析出有效数据');
        setParseFailed(true);
        setFileName(file.name);
        setIsProcessing(false);
        setUploadProgress(0);
        return false;
      }

      setParsedFile(parsed);
      setRawRows(parsed.data);
      setSheetData(parsed.sheetData || null);
      setTextLines(parsed.textLines || null);
      setFileObj(file);
      setFileName(file.name);
      setFileType(parsed.fileType || '');
      setItems([]);
      setUploadProgress(100);

      if (parsed.truncated) {
        setProgressText(`文件解析成功，共 ${parsed.data.length} 行（已限制最大读取行数，完整数据将在解析时处理）`);
        message.info(`文件较大，已读取前 ${parsed.data.length} 行用于预览，解析时会处理全部数据`);
      } else {
        setProgressText(`文件解析成功，共 ${parsed.data.length} 行`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`文件解析失败：${msg}`);
      setParseFailed(true);
      setFileName(file.name);
    } finally {
      setTimeout(() => { setIsProcessing(false); setUploadProgress(0); setProgressText(''); }, 400);
    }
    return false;
  }, []);

  /* ================================================================
   * Step 2: 规则解析（从 V2 移植，使用 executeRuleEngineAsync 不阻塞 UI）
   * ================================================================ */
  const runParseWithRule = useCallback(async (rule: ParseRule) => {
    if (!rawRows || rawRows.length === 0) {
      message.warning('请先上传文件');
      return;
    }
    if (!rule.fieldMappings?.length && rule.parseMode !== 'card' && rule.parseMode !== 'text') {
      message.warning('当前规则没有字段映射');
      return;
    }
    setIsProcessing(true);
    setUploadProgress(0);
    setProgressText('正在执行解析...');
    setParseFailed(false);

    try {
      // 使用异步分片版本，避免阻塞 UI（与 V2 一致）
      const parsedItems = await executeRuleEngineAsync({
        rows: rawRows,
        sheetData: sheetData || undefined,
        textLines: textLines || undefined,
        rule,
        onProgress: (cur, tot) => {
          const pct = Math.round((cur / tot) * 80) + 10;
          setUploadProgress(pct);
          setProgressText(`正在解析 ${cur}/${tot} 个数据块...`);
        },
      });

      setUploadProgress(90);
      setProgressText(`已解析 ${parsedItems.length} 条，正在校验...`);

      // 数据库查重 + 本地校验（与 V2 一致）
      const externalCodes = parsedItems.map((i) => i.externalCode).filter(Boolean);
      const dbDup = await checkDuplicateExternalCodes(externalCodes);
      const { itemsWithErrors, errorList } = validateAllItems(parsedItems);
      const withDbDup: OrderItem[] = itemsWithErrors.map((item) => {
        const code = item.externalCode;
        if (code && dbDup.has(code)) {
          return {
            ...item,
            errors: [...item.errors, { field: 'externalCode' as const, message: '该外部编码已存在于数据库' }],
          };
        }
        return item;
      });

      setItems(withDbDup);
      setAllErrors(errorList);
      setUploadProgress(100);
      setProgressText(`解析完成：${withDbDup.length} 条`);

      if (withDbDup.length === 0) {
        setParseFailed(true);
        message.warning('解析结果为空，请检查规则配置或点击「新建规则」');
      } else {
        setParseFailed(false);
        message.success(`解析完成：${withDbDup.length} 条数据`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`执行解析失败：${msg}`);
      setParseFailed(true);
    } finally {
      setTimeout(() => { setIsProcessing(false); setUploadProgress(0); setProgressText(''); }, 400);
    }
  }, [rawRows, sheetData, textLines]);

  /* ---------- AI 直接解析（从 V2 移植，解析全部行 + 进度弹窗） ---------- */
  const runAIDirectParse = useCallback(async () => {
    if (!rawRows?.length && !textLines?.length) {
      message.warning('请先上传文件');
      return;
    }
    const provider = loadProvider();
    if (!provider.apiKey.trim()) {
      message.warning('请先配置 AI API Key');
      return;
    }

    // 打开进度弹窗（与 V2 一致）
    setAiDirectModalOpen(true);
    setAiDirectModalStep('正在发送文件内容给 AI...');
    setIsProcessing(true);
    setUploadProgress(10);
    setProgressText('正在发送文件内容给 AI...');
    setParseFailed(false);

    try {
      const fType = fileType || (textLines?.length ? 'pdf' : 'excel');

      const res = await fetch('/api/v2/ai/direct-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textLines: textLines || undefined,
          rows: rawRows || undefined,
          fileType: fType,
          userHint: '',
          provider,
        }),
      });

      setUploadProgress(60);
      setProgressText('AI 正在解析...');
      setAiDirectModalStep('AI 正在分析文件内容...');

      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || `请求返回 ${res.status}`);

      setUploadProgress(85);
      setProgressText(`已解析 ${data.items.length} 条，正在校验...`);
      setAiDirectModalStep(`已提取 ${data.items.length} 条数据，正在校验...`);

      // 复用 V2 的校验逻辑（数据库查重 + 本地校验）
      const externalCodes = data.items.map((i: any) => i.externalCode).filter(Boolean);
      const dbDup = await checkDuplicateExternalCodes(externalCodes);
      const { itemsWithErrors, errorList } = validateAllItems(data.items);
      const withDbDup: OrderItem[] = itemsWithErrors.map((item: OrderItem) => {
        const code = item.externalCode;
        if (code && dbDup.has(code)) {
          return { ...item, errors: [...item.errors, { field: 'externalCode' as const, message: '该外部编码已存在于数据库' }] };
        }
        return item;
      });

      setItems(withDbDup);
      setAllErrors(errorList);
      setUploadProgress(100);
      setProgressText(`AI 直接解析完成：${withDbDup.length} 条数据`);
      setAiDirectModalStep('解析完成！');

      if (withDbDup.length === 0) {
        setParseFailed(true);
        message.warning('解析结果为空，可能文件格式不被支持');
      } else {
        setParseFailed(false);
        message.success(`AI 直接解析完成：${withDbDup.length} 条数据${data.explanation ? ' - ' + data.explanation.slice(0, 80) : ''}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`AI 直接解析失败：${msg}`);
      setParseFailed(true);
    } finally {
      setAiDirectModalOpen(false);
      setTimeout(() => { setIsProcessing(false); setUploadProgress(0); setProgressText(''); }, 400);
    }
  }, [rawRows, textLines, fileType]);

  /* ---------- 选择规则（从 V2 移植，含立即解析 + 进度展示） ---------- */
  const handlePickRule = useCallback(
    (ruleId: string) => {
      if (!ruleId) {
        setSelectedRuleId('');
        setCurrentRule(null);
        setItems([]);
        setAllErrors([]);
        return;
      }

      if (!rawRows?.length && !textLines?.length) {
        message.warning('请先上传文件');
        return;
      }

      // AI 直接解析（内置选项，不是数据库规则）
      if (ruleId === '__ai_direct__') {
        setSelectedRuleId('__ai_direct__');
        setCurrentRule(null);
        runAIDirectParse();
        return;
      }

      // 立即更新选中状态，UI 响应不卡顿（与 V2 一致）
      setSelectedRuleId(ruleId);
      if (rawRows && rawRows.length > 0) {
        setIsProcessing(true);
        setUploadProgress(1);
        setProgressText('正在加载规则...');
      }
      (async () => {
        const rule = await getRuleById(ruleId);
        if (rule) {
          setCurrentRule(rule);
          if (rawRows && rawRows.length > 0 && (rule.fieldMappings?.length || rule.parseMode === 'card' || rule.parseMode === 'text')) {
            runParseWithRule(rule);
          } else {
            setIsProcessing(false);
            setUploadProgress(0);
            setProgressText('');
          }
        }
      })();
    },
    [rawRows, runParseWithRule, runAIDirectParse, textLines]
  );

  // 更新 handlePickRule ref（与 V2 一致）
  handlePickRuleRef.current = handlePickRule;

  // 文件改变时，如果已选中解析规则，重新触发解析（与 V2 一致）
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (selectedRuleIdRef.current && (rawRows?.length || textLines?.length)) {
      handlePickRuleRef.current?.(selectedRuleIdRef.current);
    }
  }, [rawRows?.length, textLines?.length]);

  /* ---------- 规则编辑器 ---------- */
  const openCreateRule = useCallback(() => {
    if (!rawRows?.length && !textLines?.length) {
      message.warning('请先上传文件');
      return;
    }
    setEditingRule(null);
    setRuleEditorMode('create');
    setRuleEditorOpen(true);
  }, [rawRows, textLines]);

  // 保存规则后立即解析（与 V2 一致）
  const handleSaveRule = useCallback(
    async (rule: ParseRule) => {
      const ok = await saveRule(rule);
      if (!ok) {
        message.error('保存规则失败');
        return;
      }
      await loadRules();
      setSelectedRuleId(rule.id);
      setCurrentRule(rule);
      setRuleEditorOpen(false);
      message.success('规则保存成功');
      if (rawRows?.length || textLines?.length) {
        runParseWithRule(rule);
      }
    },
    [loadRules, rawRows, runParseWithRule, textLines]
  );

  /* ================================================================
   * Step 3: 表格编辑 / 删除 / 导出（从 V2 移植）
   * ================================================================ */
  const addRow = useCallback(() => {
    setItems((prev) => [...prev, createEmptyOrderItem()]);
  }, []);

  const removeRow = useCallback((rowIndex: number) => {
    setItems((prev) => prev.filter((_, i) => i !== rowIndex));
  }, []);

  const handleExport = useCallback(() => {
    const blob = exportToExcel(items);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `订单预览_${new Date().toLocaleString().replace(/[/:]/g, '-')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('导出成功');
  }, [items]);

  /* ================================================================
   * Step 4: 提交异步任务（V3 新增：提交前校验 + 发送 items + rule_id + file）
   * ================================================================ */
  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return;

    // 提交前校验：仅空数据阻断，错误数据不阻断（由 Worker 异步校验+记录）
    if (items.length === 0) {
      message.warning('当前没有可提交的数据');
      return;
    }
    const invalid = items.filter((i) => i.errors.length > 0);
    const hasErrors = invalid.length > 0;

    Modal.confirm({
      title: '确认创建异步导入任务',
      content: (
        <div>
          <p>共 {items.length} 条数据将提交到异步队列处理，上传后可前往任务列表查看处理进度。</p>
          {hasErrors && (
            <p style={{ color: '#fa8c16', marginTop: 8, marginBottom: 0 }}>
              ⚠️ 其中 {invalid.length} 条数据存在校验错误，将在 Worker 处理时记录为错误行，不影响有效数据入库。
            </p>
          )}
        </div>
      ),
      okText: '确定提交',
      okType: 'primary',
      okButtonProps: { style: { background: '#0fc6c2', borderColor: '#0fc6c2' } },
      cancelText: '取消',
      onOk: () => {
        Modal.destroyAll();
        (async () => {
          submittingRef.current = true;
          setSubmitting(true);
          try {
            const formData = new FormData();
            formData.append('file', fileObj as File);
            // rule_id：真实规则 ID 或 '__ai_direct__'（记录来源）
            formData.append('rule_id', selectedRuleId);
            // items：用户确认后的最终数据（含编辑结果），Worker 走预解析模式保留编辑
            formData.append('items', JSON.stringify(items));

            const resp = await fetch('/api/v3/import-tasks', { method: 'POST', body: formData });
            const data = await resp.json();

            if (data.ok || data.task_id) {
              message.success(`异步任务创建成功！上传耗时 ${data.upload_duration_ms || 0}ms`);
              router.push(`/v3/tasks/${data.task_id}`);
            } else {
              message.error(data.error || '创建任务失败');
            }
          } catch (err) {
            message.error('提交请求失败');
          } finally {
            submittingRef.current = false;
            setSubmitting(false);
          }
        })();
      },
    });
  }, [items, fileObj, selectedRuleId, router]);

  /* ================================================================
   * 渲染
   * ================================================================ */
  const hasFile = Boolean(rawRows?.length || textLines?.length);

  // 统计（与 V2 一致）
  const stats = {
    total: items.length,
    errorCount: items.filter((i) => i.errors.length > 0).length,
    validCount: items.length - items.filter((i) => i.errors.length > 0).length,
  };

  // 可编辑列定义（从 V2 移植：双击 Input、错误红字红底 + Tooltip、删除按钮）
  const previewColumns: ColumnsType<OrderItem> = useMemo(() => [
    {
      title: '#',
      width: 60,
      fixed: 'left',
      render: (_v, _r, idx) => <span style={{ color: '#888' }}>{idx + 1}</span>,
    },
    {
      title: '操作',
      width: 80,
      fixed: 'left',
      render: (_v, _r, idx) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => removeRow(idx)} />
      ),
    },
    ...SYSTEM_FIELDS.map((f) => ({
      title: (
        <span>
          {f.label}
          {f.required && <span style={{ color: '#ff4d4f' }}>*</span>}
        </span>
      ),
      dataIndex: f.key,
      width: Math.max(140, f.width || 160),
      render: (val: string, record: OrderItem, rowIdx: number) => {
        const isEditing = editingCell?.row === rowIdx && editingCell.field === f.key;
        const errMsg = record.errors.find((e) => e.field === f.key)?.message;
        if (isEditing) {
          return (
            <Input
              size="small"
              autoFocus
              defaultValue={val}
              onBlur={(e) => handleCellChangeRef.current?.(rowIdx, f.key, e.target.value)}
              onPressEnter={(e) => handleCellChangeRef.current?.(rowIdx, f.key, (e.target as HTMLInputElement).value)}
            />
          );
        }
        return (
          <Tooltip title={errMsg}>
            <span
              onDoubleClick={() => setEditingCell({ row: rowIdx, field: f.key })}
              style={{
                display: 'block',
                color: errMsg ? '#ff4d4f' : '#262626',
                background: errMsg ? '#fff2f0' : 'transparent',
                padding: '2px 6px',
                borderRadius: 4,
                cursor: 'text',
                minHeight: 22,
                userSelect: 'text',
              }}
            >
              {val || <span style={{ color: '#bfbfbf' }}>—</span>}
            </span>
          </Tooltip>
        );
      },
    })),
  ], [editingCell, removeRow]);

  const getRowClassName = useCallback((r: OrderItem) => (r.errors.length > 0 ? 'row-error' : ''), []);

  return (
    <V3Layout>
      <div className="v2-page-title">异步批量导入</div>

      {/* 架构说明 */}
      <Alert
        message="异步事件驱动架构（在 V2 完整交互基础上新增异步处理）"
        description={(
          <div style={{ fontSize: 13 }}>
            <Text strong>Step 1</Text> 选择文件 → <Text strong>Step 2</Text> 选择/AI生成规则 → 预览编辑校验 → <Text strong>Step 3</Text> 提交异步任务
            <br />
            保留 V2 的双击编辑、字段高亮、添加/删除行、校验规则应用；上传即返回 task_id（≤1s），批量入库异步执行。
          </div>
        )}
        type="info"
        showIcon
        className="v2-alert"
      />

      {/* ==================== Step 1: 文件上传 ==================== */}
      <Card
        className="v2-card"
        style={{ marginTop: 16 }}
        title={(
          <span className="v2-section-header">
            <Tag className="v2-tag-blue" style={{ marginRight: 8 }}>Step 1</Tag>
            <FileExcelOutlined className="v2-section-icon" />选择文件
          </span>
        )}
      >
        {!hasFile ? (
          <Dragger
            accept=".xlsx,.xls,.docx,.pdf"
            multiple={false}
            beforeUpload={handleFileSelect}
            showUploadList={false}
            disabled={isProcessing}
            className="v2-uploader"
          >
            <div className="v2-uploader-content">
              <div className="v2-uploader-icon-wrapper">
                <InboxOutlined className="v2-uploader-icon" />
              </div>
              <div className="v2-uploader-text">点击或拖拽文件到此区域</div>
              <div className="v2-uploader-hint">支持 Excel、Word、PDF 格式</div>
              <div className="v2-uploader-tags">
                <Tag className="v2-tag-blue">.xlsx</Tag>
                <Tag className="v2-tag-blue">.xls</Tag>
                <Tag className="v2-tag-orange">.docx</Tag>
                <Tag className="v2-tag-orange">.pdf</Tag>
              </div>
            </div>
          </Dragger>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            {fileType === 'excel' ? <FileExcelOutlined style={{ fontSize: 20, color: '#52c41a' }} /> : <FileTextOutlined style={{ fontSize: 20, color: '#1677ff' }} />}
            <Text strong>{fileName}</Text>
            <Tag className="v2-tag-blue">{rawRows?.length || textLines?.length || 0} 行</Tag>
            <Button
              size="small"
              className="v2-btn"
              onClick={() => {
                setFileObj(null); setRawRows(null); setSheetData(null);
                setTextLines(null); setFileName(''); setFileType('');
                setItems([]); setAllErrors([]); setEditingCell(null);
                setSelectedRuleId(''); setCurrentRule(null); setParseFailed(false);
              }}
            >
              重新选择
            </Button>
          </div>
        )}

        {isProcessing && uploadProgress > 0 && (
          <div style={{ marginTop: 12 }}>
            <Progress percent={uploadProgress} strokeColor={{ '0%': '#0fc6c2', '100%': '#0bb5ae' }} />
            {progressText && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{progressText}</div>}
          </div>
        )}
      </Card>

      {/* ==================== Step 2: 规则选择 ==================== */}
      {hasFile && (
        <Card
          className="v2-card"
          style={{ marginTop: 16 }}
          title={(
            <span className="v2-section-header">
              <Tag className="v2-tag-blue" style={{ marginRight: 8 }}>Step 2</Tag>
              <DatabaseOutlined className="v2-section-icon" />选择 / 生成解析规则
            </span>
          )}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>选择已有规则，或让 AI 根据文件内容智能生成</Text>
            <Space>
              <Button
                className="v2-btn"
                icon={<PlusOutlined />}
                onClick={openCreateRule}
              >
                新建规则（AI 智能生成）
              </Button>
              <Button
                type="link"
                size="small"
                onClick={() => router.push('/v3/rules')}
                style={{ fontSize: 12, padding: 0 }}
              >
                管理全部规则
              </Button>
            </Space>
          </div>

          <Select
            showSearch
            className="v2-select"
            style={{ width: '100%' }}
            value={selectedRuleId || undefined}
            onChange={handlePickRule}
            placeholder="从已保存的规则中选择，或使用 AI 直接解析"
            optionFilterProp="label"
            options={[
              {
                value: '__ai_direct__',
                label: '🤖 AI 直接解析（推荐）— 自动识别表格结构，提取订单数据',
              },
              ...rules.map((r) => ({
                value: r.id,
                label: `${r.name}${r.aiGenerated ? ' · AI' : ''} · ${r.fieldMappings.length} 个字段映射`,
              })),
            ]}
            allowClear
          />

          {/* 解析进度 */}
          {isProcessing && uploadProgress > 0 && (
            <div style={{ marginTop: 14 }}>
              <Progress percent={uploadProgress} strokeColor={{ '0%': '#0fc6c2', '100%': '#0bb5ae' }} />
              {progressText && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{progressText}</div>}
            </div>
          )}

          {/* 解析失败提示 */}
          {parseFailed && fileName && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 14 }}
              message={`文件「${fileName}」解析未成功或结果为空`}
              description={
                <Space direction="vertical" size={4}>
                  <span>请尝试点击「新建规则」让 AI 分析文件结构，或选择 AI 直接解析。</span>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateRule}>新建解析规则</Button>
                </Space>
              }
            />
          )}

          {/* 当前规则信息 */}
          {currentRule && (
            <div style={{ marginTop: 14, padding: 14, borderRadius: 6, background: '#fafafa', border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div>
                  <span style={{ fontSize: 15, fontWeight: 500 }}>{currentRule.name}</span>
                  <Space size={4} style={{ marginLeft: 8 }}>
                    {currentRule.aiGenerated && <Tag color="gold">AI 推荐</Tag>}
                    {currentRule.aiConfidence ? (
                      <Tag color="cyan">置信度 {Math.round(currentRule.aiConfidence * 100)}%</Tag>
                    ) : null}
                    <Tag>{currentRule.fileType}</Tag>
                  </Space>
                </div>
              </div>
              <div style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>{currentRule.description || '（无描述）'}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {currentRule.fieldMappings.map((m, i) => (
                  <Tag key={i} style={{ margin: 0 }}>
                    <span style={{ color: '#888' }}>{m.sourceColumn}</span>
                    <span style={{ margin: '0 4px', color: '#0fc6c2' }}>→</span>
                    <span>{SYSTEM_FIELDS.find((f) => f.key === m.targetField)?.label || m.targetField}</span>
                  </Tag>
                ))}
                {currentRule.extractionRules?.map((e, i) => (
                  <Tag key={`e${i}`} color="blue">
                    {e.type}:{e.pattern} → {SYSTEM_FIELDS.find((f) => f.key === e.targetField)?.label || e.targetField}
                  </Tag>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ==================== 数据预览 & 提交（从 V2 移植完整交互） ==================== */}
      {items.length > 0 && (
        <Card
          className="v2-card"
          style={{ marginTop: 16 }}
          title={(
            <span className="v2-section-header">
              <Tag className="v2-tag-blue" style={{ marginRight: 8 }}>Step 3</Tag>
              <ThunderboltOutlined className="v2-section-icon" />数据预览 & 提交异步任务
            </span>
          )}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Space>
              <Tag color="cyan">{stats.total} 条</Tag>
              {stats.errorCount > 0 && <Tag color="red">{stats.errorCount} 条有错误</Tag>}
              <Tag color="green">{stats.validCount} 条有效</Tag>
            </Space>
            <Space>
              <Button icon={<PlusOutlined />} onClick={addRow} size="small">新增空行</Button>
              <Button icon={<DownloadOutlined />} onClick={handleExport} size="small">导出 Excel</Button>
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={handleSubmit}
                loading={submitting}
                disabled={isProcessing}
                size="small"
                style={{ background: '#0fc6c2', borderColor: '#0fc6c2' }}
              >
                创建异步任务
              </Button>
            </Space>
          </div>

          {stats.errorCount > 0 && (
            <Alert
              type="error"
              showIcon
              closable
              message={`有 ${stats.errorCount} 条数据存在错误（双击单元格修改）`}
              action={
                <Button size="small" onClick={() => setErrorDrawerOpen(true)}>
                  查看全部 {allErrors.length} 个错误
                </Button>
              }
              style={{ marginBottom: 12 }}
            />
          )}

          <Table<OrderItem>
            rowKey={(r, idx) => r.id || `r_${idx}`}
            size="small"
            bordered
            virtual
            columns={previewColumns}
            dataSource={items}
            pagination={false}
            scroll={{ x: SYSTEM_FIELDS.length * 160 + 200, y: 500 }}
            rowClassName={getRowClassName}
          />
          <style>{`
            .row-error td { background: #fff2f0 !important; }
          `}</style>
        </Card>
      )}

      {/* V3 能力说明 */}
      <Card
        className="v2-card"
        style={{ marginTop: 16 }}
        title={<span className="v2-section-header"><SafetyCertificateOutlined className="v2-section-icon" />V3 在 V2 基础上新增的能力</span>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { v2: '同步阻塞导入', v3: '异步事件驱动（上传 ≤1s 返回，Worker 后台处理）' },
            { v2: '逐行 SKU 查询', v3: '批量 IN 查询 + UPSERT 幂等写入' },
            { v2: '整体失败重传', v3: '三层幂等保护（jobId + 批次状态 + 业务键）' },
            { v2: '仅前端校验', v3: '行级错误持久化 + 脱敏 + 修复建议' },
            { v2: '黑盒处理', v3: '全链路 trace_id + 监控看板 + Trace 检索' },
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
              <Tag style={{ minWidth: 50, textAlign: 'center' }}>{i + 1}</Tag>
              <Text delete type="secondary" style={{ fontSize: 13, flex: 1 }}>{item.v2}</Text>
              <Text style={{ fontSize: 16 }}>→</Text>
              <Text strong style={{ fontSize: 13, flex: 1, color: '#0fc6c2' }}>{item.v3}</Text>
            </div>
          ))}
        </div>
      </Card>

      {/* 规则编辑器（复用 V2 组件，传入已解析的文件数据） */}
      <RuleEditor
        open={ruleEditorOpen}
        initialRule={editingRule || undefined}
        sampleRows={rawRows || undefined}
        sampleSheetData={sheetData || undefined}
        sampleTextLines={textLines || undefined}
        mode={ruleEditorMode}
        onClose={() => setRuleEditorOpen(false)}
        onSave={handleSaveRule}
      />

      {/* 错误抽屉（从 V2 移植） */}
      <Drawer
        title={`全部校验错误（${allErrors.length} 个）`}
        open={errorDrawerOpen}
        onClose={() => setErrorDrawerOpen(false)}
        width={560}
      >
        {allErrors.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#8c8c8c', padding: 40 }}>暂无错误</div>
        ) : (
          <Table
            size="small"
            pagination={{ pageSize: 50 }}
            dataSource={allErrors.map((e, i) => ({ ...e, key: i }))}
            columns={[
              { title: '行号', dataIndex: 'row', width: 70 },
              { title: '字段', dataIndex: 'fieldLabel', width: 120 },
              { title: '错误原因', dataIndex: 'message' },
            ]}
          />
        )}
      </Drawer>

      {/* AI 直接解析进度弹窗（从 V2 移植） */}
      <Modal
        open={aiDirectModalOpen}
        closable={false}
        footer={null}
        centered
        maskClosable={false}
        width={480}
        zIndex={1001}
      >
        <div style={{ textAlign: 'center', padding: '24px 0 12px' }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 20, color: '#1a1a1a' }}>
            🤖 AI 正在解析文件
          </div>
          <Progress
            percent={uploadProgress}
            strokeColor={{ '0%': '#0fc6c2', '100%': '#0bb5ae' }}
            size="default"
            style={{ marginBottom: 16 }}
          />
          <div style={{ fontSize: 14, color: '#555', minHeight: 22 }}>
            {aiDirectModalStep || progressText}
          </div>
          <div style={{ fontSize: 12, color: '#999', marginTop: 12 }}>
            解析期间请勿关闭页面或进行其他操作
          </div>
        </div>
      </Modal>
    </V3Layout>
  );
}

// 默认导出：用 Suspense 包裹（useSearchParams 要求）
export default function V3UploadPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: '#8c8c8c' }}>加载中...</div>}>
      <UploadPageContent />
    </Suspense>
  );
}
