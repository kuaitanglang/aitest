'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ConfigProvider,
  Layout,
  Menu,
  Upload,
  Button,
  Input,
  Select,
  message,
  Modal,
  Progress,
  Tag,
  Pagination,
  Empty,
  Breadcrumb,
  Alert,
  Badge,
  Tabs,
  Tooltip,
  Space,
  Drawer,
  Table,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  UploadOutlined,
  FileExcelOutlined,
  FileWordOutlined,
  FilePdfOutlined,
  PlusOutlined,
  DeleteOutlined,
  DownloadOutlined,
  SendOutlined,
  SearchOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  DashboardOutlined,
  ReloadOutlined,
  InboxOutlined,
  UserOutlined,
  BellOutlined,
  EyeOutlined,
  EditOutlined,
  CopyOutlined,
  BulbOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { parseFileByType, exportToExcel } from './lib/parser';
import { executeRuleEngine, executeRuleEngineAsync } from './lib/engine';
import { validateAllItems } from './lib/llm';
import type { ParsedFileData } from './types';
import {
  saveRule,
  getAllRules,
  getRuleById,
  deleteRule,
  saveOrderItems,
  checkDuplicateExternalCodes,
  getAllOrders,
} from './lib/database';
import {
  OrderItem,
  ParseRule,
  FieldMapping,
  SYSTEM_FIELDS,
  createEmptyOrderItem,
  OrderField,
} from './types';
import RuleEditor, { loadProvider } from './components/RuleEditor';

const { Header, Sider, Content } = Layout;
const { Dragger } = Upload;

type MenuKey = 'dashboard' | 'upload' | 'history' | 'rules';

const MENU_ITEMS = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '首页概览' },
  { key: 'upload', icon: <FileExcelOutlined />, label: '批量导入订单' },
  { key: 'history', icon: <FileTextOutlined />, label: '订单记录' },
  { key: 'rules', icon: <DatabaseOutlined />, label: '解析规则' },
];

const BREADCRUMB_MAP: Record<MenuKey, string[]> = {
  dashboard: ['首页概览'],
  upload: ['订单管理', '批量导入订单'],
  history: ['订单管理', '订单记录'],
  rules: ['规则管理', '解析规则'],
};

const THEME_TOKEN = {
  cssVar: { prefix: 'ant', key: '' },
  token: {
    colorPrimary: '#0fc6c2',
    colorInfo: '#0fc6c2',
    colorLink: '#0fc6c2',
    borderRadius: 6,
    colorBgContainer: '#ffffff',
    colorBorder: '#e5e7eb',
  },
  components: {
    Table: {
      headerBg: '#f0fbfb',
      headerColor: '#1f2937',
      rowHoverBg: '#f0fdfa',
    },
    Menu: {
      itemSelectedBg: '#e6fffb',
      itemActiveBg: '#f0fbfb',
      itemHoverBg: '#f0fbfb',
    },
    Button: {
      primaryShadow: '0 2px 4px rgba(15, 198, 194, 0.2)',
    },
  },
};

export default function V2Home() {
  const [activeMenu, setActiveMenu] = useState<MenuKey>('dashboard');
  const [collapsed, setCollapsed] = useState(false);

  /* ---------- 文件 & 规则状态 ---------- */
  const [fileName, setFileName] = useState('');
  const [rawRows, setRawRows] = useState<any[][] | null>(null);
  const [sheetData, setSheetData] = useState<Record<string, any[][]> | null>(null);
  const [textLines, setTextLines] = useState<string[] | null>(null);
  const [parsedFile, setParsedFile] = useState<ParsedFileData | null>(null);
  const [parseFailed, setParseFailed] = useState(false);
  const [aiDirectModalOpen, setAiDirectModalOpen] = useState(false);
  const [aiDirectModalStep, setAiDirectModalStep] = useState('');
  const [selectedRuleId, setSelectedRuleId] = useState<string>('');
  const [currentRule, setCurrentRule] = useState<ParseRule | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [submitProgress, setSubmitProgress] = useState(0);
  const [submitModalOpen, setSubmitModalOpen] = useState(false);
  const [errorDrawerOpen, setErrorDrawerOpen] = useState(false);
  const [allErrors, setAllErrors] = useState<{ row: number; field: string; fieldLabel: string; message: string }[]>([]);

  /* ---------- 解析结果 ---------- */
  const [items, setItems] = useState<OrderItem[]>([]);
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);

  // 文件改变时重解析：跳过首次挂载 + 用 ref 避免依赖循环
  const isInitialMount = useRef(true);
  const selectedRuleIdRef = useRef(selectedRuleId);
  selectedRuleIdRef.current = selectedRuleId;
  const handlePickRuleRef = useRef<((ruleId: string) => void) | null>(null);

  // 使用 ref 存储 handleCellChange 的最新引用，避免 previewColumns 中的闭包问题
  const handleCellChangeRef = useRef<(rowIndex: number, field: keyof OrderItem, value: string) => void>();
  handleCellChangeRef.current = useCallback(
    (rowIndex: number, field: keyof OrderItem, value: string) => {
      setItems((prev) => {
        const next = [...prev];
        const updated: OrderItem = { ...next[rowIndex], [field]: value } as OrderItem;
        const { itemsWithErrors, errorList } = validateAllItems(next.map((it, i) => (i === rowIndex ? updated : it)));
        setAllErrors(errorList);
        next[rowIndex] = itemsWithErrors[rowIndex] || updated;

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

  // 稳定引用的 handleCellChange，供外部使用
  const handleCellChange = useCallback(
    (rowIndex: number, field: keyof OrderItem, value: string) => {
      handleCellChangeRef.current?.(rowIndex, field, value);
    },
    []
  );

  /* ---------- 订单记录页 ---------- */
  const [ordersList, setOrdersList] = useState<OrderItem[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersPageSize, setOrdersPageSize] = useState(10);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchField, setSearchField] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  /* ---------- 规则管理页 ---------- */
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [rulesPage, setRulesPage] = useState(1);
  const [rulesPageSize, setRulesPageSize] = useState(10);
  const [ruleKeyword, setRuleKeyword] = useState('');

  /* ---------- 编辑器 / 结果 Modal ---------- */
  const [ruleEditorOpen, setRuleEditorOpen] = useState(false);
  const [ruleEditorMode, setRuleEditorMode] = useState<'create' | 'edit'>('create');
  const [editingRule, setEditingRule] = useState<ParseRule | null>(null);

  const [showResult, setShowResult] = useState<{
    visible: boolean; success: number; failed: number; duplicates: number;
  }>({ visible: false, success: 0, failed: 0, duplicates: 0 });

  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    loadRules();
    fetchOrders();
  }, []);

  const loadRules = useCallback(async () => {
    const list = await getAllRules();
    setRules(list);
  }, []);

  const fetchOrders = useCallback(
    async (page = 1, pageSize = ordersPageSize, term = '', field = '', sd = '', ed = '') => {
      const { list, total } = await getAllOrders(page, pageSize, term, field, sd, ed);
      setOrdersList(list);
      setOrdersTotal(total);
      setOrdersPage(page);
    },
    [ordersPageSize]
  );

  /* ================================================================ */
  /* Step 1: 文件上传（仅解析，不做字段映射）                           */
  /* ================================================================ */
  const handleFileSelect = useCallback(
    async (file: File) => {
      setIsProcessing(true);
      setUploadProgress(10);
      setProgressText('正在读取文件...');
      setParseFailed(false);

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
        setSheetData(parsed.sheetData);
        setTextLines(parsed.textLines || null);
        setFileName(file.name);
        setItems([]);
        setUploadProgress(100);

        // 如果文件被截断，提示用户
        if (parsed.truncated) {
          setProgressText(`文件解析成功，共 ${parsed.data.length} 行（已限制最大读取行数，完整数据将在解析时处理）`);
          message.info(`文件较大，已读取前 ${parsed.data.length} 行用于预览，解析时会处理全部数据`);
        } else {
          setProgressText(`文件解析成功，共 ${parsed.data.length} 行`);
          // 不再弹出 message，由 AI 解析 Modal 统一展示进度
        }
        setActiveMenu('upload');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        message.error(`文件解析失败：${msg}`);
        setParseFailed(true);
        setFileName(file.name);
      } finally {
        setTimeout(() => { setIsProcessing(false); setUploadProgress(0); setProgressText(''); }, 400);
      }
      return false;
    },
    []
  );

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
      const totalSteps = rule.multiSheet && sheetData ? Object.keys(sheetData).length : 1;
      let step = 0;
      // 使用异步分片版本，避免阻塞 UI
      const parsedItems = await executeRuleEngineAsync({
        rows: rawRows,
        sheetData: sheetData || undefined,
        textLines: textLines || undefined,
        rule,
        onProgress: (cur, tot) => {
          step = cur;
          const pct = Math.round((cur / tot) * 80) + 10;
          setUploadProgress(pct);
          setProgressText(`正在解析 ${cur}/${tot} 个数据块...`);
        },
      });

      setUploadProgress(90);
      setProgressText(`已解析 ${parsedItems.length} 条，正在校验...`);

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

  /* ================================================================ */
  /* Step 2: 选择/新建规则                                             */
  /* ================================================================ */
  const handlePickRule = useCallback(
    (ruleId: string) => {
      if (!ruleId) {
        setSelectedRuleId('');
        setCurrentRule(null);
        return;
      }

      // 必须先上传文件
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

      // 立即更新选中状态，UI 响应不卡顿
      setSelectedRuleId(ruleId);
      // 立即显示解析进度，避免用户以为卡死
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
    [rawRows, runParseWithRule]
  );

  const openCreateRule = useCallback(() => {
    setEditingRule(null);
    setRuleEditorMode('create');
    setRuleEditorOpen(true);
  }, []);

  const openEditRule = useCallback((rule: ParseRule) => {
    setEditingRule(rule);
    setRuleEditorMode('edit');
    setRuleEditorOpen(true);
  }, []);

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
      if (rawRows?.length) runParseWithRule(rule);
    },
    [loadRules, rawRows, runParseWithRule]
  );

  const runParse = useCallback(async (useAI = false) => {
    if (!rawRows?.length) {
      message.warning('请先上传文件');
      return;
    }
    let rule = currentRule;
    if (useAI) {
      message.info('正在使用 AI 分析文件并生成解析规则...');
      setIsProcessing(true);
      setUploadProgress(10);
      try {
        const provider = loadProvider();
        if (!provider.apiKey.trim()) {
          message.warning('请先配置 AI API Key');
          setIsProcessing(false);
          return;
        }
        const res = await fetch('/api/v2/ai/suggest-rule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: rawRows,
            sheetData,
            textLines,
            // 不再传 headerRowIndex，由后端自动检测表头行
            userHint: '',
            provider,
          }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || `请求返回 ${res.status}`);
        rule = data.rule as ParseRule;
        setCurrentRule(rule);
        message.success(`AI 已生成解析规则：${rule.fieldMappings.length} 个字段映射`);
      } catch (err: unknown) {
        message.error(`AI 生成规则失败：${err instanceof Error ? err.message : err}`);
        setIsProcessing(false);
        return;
      }
    }
    if (!rule) {
      message.warning('请先选择规则或使用 AI 解析');
      return;
    }
    await runParseWithRule(rule);
  }, [rawRows, sheetData, textLines, currentRule, runParseWithRule]);

  /* ================================================================ */
  /* AI 直接解析（新架构：AI 直接输出 OrderItem[]）                      */
  /* ================================================================ */
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

    // 打开进度弹窗
    setAiDirectModalOpen(true);
    setAiDirectModalStep('正在发送文件内容给 AI...');
    setIsProcessing(true);
    setUploadProgress(10);
    setProgressText('正在发送文件内容给 AI...');
    setParseFailed(false);

    try {
      // 检测文件类型
      const fileType = parsedFile?.fileType || (textLines?.length ? 'pdf' : 'excel');

      const res = await fetch('/api/v2/ai/direct-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textLines: textLines || undefined,
          rows: rawRows || undefined,
          fileType,
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

      // 复用现有的校验逻辑
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
  }, [rawRows, textLines, parsedFile, loadProvider]);

  // 更新 handlePickRule ref（放在 useCallback 之后）
  handlePickRuleRef.current = handlePickRule;

  /* 文件改变时，如果已选中解析规则，重新触发解析 */
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (selectedRuleIdRef.current && (rawRows?.length || textLines?.length)) {
      handlePickRuleRef.current?.(selectedRuleIdRef.current);
    }
  }, [rawRows?.length, textLines?.length]);

  /* ================================================================ */
  /* Step 4: 表格编辑 / 删除 / 导出 / 提交                             */
  /* ================================================================ */

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

  const handleSubmit = useCallback(async () => {
    if (items.length === 0) {
      message.warning('当前没有可提交的数据');
      return;
    }
    const invalid = items.filter((i) => i.errors.length > 0);
    if (invalid.length > 0) {
      Modal.error({
        title: `有 ${invalid.length} 条数据存在错误`,
        content: (
          <div style={{ maxHeight: 300, overflowY: 'auto', fontSize: 13, lineHeight: 1.8 }}>
            {invalid.slice(0, 20).map((it, idx) => (
              <div key={idx}>
                第 {items.indexOf(it) + 1} 行：{it.errors.map((e) => e.message).join('；')}
              </div>
            ))}
          </div>
        ),
      });
      return;
    }
    Modal.confirm({
      title: '确认提交',
      content: `共 ${items.length} 条数据将被写入订单库`,
      okText: '确定提交',
      okType: 'primary',
      okButtonProps: { style: { background: '#0fc6c2', borderColor: '#0fc6c2' } },
      cancelText: '取消',
      onOk: () => {
        Modal.destroyAll();
        setSubmitModalOpen(true);
        setIsProcessing(true);
        setSubmitProgress(1);
        setProgressText('正在提交订单...');
        (async () => {
          try {
            const batchSize = 50;
            let result = { success: 0, failed: 0, duplicates: 0 };
            for (let i = 0; i < items.length; i += batchSize) {
              const batch = items.slice(i, i + batchSize);
              const batchResult = await saveOrderItems(batch);
              result = {
                success: result.success + batchResult.success,
                failed: result.failed + batchResult.failed,
                duplicates: result.duplicates + batchResult.duplicates,
              };
              const pct = Math.round(((i + batch.length) / items.length) * 99);
              setSubmitProgress(pct);
              setProgressText(`已提交 ${i + batch.length}/${items.length} 条...`);
              await new Promise((r) => setTimeout(r, 0));
            }
            setSubmitProgress(100);
            setProgressText('提交完成');
            setShowResult({ visible: true, ...result });
            setTimeout(() => {
              requestAnimationFrame(() => { setItems([]); });
              setSubmitModalOpen(false);
              setIsProcessing(false);
              setSubmitProgress(0);
              fetchOrders(1, ordersPageSize, searchTerm, searchField, startDate, endDate);
            }, 1500);
          } catch (e: unknown) {
            message.error(`提交失败：${e instanceof Error ? e.message : e}`);
            setSubmitModalOpen(false);
            setIsProcessing(false);
            setSubmitProgress(0);
          }
        })();
      },
    });
  }, [items, fetchOrders]);

  /* ================================================================ */
  /* 规则列表：复制 / 删除                                             */
  /* ================================================================ */
  const handleCopyRule = useCallback(
    async (rule: ParseRule) => {
      const copy: ParseRule = {
        ...rule,
        id: `rule_${Date.now()}`,
        name: `${rule.name}（副本）`,
        aiGenerated: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const ok = await saveRule(copy);
      if (ok) {
        await loadRules();
        message.success('已复制为新规则');
      }
    },
    [loadRules]
  );

  const handleDeleteRule = useCallback(
    async (rule: ParseRule) => {
      Modal.confirm({
        title: '确认删除',
        content: `确定要删除规则「${rule.name}」吗？删除后无法恢复。`,
        okText: '确认删除',
        okType: 'danger',
        cancelText: '取消',
        onOk: async () => {
          const ok = await deleteRule(rule.id);
          if (ok) {
            await loadRules();
            if (selectedRuleId === rule.id) {
              setSelectedRuleId('');
              setCurrentRule(null);
            }
            message.success('已删除规则');
          }
        },
      });
    },
    [loadRules, selectedRuleId]
  );

  /* ================================================================ */
  /* 页面内容渲染                                                      */
  /* ================================================================ */
  const stats = {
    total: items.length,
    errorCount: items.filter((i) => i.errors.length > 0).length,
    validCount: items.length - items.filter((i) => i.errors.length > 0).length,
  };

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

  // 使用 useCallback 包裹 rowClassName，避免每次渲染重新创建
  const getRowClassName = useCallback((r: OrderItem) => (r.errors.length > 0 ? 'row-error' : ''), []);

  const rulesPageData = useMemo(() => {
    if (!ruleKeyword.trim()) return rules;
    const kw = ruleKeyword.trim().toLowerCase();
    return rules.filter(
      (r) =>
        r.name.toLowerCase().includes(kw) ||
        (r.description || '').toLowerCase().includes(kw) ||
        r.fieldMappings.some((m) => m.sourceColumn.toLowerCase().includes(kw) || m.targetField.includes(kw))
    );
  }, [rules, ruleKeyword]);

  /* ------------------------- 上传页 ------------------------- */
  const renderUpload = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Step 1：文件上传 */}
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          padding: 24,
          border: '1px solid #e5e7eb',
          boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 12 }}>
          <FileExcelOutlined style={{ color: '#0fc6c2', marginRight: 8 }} />
          第一步：上传订单文件
        </div>
        <Dragger
          accept=".xlsx,.xls,.doc,.docx,.pdf"
          maxCount={1}
          beforeUpload={(file) => { handleFileSelect(file); return false; }}
          showUploadList={false}
          disabled={isProcessing}
          style={{ padding: '12px 16px' }}
        >
          <p style={{ fontSize: 28, color: '#0fc6c2', marginBottom: 4 }}>
            <InboxOutlined />
          </p>
          <p style={{ fontSize: 14, color: '#262626', marginBottom: 2, fontWeight: 500 }}>点击或拖拽文件到此处上传</p>
          <p style={{ color: '#8c8c8c', marginBottom: 8, fontSize: 12 }}>支持 Excel (.xlsx, .xls) · Word (.docx, .doc) · PDF</p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 6 }}>
            <Tag color="cyan"><FileExcelOutlined /> Excel（推荐）</Tag>
            <Tag><FileWordOutlined /> Word</Tag>
            <Tag><FilePdfOutlined /> PDF</Tag>
          </div>
        </Dragger>

        {fileName && !isProcessing && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: '#f0fbfb', borderRadius: 6, border: '1px solid #b5f5ec', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileExcelOutlined style={{ fontSize: 18, color: '#0fc6c2' }} />
              <span style={{ fontWeight: 500 }}>{fileName}</span>
              <Tag color="cyan">{rawRows?.length || 0} 行</Tag>
            </div>
            <Button
              size="small"
              onClick={() => { setFileName(''); setRawRows(null); setItems([]); setCurrentRule(null); setSelectedRuleId(''); }}
            >
              清除
            </Button>
          </div>
        )}
      </div>

      {/* Step 2：规则 */}
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          padding: 24,
          border: '1px solid #e5e7eb',
          boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>
            <DatabaseOutlined style={{ color: '#0fc6c2', marginRight: 8 }} />
            选择已有规则，或新建规则
          </div>
          <Space>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openCreateRule}
              disabled={!rawRows}
            >
              新建规则（AI 智能生成）
            </Button>
          </Space>
        </div>

        {!rawRows && (
          <Alert
            type="warning"
            showIcon
            message="请先上传文件，然后再选择/新建规则"
            style={{ marginBottom: 12 }}
          />
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          <Select
            showSearch
            value={selectedRuleId || undefined}
            onChange={handlePickRule}
            placeholder="从已保存的规则中选择一个"
            style={{ width: '100%' }}
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
        </div>

        {isProcessing && uploadProgress > 0 && (
          <div style={{ marginTop: 14 }}>
            <Progress percent={uploadProgress} strokeColor={{ '0%': '#0fc6c2', '100%': '#0bb5ae' }} />
            {progressText && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{progressText}</div>}
          </div>
        )}

        {parseFailed && fileName && (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 14 }}
            message={`文件「${fileName}」解析未成功或结果为空`}
            description={
              <Space direction="vertical" size={4}>
                <span>请尝试点击「新建规则」让 AI 分析文件结构，或手动配置解析规则。</span>
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateRule}>新建解析规则</Button>
              </Space>
            }
          />
        )}

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
      </div>

      {/* 数据预览 */}
      {items.length > 0 && (
        <div
          style={{
            background: '#fff',
            borderRadius: 8,
            padding: 24,
            border: '1px solid #e5e7eb',
            boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Space>
              <span style={{ fontSize: 16, fontWeight: 500 }}>数据预览 & 提交</span>
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
                disabled={stats.errorCount > 0 || isProcessing}
                size="small"
                style={{ background: '#0fc6c2', borderColor: '#0fc6c2' }}
              >
                提交下单
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

          {/* 提交进度弹窗 - 防止重复操作 */}
          <Modal
            open={submitModalOpen}
            title={null}
            footer={null}
            closable={false}
            maskClosable={false}
            centered
            width={420}
          >
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <Progress
                type="circle"
                percent={submitProgress}
                status={submitProgress >= 100 ? 'success' : 'active'}
                strokeColor="#0fc6c2"
                size={120}
              />
              <div style={{ marginTop: 16, fontSize: 15, fontWeight: 500 }}>
                {progressText || `正在处理... ${submitProgress}%`}
              </div>
              {submitProgress >= 100 && showResult.visible && (
                <div style={{ marginTop: 12, fontSize: 13, color: '#666' }}>
                  成功 {showResult.success} 条
                  {showResult.failed > 0 && <span style={{ color: '#ff4d4f' }}>，失败 {showResult.failed} 条</span>}
                  {showResult.duplicates > 0 && <span>，重复 {showResult.duplicates} 条</span>}
                </div>
              )}
            </div>
          </Modal>

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
        </div>
      )}
    </div>
  );

  /* ------------------------- 首页概览 ------------------------- */
  const renderDashboard = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
        <div
          onClick={() => setActiveMenu('upload')}
          style={{ background: '#fff', borderRadius: 8, padding: 24, cursor: 'pointer', border: '1px solid #e5e7eb' }}
        >
          <FileExcelOutlined style={{ fontSize: 32, color: '#0fc6c2' }} />
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 500 }}>批量导入订单</div>
          <div style={{ fontSize: 13, color: '#888' }}>上传文件 → 选/建规则 → 解析 → 提交</div>
        </div>
        <div
          onClick={() => setActiveMenu('history')}
          style={{ background: '#fff', borderRadius: 8, padding: 24, cursor: 'pointer', border: '1px solid #e5e7eb' }}
        >
          <FileTextOutlined style={{ fontSize: 32, color: '#0fc6c2' }} />
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 500 }}>订单记录</div>
          <div style={{ fontSize: 24, fontWeight: 600, color: '#0fc6c2', margin: '4px 0' }}>{ordersTotal}</div>
          <div style={{ fontSize: 13, color: '#888' }}>已导入订单</div>
        </div>
        <div
          onClick={() => setActiveMenu('rules')}
          style={{ background: '#fff', borderRadius: 8, padding: 24, cursor: 'pointer', border: '1px solid #e5e7eb' }}
        >
          <DatabaseOutlined style={{ fontSize: 32, color: '#0fc6c2' }} />
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 500 }}>解析规则</div>
          <div style={{ fontSize: 24, fontWeight: 600, color: '#0fc6c2', margin: '4px 0' }}>{rules.length}</div>
          <div style={{ fontSize: 13, color: '#888' }}>已保存规则</div>
        </div>
      </div>
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, border: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckCircleOutlined style={{ color: '#0fc6c2' }} /> 快速开始
        </div>
        <div style={{ color: '#666', fontSize: 13, lineHeight: 2 }}>
          1. 点击左侧「批量导入订单」菜单 <br />
          2. 上传订单文件（推荐 Excel）<br />
          3. 选择已有规则，或点击「新建规则」让 AI 智能推荐字段映射<br />
          4. 点击「执行解析」预览数据，双击单元格可直接编辑<br />
          5. 点击「提交下单」完成数据入库
        </div>
      </div>
    </div>
  );

  /* ------------------------- 订单记录页 ------------------------- */
  const renderHistory = () => (
    <div
      style={{
        background: '#fff',
        borderRadius: 8,
        padding: 24,
        border: '1px solid #e5e7eb',
        boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 500 }}>订单记录</span>
        <Space>
          <Select
            value={searchField || 'all'}
            onChange={(v) => setSearchField(v === 'all' ? '' : v)}
            style={{ width: 140 }}
            options={[
              { value: 'all', label: '全部字段' },
              { value: 'externalCode', label: '外部编码' },
              { value: 'storeName', label: '收货门店' },
              { value: 'receiverName', label: '收件人' },
              { value: 'skuCode', label: 'SKU编码' },
              { value: 'skuName', label: 'SKU名称' },
            ]}
          />
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: 150 }}
            placeholder="开始日期"
          />
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ width: 150 }}
            placeholder="结束日期"
          />
          <Input
            placeholder="搜索关键词"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onPressEnter={() => fetchOrders(1, ordersPageSize, searchTerm, searchField, startDate, endDate)}
            style={{ width: 240 }}
            prefix={<SearchOutlined />}
            allowClear
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => fetchOrders(1, ordersPageSize, searchTerm, searchField, startDate, endDate)}>搜索</Button>
          <Button icon={<ReloadOutlined />} onClick={() => { setSearchTerm(''); setSearchField(''); setStartDate(''); setEndDate(''); fetchOrders(1, ordersPageSize, '', '', '', ''); }}>重置</Button>
        </Space>
      </div>
      {ordersList.length === 0 ? (
        <Empty description="暂无订单数据" style={{ padding: '48px 0' }} />
      ) : (
        <>
          <Table<OrderItem>
            rowKey={(r) => r.id}
            size="small"
            bordered
            scroll={{ x: SYSTEM_FIELDS.length * 160 }}
            pagination={false}
            columns={[
              { title: '#', width: 60, render: (_v, _r, i) => (ordersPage - 1) * ordersPageSize + i + 1 },
              ...SYSTEM_FIELDS.map((f) => ({
                title: f.label,
                dataIndex: f.key,
                width: f.width || 150,
                render: (val: string) => val || <span style={{ color: '#bbb' }}>—</span>,
              })),
              {
                title: '创建时间',
                dataIndex: 'createdAt',
                width: 170,
                render: (val?: string) =>
                  val ? new Date(val).toLocaleString() : <span style={{ color: '#bbb' }}>—</span>,
              },
            ]}
            dataSource={ordersList}
          />
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#888', fontSize: 13 }}>共 {ordersTotal} 条记录</span>
            <Pagination
              current={ordersPage}
              pageSize={ordersPageSize}
              total={ordersTotal}
              showSizeChanger
              pageSizeOptions={['10', '20', '50', '100']}
              showTotal={(t) => `共 ${t} 条`}
              onChange={(p, ps) => { setOrdersPageSize(ps); fetchOrders(p, ps, searchTerm, searchField, startDate, endDate); }}
            />
          </div>
        </>
      )}
    </div>
  );

  /* ------------------------- 规则管理页 ------------------------- */
  const renderRules = () => (
    <div style={{ background: '#fff', borderRadius: 8, padding: 24, border: '1px solid #e5e7eb' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 500 }}>选择解析方式</span>
        <Space>
          <Input
            placeholder="按名称/描述/字段搜索"
            value={ruleKeyword}
            onChange={(e) => { setRuleKeyword(e.target.value); setRulesPage(1); }}
            prefix={<SearchOutlined />}
            allowClear
            style={{ width: 200 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateRule}>新建规则</Button>
        </Space>
      </div>

      {rulesPageData.length === 0 ? (
        <Empty description="暂无规则，点击右上角「新建规则」" style={{ padding: '48px 0' }} />
      ) : (
        <Table<ParseRule>
          size="small"
          rowKey={(r) => r.id}
          bordered
          pagination={{
            current: rulesPage,
            pageSize: rulesPageSize,
            total: rulesPageData.length,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50'],
            onChange: (p, ps) => { setRulesPage(p); setRulesPageSize(ps); },
          }}
          columns={[
            { title: '规则名称', dataIndex: 'name', width: 240 },
            {
              title: '类型',
              dataIndex: 'fileType',
              width: 80,
              render: (v: string) => <Tag color="cyan">{v}</Tag>,
            },
            {
              title: 'AI',
              width: 70,
              render: (_v, r) =>
                r.aiGenerated ? (
                  <Tag color="gold">AI · {Math.round((r.aiConfidence || 0) * 100)}%</Tag>
                ) : (
                  <Tag>手动</Tag>
                ),
            },
            {
              title: '字段映射',
              width: 260,
              render: (_v, r) => (
                <span style={{ fontSize: 12, color: '#666' }}>
                  {r.fieldMappings.slice(0, 4).map((m, i) => (
                    <Tag key={i} style={{ margin: 2 }}>
                      {m.sourceColumn}→{SYSTEM_FIELDS.find((f) => f.key === m.targetField)?.label || m.targetField}
                    </Tag>
                  ))}
                  {r.fieldMappings.length > 4 && <Tag> +{r.fieldMappings.length - 4} </Tag>}
                </span>
              ),
            },
            { title: '描述', dataIndex: 'description', ellipsis: true },
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              width: 170,
              render: (v?: string) => (v ? new Date(v).toLocaleString() : '—'),
            },
            {
              title: '操作',
              width: 240,
              fixed: 'right',
              render: (_v, r) => (
                <Space size={4}>
                  <Button size="small" onClick={() => { handlePickRule(r.id); setActiveMenu('upload'); }}>
                    使用
                  </Button>
                  <Button size="small" icon={<EyeOutlined />} onClick={() => setPreviewOpen(true)}>查看</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEditRule(r)}>编辑</Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopyRule(r)}>复制</Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteRule(r)}>删除</Button>
                </Space>
              ),
            },
          ]}
          dataSource={rulesPageData}
          scroll={{ x: 1300 }}
        />
      )}

      <Drawer
        title={currentRule?.name || '规则详情'}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        width={560}
      >
        {currentRule && (
          <>
            <Alert
              message={currentRule.description || '（无描述）'}
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
            />
            <div style={{ fontSize: 14, fontWeight: 500, margin: '12px 0 8px' }}>字段映射</div>
            {currentRule.fieldMappings.length === 0 ? (
              <Empty description="无字段映射" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '12px 0' }} />
            ) : (
              <Table<FieldMapping>
                size="small"
                rowKey={(_, i) => `fm_${i}`}
                pagination={false}
                columns={[
                  { title: '源列', dataIndex: 'sourceColumn' },
                  {
                    title: '目标字段',
                    dataIndex: 'targetField',
                    render: (v: string) => SYSTEM_FIELDS.find((f) => f.key === v)?.label || v,
                  },
                  {
                    title: '类型',
                    dataIndex: 'mappingType',
                    render: (v: string) => ({ direct: '直接取值', regex: '正则匹配', composite: '组合' }[v] || v),
                  },
                ]}
                dataSource={currentRule.fieldMappings}
              />
            )}
            <div style={{ fontSize: 14, fontWeight: 500, margin: '16px 0 8px' }}>提取规则</div>
            {!currentRule.extractionRules || currentRule.extractionRules.length === 0 ? (
              <Empty description="无提取规则" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '12px 0' }} />
            ) : (
              <Table
                size="small"
                rowKey={(r, i) => `er_${i}`}
                pagination={false}
                columns={[
                  { title: '名称', dataIndex: 'name' },
                  { title: '位置', dataIndex: 'type' },
                  { title: '关键词', dataIndex: 'pattern' },
                  {
                    title: '写入字段',
                    dataIndex: 'targetField',
                    render: (v: string) => SYSTEM_FIELDS.find((f) => f.key === v)?.label || v,
                  },
                ]}
                dataSource={currentRule.extractionRules}
              />
            )}
          </>
        )}
      </Drawer>
    </div>
  );

  const breadcrumbItems = BREADCRUMB_MAP[activeMenu] || [];

  return (
    <ConfigProvider locale={zhCN} theme={THEME_TOKEN}>
      <Layout className="v2-layout" style={{ minHeight: '100vh', background: '#f5f7fa' }}>
        <Header
          className="v2-header"
          style={{
            background: 'linear-gradient(90deg, #0fc6c2 0%, #0bb5ae 100%)',
            height: 56,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            boxShadow: '0 2px 8px rgba(15, 198, 194, 0.15)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', color: '#fff', fontSize: 18, fontWeight: 600 }}>
            <FileTextOutlined style={{ fontSize: 22, marginRight: 10 }} />
            万能导入系统 V2
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, color: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <UserOutlined />
              <span>管理员</span>
            </div>
          </div>
        </Header>
        <Layout>
          <Sider
            width={200}
            className="v2-sider-menu"
            style={{
              background: '#fff',
              borderRight: '1px solid #e5e7eb',
              overflow: 'auto',
              height: 'calc(100vh - 56px)',
              position: 'sticky',
              top: 56,
            }}
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            trigger={null}
          >
            <Menu
              mode="inline"
              className="v2-sider-menu"
              selectedKeys={[activeMenu]}
              onClick={(e) => setActiveMenu(e.key as MenuKey)}
              items={MENU_ITEMS as any}
              style={{ height: '100%', borderRight: 0, paddingTop: 12 }}
            />
          </Sider>
          <Content style={{ padding: 16, minHeight: 'calc(100vh - 56px)' }}>
            <Breadcrumb items={breadcrumbItems.map((label) => ({ title: label }))} style={{ marginBottom: 16 }} />
            {activeMenu === 'dashboard' && renderDashboard()}
            {activeMenu === 'upload' && renderUpload()}
            {activeMenu === 'history' && renderHistory()}
            {activeMenu === 'rules' && renderRules()}
          </Content>
        </Layout>
      </Layout>

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

      <Drawer
        title={`全部校验错误（${allErrors.length} 个）`}
        open={errorDrawerOpen}
        onClose={() => setErrorDrawerOpen(false)}
        width={560}
      >
        {allErrors.length === 0 ? (
          <Empty description="暂无错误" />
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

      {/* 提交结果统计已内嵌到进度弹窗中，不再需要独立 Modal */}

      {/* AI 直接解析进度弹窗 */}
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
    </ConfigProvider>
  );
}
