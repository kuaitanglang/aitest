export interface OrderItem {
  id: string;
  externalCode: string;
  senderName: string;
  senderPhone: string;
  senderAddress: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  weight: string;
  quantity: string;
  temperature: string;
  remark: string;
  createdAt?: string;
  errors: FieldError[];
}

export interface FieldError {
  field: keyof OrderItem;
  message: string;
}

export interface ColumnMapping {
  excelColumn: string;
  systemField: OrderItemField;
}

export interface TemplateRule {
  id: string;
  name: string;
  headerFingerprint: string;
  mappings: ColumnMapping[];
  createdAt: number;
}

export const TEMPERATURE_OPTIONS = ['常温', '冷藏', '冷冻'];

export const REQUIRED_FIELDS: (keyof OrderItem)[] = [
  'senderName',
  'senderPhone',
  'senderAddress',
  'receiverName',
  'receiverPhone',
  'receiverAddress',
  'weight',
  'quantity',
  'temperature',
];

export const COLUMN_ALIASES: Record<Exclude<keyof OrderItem, 'createdAt'>, string[]> = {
  id: ['id', '序号', '编号', 'No.', 'ID', '序', '#'],
  externalCode: [
    '外部编码', '外部订单号', '订单编号', '外部单号', 
    'external_code', 'order_no', 'orderId', 'trackingNo',
    '订单号', '快递单号', '物流单号', '单号', 
    'ExternalCode', 'OrderNo', 'TrackingNumber',
    'Ref Code', 'ref_code', 'refcode', 'Reference Code',
    '外部订单号', '参考编码', '参考号',
    '客户单号', '客户订单号', '内部订单号', '订单号'
  ],
  senderName: [
    '发件人姓名', '寄件人姓名', '发件人', '寄件人', 
    'sender', 'sender_name', 'from_name', 'shipper',
    '发货人姓名', '寄方姓名', '寄件方', '发货人',
    'SenderName', 'ShipperName', 'FromName',
    'Sender', '发货人', '寄件方', '发件方'
  ],
  senderPhone: [
    '发件人电话', '寄件人电话', '发件人联系方式', '寄件人联系方式', 
    'sender_phone', 'from_phone', 'shipper_phone',
    '发件人手机', '寄件人手机', '发货人电话',
    'SenderPhone', 'ShipperPhone', 'FromPhone',
    'Sender Tel', 'sender_tel', 'SenderTel',
    '发货电话', '寄件电话', '发货人联系电话', '发件人联系电话',
    '发件电话'
  ],
  senderAddress: [
    '发件人地址', '寄件人地址', '发货地址', 
    'sender_address', 'from_address', 'shipper_address',
    '发件地址', '寄件地址', '发货人地址',
    'SenderAddress', 'ShipperAddress', 'FromAddress',
    'Sender Address', 'sender_address',
    '发货地址', '寄件地址', '发件地址', '发货人详细地址'
  ],
  receiverName: [
    '收件人姓名', '收货人姓名', '收件人', '收货人', '收方', 
    'receiver', 'receiver_name', 'to_name', 'consignee',
    '收货方', '收方姓名', '收件方',
    'ReceiverName', 'ConsigneeName', 'ToName',
    'Receiver', '收货人', '收件方', '收货方'
  ],
  receiverPhone: [
    '收件人电话', '收货人电话', '收件人联系方式', '收货人联系方式', 
    'receiver_phone', 'to_phone', 'consignee_phone',
    '收件人手机', '收货人手机', '收货方电话',
    'ReceiverPhone', 'ConsigneePhone', 'ToPhone',
    'Receiver Tel', 'receiver_tel', 'ReceiverTel',
    '收货电话', '收件电话', '收货人联系电话'
  ],
  receiverAddress: [
    '收件人地址', '收货人地址', '收货地址', 
    'receiver_address', 'to_address', 'consignee_address',
    '收货地址', '收方地址', '收件方地址',
    'ReceiverAddress', 'ConsigneeAddress', 'ToAddress',
    'Receiver Address', 'receiver_address',
    '收货地址', '收件地址', '收货人详细地址'
  ],
  weight: [
    '重量', '重量(kg)', '重量KG', '货物重量', 
    'weight', 'kg', 'weight_kg', 'Weight',
    '净重', '毛重', '实际重量',
    'Weight(kg)', 'Weight_KG',
    '重量(KG)', '重量（KG）', '重量(公斤)', '重量kg'
  ],
  quantity: [
    '件数', '数量', '包裹数量', '总件数', 
    'quantity', 'count', 'pieces', 'Quantity',
    '箱数', '盒数', '包装数量',
    'Qty', 'qty', 'QTY',
    '件数(箱)', '数量（件）', '总数'
  ],
  temperature: [
    '温层', '温度', '温度层', '冷藏要求', '温控', 
    'temperature', 'temp', 'cold', 'Temperature',
    '储存温度', '运输温度', '冷链类型',
    'Temp Zone', 'temp_zone', 'TempZone',
    '温度要求', '温控要求', '储存条件',
    '温层要求', '温区', '温度区域'
  ],
  remark: [
    '备注', '说明', '备注信息', '附加说明', 
    'remark', 'note', 'comments', 'Remark',
    '注意事项', '特殊说明', '其他信息',
    'Note', '附言', '留言', '补充信息',
    '给送货员留言', '给快递员留言', '订单备注'
  ],
  errors: [],
};

export type OrderItemField = Exclude<keyof OrderItem, 'id' | 'errors'>;

export const SYSTEM_FIELDS: { key: OrderItemField; label: string }[] = [
  { key: 'externalCode', label: '外部编码' },
  { key: 'senderName', label: '发件人姓名' },
  { key: 'senderPhone', label: '发件人电话' },
  { key: 'senderAddress', label: '发件人地址' },
  { key: 'receiverName', label: '收件人姓名' },
  { key: 'receiverPhone', label: '收件人电话' },
  { key: 'receiverAddress', label: '收件人地址' },
  { key: 'weight', label: '重量(kg)' },
  { key: 'quantity', label: '件数' },
  { key: 'temperature', label: '温层' },
  { key: 'remark', label: '备注' },
];