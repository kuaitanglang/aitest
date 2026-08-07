'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button, Table, Input, Select, message, Card, Tag, Space } from 'antd';
import { UploadOutlined, RestOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { supabase } from '@/lib/supabase';
import { OrderItem, SYSTEM_FIELDS, OrderItemField } from '@/types';
import Link from 'next/link';

export default function HistoryPage() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalOrders, setTotalOrders] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchField, setSearchField] = useState<OrderItemField | 'createdAt'>('externalCode');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    
    if (!supabase) {
      setLoading(false);
      return;
    }
    
    let query = supabase.from('orders').select('*', { count: 'exact' });
    
    if (startDate) query = query.gte('created_at', `${startDate}T00:00:00`);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59`);
    
    const { data, count } = await query.order('created_at', { ascending: false });
    
    if (data) {
      setOrders(data.map((d) => ({
        id: d.id,
        externalCode: d.external_code || '',
        senderName: d.sender_name || '',
        senderPhone: d.sender_phone || '',
        senderAddress: d.sender_address || '',
        receiverName: d.receiver_name || '',
        receiverPhone: d.receiver_phone || '',
        receiverAddress: d.receiver_address || '',
        weight: String(d.weight || ''),
        quantity: String(d.quantity || ''),
        temperature: d.temperature || '',
        remark: d.remark || '',
        createdAt: d.created_at,
        errors: [],
      })));
      setTotalOrders(count || 0);
    }
    setLoading(false);
  }, [startDate, endDate]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const filteredOrders = orders.filter((order) => {
    if (searchField === 'createdAt') {
      if (!searchTerm) return true;
      const createdAtStr = order.createdAt ? new Date(order.createdAt).toLocaleDateString('zh-CN') : '';
      return createdAtStr.includes(searchTerm);
    }
    const value = (order[searchField as OrderItemField] as string)?.toLowerCase() || '';
    return value.includes(searchTerm.toLowerCase());
  });

  const columns = SYSTEM_FIELDS.map((field) => ({
    title: field.label,
    dataIndex: field.key,
    key: field.key,
    render: (text: string) => text || '-',
  }));

  const listColumns = [
    { title: '序号', key: 'index', width: 60, render: (_: any, __: OrderItem, index: number) => (currentPage - 1) * 10 + index + 1 },
    ...columns,
    { title: '创建时间', key: 'createdAt', render: (_: unknown, record: OrderItem) => record.createdAt ? new Date(record.createdAt).toLocaleString('zh-CN') : '-' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <Card className="mx-4 mt-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button icon={<ArrowLeftOutlined />}>首页</Button>
            </Link>
            <Link href="/upload">
              <Button icon={<UploadOutlined />} type="primary">导入订单</Button>
            </Link>
            <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-teal-600 rounded-xl flex items-center justify-center">
              <RestOutlined className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-green-600 to-teal-600 bg-clip-text text-transparent">
                订单历史记录
              </h1>
              <p className="text-xs text-gray-500">查看所有已导入的订单记录</p>
            </div>
          </div>
          <Tag color="blue">{totalOrders} 条记录</Tag>
        </div>
      </Card>

      <div className="mx-4 mt-4 mb-8">
        <Card bordered={false}>
          <div className="flex flex-wrap items-center justify-between mb-4 gap-4">
            <Space wrap>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="开始日期" style={{ width: 150 }} />
              <span>至</span>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="结束日期" style={{ width: 150 }} />
              <Select value={searchField} onChange={(value) => setSearchField(value as OrderItemField | 'createdAt')} style={{ width: 150 }} options={[
                { value: 'externalCode', label: '外部编码' },
                { value: 'receiverName', label: '收件人姓名' },
                { value: 'senderName', label: '发件人姓名' },
                { value: 'createdAt', label: '创建时间' },
              ]} />
              <Input placeholder="搜索..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} style={{ width: 200 }} />
              <Button icon={<RestOutlined />} onClick={fetchOrders} loading={loading}>刷新</Button>
            </Space>
          </div>

          <Table columns={listColumns} dataSource={filteredOrders} loading={loading} pagination={{
            current: currentPage, pageSize: 10, total: totalOrders, onChange: setCurrentPage,
            showTotal: (total) => `共 ${total} 条记录`,
          }} bordered scroll={{ x: 'max-content' }} rowKey="id" size="small" />
        </Card>
      </div>

      <div className="mx-4 mb-8">
        <Card className="bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200" bordered={false}>
          <div className="text-center py-4">
            <h3 className="text-lg font-semibold mb-2">需要导入新的订单？</h3>
            <p className="text-gray-600 mb-4">支持多种Excel模板格式，自动识别列映射，智能校验数据</p>
            <Link href="/upload"><Button type="primary" size="large" icon={<UploadOutlined />}>前往导入页面</Button></Link>
          </div>
        </Card>
      </div>
    </div>
  );
}