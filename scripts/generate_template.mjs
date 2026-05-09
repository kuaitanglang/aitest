import * as XLSX from 'xlsx';
import { readFileSync, writeFileSync } from 'fs';

const filePath = 'C:\\Users\\xiangzhian\\Downloads\\excel\\template1-standard.xlsx';
const buf = readFileSync(filePath);
const wb = XLSX.read(buf, { type: 'buffer' });
const ws = wb.Sheets[wb.SheetNames[0]];

const range = XLSX.utils.decode_range(ws['!ref']);
const numCols = range.e.c - range.s.c + 1;

const headerRow = [];
for (let c = range.s.c; c <= range.e.c; c++) {
  const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
  headerRow.push(cell?.v ?? '');
}
console.log('Headers:', headerRow);

const senders = [
  { name: '张伟', phone: '13800138001', address: '北京市朝阳区建国路88号' },
  { name: '王芳', phone: '13800138002', address: '广州市天河区体育西路66号' },
  { name: '李强', phone: '13800138003', address: '成都市武侯区人民南路50号' },
  { name: '赵敏', phone: '13800138004', address: '杭州市西湖区文三路90号' },
  { name: '陈静', phone: '13800138005', address: '武汉市江汉区江汉路150号' },
  { name: '刘洋', phone: '13800138006', address: '深圳市南山区科技路100号' },
  { name: '周磊', phone: '13800138007', address: '南京市鼓楼区中山路200号' },
  { name: '吴婷', phone: '13800138008', address: '西安市雁塔区高新路80号' },
  { name: '郑浩', phone: '13800138009', address: '长沙市岳麓区枫山路38号' },
  { name: '孙悦', phone: '13800138010', address: '郑州市金水区花园路120号' },
];

const receivers = [
  { name: '李四', phone: '13900139001', address: '上海市浦东新区陆家嘴路100号' },
  { name: '赵六', phone: '13900139002', address: '深圳市南山区科技路200号' },
  { name: '周八', phone: '13900139003', address: '重庆市渝中区解放碑步行街1号' },
  { name: '吴十', phone: '13900139004', address: '南京市鼓楼区中山路300号' },
  { name: '冯十二', phone: '13900139005', address: '长沙市岳麓区麓山路88号' },
  { name: '钱九', phone: '13900139006', address: '杭州市滨江区江南大道500号' },
  { name: '杨七', phone: '13900139007', address: '成都市锦江区春熙路66号' },
  { name: '马五', phone: '13900139008', address: '武汉市武昌区珞喻路200号' },
  { name: '黄三', phone: '13900139009', address: '西安市碑林区友谊路150号' },
  { name: '林二', phone: '13900139010', address: '广州市越秀区中山五路80号' },
];

const temperatures = ['常温', '冷藏', '冷冻'];
const remarks = ['易碎品', '加急', '贵重物品', '怕压', '冷藏保鲜', '轻拿轻放', '不可倒置', '防潮', '', ''];

// Remove old data rows (keep row 0 header), add 200 new rows
const newData = [headerRow];

for (let i = 1; i <= 200; i++) {
  const sender = senders[(i - 1) % senders.length];
  const receiver = receivers[(i - 1) % receivers.length];
  const temp = temperatures[(i - 1) % temperatures.length];
  const remark = remarks[(i - 1) % remarks.length];
  const weight = (Math.random() * 50 + 0.5).toFixed(1);
  const qty = Math.floor(Math.random() * 20) + 1;
  const code = `ORD-${String(i).padStart(6, '0')}`;
  
  newData.push([
    code,
    sender.name,
    sender.phone,
    sender.address,
    receiver.name,
    receiver.phone,
    receiver.address,
    weight,
    qty,
    temp,
    remark,
  ]);
}

const newWs = XLSX.utils.aoa_to_sheet(newData);
newWs['!cols'] = ws['!cols'];
const newWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(newWb, newWs, wb.SheetNames[0]);

const outBuf = XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(filePath, outBuf);

console.log(`Done! Generated ${newData.length - 1} rows of data (1 header + ${newData.length - 1} data rows)`);