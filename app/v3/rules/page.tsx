'use client';

/**
 * V3 解析规则管理页面
 * 复用 V2 的 RuleEditor 组件和 database.ts CRUD 函数
 * 支持创建、编辑、复制、删除规则，以及 AI 生成规则
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Table, Button, Input, Tag, Space, Empty, Modal, Drawer, Alert, message, Typography } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  SearchOutlined,
  EyeOutlined,
  EditOutlined,
  CopyOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import V3Layout from '@/v3/components/V3Layout';
import RuleEditor from '@/v2/components/RuleEditor';
import {
  getAllRules,
  saveRule,
  deleteRule,
} from '@/v2/lib/database';
import type { ParseRule, FieldMapping } from '@/v2/types';
import { SYSTEM_FIELDS as SYS_FIELDS } from '@/v2/types';

const { Text } = Typography;

export default function V3RulesPage() {
  const router = useRouter();
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // RuleEditor 状态
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [editingRule, setEditingRule] = useState<ParseRule | null>(null);

  // 规则详情 Drawer
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRule, setPreviewRule] = useState<ParseRule | null>(null);

  // 选中的规则（用于上传时跳转回来）
  const [selectedRuleId, setSelectedRuleId] = useState<string>('');

  // 防止 React 严格模式下 useEffect 双执行导致重复请求
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadRules();
  }, []);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getAllRules();
      setRules(list);
    } catch (err) {
      console.error('加载规则失败:', err);
      message.error('加载规则列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 过滤后的规则列表
  const filteredRules = rules.filter((r) => {
    if (!keyword.trim()) return true;
    const kw = keyword.toLowerCase();
    return (
      r.name?.toLowerCase().includes(kw) ||
      r.description?.toLowerCase().includes(kw) ||
      r.fieldMappings?.some((m) => m.sourceColumn?.toLowerCase().includes(kw) || m.targetField?.toLowerCase().includes(kw))
    );
  });

  const pageData = filteredRules.slice((page - 1) * pageSize, page * pageSize);

  // 新建规则
  const openCreateRule = useCallback(() => {
    setEditingRule(null);
    setEditorMode('create');
    setEditorOpen(true);
  }, []);

  // 编辑规则
  const openEditRule = useCallback((rule: ParseRule) => {
    setEditingRule(rule);
    setEditorMode('edit');
    setEditorOpen(true);
  }, []);

  // 保存规则（新建/编辑）
  const handleSaveRule = useCallback(
    async (rule: ParseRule) => {
      const ok = await saveRule(rule);
      if (!ok) {
        message.error('保存规则失败');
        return;
      }
      await loadRules();
      setSelectedRuleId(rule.id);
      setEditorOpen(false);
      message.success(editorMode === 'create' ? '规则创建成功' : '规则已更新');
    },
    [loadRules, editorMode]
  );

  // 删除规则
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
            if (selectedRuleId === rule.id) setSelectedRuleId('');
            message.success('已删除规则');
          } else {
            message.error('删除失败');
          }
        },
      });
    },
    [loadRules, selectedRuleId]
  );

  // 复制规则
  const handleCopyRule = useCallback(
    async (rule: ParseRule) => {
      const copy: ParseRule = {
        ...rule,
        id: `rule_${Date.now()}`,
        name: `${rule.name} (副本)`,
        aiGenerated: false,
        aiConfidence: 0,
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

  // 查看规则详情
  const handlePreview = useCallback((rule: ParseRule) => {
    setPreviewRule(rule);
    setPreviewOpen(true);
  }, []);

  // 使用规则（跳转到上传页）
  const handleUseRule = useCallback(
    (rule: ParseRule) => {
      setSelectedRuleId(rule.id);
      // 通过 URL 参数传递选中的 rule_id
      router.push(`/v3?rule_id=${rule.id}`);
    },
    [router]
  );

  // 表格列定义
  const columns = [
    {
      title: '规则名称',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (v: string) => <Text strong style={{ fontSize: 13 }}>{v}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'fileType',
      key: 'fileType',
      width: 80,
      render: (v: string) => <Tag className="v2-tag-blue">{v}</Tag>,
    },
    {
      title: '来源',
      key: 'ai',
      width: 80,
      render: (_: any, r: ParseRule) =>
        r.aiGenerated ? (
          <Tag className="v2-tag-gold">AI · {Math.round((r.aiConfidence || 0) * 100)}%</Tag>
        ) : (
          <Tag>手动</Tag>
        ),
    },
    {
      title: '字段映射',
      key: 'mappings',
      width: 280,
      render: (_: any, r: ParseRule) => (
        <span style={{ fontSize: 12, color: '#666' }}>
          {r.fieldMappings.slice(0, 4).map((m: FieldMapping, i: number) => (
            <Tag key={i} style={{ margin: 2, fontSize: 11 }}>
              {m.sourceColumn} → {SYS_FIELDS.find((f) => f.key === m.targetField)?.label || m.targetField}
            </Tag>
          ))}
          {r.fieldMappings.length > 4 && <Tag>+{r.fieldMappings.length - 4}</Tag>}
        </span>
      ),
    },
    { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (v?: string) => (v ? new Date(v).toLocaleString('zh-CN') : '—'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      fixed: 'right' as const,
      render: (_: any, r: ParseRule) => (
        <Space size={4}>
          <Button size="small" className="v2-btn" type="primary" onClick={() => handleUseRule(r)}>
            使用
          </Button>
          <Button size="small" className="v2-btn" icon={<EyeOutlined />} onClick={() => handlePreview(r)} />
          <Button size="small" className="v2-btn" icon={<EditOutlined />} onClick={() => openEditRule(r)} />
          <Button size="small" className="v2-btn" icon={<CopyOutlined />} onClick={() => handleCopyRule(r)} />
          <Button size="small" className="v2-btn" danger icon={<DeleteOutlined />} onClick={() => handleDeleteRule(r)} />
        </Space>
      ),
    },
  ];

  return (
    <V3Layout>
      <div className="v2-page-title">解析规则管理</div>

      {/* 工具栏 */}
      <div className="v2-list-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DatabaseOutlined style={{ color: '#0fc6c2' }} />
          <span style={{ fontSize: 15, fontWeight: 500 }}>
            已保存 {rules.length} 条规则
          </span>
        </div>
        <Space>
          <Input
            placeholder="按名称/描述/字段搜索"
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
            prefix={<SearchOutlined />}
            allowClear
            style={{ width: 220 }}
          />
          <Button type="primary" className="v2-btn v2-btn-primary" icon={<PlusOutlined />} onClick={openCreateRule}>
            新建规则
          </Button>
        </Space>
      </div>

      {/* 规则列表 */}
      <Card className="v2-card">
        {pageData.length === 0 && !loading ? (
          <Empty description={keyword ? '未找到匹配的规则' : '暂无规则，点击右上角「新建规则」创建'} style={{ padding: '48px 0' }} />
        ) : (
          <Table<ParseRule>
            className="v2-table"
            size="small"
            rowKey={(r) => r.id}
            bordered
            loading={loading}
            columns={columns}
            dataSource={pageData}
            scroll={{ x: 1200 }}
            pagination={{
              current: page,
              pageSize,
              total: filteredRules.length,
              showSizeChanger: true,
              pageSizeOptions: ['10', '20', '50'],
              onChange: (p, ps) => { setPage(p); setPageSize(ps); },
              showTotal: (t) => `共 ${t} 条规则`,
            }}
          />
        )}
      </Card>

      {/* 提示信息 */}
      <div className="v2-tips" style={{ marginTop: 16 }}>
        <div className="v2-tips-header">
          <ThunderboltOutlined />
          规则复用说明
        </div>
        <ul className="v2-tips-list">
          <li>V3 复用 V2 的解析规则引擎（executeRuleEngine），所有 V2 创建的规则可直接在 V3 使用</li>
          <li>规则的创建、编辑、AI 生成、字段映射配置与 V2 完全一致</li>
          <li>V3 在此基础上增加：异步批量处理、SKU 主数据校验、幂等 UPSERT、行级错误追踪</li>
          <li>点击「使用」可将选中的规则带入上传页面</li>
        </ul>
      </div>

      {/* 规则编辑器（复用 V2 组件） */}
      <RuleEditor
        open={editorOpen}
        initialRule={editingRule || undefined}
        mode={editorMode}
        onClose={() => setEditorOpen(false)}
        onSave={handleSaveRule}
      />

      {/* 规则详情 Drawer */}
      <Drawer
        title={previewRule?.name || '规则详情'}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        width={520}
      >
        {previewRule && (
          <>
            <Alert
              message={previewRule.description || '（无描述）'}
              type="info"
              showIcon
              className="v2-alert"
            />
            <div style={{ fontSize: 14, fontWeight: 500, margin: '16px 0 8px' }}>
              基本信息
            </div>
            <div style={{ fontSize: 13, color: '#595959', lineHeight: 2 }}>
              <div>文件类型：<Tag className="v2-tag-blue">{previewRule.fileType}</Tag></div>
              <div>解析模式：<Tag>{previewRule.parseMode}</Tag></div>
              {previewRule.aiGenerated && (
                <div>AI 生成：<Tag className="v2-tag-gold">置信度 {Math.round((previewRule.aiConfidence || 0) * 100)}%</Tag></div>
              )}
              <div>表头跳过行：{previewRule.headerSkipRows}</div>
              <div>底部跳过行：{previewRule.footerSkipRows}</div>
              <div>跳过关键词：{previewRule.skipPatterns?.join(', ') || '无'}</div>
            </div>

            <div style={{ fontSize: 14, fontWeight: 500, margin: '16px 0 8px' }}>
              字段映射（{previewRule.fieldMappings.length} 个）
            </div>
            {previewRule.fieldMappings.length === 0 ? (
              <Empty description="无字段映射" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Table<FieldMapping>
                className="v2-table"
                size="small"
                rowKey={(_, i) => `fm_${i}`}
                pagination={false}
                columns={[
                  { title: '源列', dataIndex: 'sourceColumn', key: 'source', width: 140 },
                  {
                    title: '目标字段',
                    dataIndex: 'targetField',
                    key: 'target',
                    width: 140,
                    render: (v: string) => SYS_FIELDS.find((f) => f.key === v)?.label || v,
                  },
                  { title: '映射方式', dataIndex: 'mappingType', key: 'type', width: 100 },
                ]}
                dataSource={previewRule.fieldMappings}
              />
            )}

            {previewRule.extractionRules && previewRule.extractionRules.length > 0 && (
              <>
                <div style={{ fontSize: 14, fontWeight: 500, margin: '16px 0 8px' }}>
                  提取规则（{previewRule.extractionRules.length} 个）
                </div>
                <Table
                  className="v2-table"
                  size="small"
                  rowKey={(_, i) => `er_${i}`}
                  pagination={false}
                  columns={[
                    { title: '类型', dataIndex: 'type', key: 'type', width: 100 },
                    { title: '匹配', dataIndex: 'matchPattern', key: 'match' },
                    { title: '字段', dataIndex: 'targetField', key: 'field', width: 100 },
                  ]}
                  dataSource={previewRule.extractionRules}
                />
              </>
            )}

            <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
              <Button
                type="primary"
                className="v2-btn v2-btn-primary"
                onClick={() => {
                  setPreviewOpen(false);
                  handleUseRule(previewRule);
                }}
              >
                使用此规则上传
              </Button>
              <Button
                className="v2-btn"
                icon={<EditOutlined />}
                onClick={() => {
                  setPreviewOpen(false);
                  openEditRule(previewRule);
                }}
              >
                编辑
              </Button>
            </div>
          </>
        )}
      </Drawer>
    </V3Layout>
  );
}
