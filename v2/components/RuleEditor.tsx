'use client';

import { useState, useEffect } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Button,
  Row,
  Col,
  Table,
  Space,
  Tag,
  Tabs,
  Alert,
  Tooltip,
  message,
  Drawer,
  Divider,
  Empty,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  SaveOutlined,
  BulbOutlined,
  SettingOutlined,
  ExperimentOutlined,
  SyncOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  ParseRule,
  FieldMapping,
  ExtractionRule,
  OrderField,
  SYSTEM_FIELDS,
} from '../types';

export interface RuleEditorProps {
  open: boolean;
  initialRule?: Partial<ParseRule> | null;
  sampleRows?: any[][];
  sampleSheetData?: Record<string, any[][]>;
  sampleTextLines?: string[];
  mode: 'create' | 'edit';
  onClose: () => void;
  onSave: (rule: ParseRule) => Promise<void>;
}

function emptyRule(): ParseRule {
  return {
    id: `rule_${Date.now()}`,
    name: '新解析规则',
    description: '',
    fileType: 'excel',
    parseMode: 'table',
    multiSheet: false,
    cardMarker: '▶',
    headerSkipRows: 1,
    footerSkipRows: 30,
    dataStartRow: 1,
    dataEndRow: undefined,
    skipPatterns: ['合计', '总计', '小计'],
    aggregateBy: '',
    extractionRules: [],
    fieldMappings: [],
    aiGenerated: false,
    aiConfidence: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const FIELD_OPTIONS = SYSTEM_FIELDS.map((f) => ({
  value: f.key,
  label: `${f.label}${f.required ? '（必填）' : ''}`,
}));

type AIProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  sampleRowLimit: number;
};

const DEFAULT_PROVIDER: AIProviderConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-994136d2e30c491c8100b9b9e8dc3729',
  model: 'deepseek-chat',
  temperature: 0.2,
  sampleRowLimit: 100,
};

const STORAGE_KEY = 'v2:ai-provider';

export function loadProvider(): AIProviderConfig {
  if (typeof window === 'undefined') return DEFAULT_PROVIDER;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROVIDER;
    const parsed = JSON.parse(raw);
    // 清除旧版本的 maxTokens 字段
    if (parsed.maxTokens !== undefined) {
      delete parsed.maxTokens;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    }
    return { ...DEFAULT_PROVIDER, ...parsed };
  } catch {
    return DEFAULT_PROVIDER;
  }
}

function saveProvider(p: AIProviderConfig) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** 几个常用的预设，方便切换 */
const MODEL_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: 'DeepSeek（默认）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn', model: 'Qwen/Qwen2.5-72B-Instruct' },
  { label: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen-plus' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini' },
  { label: '本地 Ollama（openai 兼容）', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
];

export default function RuleEditor(props: RuleEditorProps) {
  const { open, initialRule, sampleRows, sampleSheetData, sampleTextLines, mode, onClose, onSave } = props;

  const [rule, setRule] = useState<ParseRule>(emptyRule());
  const [submitting, setSubmitting] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [provider, setProvider] = useState<AIProviderConfig>(DEFAULT_PROVIDER);
  const [userHint, setUserHint] = useState('');
  const [lastRawResponse, setLastRawResponse] = useState<string>('');
  const [autoAiRunning, setAutoAiRunning] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewResult, setPreviewResult] = useState<any[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setRule({
        ...emptyRule(),
        ...(initialRule || {}),
        id: mode === 'create' ? `rule_${Date.now()}` : initialRule?.id || `rule_${Date.now()}`,
        fieldMappings: (initialRule?.fieldMappings || []).map((m) => ({ ...m })),
        extractionRules: (initialRule?.extractionRules || []).map((r) => ({ ...r })),
        skipPatterns: [...(initialRule?.skipPatterns || [])],
      } as ParseRule);
      setProvider(loadProvider());
      setLastRawResponse('');
    }
  }, [open, initialRule, mode]);

  useEffect(() => {
    if (open && mode === 'create' && sampleRows && sampleRows.length >= 2) {
      const p = loadProvider();
      if (p.apiKey.trim()) {
        setAutoAiRunning(true);
        runAiGenerate(p).catch(() => setAutoAiRunning(false));
      }
    }
  }, [open, mode, sampleRows]);

  const patch = (p: Partial<ParseRule>) => setRule((prev) => ({ ...prev, ...p }));

  const addMapping = () => {
    setRule((prev) => ({
      ...prev,
      fieldMappings: [...prev.fieldMappings, { sourceColumn: '', targetField: 'skuCode', mappingType: 'direct' }],
    }));
  };

  const updateMapping = (i: number, p: Partial<FieldMapping>) => {
    setRule((prev) => {
      const next = [...prev.fieldMappings];
      next[i] = { ...next[i], ...p };
      return { ...prev, fieldMappings: next };
    });
  };

  const removeMapping = (i: number) => {
    setRule((prev) => ({ ...prev, fieldMappings: prev.fieldMappings.filter((_, idx) => idx !== i) }));
  };

  const addExtraction = () => {
    setRule((prev) => ({
      ...prev,
      extractionRules: [
        ...prev.extractionRules,
        {
          id: `ext_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: '新提取规则',
          type: 'header',
          pattern: '',
          targetField: 'receiverName',
        },
      ],
    }));
  };

  const updateExtraction = (i: number, p: Partial<ExtractionRule>) => {
    setRule((prev) => {
      const next = [...prev.extractionRules];
      next[i] = { ...next[i], ...p };
      return { ...prev, extractionRules: next };
    });
  };

  const removeExtraction = (i: number) => {
    setRule((prev) => ({ ...prev, extractionRules: prev.extractionRules.filter((_, idx) => idx !== i) }));
  };

  /** 试解析预览：使用当前规则对样本数据进行解析，显示预览结果 */
  const runPreview = async () => {
    if (!sampleRows || sampleRows.length < 2) {
      message.warning('当前没有文件样本数据');
      return;
    }
    if (!rule.fieldMappings || rule.fieldMappings.length === 0) {
      message.warning('请先配置字段映射');
      return;
    }

    setPreviewLoading(true);
    try {
      const res = await fetch('/api/v2/ai/preview-rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: sampleRows,
          sheetData: sampleSheetData,
          textLines: sampleTextLines,
          rule,
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.error || `请求返回 ${res.status}`);
      }
      setPreviewResult(data.items.slice(0, 20));
      setPreviewOpen(true);
      message.success(`试解析完成：共 ${data.items.length} 条数据（显示前20条）`);
    } catch (err: any) {
      message.error(`试解析失败：${err?.message || err}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  /** 真正的大模型调用：POST /api/v2/ai/suggest-rule */
  const runAiGenerate = async (useProvider?: AIProviderConfig) => {
    if (!sampleRows || sampleRows.length < 2) {
      message.warning('当前没有文件样本数据，无法调用 AI；请先上传文件');
      return;
    }
    const p = useProvider || provider;
    if (!p.apiKey.trim()) {
      message.warning('请先点击⚙️按钮，填入 API Key 后再试');
      setConfigOpen(true);
      return;
    }
    setAiRunning(true);
    try {
      const res = await fetch('/api/v2/ai/suggest-rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: sampleRows,
          sheetData: sampleSheetData,
          textLines: sampleTextLines,
          // 不再传 headerRowIndex，由后端自动检测表头行
          userHint,
          provider: p,
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        throw new Error(data?.error || `请求返回 ${res.status}`);
      }
      const suggested: ParseRule = data.rule;
      setLastRawResponse(data.rawResponse || '');

      // 验证结果提示
      if (data.validationPassed === false) {
        message.warning(
          `AI 已生成规则（${suggested.fieldMappings.length} 个字段映射），但部分字段名与实际表头不完全匹配，建议检查后手动调整`,
          8
        );
      } else {
        message.success(
          `✅ AI 已推荐 ${suggested.fieldMappings.length} 个字段映射 + ${suggested.extractionRules.length} 个提取规则（置信度 ${Math.round((suggested.aiConfidence || 0) * 100)}%）`
        );
      }

      setRule((prev) => ({
        ...prev,
        name: prev.name && prev.name !== '新解析规则' ? prev.name : suggested.name,
        description: suggested.description || prev.description,
        parseMode: suggested.parseMode || prev.parseMode,
        multiSheet: suggested.multiSheet ?? prev.multiSheet,
        cardMarker: suggested.cardMarker || prev.cardMarker,
        headerSkipRows: suggested.headerSkipRows ?? prev.headerSkipRows,
        footerSkipRows: suggested.footerSkipRows ?? prev.footerSkipRows,
        dataStartRow: suggested.dataStartRow ?? prev.dataStartRow,
        dataEndRow: suggested.dataEndRow,
        skipPatterns: Array.isArray(suggested.skipPatterns) && suggested.skipPatterns.length
          ? suggested.skipPatterns
          : prev.skipPatterns,
        aggregateBy: suggested.aggregateBy || '',
        transposeConfig: suggested.transposeConfig || prev.transposeConfig,
        fieldMappings: suggested.fieldMappings,
        extractionRules: suggested.extractionRules,
        aiGenerated: true,
        aiConfidence: suggested.aiConfidence,
        updatedAt: new Date().toISOString(),
      }));
    } catch (err: any) {
      message.error(`AI 调用失败：${err?.message || err}`, 6);
    } finally {
      setAiRunning(false);
      setAutoAiRunning(false);
    }
  };

  const doSave = async () => {
    if (!rule.name?.trim()) {
      message.error('请填写规则名称');
      return;
    }
    if (!rule.fieldMappings || rule.fieldMappings.length === 0) {
      message.error('请至少添加一条字段映射');
      return;
    }
    for (const m of rule.fieldMappings) {
      if (!m.sourceColumn || !m.targetField) {
        message.error('字段映射存在未填写的「源列」或「目标字段」');
        return;
      }
    }
    setSubmitting(true);
    try {
      await onSave({ ...rule, updatedAt: new Date().toISOString() });
      message.success('规则已保存');
      onClose();
    } catch (e: any) {
      message.error(`保存失败：${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  };

  const mappingColumns: ColumnsType<FieldMapping & { _sample?: string }> = [
    {
      title: '源列（表头等）',
      dataIndex: 'sourceColumn',
      width: 200,
      render: (val: string, record: FieldMapping, idx: number) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Input
            placeholder="如：SKU编码"
            value={val}
            onChange={(e) => updateMapping(idx, { sourceColumn: e.target.value })}
          />
          {record.speculative && <Tag color="orange" style={{ margin: 0 }}>AI 推测</Tag>}
        </Space>
      ),
    },
    {
      title: '目标字段',
      dataIndex: 'targetField',
      width: 220,
      render: (val: OrderField, _r, idx) => (
        <Select
          value={val}
          options={FIELD_OPTIONS}
          style={{ width: '100%' }}
          onChange={(v) => updateMapping(idx, { targetField: v })}
        />
      ),
    },
    {
      title: '映射类型',
      dataIndex: 'mappingType',
      width: 150,
      render: (val: string, _r, idx) => (
        <Select
          value={val || 'direct'}
          options={[
            { value: 'direct', label: '直接取值' },
            { value: 'regex', label: '正则匹配' },
            { value: 'composite', label: '组合字段' },
          ]}
          style={{ width: '100%' }}
          onChange={(v) => updateMapping(idx, { mappingType: v as any })}
        />
      ),
    },
    {
      title: '正则 / 分隔符',
      dataIndex: 'regexPattern',
      width: 220,
      render: (_val: string, record, idx) => {
        if (record.mappingType === 'regex') {
          return (
            <Input
              placeholder="如：(\\d+)"
              value={record.regexPattern || ''}
              onChange={(e) => updateMapping(idx, { regexPattern: e.target.value })}
            />
          );
        }
        if (record.mappingType === 'composite') {
          return (
            <Input
              placeholder="分隔符，如：-"
              value={(record as any).separator || ''}
              onChange={(e) => updateMapping(idx, { separator: e.target.value } as any)}
            />
          );
        }
        return <span style={{ color: '#999' }}>—</span>;
      },
    },
    {
      title: '操作',
      width: 80,
      fixed: 'right',
      render: (_v, _r, idx) => (
        <Button type="text" danger icon={<DeleteOutlined />} onClick={() => removeMapping(idx)} />
      ),
    },
  ];

  const extractionColumns: ColumnsType<ExtractionRule> = [
    {
      title: '规则名',
      dataIndex: 'name',
      width: 140,
      render: (v: string, _r, idx) => (
        <Input value={v} onChange={(e) => updateExtraction(idx, { name: e.target.value })} />
      ),
    },
    {
      title: '位置',
      dataIndex: 'type',
      width: 120,
      render: (v: string, _r, idx) => (
        <Select
          value={v}
          options={[
            { value: 'header', label: '顶部区域' },
            { value: 'footer', label: '底部区域' },
            { value: 'inline', label: '每行内文本' },
            { value: 'card', label: '卡片式区域' },
          ]}
          onChange={(val) => updateExtraction(idx, { type: val as any })}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: '匹配关键词',
      dataIndex: 'pattern',
      width: 200,
      render: (v: string, _r, idx) => (
        <Input value={v} placeholder="如：电话" onChange={(e) => updateExtraction(idx, { pattern: e.target.value })} />
      ),
    },
    {
      title: '正则（可选）',
      dataIndex: 'regex',
      width: 220,
      render: (v: string | undefined, _r, idx) => (
        <Input value={v || ''} placeholder="如：(1\\d{10})" onChange={(e) => updateExtraction(idx, { regex: e.target.value })} />
      ),
    },
    {
      title: '写入字段',
      dataIndex: 'targetField',
      width: 180,
      render: (v: string, _r, idx) => (
        <Select
          value={v}
          options={FIELD_OPTIONS}
          style={{ width: '100%' }}
          onChange={(val) => updateExtraction(idx, { targetField: val })}
        />
      ),
    },
    {
      title: '默认值',
      dataIndex: 'defaultValue',
      width: 150,
      render: (v: string | undefined, _r, idx) => (
        <Input
          value={v || ''}
          onChange={(e) => updateExtraction(idx, { defaultValue: e.target.value })}
        />
      ),
    },
    {
      title: '操作',
      width: 80,
      fixed: 'right',
      render: (_v, _r, idx) => (
        <Button type="text" danger icon={<DeleteOutlined />} onClick={() => removeExtraction(idx)} />
      ),
    },
  ];

  return (
    <>
      <Modal
        title={
          <Space>
            <span>{mode === 'create' ? '新建解析规则' : '编辑解析规则'}</span>
            {autoAiRunning && <Tag color="orange"><SyncOutlined spin /> AI 正在分析...</Tag>}
            {rule.aiGenerated && !autoAiRunning && <Tag color="gold">🧠 AI 推荐</Tag>}
            {sampleRows && sampleRows.length > 1 && <Tag color="cyan">已上传样本 · {sampleRows.length} 行</Tag>}
          </Space>
        }
        open={open}
        onCancel={onClose}
        width={1120}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={onClose}>取消</Button>,
          <Button
            key="save"
            type="primary"
            icon={<SaveOutlined />}
            loading={submitting}
            onClick={doSave}
          >
            保存规则
          </Button>,
        ]}
      >
        {/* AI 功能区：放到顶部 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginBottom: 12,
            padding: '8px 0',
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <Button
            icon={<EyeOutlined />}
            onClick={runPreview}
            loading={previewLoading}
            disabled={!sampleRows || sampleRows.length < 2 || !rule.fieldMappings || rule.fieldMappings.length === 0}
          >
            👁️ 试解析预览
          </Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setConfigOpen(true)}
          >
            模型 / API
          </Button>
          <Button
            type="primary"
            icon={<BulbOutlined />}
            onClick={() => runAiGenerate()}
            loading={aiRunning}
            disabled={!sampleRows || sampleRows.length < 2}
          >
            🧠 AI 智能推荐
          </Button>
        </div>

        <Form layout="vertical" style={{ marginTop: 8 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="规则名称" required>
                <Input
                  value={rule.name}
                  placeholder="给规则起个容易识别的名字"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="文件类型">
                <Select
                  value={rule.fileType}
                  options={[
                    { value: 'excel', label: 'Excel' },
                    { value: 'word', label: 'Word' },
                    { value: 'pdf', label: 'PDF' },
                  ]}
                  onChange={(v) => patch({ fileType: v })}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="AI 置信度">
                <Input
                  disabled
                  value={rule.aiConfidence ? `${Math.round(rule.aiConfidence * 100)}%` : '—'}
                  prefix={<ThunderboltOutlined />}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="解析模式">
                <Select
                  value={rule.parseMode || 'table'}
                  options={[
                    { value: 'table', label: '标准表格' },
                    { value: 'card', label: '卡片式' },
                    { value: 'transpose', label: '矩阵转置' },
                    { value: 'text', label: '纯文本' },
                  ]}
                  onChange={(v) => patch({ parseMode: v })}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="多 Sheet 合并">
                <Select
                  value={rule.multiSheet ? 'yes' : 'no'}
                  options={[{ value: 'no', label: '否' }, { value: 'yes', label: '是' }]}
                  onChange={(v) => patch({ multiSheet: v === 'yes' })}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="卡片标记符">
                <Input value={rule.cardMarker || '▶'} onChange={(e) => patch({ cardMarker: e.target.value })} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="数据结束行">
                <InputNumber min={0} value={rule.dataEndRow} onChange={(v) => patch({ dataEndRow: v ?? undefined })} style={{ width: '100%' }} placeholder="可选" />
              </Form.Item>
            </Col>
          </Row>

          {rule.parseMode === 'transpose' && (
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="行标识列">
                  <Input
                    value={rule.transposeConfig?.rowHeaderColumn || ''}
                    onChange={(e) => patch({
                      transposeConfig: {
                        type: rule.transposeConfig?.type || 'matrix',
                        rowHeaderColumn: e.target.value,
                        columnHeaderRow: rule.transposeConfig?.columnHeaderRow ?? rule.dataStartRow,
                        valueColumn: rule.transposeConfig?.valueColumn || '',
                      },
                    })}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="列头行索引">
                  <InputNumber
                    min={0}
                    value={rule.transposeConfig?.columnHeaderRow ?? rule.dataStartRow}
                    onChange={(v) => patch({
                      transposeConfig: {
                        type: rule.transposeConfig?.type || 'matrix',
                        rowHeaderColumn: rule.transposeConfig?.rowHeaderColumn || '',
                        columnHeaderRow: Number(v) || 0,
                        valueColumn: rule.transposeConfig?.valueColumn || '',
                      },
                    })}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="转置类型">
                  <Select
                    value={rule.transposeConfig?.type || 'matrix'}
                    options={[
                      { value: 'matrix', label: 'SKU×门店矩阵' },
                      { value: 'double', label: '日期×门店+复合单元格' },
                    ]}
                    onChange={(v) => patch({
                      transposeConfig: {
                        type: v,
                        rowHeaderColumn: rule.transposeConfig?.rowHeaderColumn || '',
                        columnHeaderRow: rule.transposeConfig?.columnHeaderRow ?? rule.dataStartRow,
                        valueColumn: rule.transposeConfig?.valueColumn || '',
                      },
                    })}
                  />
                </Form.Item>
              </Col>
            </Row>
          )}

          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="表头跳过行数">
                <InputNumber min={0} max={50} value={rule.headerSkipRows} onChange={(v) => patch({ headerSkipRows: Number(v) || 0 })} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="数据起始行（相对表头位置）">
                <InputNumber min={0} max={100} value={rule.dataStartRow} onChange={(v) => patch({ dataStartRow: Number(v) || 0 })} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="跳过关键词">
                <Select
                  mode="tags"
                  value={rule.skipPatterns}
                  onChange={(v) => patch({ skipPatterns: v })}
                  style={{ width: '100%' }}
                  placeholder="输入后回车添加"
                  tokenSeparators={[',']}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="聚合字段（可选）">
                <Select
                  allowClear
                  value={rule.aggregateBy || undefined}
                  options={[{ value: '', label: '不聚合（默认）' }, ...FIELD_OPTIONS]}
                  onChange={(v) => patch({ aggregateBy: v || '' })}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="AI 补充提示（可选，会与文件样本一起发给模型）">
            <Input.TextArea
              value={userHint}
              onChange={(e) => setUserHint(e.target.value)}
              rows={2}
              placeholder='如：这份是某电商的发货单，收货门店在顶部；SKU 数量列可能有"1件""2件"字样'
            />
          </Form.Item>

          <Form.Item label="规则描述">
            <Input.TextArea
              value={rule.description}
              rows={2}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="描述此规则适用的文件特征，方便以后选择"
            />
          </Form.Item>
        </Form>

        <Tabs
          items={[
            {
              key: 'mappings',
              label: `字段映射（${rule.fieldMappings.length}）`,
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="字段映射：告诉系统 Excel 中某一列对应哪个业务字段（SKU编码、数量、门店等）"
                  />
                  <Table
                    size="small"
                    rowKey={(_, idx) => `m_${idx}`}
                    columns={mappingColumns}
                    dataSource={rule.fieldMappings}
                    pagination={false}
                    bordered
                    scroll={{ x: 1100 }}
                    footer={() => (
                      <Button type="dashed" block icon={<PlusOutlined />} onClick={addMapping}>
                        添加一条字段映射
                      </Button>
                    )}
                  />
                </>
              ),
            },
            {
              key: 'extractions',
              label: `提取规则（${rule.extractionRules.length}）`,
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="提取规则：处理表格之外的自由文本（如顶部「配送单号：xxx」、底部「收件人电话：xxx」），匹配关键词后把内容写入目标字段"
                  />
                  <Table
                    size="small"
                    rowKey={(r) => r.id}
                    columns={extractionColumns}
                    dataSource={rule.extractionRules}
                    pagination={false}
                    bordered
                    scroll={{ x: 1200 }}
                    footer={() => (
                      <Button type="dashed" block icon={<PlusOutlined />} onClick={addExtraction}>
                        添加一条提取规则
                      </Button>
                    )}
                  />
                </>
              ),
            },
          ]}
        />

        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: '#fafafa',
            borderRadius: 6,
            border: '1px dashed #e5e7eb',
          }}
        >
          <div style={{ color: '#555', fontSize: 13 }}>
            <strong>📋 配置预览：</strong>
            {rule.fieldMappings.length} 条字段映射，{rule.extractionRules.length} 条提取规则
            {rule.aggregateBy && `，按 ${SYSTEM_FIELDS.find((f) => f.key === rule.aggregateBy)?.label || rule.aggregateBy} 聚合`}
          </div>
        </div>
      </Modal>

      {/* 模型 & API 配置抽屉 */}
      <Drawer
        title={
          <Space>
            <SettingOutlined /> <span>大模型配置（OpenAI 兼容协议）</span>
          </Space>
        }
        open={configOpen}
        onClose={() => {
          saveProvider(provider);
          setConfigOpen(false);
        }}
        width={520}
      >
        <Alert
          type="info"
          showIcon
          icon={<ExperimentOutlined />}
          message={
            <span>
              配置仅保存在浏览器 <code>localStorage</code>，下次进入页面自动带出。生产环境建议改为由服务端集中管理。
            </span>
          }
          style={{ marginBottom: 16 }}
        />

        <Divider style={{ margin: '8px 0 16px' }}>快捷预设</Divider>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {MODEL_PRESETS.map((p) => (
            <Tag
              key={p.label}
              style={{ cursor: 'pointer', padding: '4px 10px' }}
              onClick={() =>
                setProvider((prev) => ({ ...prev, baseUrl: p.baseUrl, model: p.model }))
              }
            >
              {p.label}
            </Tag>
          ))}
        </div>

        <Divider style={{ margin: '8px 0 16px' }}>具体参数</Divider>
        <Form layout="vertical">
          <Form.Item label="Base URL（OpenAI 兼容）">
            <Input
              value={provider.baseUrl}
              onChange={(e) => setProvider({ ...provider, baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com"
            />
          </Form.Item>
          <Form.Item label="API Key">
            <Input.Password
              value={provider.apiKey}
              onChange={(e) => setProvider({ ...provider, apiKey: e.target.value })}
              placeholder="sk-..."
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="模型名称">
            <Input
              value={provider.model}
              onChange={(e) => setProvider({ ...provider, model: e.target.value })}
              placeholder="deepseek-chat"
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="Temperature（越大越随机）">
                <InputNumber
                  min={0}
                  max={2}
                  step={0.1}
                  value={provider.temperature}
                  onChange={(v) => setProvider({ ...provider, temperature: Number(v) ?? 0 })}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="上传给模型的样本行数">
            <InputNumber
              min={3}
              max={100}
              value={provider.sampleRowLimit}
              onChange={(v) => setProvider({ ...provider, sampleRowLimit: Number(v) ?? 15 })}
              style={{ width: '100%' }}
            />
            <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
              越大越精准，但会消耗更多 Token。默认 15 行一般足够。
            </div>
          </Form.Item>

          <Tooltip title="仅保存到浏览器 localStorage，不会上传到本系统后端">
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => {
                saveProvider(provider);
                message.success('模型配置已保存');
                setConfigOpen(false);
              }}
              style={{ marginTop: 8 }}
            >
              保存模型配置
            </Button>
          </Tooltip>
        </Form>
      </Drawer>

      {/* 试解析预览抽屉 - 层级高于规则编辑弹窗 */}
      <Drawer
        title={
          <Space>
            <EyeOutlined /> <span>规则预览（试解析）</span>
          </Space>
        }
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        width={900}
        zIndex={1200}
      >
        <div style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            message="这是使用当前规则对已上传文件进行的试解析结果，确认正确后再保存规则"
          />
        </div>
        {previewResult.length > 0 ? (
          <Table
            dataSource={previewResult.map((item, idx) => ({ ...item, key: `preview_${idx}` }))}
            columns={[
              { title: '序号', dataIndex: '_index', render: (_, __, idx) => idx + 1, width: 60 },
              { title: '外部编码', dataIndex: 'externalCode', ellipsis: true },
              { title: '收货门店', dataIndex: 'storeName', ellipsis: true },
              { title: '收件人', dataIndex: 'receiverName' },
              { title: '电话', dataIndex: 'receiverPhone' },
              { title: '地址', dataIndex: 'receiverAddress', ellipsis: true },
              { title: 'SKU编码', dataIndex: 'skuCode' },
              { title: 'SKU名称', dataIndex: 'skuName', ellipsis: true },
              { title: '数量', dataIndex: 'skuQuantity', align: 'right' },
              { title: '规格', dataIndex: 'skuSpec', ellipsis: true },
              { title: '备注', dataIndex: 'remark', ellipsis: true },
            ]}
            pagination={{ pageSize: 10 }}
            scroll={{ x: 1200 }}
          />
        ) : (
          <Empty description="暂无预览数据" />
        )}
      </Drawer>
    </>
  );
}
