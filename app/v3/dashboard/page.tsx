'use client';

/**
 * V3 仪表盘（融合原仪表盘 + 监控看板）
 *
 * 内容整合：
 *   1. 系统概览统计（来自 /api/v3/import-monitor/summary，5s 自动刷新）
 *   2. 数据统计（总行数 / 成功行数 / 吞吐量）
 *   3. 快捷入口
 *   4. 活跃任务（pending/processing，自动刷新）
 *   5. 最近任务（最近 10 条）
 */
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Table, Tag, Button, Row, Col, Statistic, Typography, Space, Progress, Empty } from 'antd';
import {
  UploadOutlined,
  FileTextOutlined,
  UnorderedListOutlined,
  ApiOutlined,
  DatabaseOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
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

export default function V3DashboardPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // 防重复请求
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [sumResp, taskResp] = await Promise.all([
        fetch('/api/v3/import-monitor/summary').then(r => r.json()),
        fetch('/api/v3/import-tasks?page=1&pageSize=10').then(r => r.json()),
      ]);
      if (sumResp.ok) setSummary(sumResp.summary);
      if (taskResp.ok) setTasks(taskResp.tasks || []);
    } catch (err) {
      console.error('加载失败:', err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    loadData();
    if (!autoRefresh) return;
    const t = setInterval(loadData, 5000);
    return () => clearInterval(t);
  }, [autoRefresh]);

  const activeTasks = tasks.filter((t: any) => ['pending', 'processing'].includes(t.status));
  const recentTasks = tasks.filter((t: any) => !['pending', 'processing'].includes(t.status));

  const quickLinks = [
    { title: '新建导入', desc: '上传 Excel 文件', icon: <UploadOutlined />, path: '/v3' },
    { title: '任务列表', desc: '查看所有任务', icon: <UnorderedListOutlined />, path: '/v3/tasks' },
    { title: '订单记录', desc: '查看已导入订单', icon: <FileTextOutlined />, path: '/v3/orders' },
    { title: '解析规则', desc: '管理规则', icon: <DatabaseOutlined />, path: '/v3/rules' },
    { title: 'Trace 追踪', desc: '全链路事件', icon: <ApiOutlined />, path: '/v3/traces' },
  ];

  // 活跃任务列
  const activeColumns = [
    { title: '任务ID', dataIndex: 'id', key: 'id', width: 220, render: (v: string) => (
      <a onClick={() => router.push(`/v3/tasks/${v}`)}>{v.slice(0, 24)}...</a>
    ) },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100, render: (v: string) =>
      <Tag color={STATUS_COLORS[v]} icon={v === 'processing' ? <SyncOutlined spin /> : undefined}>{STATUS_LABELS[v] || v}</Tag> },
    { title: '进度', key: 'progress', width: 160, render: (_: any, r: any) => {
      const p = r.total_rows > 0 ? Math.round((r.processed_rows / r.total_rows) * 100) : 0;
      return <Progress percent={p} size="small" status={r.status === 'failed' ? 'exception' : 'normal'} />;
    }},
    { title: '成功', dataIndex: 'success_rows', key: 'success', width: 80, render: (v: number) =>
      <Text style={{ color: '#52c41a' }}>{v || 0}</Text> },
    { title: '失败', dataIndex: 'failed_rows', key: 'failed', width: 80, render: (v: number) =>
      <Text style={{ color: v ? '#ff4d4f' : undefined }}>{v || 0}</Text> },
  ];

  // 最近任务列
  const recentColumns = [
    { title: '任务ID', dataIndex: 'id', key: 'id', width: 220, render: (v: string) => (
      <a onClick={() => router.push(`/v3/tasks/${v}`)}>{v.slice(0, 24)}...</a>
    ) },
    { title: '文件名', dataIndex: 'file_name', key: 'file_name', ellipsis: true },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100, render: (v: string) =>
      <Tag color={STATUS_COLORS[v]}>{STATUS_LABELS[v] || v}</Tag> },
    { title: '进度', key: 'progress', width: 120, render: (_: any, r: any) => {
      const p = r.total_rows > 0 ? Math.round((r.processed_rows / r.total_rows) * 100) : 0;
      return `${r.processed_rows || 0}/${r.total_rows || 0} (${p}%)`;
    }},
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 180, render: (v: string) =>
      v ? new Date(v).toLocaleString('zh-CN') : '-' },
  ];

  return (
    <V3Layout breadcrumbItems={[{ title: '异步导入 V3' }, { title: '仪表盘' }]}>
      {/* 系统概览 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card><Statistic title="任务总数" value={summary?.total || 0} prefix={<ClockCircleOutlined />} /></Card>
        </Col>
        <Col span={4}>
          <Card><Statistic title="处理中" value={summary?.processing || 0} valueStyle={{ color: '#1677ff' }} prefix={<SyncOutlined spin />} /></Card>
        </Col>
        <Col span={4}>
          <Card><Statistic title="已完成" value={summary?.completed || 0} valueStyle={{ color: '#52c41a' }} prefix={<CheckCircleOutlined />} /></Card>
        </Col>
        <Col span={4}>
          <Card><Statistic title="部分成功" value={summary?.partial_success || 0} valueStyle={{ color: '#faad14' }} /></Card>
        </Col>
        <Col span={4}>
          <Card><Statistic title="失败" value={summary?.failed || 0} valueStyle={{ color: '#ff4d4f' }} prefix={<CloseCircleOutlined />} /></Card>
        </Col>
        <Col span={4}>
          <Card><Statistic title="平均耗时" value={summary?.avg_duration_ms || 0} suffix="ms" /></Card>
        </Col>
      </Row>

      {/* 数据统计 + 队列积压 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={5}><Card><Statistic title="总行数" value={summary?.total_rows || 0} /></Card></Col>
        <Col span={5}><Card><Statistic title="成功行数" value={summary?.success_rows || 0} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        <Col span={5}><Card><Statistic title="吞吐量" value={summary?.throughput_rows_per_sec || 0} suffix="行/秒" /></Card></Col>
        <Col span={5}><Card><Statistic title="积压事件" value={summary?.pending_outbox || 0} valueStyle={{ color: (summary?.pending_outbox || 0) > 0 ? '#faad14' : undefined }} /></Card></Col>
        <Col span={4}><Card><Statistic title="待处理批次" value={summary?.pending_batches || 0} valueStyle={{ color: (summary?.pending_batches || 0) > 0 ? '#faad14' : undefined }} /></Card></Col>
      </Row>

      {/* 阶段耗时分布 P50/P95/P99（考题模块八核心要求） */}
      {summary?.stage_metrics && (
        <Card title="阶段耗时分布 (P50 / P95 / P99)" size="small" style={{ marginBottom: 16 }}>
          <Table
            size="small"
            pagination={false}
            dataSource={[
              { key: 'parse', stage: '解析', ...summary.stage_metrics.parse_duration_ms },
              { key: 'rule', stage: '规则映射', ...summary.stage_metrics.rule_duration_ms },
              { key: 'validate', stage: '校验', ...summary.stage_metrics.validate_duration_ms },
              { key: 'insert', stage: '写入', ...summary.stage_metrics.insert_duration_ms },
              { key: 'total', stage: '总计', ...summary.stage_metrics.total_duration_ms },
            ]}
            columns={[
              { title: '阶段', dataIndex: 'stage', key: 'stage', width: 100 },
              { title: 'P50 (ms)', dataIndex: 'p50', key: 'p50', width: 100, render: (v: number) => v || '-' },
              { title: 'P95 (ms)', dataIndex: 'p95', key: 'p95', width: 100, render: (v: number) => v ? <Text type={v > 3000 ? 'danger' : undefined}>{v}</Text> : '-' },
              { title: 'P99 (ms)', dataIndex: 'p99', key: 'p99', width: 100, render: (v: number) => v ? <Text type={v > 5000 ? 'danger' : undefined}>{v}</Text> : '-' },
            ]}
          />
        </Card>
      )}

      {/* 错误类型分布（考题模块八核心要求） */}
      {summary?.error_distribution && Object.keys(summary.error_distribution).length > 0 && (
        <Card title="错误类型分布" size="small" style={{ marginBottom: 16 }}>
          <Row gutter={[8, 8]}>
            {Object.entries(summary.error_distribution).map(([code, count]) => (
              <Col span={3} key={code}>
                <Card size="small">
                  <Statistic title={code} value={count as number} valueStyle={{ fontSize: 20, color: (count as number) > 0 ? '#ff4d4f' : undefined }} />
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      )}

      {/* 快捷入口 */}
      <Card title="快捷入口" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 16]}>
          {quickLinks.map((l, i) => (
            <Col span={4} key={i} flex={Math.floor(24 / quickLinks.length)}>
              <Card hoverable size="small" onClick={() => router.push(l.path)}>
                <Space direction="vertical" align="center" style={{ width: '100%' }}>
                  <Text style={{ fontSize: 24, color: '#0fc6c2' }}>{l.icon}</Text>
                  <Text strong>{l.title}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{l.desc}</Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      {/* 活跃任务 */}
      <Card
        title="活跃任务"
        style={{ marginBottom: 16 }}
        extra={
          <Button
            type={autoRefresh ? 'primary' : 'default'}
            className="v2-btn"
            icon={<SyncOutlined spin={autoRefresh && loading} />}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? '自动刷新(5s)' : '已暂停'}
          </Button>
        }
      >
        {activeTasks.length === 0 ? (
          <Empty description="当前无活跃任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table columns={activeColumns} dataSource={activeTasks} rowKey="id" pagination={false} size="small" loading={loading} />
        )}
      </Card>

      {/* 最近任务 */}
      <Card title="最近任务" extra={<Button className="v2-btn" onClick={loadData} loading={loading}>刷新</Button>}>
        {recentTasks.length === 0 ? (
          <Empty description="暂无已完成任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table columns={recentColumns} dataSource={recentTasks} rowKey="id" pagination={false} size="small" />
        )}
      </Card>
    </V3Layout>
  );
}
