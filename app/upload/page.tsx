'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, Button, Table, Input, Select, message, Modal, Progress, Card, Tag, Space } from 'antd';
import { UploadOutlined, PlusOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, ArrowLeftOutlined, SendOutlined, CheckOutlined, WarningOutlined } from '@ant-design/icons';
import { parseExcelFile, autoDetectMappings, findMatchingTemplate, saveTemplateRule, convertToOrderItems, validateOrderItem, exportToExcel, findDuplicateExternalCodes, checkDuplicatesInDatabase } from '@/lib/excel';
import { supabase } from '@/lib/supabase';
import { OrderItem, ColumnMapping, SYSTEM_FIELDS, REQUIRED_FIELDS, TEMPERATURE_OPTIONS, OrderItemField } from '@/types';
import type { UploadProps } from 'antd';
import Link from 'next/link';

export default function UploadPage() {
  const [items, setItems] = useState<OrderItem[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [showMappingConfig, setShowMappingConfig] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [importProgress, setImportProgress] = useState({ progress: 0, current: 0, total: 0 });
  const [isImporting, setIsImporting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ success: number; failed: number } | null>(null);
  const editingCellRef = useRef<any>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.key === 'Enter') {
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
  }, []);

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
        message.success('已自动应用保存的模板映射');
      } else {
        detectedMappings = autoDetectMappings(excelHeaders);
        message.info('已自动识别列映射，如需调整可点击"列映射配置"');
      }
      setMappings(detectedMappings);

      setImportProgress({ progress: 60, current: 3, total: 5 });
      const orderItems = convertToOrderItems(data, detectedMappings);
      
      setImportProgress({ progress: 80, current: 4, total: 5 });
      const duplicates = findDuplicateExternalCodes(orderItems);
      const externalCodes = orderItems.map(item => item.externalCode.trim()).filter(Boolean);
      const dbDuplicates = await checkDuplicatesInDatabase(externalCodes);
      
      orderItems.forEach((item, index) => {
        const code = item.externalCode.trim();
        if (code && duplicates.has(code)) {
          const indices = duplicates.get(code)!;
          if (indices.indexOf(index) > 0) {
            item.errors.push({
              field: 'externalCode',
              message: `外部编码重复（与第${indices[0] + 1}行重复）`
            });
          }
        }
        if (code && dbDuplicates.has(code)) {
          item.errors.push({
            field: 'externalCode',
            message: `外部编码已存在于数据库中`
          });
        }
      });

      setItems(orderItems);
      setImportProgress({ progress: 100, current: 5, total: 5 });
      setShowPreview(true);
    } catch (error) {
      message.error(`文件解析失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsImporting(false);
    }
  }, []);

  const handleMappingConfig = useCallback(() => {
    setShowMappingConfig(true);
  }, []);

  const handleMappingConfirm = useCallback((newMappings: ColumnMapping[]) => {
    setMappings(newMappings);
    saveTemplateRule(newMappings);
    message.success('映射配置已保存');
    
    const reMappedItems = convertToOrderItems(
      items.map((item) => {
        const row: Record<string, string>[] = [];
        newMappings.forEach((mapping) => {
          row.push({ [mapping.excelColumn]: (item[mapping.systemField] as string) || '' });
        });
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
    const validItems = items.filter((item) => item.errors.length === 0);
    const invalidCount = items.length - validItems.length;

    if (invalidCount > 0) {
      message.error(`还有 ${invalidCount} 条数据存在错误，请先修正`);
      return;
    }

    setIsImporting(true);
    setImportProgress({ progress: 0, current: 0, total: validItems.length });

    if (!supabase) {
      message.error('数据库连接未配置');
      setIsImporting(false);
      return;
    }

    let success = 0;
    let failed = 0;

    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      try {
        await supabase.from('orders').insert({
          external_code: item.externalCode,
          sender_name: item.senderName,
          sender_phone: item.senderPhone,
          sender_address: item.senderAddress,
          receiver_name: item.receiverName,
          receiver_phone: item.receiverPhone,
          receiver_address: item.receiverAddress,
          weight: parseFloat(item.weight),
          quantity: parseInt(item.quantity, 10),
          temperature: item.temperature,
          remark: item.remark,
        });
        success++;
      } catch {
        failed++;
      }
      setImportProgress({ progress: Math.round(((i + 1) / validItems.length) * 100), current: i + 1, total: validItems.length });
    }

    setIsImporting(false);
    setShowPreview(false);
    setItems([]);
    setSubmitResult({ success, failed });
  }, [items]);

  const handleCellChange = (rowIndex: number, field: OrderItemField, value: string) => {
    const newItems = [...items];
    newItems[rowIndex] = {
      ...newItems[rowIndex],
      [field]: value,
      errors: validateOrderItem({ ...newItems[rowIndex], [field]: value }),
    };
    setItems(newItems);
  };

  const handleAddRow = () => {
    const newItem: OrderItem = {
      id: `row_${Date.now()}`,
      externalCode: '',
      senderName: '',
      senderPhone: '',
      senderAddress: '',
      receiverName: '',
      receiverPhone: '',
      receiverAddress: '',
      weight: '',
      quantity: '',
      temperature: '',
      remark: '',
      errors: [],
    };
    setItems([...items, newItem]);
  };

  const handleDeleteRow = (rowIndex: number) => {
    const newItems = items.filter((_, i) => i !== rowIndex);
    setItems(newItems);
  };

  const fileProps: UploadProps = {
    accept: '.xlsx,.xls',
    maxCount: 1,
    beforeUpload: (file) => {
      handleFileSelect(file);
      return false;
    },
    showUploadList: false,
    disabled: isImporting,
  };

  const hasErrors = items.some((item) => item.errors.length > 0);
  const allErrors = items.flatMap((item, index) =>
    item.errors.map((error) => ({ row: index + 1, field: SYSTEM_FIELDS.find((f) => f.key === error.field)?.label, message: error.message }))
  );

  const columns = SYSTEM_FIELDS.map((field) => ({
    title: (
      <span>
        {field.label}
        {REQUIRED_FIELDS.includes(field.key) && <span className="ml-1 text-red-500">*</span>}
      </span>
    ),
    dataIndex: field.key,
    key: field.key,
    editable: true,
    render: (text: string, record: OrderItem) => {
      const error = record.errors.find((e) => e.field === field.key);
      return (
        <div className={`${error ? 'text-red-600 bg-red-50 px-2 py-1 rounded' : ''}`}>
          {text || '-'}
        </div>
      );
    },
  }));

  const previewColumns = [
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, __: OrderItem, rowIndex: number) => (
        <Space>
          <Button type="text" icon={<DeleteOutlined />} danger onClick={() => handleDeleteRow(rowIndex)} />
        </Space>
      ),
    },
    ...columns.map((col) => ({
      ...col,
      render: (text: string, record: OrderItem, rowIndex: number) => {
        const error = record.errors.find((e) => e.field === col.key);
        return col.key === 'temperature' ? (
          <Select
            value={text}
            onChange={(value) => handleCellChange(rowIndex, col.key as OrderItemField, value)}
            style={{ width: '100%' }}
            options={[{ value: '', label: '请选择' }, ...TEMPERATURE_OPTIONS.map((opt) => ({ value: opt, label: opt }))]}
            className={error ? 'border-red-500' : ''}
          />
        ) : (
          <Input
            ref={editingCellRef}
            value={text}
            onChange={(e) => handleCellChange(rowIndex, col.key as OrderItemField, e.target.value)}
            onPressEnter={() => {}}
            className={error ? 'border-red-500' : ''}
          />
        );
      },
    })),
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <Card className="mx-4 mt-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button icon={<ArrowLeftOutlined />}>首页</Button>
            </Link>
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
              <UploadOutlined className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                批量导入运单
              </h1>
              <p className="text-xs text-gray-500">上传Excel → 预览编辑 → 校验提交</p>
            </div>
          </div>
          <Space>
            <Link href="/history">
              <Button>查看历史记录</Button>
            </Link>
          </Space>
        </div>
      </Card>

      <div className="mx-4 mt-4">
        {!showPreview && !submitResult && (
          <Card className="max-w-3xl mx-auto" bordered={false}>
            <Upload {...fileProps}>
              <Button icon={<UploadOutlined />} size="large" className="w-full h-32 flex flex-col justify-center" disabled={isImporting}>
                <UploadOutlined className="w-12 h-12 mb-2" />
                <span className="text-lg">拖拽Excel文件到此处或点击上传</span>
                <span className="text-sm text-gray-400">支持 .xlsx / .xls 格式</span>
              </Button>
            </Upload>

            {isImporting && (
              <div className="mt-4">
                <Progress percent={importProgress.progress} status="active" format={(percent) => `${percent}% (${importProgress.current}/${importProgress.total})`} />
              </div>
            )}

            <div className="mt-6 grid grid-cols-3 gap-4">
              <Card size="small" className="bg-green-50 border-green-200">
                <div className="flex items-center gap-2">
                  <CheckOutlined className="w-6 h-6 text-green-600" />
                  <div><p className="font-medium">多模板识别</p><p className="text-sm text-gray-500">自动匹配不同格式</p></div>
                </div>
              </Card>
              <Card size="small" className="bg-purple-50 border-purple-200">
                <div className="flex items-center gap-2">
                  <EditOutlined className="w-6 h-6 text-purple-600" />
                  <div><p className="font-medium">智能记忆</p><p className="text-sm text-gray-500">自动保存映射规则</p></div>
                </div>
              </Card>
              <Card size="small" className="bg-blue-50 border-blue-200">
                <div className="flex items-center gap-2">
                  <SendOutlined className="w-6 h-6 text-blue-600" />
                  <div><p className="font-medium">批量提交</p><p className="text-sm text-gray-500">一键导入数据库</p></div>
                </div>
              </Card>
            </div>
          </Card>
        )}

        {showPreview && !submitResult && (
          <Card bordered={false}>
            <div className="flex flex-wrap items-center justify-between mb-4 gap-4">
              <Space>
                <Button icon={<ArrowLeftOutlined />} onClick={() => { setShowPreview(false); setItems([]); }}>
                  重新上传
                </Button>
                <Button icon={<EditOutlined />} onClick={handleMappingConfig}>列映射配置</Button>
              </Space>
              <Space>
                <Button icon={<PlusOutlined />} onClick={handleAddRow} type="dashed">新增行</Button>
                <Button icon={<DownloadOutlined />} onClick={handleExport}>导出Excel</Button>
                <Button icon={<SendOutlined />} type="primary" onClick={handleSubmit} disabled={isImporting || hasErrors} loading={isImporting}>
                  提交下单（{items.filter(i => i.errors.length === 0).length}/{items.length}）
                </Button>
              </Space>
            </div>

            {isImporting && <Progress percent={importProgress.progress} status="active" format={(percent) => `提交中 ${percent}%`} className="mb-4" />}

            {hasErrors && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <WarningOutlined className="w-5 h-5 text-red-500" />
                  <span className="font-medium text-red-700">检测到 {allErrors.length} 个错误，请修正后提交</span>
                </div>
                <div className="max-h-32 overflow-y-auto">
                  {allErrors.map((error, index) => (
                    <div key={index} className="text-sm text-red-600 mb-1">第{error.row}行，{error.field}：{error.message}</div>
                  ))}
                </div>
              </div>
            )}

            <Table columns={previewColumns} dataSource={items} pagination={false} bordered scroll={{ x: 'max-content', y: 'calc(100vh - 400px)' }} rowKey="id" size="small" />
            
            <div className="mt-4 text-sm text-gray-500 text-center">提示：使用 Tab 或 Enter 键可在单元格间快速切换编辑</div>
          </Card>
        )}
      </div>

      <Modal title="列映射配置" visible={showMappingConfig} onCancel={() => setShowMappingConfig(false)} footer={[
        <Button key="back" onClick={() => setShowMappingConfig(false)}>取消</Button>,
        <Button key="submit" type="primary" onClick={() => handleMappingConfirm(mappings)}>保存并确认</Button>,
      ]} width={800}>
        <div className="mb-4 p-3 bg-blue-50 rounded-lg">
          <WarningOutlined className="w-4 h-4 text-blue-600 inline mr-2" />
          <span className="text-sm text-blue-700">系统会自动记忆您的映射配置，下次上传相同结构的Excel文件时将自动应用。</span>
        </div>
        <div className="grid grid-cols-2 gap-4 max-h-[60vh] overflow-y-auto">
          <div>
            <h4 className="font-medium mb-2 sticky top-0 bg-white py-2">Excel列名</h4>
            {headers.map((header) => (<div key={header} className="p-2 border rounded mb-1 bg-gray-50">{header || '(空)'}</div>))}
          </div>
          <div>
            <h4 className="font-medium mb-2 sticky top-0 bg-white py-2">系统字段</h4>
            {headers.map((header) => {
              const mapping = mappings.find((m) => m.excelColumn === header);
              return (
                <Select key={header} value={mapping?.systemField || ''} onChange={(value) => {
                  const newMappings = mappings.filter((m) => m.excelColumn !== header);
                  if (value) newMappings.push({ excelColumn: header, systemField: value as OrderItemField });
                  setMappings(newMappings);
                }} style={{ width: '100%', marginBottom: 8 }} allowClear options={SYSTEM_FIELDS.map((f) => ({ value: f.key, label: f.label }))} />
              );
            })}
          </div>
        </div>
      </Modal>

      {submitResult && (
        <Modal title="提交结果" visible={submitResult !== null} onCancel={() => setSubmitResult(null)} footer={[
          <Button key="submit" type="primary" onClick={() => setSubmitResult(null)}>确定</Button>,
        ]}>
          <div className="text-center py-8">
            {submitResult.success === submitResult.success + submitResult.failed ? (
              <CheckOutlined className="w-16 h-16 text-green-500 mx-auto mb-4" />
            ) : (
              <WarningOutlined className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
            )}
            <h3 className="text-xl font-bold mb-4">{submitResult.success === submitResult.success + submitResult.failed ? '提交成功' : '部分提交成功'}</h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 bg-gray-50 rounded-lg"><p className="text-2xl font-bold">{submitResult.success + submitResult.failed}</p><p className="text-sm text-gray-500">总条数</p></div>
              <div className="p-4 bg-green-50 rounded-lg"><p className="text-2xl font-bold text-green-600">{submitResult.success}</p><p className="text-sm text-green-600">成功</p></div>
              <div className="p-4 bg-red-50 rounded-lg"><p className="text-2xl font-bold text-red-600">{submitResult.failed}</p><p className="text-sm text-red-600">失败</p></div>
            </div>
            <div className="mt-4">
              <Link href="/history"><Button type="primary" block size="large">查看历史记录</Button></Link>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}