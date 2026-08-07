'use client';

/**
 * V3 任务列表
 * 分页展示所有导入任务，支持状态筛选，点击进入详情
 */
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Table, Tag, Select, Button, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import V3Layout from '@/v3/components/V3Layout';

const { Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  pending: 'default', processing: 'processing', completed: 'success',
  partial_success: 'warning', failed: 'error',
};
const STATUS_LABELS: Record<string, string> = {
  pending: '等待处理', processing: '处理中', completed: '已完成',
  partial_success: '部分成功', failed: '失败',
};

export default function V3TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState('');

  // 防止 React 严格模式双执行 + 相同参数重复请求
  const lastLoadKey = useRef('');

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) params.set('status', status);
      const resp = await fetch(`/api/v3/import-tasks?${params}`).then(r => r.json());
      if (resp.ok) {
        setTasks(resp.tasks || []);
        setTotal(resp.total || 0);
      }
    } catch (err) {
      console.error('加载失败:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const key = `${page}-${pageSize}-${status}`;
    if (lastLoadKey.current === key) return;
    lastLoadKey.current = key;
    load();
  }, [page, pageSize, status]);

  const columns = [
    { title: '任务ID', dataIndex: 'id', key: 'id', width: 240, render: (v: string) => (
      <a onClick={() => router.push(`/v3/tasks/${v}`)}>{v}</a>
    ) },
    { title: '文件名', dataIndex: 'file_name', key: 'file_name', ellipsis: true },
    { title: '状态', dataIndex: 'status', key: 'status', width: 110, render: (v: string) => (
      <Tag color={STATUS_COLORS[v]}>{STATUS_LABELS[v] || v}</Tag>
    ) },
    { title: '总行数', dataIndex: 'total_rows', key: 'total_rows', width: 90 },
    { title: '成功', dataIndex: 'success_rows', key: 'success', width: 80, render: (v: number) =>
      <Text style={{ color: '#52c41a' }}>{v || 0}</Text> },
    { title: '失败', dataIndex: 'failed_rows', key: 'failed', width: 80, render: (v: number) =>
      <Text style={{ color: v ? '#ff4d4f' : undefined }}>{v || 0}</Text> },
    { title: '批次', key: 'batches', width: 90, render: (_: any, r: any) =>
      `${r.completed_batches || 0}/${r.total_batches || 0}` },
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 170, render: (v: string) =>
      v ? new Date(v).toLocaleString('zh-CN') : '-' },
  ];

  return (
    <V3Layout breadcrumbItems={[{ title: '异步导入 V3' }, { title: '任务列表' }]}>
      <Card
        title="导入任务"
        extra={
          <Space>
            <Select
              value={status || 'all'}
              onChange={(v) => { setStatus(v === 'all' ? '' : v); setPage(1); }}
              style={{ width: 140 }}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'pending', label: '等待处理' },
                { value: 'processing', label: '处理中' },
                { value: 'completed', label: '已完成' },
                { value: 'partial_success', label: '部分成功' },
                { value: 'failed', label: '失败' },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={tasks}
          rowKey="id"
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
          size="small"
        />
      </Card>
    </V3Layout>
  );
}
