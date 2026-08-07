'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Progress, Tag, Table, Button, Alert, Typography, Row, Col, message, Statistic } from 'antd';
import { ArrowLeftOutlined, DownloadOutlined, ReloadOutlined, ClockCircleOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
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
const ERROR_LABELS: Record<string, string> = {
  E001: 'SKU 不存在', E002: '必填字段缺失', E003: '电话格式错误', E004: '数量无效',
  E005: '外部编码重复', E006: '规则映射失败', E007: '数据库写入失败', E008: '文件格式不支持',
};

export default function TaskDetailPage({ params }: { params: { taskId: string } }) {
  const router = useRouter();
  const [task, setTask] = useState<any>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // 单独刷新批次数据（任务完成后用户可手动触发）
  async function refreshBatches() {
    setRefreshing(true);
    try {
      const batchResp = await fetch(`/api/v3/import-tasks/${params.taskId}/batches`).then(r => r.json());
      if (batchResp.ok) setBatches(batchResp.batches || []);
    } catch (err) {
      console.error('刷新批次失败:', err);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    let timer: NodeJS.Timeout;

    async function poll() {
      try {
        const [taskResp, batchResp] = await Promise.all([
          fetch(`/api/v3/import-tasks/${params.taskId}`).then(r => r.json()),
          fetch(`/api/v3/import-tasks/${params.taskId}/batches`).then(r => r.json()),
        ]);
        if (!mounted) return;
        // 先设置批次数据（无论任务是否完成都要渲染批次明细）
        if (batchResp.ok) setBatches(batchResp.batches || []);
        if (taskResp.ok) {
          setTask(taskResp.task);
          // 任务已完成则停止轮询，但再等 1 秒做最后一次批次刷新（确保拿到最新数据）
          if (['completed', 'partial_success', 'failed'].includes(taskResp.task?.status)) {
            setLoading(false);
            // 延迟 1 秒后再刷新一次批次（Worker 可能在任务标记完成后才写入最后几条性能日志）
            setTimeout(() => { if (mounted) refreshBatches(); }, 1000);
            return;
          }
        }
      } catch (err) {
        console.error('轮询失败:', err);
      }
      timer = setTimeout(poll, 2000);
    }
    poll();
    return () => { mounted = false; clearTimeout(timer); };
  }, [params.taskId]);

  if (!task) {
    return (
      <V3Layout breadcrumbItems={[{ title: '异步导入 V3' }, { title: '加载中...' }]}>
        <Card className="v2-card"><Text type="secondary">加载任务数据...</Text></Card>
      </V3Layout>
    );
  }

  const progress = task.total_rows > 0 ? Math.round((task.processed_rows / task.total_rows) * 100) : 0;

  // 吞吐量 = total_rows / 处理耗时（秒），任务完成后才有意义
  const durationSec = task.created_at && task.completed_at
    ? (new Date(task.completed_at).getTime() - new Date(task.created_at).getTime()) / 1000
    : 0;
  const throughput = durationSec > 0 ? Math.round(task.total_rows / durationSec) : 0;

  const batchColumns = [
    { title: '批次', dataIndex: 'batch_index', key: 'batch_index', render: (v: number) => `#${v + 1}`, width: 60 },
    { title: '单元ID', dataIndex: 'unit_id', key: 'unit_id', width: 100 },
    { title: '行范围', key: 'rows', render: (_: any, r: any) => `${r.start_row} - ${r.end_row}`, width: 90 },
    { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (s: string) => <Tag color={STATUS_COLORS[s]}>{STATUS_LABELS[s] || s}</Tag> },
    { title: '解析(ms)', dataIndex: 'parse_duration_ms', key: 'parse', width: 80, render: (v: number) => v || '-' },
    { title: '规则(ms)', dataIndex: 'rule_duration_ms', key: 'rule', width: 80, render: (v: number) => v || '-' },
    { title: '校验(ms)', dataIndex: 'validate_duration_ms', key: 'validate', width: 80, render: (v: number) => v || '-' },
    { title: '写入(ms)', dataIndex: 'insert_duration_ms', key: 'insert', width: 80, render: (v: number) => v || '-' },
    { title: '总耗时(ms)', dataIndex: 'total_duration_ms', key: 'total', width: 100, render: (v: number) => v ? <Text strong>{v}</Text> : '-' },
    { title: '成功/失败', key: 'result', width: 90, render: (_: any, r: any) => `${r.rows_success || 0}/${r.rows_failed || 0}` },
  ];

  return (
    <V3Layout breadcrumbItems={[{ title: '异步导入 V3' }, { title: '任务详情' }, { title: params.taskId.slice(0, 20) + '...' }]}>
      <div style={{ marginBottom: 16 }}>
        <Button className="v2-btn" icon={<ArrowLeftOutlined />} onClick={() => router.push('/v3')}>返回导入</Button>
      </div>

      {/* 任务信息 */}
      <Card className="v2-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>task_id</Text>
            <br />
            <Text copyable code style={{ fontSize: 13 }}>{task.id}</Text>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>trace_id</Text>
            <br />
            <Text copyable code style={{ fontSize: 13 }}>{task.trace_id}</Text>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>文件名</Text>
            <br />
            <Text style={{ fontSize: 13 }}>{task.file_name}</Text>
          </div>
        </div>
      </Card>

      {/* 降级告警 */}
      {task.degraded && (
        <Alert
          message="SKU 校验已降级"
          description="本次导入未经过商品主数据完整校验，数据可能需要后续复核。"
          type="warning"
          showIcon
          className="v2-alert"
        />
      )}

      {/* 统计卡片 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16, marginTop: task.degraded ? 16 : 0 }}>
        <Col span={5}>
          <Card className="v3-stat-card">
            <Statistic
              title="状态"
              value={STATUS_LABELS[task.status] || task.status}
              valueStyle={{ color: task.status === 'completed' ? '#52c41a' : task.status === 'failed' ? '#ff4d4f' : '#1677ff', fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card className="v3-stat-card">
            <Statistic title="总行数" value={task.total_rows} />
          </Card>
        </Col>
        <Col span={5}>
          <Card className="v3-stat-card">
            <div><Text type="secondary" style={{ fontSize: 12 }}>成功行数</Text></div>
            <Text strong style={{ fontSize: 24, color: '#52c41a' }}>{task.success_rows}</Text>
            <CheckCircleOutlined style={{ color: '#52c41a', marginLeft: 8 }} />
          </Card>
        </Col>
        <Col span={5}>
          <Card className="v3-stat-card">
            <div><Text type="secondary" style={{ fontSize: 12 }}>失败行数</Text></div>
            <Text strong style={{ fontSize: 24, color: task.failed_rows > 0 ? '#ff4d4f' : '#8c8c8c' }}>{task.failed_rows}</Text>
            {task.failed_rows > 0 && <CloseCircleOutlined style={{ color: '#ff4d4f', marginLeft: 8 }} />}
          </Card>
        </Col>
        <Col span={4}>
          <Card className="v3-stat-card">
            <div><Text type="secondary" style={{ fontSize: 12 }}>吞吐</Text></div>
            <Text strong style={{ fontSize: 24 }}>{throughput}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}> 行/s</Text>
          </Card>
        </Col>
      </Row>

      {/* 进度条 */}
      <Card className="v2-card" style={{ marginBottom: 16 }}>
        <div className="v2-section-header">处理进度</div>
        <Progress
          percent={progress}
          status={task.status === 'failed' ? 'exception' : task.status === 'completed' || task.status === 'partial_success' ? 'success' : 'active'}
          strokeColor={{ '0%': '#0fc6c2', '100%': '#0bb5ae' }}
        />
        <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: 13 }}>
          <Text type="secondary">已处理 {task.processed_rows} / {task.total_rows} 行</Text>
          <Text type="secondary">批次 {task.completed_batches} / {task.total_batches}</Text>
          {task.eta_sec > 0 && task.status === 'processing' && (
            <Text type="secondary"><ClockCircleOutlined /> 预计剩余 {task.eta_sec}s</Text>
          )}
        </div>
      </Card>

      {/* 错误概览 */}
      {task.failed_rows > 0 && (
        <Card className="v2-card" title={<span className="v2-section-header">错误概览</span>} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {Object.entries(task.error_summary || {}).map(([code, count]) => (
              <Tag key={code} color="red" style={{ fontSize: 13 }}>
                {ERROR_LABELS[code] || code}: {count as number}
              </Tag>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button className="v2-btn" size="small" onClick={() => router.push(`/v3/tasks/${params.taskId}/errors`)}>
              查看错误明细
            </Button>
            <Button className="v2-btn" size="small" icon={<DownloadOutlined />} onClick={() => downloadErrors(params.taskId)}>
              导出 CSV
            </Button>
          </div>
        </Card>
      )}

      {/* 批次性能明细 */}
      <Card className="v2-card" title={<span className="v2-section-header">批次性能明细</span>} style={{ marginBottom: 16 }}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={refreshBatches} loading={refreshing}>刷新</Button>}
      >
        <Table
          className="v2-table"
          dataSource={batches}
          columns={batchColumns}
          rowKey="unit_id"
          size="small"
          pagination={false}
          scroll={{ x: 850 }}
        />
      </Card>

      {/* 链路追踪 */}
      <Card className="v2-card" size="small">
        <Button type="link" onClick={() => router.push(`/v3/traces?trace_id=${task.trace_id}`)}>
          查看完整链路时间线 →
        </Button>
      </Card>
    </V3Layout>
  );

  async function downloadErrors(taskId: string) {
    try {
      const resp = await fetch(`/api/v3/import-tasks/${taskId}/errors?page_size=10000`);
      const data = await resp.json();
      if (data.errors) {
        const headers = ['行号', '批次', '错误码', '错误原因', '字段', '原始值'];
        const rows = data.errors.map((e: any) => [e.row_number, e.batch_index, e.error_code, e.error_reason, e.field_name, e.raw_value]);
        const csv = [headers, ...rows].map(r => r.map((c: any) => `"${c}"`).join(',')).join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `errors_${taskId}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      message.error('导出失败');
    }
  }
}
