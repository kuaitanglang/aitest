'use client';

/**
 * V3 任务错误明细
 * 分页查看某任务的导入错误，支持按批次、错误码筛选
 */
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, Table, Tag, Select, Button, Space, Typography, Statistic, Row, Col } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import V3Layout from '@/v3/components/V3Layout';

const { Text } = Typography;

const ERROR_LABELS: Record<string, string> = {
  E001: 'SKU 不存在', E002: '必填字段缺失', E003: '电话格式错误', E004: '数量无效',
  E005: '外部编码重复', E006: '规则映射失败', E007: '数据库写入失败', E008: '文件格式不支持',
};
const ERROR_COLORS: Record<string, string> = {
  E001: 'orange', E002: 'red', E003: 'volcano', E004: 'magenta',
  E005: 'gold', E006: 'purple', E007: 'red', E008: 'cyan',
};

export default function V3TaskErrorsPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = (params?.taskId as string) || '';

  const [errors, setErrors] = useState<any[]>([]);
  const [errorSummary, setErrorSummary] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [codeFilter, setCodeFilter] = useState('');
  const [batchFilter, setBatchFilter] = useState('');

  async function load() {
    setLoading(true);
    try {
      const searchParams = new URLSearchParams({
        page: String(page), page_size: String(pageSize),
      });
      if (codeFilter) searchParams.set('error_code', codeFilter);
      if (batchFilter) searchParams.set('batch', batchFilter);
      const resp = await fetch(`/api/v3/import-tasks/${taskId}/errors?${searchParams}`).then(r => r.json());
      if (resp.ok) {
        setErrors(resp.errors || []);
        setTotal(resp.total || 0);
        setErrorSummary(resp.error_summary || {});
      }
    } catch (err) {
      console.error('加载失败:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [page, pageSize, codeFilter, batchFilter, taskId]);

  // 从 errorSummary 中获取有错误的批次列表
  const batchOptions = [...new Set(errors.map(e => e.batch_index))].sort((a, b) => a - b);

  const columns = [
    { title: '行号', dataIndex: 'row_number', key: 'row', width: 70 },
    { title: '批次', dataIndex: 'batch_index', key: 'batch', width: 70, render: (v: number) => `#${v + 1}` },
    { title: '单元', dataIndex: 'unit_id', key: 'unit', width: 90 },
    { title: '错误码', dataIndex: 'error_code', key: 'code', width: 90, render: (v: string) =>
      <Tag color={ERROR_COLORS[v] || 'default'}>{v}</Tag> },
    { title: '错误类型', key: 'label', width: 130, render: (_: any, r: any) =>
      ERROR_LABELS[r.error_code] || r.error_code },
    { title: '字段', dataIndex: 'field_name', key: 'field', width: 130, render: (v: string) =>
      v || '-' },
    { title: '原始值', dataIndex: 'raw_value', key: 'raw', width: 160, ellipsis: true, render: (v: string) =>
      v ? <Text code>{v}</Text> : '-' },
    { title: '错误原因', dataIndex: 'error_reason', key: 'reason', ellipsis: true },
  ];

  return (
    <V3Layout breadcrumbItems={[
      { title: '异步导入 V3' },
      { title: '任务列表' },
      { title: taskId.slice(0, 20) + '...' },
      { title: '错误明细' },
    ]}>
      <div style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/v3/tasks/${taskId}`)}>
          返回任务详情
        </Button>
      </div>

      {/* 错误类型统计卡片 */}
      {Object.keys(errorSummary).length > 0 && (
        <Row gutter={[8, 8]} style={{ marginBottom: 16 }}>
          {Object.entries(errorSummary).map(([code, count]) => (
            <Col key={code} span={3}>
              <Card size="small">
                <Statistic
                  title={ERROR_LABELS[code] || code}
                  value={count}
                  valueStyle={{ color: count > 0 ? '#ff4d4f' : undefined, fontSize: 20 }}
                  prefix={<Tag color={ERROR_COLORS[code] || 'default'} style={{ marginRight: 4 }}>{code}</Tag>}
                />
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Card
        title={`错误明细 (共 ${total} 条)`}
        extra={
          <Space>
            <Select
              value={batchFilter || 'all'}
              onChange={(v) => { setBatchFilter(v === 'all' ? '' : String(v)); setPage(1); }}
              style={{ width: 140 }}
              options={[
                { value: 'all', label: '全部批次' },
                ...batchOptions.map(b => ({ value: String(b), label: `批次 #${b + 1}` })),
              ]}
            />
            <Select
              value={codeFilter || 'all'}
              onChange={(v) => { setCodeFilter(v === 'all' ? '' : v); setPage(1); }}
              style={{ width: 180 }}
              options={[
                { value: 'all', label: '全部错误码' },
                ...Object.keys(ERROR_LABELS).map(c => ({ value: c, label: `${c} ${ERROR_LABELS[c]}` })),
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={errors}
          rowKey={(r: any) => `${r.row_number}-${r.field_name}-${r.unit_id}`}
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
          size="small"
        />
      </Card>
    </V3Layout>
  );
}
