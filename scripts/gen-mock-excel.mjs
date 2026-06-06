import XLSX from 'xlsx';

// 生成 1000 行模拟出库单数据
const headers = ['序号', '物品编码', '物品名称', '规格型号', '单位', '数量', '单价', '金额', '收货门店', '收件人', '联系电话', '收货地址', '备注'];

const stores = [
  '海口龙华店', '海口秀英店', '三亚吉阳店', '儋州那大店',
  '文昌文城店', '琼海嘉积店', '万宁兴隆店', '东方八所店',
  '澄迈金江店', '定安定城店', '屯昌屯城镇店', '陵水椰林店',
];

const products = [
  ['SKU001', '雪花牛肉片', '500g/盒'],
  ['SKU002', '肥牛卷', '500g/盒'],
  ['SKU003', '羊肉卷', '500g/盒'],
  ['SKU004', '五花肉片', '500g/盒'],
  ['SKU005', '牛舌切片', '300g/盒'],
  ['SKU006', '猪梅花肉', '400g/盒'],
  ['SKU007', '鸡脆骨', '350g/盒'],
  ['SKU008', '鱿鱼须', '250g/袋'],
  ['SKU009', '鱼豆腐', '200g/包'],
  ['SKU010', '虾滑', '150g/盒'],
  ['SKU011', '生菜拼盘', '1份'],
  ['SKU012', '金针菇', '200g/份'],
  ['SKU013', '土豆片', '300g/份'],
  ['SKU014', '宽粉', '250g/份'],
  ['SKU015', '年糕条', '200g/份'],
];

const names = ['张伟', '王芳', '李娜', '刘强', '陈静', '杨洋', '赵敏', '周杰', '吴磊', '郑凯'];
const addresses = ['解放路88号', '中山路156号', '人民大道23号', '滨海路77号', '建设街45号'];

const data = [headers];

for (let i = 1; i <= 1000; i++) {
  const product = products[i % products.length];
  const store = stores[i % stores.length];
  const name = names[i % names.length];
  const addr = addresses[i % addresses.length];
  const qty = Math.floor(Math.random() * 20) + 1;
  const price = (Math.random() * 80 + 20).toFixed(2);
  const amount = (qty * parseFloat(price)).toFixed(2);

  data.push([
    i,
    product[0],
    product[1],
    product[2],
    '份',
    qty,
    price,
    amount,
    store,
    name,
    `138${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
    `${store.replace('店', '')}${addr}`,
    '',
  ]);
}

// 添加合计行
data.push(['', '', '', '', '', '', '合计:', data.slice(1).reduce((s, r) => s + r[5], 0), data.slice(1).reduce((s, r) => s + parseFloat(r[7]), 0).toFixed(2), '', '', '', '', '']);

const ws = XLSX.utils.aoa_to_sheet(data);

// 设置列宽
ws['!cols'] = [
  { wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 6 },
  { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 8 },
  { wch: 14 }, { wch: 24 }, { wch: 10 },
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '出库单');
XLSX.writeFile(wb, 'mock-1000rows.xlsx');

console.log(`✅ 已生成 mock-1000rows.xlsx：${data.length - 1} 条数据行（含合计行）`);
console.log(`📁 文件大小：约 ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`);
