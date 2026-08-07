'use client';

/**
 * V3 Trace 追踪
 * 搜索全链路事件，支持按 task_id / trace_id / event_name / event_status 过滤
 *
 * 支持从 URL 参数自动填充搜索条件（如 /v3/traces?trace_id=xxx）
 */
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, Table, Tag, Input, Select, Button, Space, Typography, message } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import V3Layout from '@/v3/components/V3Layout';

const { Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  success: 'success', failed: 'error', warning: 'warning',
};

const EVENT_TYPES = [
  'TaskCreated', 'TaskInitialized', 'ImportTaskCompleted',
  'BatchStarted', 'BatchSucceeded', 'BatchFailed', 'BatchRecovered',
];

export default function V3TracesPage() {
  return (
    <Suspense fallback={null}>
      <V3TracesInner />
    </Suspense>
  );
}

function V3TracesInner() {
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [traceId, setTraceId] = useState('');
  const [eventName, setEventName] = useState('');
  const [eventStatus, setEventStatus] = useState('');

  // 从 URL 参数自动填充并触发搜索
  useEffect(() => {
    const urlTaskId = searchParams.get('task_id') || '';
    const urlTraceId = searchParams.get('trace_id') || '';
    const urlEventName = searchParams.get('event_name') || '';
    if (urlTaskId || urlTraceId || urlEventName) {
      setTaskId(urlTaskId);
      setTraceId(urlTraceId);
      setEventName(urlEventName);
      // 自动触发搜索
      doSearch(urlTaskId, urlTraceId, urlEventName, '');
    }
  }, [searchParams]);

  async function search() {
    await doSearch(taskId, traceId, eventName, eventStatus);
  }

  async function doSearch(tId: string, trId: string, eName: string, eStatus: string) {
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (tId) params.set('task_id', tId);
      if (trId) params.set('trace_id', trId);
      if (eName) params.set('event_name', eName);
      if (eStatus) params.set('event_status', eStatus);
      const resp = await fetch(`/api/v3/traces/search?${params}`).then(r => r.json());
      if (resp.ok) {
        setEvents(resp.events || []);
      } else {
        setEvents([]);
        message.error(resp.error || '查询失败');
      }
    } catch (err) {
      console.error('搜索失败:', err);
      message.error('搜索失败');
    } finally {
      setLoading(false);
    }
  }

  const columns = [
    { title: '时间', dataIndex: 'occurred_at', key: 'time', width: 180, render: (v: string) =>
      v ? new Date(v).toLocaleString('zh-CN') : '-' },
    { title: 'Trace ID', dataIndex: 'trace_id', key: 'trace_id', width: 180, render: (v: string) =>
      v ? <Text code style={{ fontSize: 12 }}>{v.slice(0, 20)}...</Text> : '-' },
    { title: '任务', dataIndex: 'task_id', key: 'task_id', width: 180, render: (v: string) =>
      v ? <Text code style={{ fontSize: 12 }}>{v.slice(0, 20)}...</Text> : '-' },
    { title: '批次', dataIndex: 'unit_id', key: 'unit_id', width: 90 },
    { title: '事件', dataIndex: 'event_name', key: 'event_name', width: 160, render: (v: string) =>
      <Tag>{v}</Tag> },
    { title: '状态', dataIndex: 'event_status', key: 'event_status', width: 90, render: (v: string) =>
      <Tag color={STATUS_COLORS[v] || 'default'}>{v}</Tag> },
    { title: '描述', dataIndex: 'message', key: 'message', ellipsis: true },
  ];

  return (
    <V3Layout breadcrumbItems={[{ title: '异步导入 V3' }, { title: 'Trace 追踪' }]}>
      <Card title="搜索条件" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input
            placeholder="Task ID"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            style={{ width: 260 }}
            allowClear
          />
          <Input
            placeholder="Trace ID"
            value={traceId}
            onChange={(e) => setTraceId(e.target.value)}
            style={{ width: 260 }}
            allowClear
          />
          <Select
            placeholder="事件类型"
            value={eventName || undefined}
            onChange={setEventName}
            allowClear
            style={{ width: 180 }}
            options={EVENT_TYPES.map(t => ({ value: t, label: t }))}
          />
          <Select
            placeholder="状态"
            value={eventStatus || undefined}
            onChange={setEventStatus}
            allowClear
            style={{ width: 120 }}
            options={[
              { value: 'success', label: '成功' },
              { value: 'failed', label: '失败' },
              { value: 'warning', label: '警告' },
            ]}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={search} loading={loading}>搜索</Button>
        </Space>
      </Card>

      <Card title={`Trace 事件${searched ? ` (${events.length} 条)` : ''}`}>
        <Table
          columns={columns}
          dataSource={events}
          rowKey={(r: any) => `${r.trace_id}-${r.event_name}-${r.occurred_at}`}
          loading={loading}
          pagination={{ pageSize: 50 }}
          size="small"
          locale={{ emptyText: searched ? '无匹配事件' : '请输入条件后搜索' }}
        />
      </Card>
    </V3Layout>
  );
}
