export type ParseMode = 'table' | 'card' | 'transpose' | 'text';

export interface ParseRule {
  id: string;
  name: string;
  description: string;
  fileType: 'excel' | 'word' | 'pdf';
  parseMode?: ParseMode;
  multiSheet?: boolean;
  cardMarker?: string;
  headerSkipRows: number;
  footerSkipRows: number;
  dataStartRow: number;
  dataEndRow?: number;
  skipPatterns: string[];
  aggregateBy?: string;
  transposeConfig?: TransposeConfig;
  extractionRules: ExtractionRule[];
  fieldMappings: FieldMapping[];
  aiGenerated: boolean;
  aiConfidence?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransposeConfig {
  type: 'matrix' | 'double';
  /** 行标识列（SKU名 / 门店名） */
  rowHeaderColumn: string;
  /** 列头所在行索引（double 模式：日期行） */
  columnHeaderRow: number;
  valueColumn?: string;
  /** 复合单元格行分隔符 */
  lineSeparator?: string;
  /** 复合值匹配，默认 "(.+)[x×*](\\d+)" */
  compositePattern?: string;
  /** matrix 模式下作为门店/数量列的列头前缀过滤 */
  columnFilter?: string;
}

export interface ExtractionRule {
  id: string;
  name: string;
  type: 'header' | 'footer' | 'inline' | 'card';
  pattern: string;
  targetField: string;
  regex?: string;
  defaultValue?: string;
}

export interface FieldMapping {
  sourceColumn: string;
  targetField: OrderField;
  mappingType: 'direct' | 'regex' | 'composite';
  regexPattern?: string;
  compositeFields?: string[];
  separator?: string;
  /** AI 推测的映射，需用户确认 */
  speculative?: boolean;
}

export type OrderField =
  | 'externalCode'
  | 'storeName'
  | 'receiverName'
  | 'receiverPhone'
  | 'receiverAddress'
  | 'skuCode'
  | 'skuName'
  | 'skuQuantity'
  | 'skuSpec'
  | 'remark';

export interface OrderItem {
  id: string;
  externalCode: string;
  storeName: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  skuCode: string;
  skuName: string;
  skuQuantity: string;
  skuSpec: string;
  remark: string;
  errors: FieldError[];
  createdAt?: string;
}

export interface FieldError {
  field: OrderField;
  message: string;
}

export interface ParsedFileData {
  headers: string[];
  data: any[][];
  sheets: string[];
  sheetData: Record<string, any[][]>;
  fileType: 'excel' | 'word' | 'pdf';
  textLines?: string[];
  /** 是否被截断（大文件只读取了前 N 行） */
  truncated?: boolean;
}

export interface ParseEngineInput {
  rows?: any[][];
  sheetData?: Record<string, any[][]>;
  textLines?: string[];
  rule: ParseRule;
  onProgress?: (current: number, total: number) => void;
}

export const SYSTEM_FIELDS: {
  key: OrderField;
  label: string;
  required: boolean;
  width: number;
}[] = [
  { key: 'externalCode', label: '外部编码', required: false, width: 150 },
  { key: 'storeName', label: '收货门店', required: false, width: 180 },
  { key: 'receiverName', label: '收件人姓名', required: false, width: 120 },
  { key: 'receiverPhone', label: '收件人电话', required: false, width: 130 },
  { key: 'receiverAddress', label: '收件人地址', required: false, width: 220 },
  { key: 'skuCode', label: 'SKU物品编码', required: true, width: 140 },
  { key: 'skuName', label: 'SKU物品名称', required: true, width: 180 },
  { key: 'skuQuantity', label: 'SKU发货数量', required: true, width: 110 },
  { key: 'skuSpec', label: 'SKU规格型号', required: false, width: 140 },
  { key: 'remark', label: '备注', required: false, width: 160 },
];

export const REQUIRED_FIELDS: OrderField[] = ['skuCode', 'skuName', 'skuQuantity'];

export const FIELD_ALIASES: Record<OrderField, string[]> = {
  externalCode: [
    '外部编码', '外部订单号', '订单编号', '外部单号',
    'order_no', 'orderId', '运单号', '快递单号', '物流单号', '单号',
    '配送单号', '参考编码', '参考号', '客户单号', '客户订单号',
    '内部订单号', '订单号', '外部编号', '配送汇总单号', '单据号',
  ],
  storeName: [
    '收货门店', '门店名称', '门店', '机构名称', '收货方', '收货机构', '调入门店',
    '收货单位', '配送门店', '门店收货', '收货门店名称', '店铺名称',
    '店铺', '连锁店', '分店名称', '收件门店',
  ],
  receiverName: [
    '收件人姓名', '收货人姓名', '收件人', '收货人', '收方',
    'receiver', 'receiver_name', 'consignee', '联系人', '收货联系人',
    '收件人', '接收人',
  ],
  receiverPhone: [
    '收件人电话', '收货人电话', '收件人联系方式', '收货人联系方式',
    'receiver_phone', 'to_phone', 'consignee_phone', '收货电话', '联系电话',
    '收件人手机', '收货人手机', '联系方式', '手机号', '电话', '手机',
  ],
  receiverAddress: [
    '收件人地址', '收货人地址', '收货地址', '收货地址详情',
    'receiver_address', 'to_address', 'consignee_address',
    '收方地址', '收件方地址', '详细地址', '收货详细地址', '地址',
  ],
  skuCode: [
    'SKU物品编码', 'SKU编码', '物品编码', '商品编码', '货号',
    'SKU', 'sku_code', '物品编号', '商品编号', '物料编码',
    '产品编码', 'SKU编号', '编码', '物品代码', '商品代码', '外部商品编码', 'SKU条码',
  ],
  skuName: [
    'SKU物品名称', 'SKU名称', '物品名称', '商品名称', '货品名称',
    'sku_name', '品名', '商品', '物料名称', '产品名称', 'SKU名', '物品', '名称',
  ],
  skuQuantity: [
    'SKU发货数量', '发货数量', '数量', '件数', '出库数量', '应发数量',
    'sku_quantity', 'qty', '发货量', '出货数量', '发货件数', '物品数量',
    '商品数量', '数量(件)', '发货', '在库数量的总和', '可用数量的总和',
  ],
  skuSpec: [
    'SKU规格型号', '规格型号', '规格', '型号', '物品规格',
    '商品规格', 'sku_spec', 'spec', '规格说明', '产品规格',
    '具体规格', '规格参数',
  ],
  remark: [
    '备注', '说明', '备注信息', '附加说明', 'remark', 'note',
    'comments', '注意事项', '特殊说明', '其他信息', '补充说明',
    '订单备注', '备注栏', 'remarks', '备忘', '单据备注', '物品备注',
  ],
};

export const createEmptyOrderItem = (): OrderItem => ({
  id: `row_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  externalCode: '',
  storeName: '',
  receiverName: '',
  receiverPhone: '',
  receiverAddress: '',
  skuCode: '',
  skuName: '',
  skuQuantity: '',
  skuSpec: '',
  remark: '',
  errors: [],
});
