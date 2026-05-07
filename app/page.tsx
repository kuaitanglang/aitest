'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, Button, Table, Input, Select, message, Modal, Progress, Card, Tag, Space, Tabs, Alert, Tooltip } from 'antd';
import { UploadOutlined, PlusOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, SendOutlined, RestOutlined, CheckOutlined, WarningOutlined } from '@ant-design/icons';
import { parseExcelFile, autoDetectMappings, findMatchingTemplate, saveTemplateRule, convertToOrderItems, validateOrderItem, exportToExcel, findDuplicateExternalCodes, checkDuplicatesInDatabase, applyDuplicateValidation, checkSingleExternalCodeExists } from '@/lib/excel';
import { supabase } from '@/lib/supabase';
import { OrderItem, ColumnMapping, SYSTEM_FIELDS, REQUIRED_FIELDS, TEMPERATURE_OPTIONS, OrderItemField } from '@/types';
import type { UploadProps } from 'antd';

export default function Home() {
  const [activeTab, setActiveTab] = useState('upload');
  
  const [items, setItems] = useState<OrderItem[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [showMappingConfig, setShowMappingConfig] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [importProgress, setImportProgress] = useState({ progress: 0, current: 0, total: 0 });
  const [isImporting, setIsImporting] = useState(false);
  const editingCellRef = useRef<any>(null);

  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalOrders, setTotalOrders] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchField, setSearchField] = useState<OrderItemField | 'createdAt'>('externalCode');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'history') {
      fetchOrders();
    }
  }, [activeTab, currentPage, searchTerm, searchField, startDate, endDate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Tab' || e.key === 'Enter') && activeTab === 'upload') {
        e.preventDefault();
        if (editingCellRef.current) {
          const form = editingCellRef.current.closest('form');
          if (form) {
            const inputs = form.querySelectorAll('input:not([type="hidden"]), select');
            const currentIndex = Array.from(inputs).indexOf(editingCellRef.current);
            const nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
            if (nextIndex >= 0 && nextIndex < inputs.length) {
              (inputs[nextIndex] as HTMLInputElement).focus();
              (inputs[nextIndex] as HTMLInputElement).select();
            }
          }
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeTab]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    
    try {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        pageSize: '10',
        ...(searchTerm && { search: searchTerm, searchField }),
        ...(startDate && { startDate }),
        ...(endDate && { endDate }),
      });

      const response = await fetch(`/api/orders/list?${params}`);
      const result = await response.json();

      if (response.ok && result.success) {
        setOrders(result.data.list);
        setTotalOrders(result.data.pagination.total);
      } else {
        console.error('Fetch orders error:', result.error);
        message.error('获取历史记录失败');
      }
    } catch (error) {
      console.error('Fetch orders error:', error);
      message.error('网络错误');
    }
    
    setLoading(false);
  }, [currentPage, searchTerm, searchField, startDate, endDate]);

  const handleFileSelect = useCallback(async (file: File) => {
    setIsImporting(true);
    setImportProgress({ progress: 0, current: 0, total: 100 });

    try {
      setImportProgress({ progress: 20, current: 1, total: 5 });
      const { headers: excelHeaders, data } = await parseExcelFile(file);
      setHeaders(excelHeaders);

      setImportProgress({ progress: 40, current: 2, total: 5 });
      const existingTemplate = findMatchingTemplate(excelHeaders);
      
      let detectedMappings: ColumnMapping[];
      if (existingTemplate) {
        detectedMappings = existingTemplate.mappings;
        message.success({
          content: `已自动应用保存的模板映射（${detectedMappings.length}个字段）`,
          duration: 3,
        });
      } else {
        detectedMappings = autoDetectMappings(excelHeaders);
        
        const matchedCount = detectedMappings.length;
        const totalCount = excelHeaders.filter(h => h).length;
        
        if (matchedCount === totalCount) {
          message.success({
            content: `✅ 完美匹配！所有 ${totalCount} 个字段已自动识别`,
            duration: 4,
          });
        } else if (matchedCount >= totalCount * 0.7) {
          message.info({
            content: `📊 已识别 ${matchedCount}/${totalCount} 个字段，部分字段可能需要手动调整`,
            duration: 5,
          });
        } else if (matchedCount > 0) {
          message.warning({
            content: `⚠️ 仅识别 ${matchedCount}/${totalCount} 个字段，建议点击"列映射配置"调整`,
            duration: 5,
          });
        } else {
          message.error({
            content: '❌ 未识别到任何字段，请点击"列映射配置"手动设置',
            duration: 5,
          });
        }
      }
      setMappings(detectedMappings);

      setImportProgress({ progress: 60, current: 3, total: 5 });
      const orderItems = convertToOrderItems(data, detectedMappings);
      
      setImportProgress({ progress: 80, current: 4, total: 5 });
      const externalCodes = orderItems.map(item => item.externalCode.trim()).filter(Boolean);
      const dbDuplicates = await checkDuplicatesInDatabase(externalCodes);

      const validatedItems = applyDuplicateValidation(orderItems, dbDuplicates);

      setItems(validatedItems);
      setImportProgress({ progress: 100, current: 5, total: 5 });
    } catch (error) {
      message.error(`文件解析失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsImporting(false);
    }
  }, []);

  const handleMappingConfig = useCallback(() => setShowMappingConfig(true), []);

  const handleMappingConfirm = useCallback((newMappings: ColumnMapping[]) => {
    setMappings(newMappings);
    saveTemplateRule(newMappings);
    message.success('映射配置已保存');
    
    const reMappedItems = convertToOrderItems(
      items.map((item) => {
        const row: Record<string, string>[] = [];
        newMappings.forEach((mapping) => row.push({ [mapping.excelColumn]: (item[mapping.systemField] as string) || '' }));
        return row;
      }),
      newMappings
    );
    
    setItems(reMappedItems);
    setShowMappingConfig(false);
  }, [items]);

  const handleExport = useCallback(() => {
    const blob = exportToExcel(items);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `运单数据_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('导出成功');
  }, [items]);

  const handleSubmit = useCallback(async () => {
    if (items.length === 0) {
      message.warning('请先导入数据');
      return;
    }

    const validItems = items.filter((item) => item.errors.length === 0);
    const invalidCount = items.length - validItems.length;

    if (invalidCount > 0) {
      const errorDetails = items.filter(i => i.errors.length > 0).map((item, idx) =>
        `第${idx + 1}行: ${item.errors.map(e => `${SYSTEM_FIELDS.find(f => f.key === e.field)?.label}${e.message}`).join('; ')}`
      ).join('\n');

      Modal.error({
        title: `有 ${invalidCount} 条数据存在错误`,
        content: (
          <div style={{ maxHeight: '300px', overflowY: 'auto', fontSize: '13px' }}>
            <pre>{errorDetails}</pre>
          </div>
        ),
        width: 600,
      });
      return;
    }

    setIsImporting(true);
    setImportProgress({ progress: 10, current: 0, total: validItems.length });

    try {
      const externalCodes = validItems.map(item => item.externalCode).filter(code => code && code.trim());

      if (externalCodes.length > 0) {
        setImportProgress({ progress: 20, current: 1, total: validItems.length });
        const dbDuplicates = await checkDuplicatesInDatabase(externalCodes);

        if (dbDuplicates.size > 0) {
          const duplicateItems = validItems.filter(item =>
            item.externalCode && dbDuplicates.has(item.externalCode.trim())
          );

          if (duplicateItems.length > 0) {
            const duplicateDetails = duplicateItems.map(item =>
              `外部编码 "${item.externalCode}" 已存在于数据库中`
            ).join('\n');

            Modal.error({
              title: `有 ${duplicateItems.length} 条数据的外部编码已存在于数据库`,
              content: (
                <div style={{ maxHeight: '300px', overflowY: 'auto', fontSize: '13px' }}>
                  <p className="mb-2">以下外部编码重复，请修改后重新提交：</p>
                  <pre>{duplicateDetails}</pre>
                </div>
              ),
              width: 600,
            });

            const updatedItems = items.map(item => {
              if (item.externalCode && dbDuplicates.has(item.externalCode.trim())) {
                const hasDbError = item.errors.some(e =>
                  e.field === 'externalCode' && e.message.includes('数据库')
                );
                if (!hasDbError) {
                  return {
                    ...item,
                    errors: [
                      ...item.errors,
                      { field: 'externalCode', message: '外部编码已存在于数据库中' },
                    ],
                  };
                }
              }
              return item;
            });

            setItems(updatedItems);
            setIsImporting(false);
            return;
          }
        }
      }

      setImportProgress({ progress: 40, current: 2, total: validItems.length });

      const response = await fetch('/api/orders/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: validItems }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        message.error(result.error || '提交失败');
        setIsImporting(false);
        return;
      }

      const { success, failed } = result.data;

      setImportProgress({ progress: 100, current: validItems.length, total: validItems.length });
      setIsImporting(false);
      setShowPreview(false);
      setItems([]);

      if (failed === 0) {
        message.success(`✅ 成功提交 ${success} 条订单`);
      } else {
        message.warning(`⚠️ 提交完成：${success} 条成功，${failed} 条失败`);
      }

      fetchOrders();
    } catch (error) {
      console.error('Submit error:', error);
      message.error('提交失败，请检查网络连接');
      setIsImporting(false);
    }
  }, [items, fetchOrders]);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleCellChange = (rowIndex: number, field: OrderItemField, value: string) => {
    const newItems = [...items];
    const updatedItem = { ...newItems[rowIndex], [field]: value, errors: validateOrderItem({ ...newItems[rowIndex], [field]: value }) };
    newItems[rowIndex] = updatedItem;

    let validatedItems = applyDuplicateValidation(newItems);

    if (field === 'externalCode' && value && value.trim()) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(async () => {
        const exists = await checkSingleExternalCodeExists(value);
        if (exists) {
          validatedItems = validatedItems.map((item, idx) =>
            idx === rowIndex
              ? {
                  ...item,
                  errors: [
                    ...item.errors.filter(e => e.field !== 'externalCode' || !e.message.includes('数据库')),
                    { field: 'externalCode', message: '外部编码已存在于数据库中' },
                  ],
                }
              : item
          );
          setItems(validatedItems);
        } else {
          const filteredErrors = validatedItems.map((item, idx) =>
            idx === rowIndex
              ? { ...item, errors: item.errors.filter(e => !(e.field === 'externalCode' && e.message.includes('数据库'))) }
              : item
          );
          setItems(filteredErrors);
        }
      }, 500);
    }

    setItems(validatedItems);
  };

  const handleAddRow = () => {
    const newItem: OrderItem = { id: `row_${Date.now()}`, externalCode: '', senderName: '', senderPhone: '', senderAddress: '', receiverName: '', receiverPhone: '', receiverAddress: '', weight: '', quantity: '', temperature: '', remark: '', errors: [] };
    setItems([...items, newItem]);
  };

  const handleDeleteRow = (rowIndex: number) => setItems(items.filter((_, i) => i !== rowIndex));

  const fileProps: UploadProps = {
    accept: '.xlsx,.xls',
    maxCount: 1,
    beforeUpload: (file) => { handleFileSelect(file); return false; },
    showUploadList: false,
    disabled: isImporting,
  };

  const hasErrors = items.some((item) => item.errors.length > 0);
  const allErrors = items.flatMap((item, index) => item.errors.map((error) => ({ row: index + 1, field: SYSTEM_FIELDS.find((f) => f.key === error.field)?.label, message: error.message })));
  const errorCount = allErrors.length;

  const columns = SYSTEM_FIELDS.map((field) => ({
    title: (<span>{field.label}{REQUIRED_FIELDS.includes(field.key) && <span className="ml-1 text-red-500">*</span>}</span>),
    dataIndex: field.key,
    key: field.key,
    width: field.key === 'senderAddress' || field.key === 'receiverAddress' ? 200 : 150,
    render: (text: string, record: OrderItem) => {
      const error = record.errors?.find((e) => e.field === field.key);
      return <div className={`${error ? 'text-red-600 bg-red-50 px-2 py-1 rounded' : ''}`}>{text || '-'}</div>;
    },
  }));

  const previewColumns = [
    { title: '#', key: 'index', width: 50, fixed: 'left' as const, render: (_: any, __: OrderItem, index: number) => index + 1 },
    { title: '操作', key: 'action', width: 60, fixed: 'left' as const, render: (_: any, __: OrderItem, rowIndex: number) => <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDeleteRow(rowIndex)} /> },
    ...columns.map((col) => ({
      ...col,
      render: (text: string, record: OrderItem, rowIndex: number) => {
        const error = record.errors?.find((e) => e.field === col.key);
        
        const errorStyle = error ? {
          borderColor: '#ff4d4f',
          backgroundColor: '#fff1f0',
          boxShadow: '0 0 0 2px rgba(255, 77, 79, 0.1)',
        } : {};
        
        if (col.key === 'temperature') {
          return (
            <Tooltip title={error?.message} placement="topLeft" overlayStyle={{ maxWidth: 300 }}>
              <Select
                size="small"
                value={text}
                onChange={(value) => handleCellChange(rowIndex, col.key as OrderItemField, value)}
                style={{ width: '100%', ...errorStyle }}
                status={error ? 'error' : undefined}
                options={[{ value: '', label: '请选择' }, ...TEMPERATURE_OPTIONS.map((opt) => ({ value: opt, label: opt }))]}
              />
            </Tooltip>
          );
        }

        return (
          <Tooltip title={error?.message} placement="topLeft" overlayStyle={{ maxWidth: 300 }}>
            <Input
              ref={editingCellRef}
              size="small"
              value={text}
              onChange={(e) => handleCellChange(rowIndex, col.key as OrderItemField, e.target.value)}
              onPressEnter={() => {}}
              status={error ? 'error' : undefined}
              style={errorStyle}
            />
          </Tooltip>
        );
      },
    })),
  ];

  const listColumns = [
    { title: '#', key: 'index', width: 50, render: (_: any, __: OrderItem, index: number) => (currentPage - 1) * 10 + index + 1 },
    ...columns.map(col => ({ ...col, render: (text: string) => text || '-' })),
    { title: '创建时间', key: 'createdAt', width: 160, render: (_: unknown, record: OrderItem) => record.createdAt ? new Date(record.createdAt).toLocaleString('zh-CN') : '-' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Card className="mt-4 mx-0" bodyStyle={{ padding: '16px 24px' }}>
        <h1 className="text-lg font-semibold m-0">订单导入系统</h1>
      </Card>

      <div className="px-4 mt-4 mb-8">
        <Tabs activeKey={activeTab} onChange={(key) => setActiveTab(key)} type="card" size="large" centered>
          <Tabs.TabPane tab={<span><UploadOutlined /> 导入</span>} key="upload">
            <Space direction="vertical" size="middle" className="w-full" style={{ display: 'flex', width: '100%' }}>
              <Card className="w-full">
                <Upload.Dragger {...fileProps} className="w-full">
                  <p className="ant-upload-drag-icon"><UploadOutlined /></p>
                  <p className="ant-upload-text">点击或拖拽上传 Excel 文件</p>
                  <p className="ant-upload-hint">支持 .xlsx / .xls 格式 · 可重复导入覆盖</p>
                </Upload.Dragger>

                {isImporting && <Progress percent={importProgress.progress} status="active" className="mt-4" />}
              </Card>

              {items.length > 0 && (
                <Card className="w-full" title={
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span>导入结果（{items.length} 条）{errorCount > 0 && <Tag color="error" className="ml-2">{errorCount} 个错误</Tag>}</span>
                    <Space wrap>
                      <Button icon={<EditOutlined />} onClick={handleMappingConfig} size="small">列映射配置</Button>
                      <Button icon={<PlusOutlined />} onClick={handleAddRow} size="small">新增行</Button>
                      <Button icon={<DownloadOutlined />} onClick={handleExport} size="small">导出</Button>
                    </Space>
                  </div>
                }>
                  {hasErrors && (
                    <Alert
                      message={`检测到 ${errorCount} 个错误，请修正后再提交`}
                      description={
                        <div className="max-h-32 overflow-y-auto text-sm mt-2">
                          {allErrors.slice(0, 20).map((error, index) => (
                            <div key={index}>{index + 1}. 第{error.row}行 {error.field}: {error.message}</div>
                          ))}
                          {errorCount > 20 && <div className="text-gray-400 mt-1">... 还有 {errorCount - 20} 个错误</div>}
                        </div>
                      }
                      type="error"
                      showIcon
                      closable
                      className="mb-4"
                    />
                  )}

                  {/* 字段映射概览 */}
                  {mappings.length > 0 && (
                    <Alert
                      message={`字段映射结果：已识别 ${mappings.length} 个字段${headers.filter(h => h).length > mappings.length ? `（未识别: ${headers.filter(h => h).length - mappings.length} 个）` : ''}`}
                      description={
                        <div className="mt-2 flex flex-wrap gap-2">
                          {mappings.map((mapping, index) => {
                            const fieldInfo = SYSTEM_FIELDS.find(f => f.key === mapping.systemField);
                            return (
                              <Tag 
                                key={index} 
                                color={REQUIRED_FIELDS.includes(mapping.systemField as OrderItemField) ? 'blue' : 'default'}
                              >
                                {mapping.excelColumn} → {fieldInfo?.label || mapping.systemField}
                              </Tag>
                            );
                          })}
                        </div>
                      }
                      type="info"
                      showIcon
                      closable
                      className="mb-4"
                    />
                  )}

                  <Table
                    columns={previewColumns}
                    dataSource={items}
                    pagination={false}
                    bordered
                    scroll={{ x: 'max-content', y: window.innerHeight - 420 }}
                    rowKey="id"
                    size="small"
                    rowClassName={(record) => record.errors && record.errors.length > 0 ? 'error-row' : ''}
                  />

                  <div className="mt-4 flex justify-end">
                    <Button
                      type="primary"
                      icon={<SendOutlined />}
                      onClick={handleSubmit}
                      disabled={isImporting || hasErrors}
                      loading={isImporting}
                      size="large"
                    >
                      提交下单（{items.filter(i => i.errors.length === 0).length}/{items.length}）
                    </Button>
                  </div>

                  {isImporting && <Progress percent={importProgress.progress} status="active" className="mt-4" />}
                </Card>
              )}
            </Space>
          </Tabs.TabPane>

          <Tabs.TabPane tab={<span><RestOutlined /> 历史记录</span>} key="history">
            <Card className="w-full">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setCurrentPage(1); }} placeholder="开始日期" style={{ width: 140 }} size="small" />
                <span>-</span>
                <Input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setCurrentPage(1); }} placeholder="结束日期" style={{ width: 140 }} size="small" />
                <Select value={searchField} onChange={(value) => { setSearchField(value as OrderItemField | 'createdAt'); setCurrentPage(1); }} style={{ width: 120 }} size="small" options={[
                  { value: 'externalCode', label: '外部编码' },
                  { value: 'receiverName', label: '收件人' },
                  { value: 'senderName', label: '发件人' },
                  { value: 'createdAt', label: '创建时间' },
                ]} />
                <Input.Search placeholder="搜索" value={searchTerm} onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }} onSearch={() => fetchOrders()} style={{ width: 200 }} size="small" allowClear />
                <Button icon={<RestOutlined />} onClick={() => { setCurrentPage(1); fetchOrders(); }} loading={loading} size="small">刷新</Button>
              </div>

              <Table columns={listColumns} dataSource={orders} loading={loading} pagination={{
                current: currentPage, pageSize: 10, total: totalOrders, onChange: (page) => { setCurrentPage(page); }, showTotal: (total) => `共 ${total} 条`, showSizeChanger: false
              }} bordered scroll={{ x: 'max-content' }} rowKey="id" size="small" className="w-full" />
            </Card>
          </Tabs.TabPane>
        </Tabs>
      </div>

      <Modal title="列映射配置" open={showMappingConfig} onCancel={() => setShowMappingConfig(false)} footer={[
        <Button key="back" onClick={() => setShowMappingConfig(false)}>取消</Button>,
        <Button key="submit" type="primary" onClick={() => handleMappingConfirm(mappings)}>保存并确认</Button>,
      ]} width={800} destroyOnClose>
        <Alert message="调整 Excel 列与系统字段的对应关系，修改后点击保存" type="info" showIcon className="mb-4" />
        <Table 
          dataSource={headers.map((header, index) => ({
            key: index,
            excelColumn: header || '(空)',
            systemField: mappings.find((m) => m.excelColumn === header)?.systemField || ''
          }))} 
          columns={[
            { title: 'Excel 列名', dataIndex: 'excelColumn', key: 'excelColumn', render: (text: string) => <span className="font-medium">{text}</span> },
            { 
              title: '系统字段', 
              dataIndex: 'systemField', 
              key: 'systemField',
              render: (value: string, record: any) => (
                <Select
                  size="small"
                  value={value}
                  onChange={(val) => {
                    const newMappings = mappings.filter((m) => m.excelColumn !== record.excelColumn);
                    if (val) newMappings.push({ excelColumn: record.excelColumn, systemField: val as OrderItemField });
                    setMappings(newMappings);
                  }}
                  style={{ width: '100%' }}
                  allowClear
                  placeholder="请选择"
                  options={SYSTEM_FIELDS.map((f) => ({ value: f.key, label: `${f.label}${REQUIRED_FIELDS.includes(f.key) ? ' *' : ''}` }))}
                />
              )
            },
          ]}
          pagination={false}
          size="small"
          bordered
        />
      </Modal>
    </div>
  );
}