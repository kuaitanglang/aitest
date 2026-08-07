'use client';

/**
 * V3 订单记录
 * 分页查看已导入的订单（v2_order_items 表）
 *
 * 使用公开 anon key 的 supabase 客户端查询（客户端组件标准做法）
 */
import { useState, useEffect, useCallback } from 'react';
import { Card, Table, Input, Button, Space, Typography, Tag } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { createClient } from '@supabase/supabase-js';
import V3Layout from '@/v3/components/V3Layout';

const { Text } = Typography;

// 客户端 supabase（用 anon key，受 RLS 保护）
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export default function V3OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');

  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    try {
      const from = (page - 1) * pageSize;
      const to = page * pageSize - 1;

      let query = supabase
        .from('v2_order_items')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (searchKeyword.trim()) {
        // 关键字搜 external_code / sku_code / receiver_name
        const kw = searchKeyword.trim();
        query = query.or(`external_code.ilike.%${kw}%,sku_code.ilike.%${kw}%,receiver_name.ilike.%${kw}%`);
      }

      const { data, count, error } = await query;
      if (error) {
        console.error('查询失败:', error.message);
      } else {
        setOrders(data || []);
        setTotal(count || 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, searchKeyword]);

  useEffect(() => { load(); }, [load]);

  const columns = [
    { title: '外部编码', dataIndex: 'external_code', key: 'external_code', width: 180 },
    { title: 'SKU', dataIndex: 'sku_code', key: 'sku_code', width: 120 },
    { title: '数量', dataIndex: 'sku_quantity', key: 'qty', width: 80, render: (v: any) =>
      <Tag color={Number(v) > 0 ? 'blue' : 'red'}>{v}</Tag> },
    { title: '收件人', dataIndex: 'receiver_name', key: 'receiver', width: 100 },
    { title: '电话', dataIndex: 'receiver_phone', key: 'phone', width: 130 },
    { title: '地址', dataIndex: 'receiver_address', key: 'addr', ellipsis: true },
    { title: '创建时间', dataIndex: 'created_at', key: 'time', width: 170, render: (v: string) =>
      v ? new Date(v).toLocaleString('zh-CN') : '-' },
  ];

  return (
    <V3Layout breadcrumbItems={[{ title: '异步导入 V3' }, { title: '订单记录' }]}>
      <Card
        title="已导入订单"
        extra={
          <Space>
            <Input
              placeholder="搜索 编码/SKU/收件人"
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                // 清空时立即触发搜索
                if (e.target.value === '' && searchKeyword) {
                  setSearchKeyword('');
                  setPage(1);
                }
              }}
              onPressEnter={() => { setPage(1); setSearchKeyword(keyword); }}
              style={{ width: 240 }}
              allowClear
              prefix={<SearchOutlined />}
            />
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          </Space>
        }
      >
        {!supabase ? (
          <Text type="secondary">Supabase 未配置，无法查询订单记录</Text>
        ) : (
          <Table
            columns={columns}
            dataSource={orders}
            rowKey="id"
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
        )}
      </Card>
    </V3Layout>
  );
}
