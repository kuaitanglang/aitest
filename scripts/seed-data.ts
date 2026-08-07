/**
 * V3 压测数据生成脚本
 *
 * 用法: npx tsx --env-file=.env.local scripts/seed-data.ts
 *
 * 功能：
 * 1. 生成 20,000 条 SKU 主数据，插入到 v3_sku_master 表
 * 2. 生成 10,000 行订单记录的 Excel 文件，保存到 test-data/10000-orders.xlsx
 * 3. 压测文件中的 SKU 从主数据中随机抽取
 * 4. 故意插入约 5% 的非法 SKU（不在主数据中）用于验证错误定位
 * 5. 脚本可重复执行（先清理旧数据再插入）
 *
 * 依赖：
 *   - supabaseAdmin（lib/supabase.ts，使用 SUPABASE_SERVICE_ROLE_KEY 绕过 RLS）
 *   - xlsx 库（package.json dependencies）
 *   - .env.local 环境变量文件
 *
 * v3_sku_master 表结构（database/v3-setup.sql）：
 *   id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
 *   sku_code    TEXT NOT NULL UNIQUE
 *   name        TEXT NOT NULL DEFAULT ''
 *   spec        TEXT DEFAULT ''
 *   unit        TEXT DEFAULT ''
 *   created_at  TIMESTAMPTZ DEFAULT NOW()
 */
import { supabaseAdmin } from '../lib/supabase';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// 配置常量
// ============================================================

/** SKU 主数据条数 */
const SKU_COUNT = 20_000;

/** 订单记录行数 */
const ORDER_COUNT = 10_000;

/** 非法 SKU 占比（用于验证错误定位） */
const INVALID_SKU_RATIO = 0.05;

/** 批量插入分片大小（Supabase REST API 单次建议 ≤1000） */
const INSERT_CHUNK_SIZE = 500;

/** 输出 Excel 路径 */
const OUTPUT_DIR = path.join(process.cwd(), 'test-data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, '10000-orders.xlsx');

// ============================================================
// 数据池（用于生成逼真的测试数据）
// ============================================================

const PRODUCT_CATEGORIES = [
  '矿泉水', '可乐', '果汁', '牛奶', '酸奶', '面包', '饼干',
  '方便面', '薯片', '巧克力', '糖果', '咖啡', '茶叶', '啤酒',
  '红酒', '白酒', '酱油', '醋', '食用油', '大米', '面粉',
  '面条', '调味料', '罐头', '火腿肠', '腊肉', '坚果', '蜜饯',
  '冰淇淋', '速冻水饺', '汤圆', '包子', '馒头', '寿司', '沙拉',
];

const SPECS = [
  '500ml', '330ml', '1.5L', '250ml', '1L', '2L', '5L',
  '500g', '1kg', '250g', '100g', '5kg', '10kg', '50g',
  '12罐/箱', '24瓶/箱', '6包/袋', '10个/盒', '30枚/盒',
];

const UNITS = ['瓶', '箱', '包', '个', '盒', '袋', '罐', '桶', '份', 'kg'];

const STORE_NAMES = [
  '北京朝阳店', '上海浦东店', '广州天河店', '深圳南山店', '杭州西湖店',
  '成都春熙路店', '武汉光谷店', '南京新街口店', '西安钟楼店', '重庆解放碑店',
  '苏州工业园店', '天津滨海店', '青岛五四广场店', '长沙五一店', '郑州二七店',
  '厦门中山路店', '沈阳中街店', '哈尔滨中央大街店', '昆明南屏店', '贵阳喷水池店',
];

const SURNAMES = [
  '张', '王', '李', '赵', '刘', '陈', '杨', '黄', '周', '吴',
  '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗',
];

const GIVEN_NAMES = [
  '伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋',
  '勇', '艳', '杰', '娟', '涛', '明', '超', '秀英', '霞', '平',
  '刚', '桂英', '丹', '建华', '玉兰', '凯', '婷', '薇', '晨', '宇',
];

const CITIES = [
  '北京市朝阳区', '上海市浦东新区', '广州市天河区', '深圳市南山区', '杭州市西湖区',
  '成都市锦江区', '武汉市洪山区', '南京市鼓楼区', '西安市碑林区', '重庆市渝中区',
];

const STREETS = [
  '中山路', '人民路', '解放路', '建设大道', '和平路',
  '文化街', '幸福路', '友谊大道', '长安街', '复兴路',
];

const PHONE_PREFIXES = [
  '138', '139', '136', '135', '137', '158', '159', '150',
  '151', '152', '188', '187', '186', '185', '183', '182',
];

// ============================================================
// 辅助函数
// ============================================================

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice<T>(arr: T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

/** 生成 SKU 编码：SKU_00001 至 SKU_20000 */
function formatSkuCode(index: number): string {
  return `SKU_${String(index).padStart(5, '0')}`;
}

/** 生成随机中文姓名 */
function randomName(): string {
  const surname = randomChoice(SURNAMES);
  const given = randomChoice(GIVEN_NAMES);
  return surname + given;
}

/** 生成随机手机号（格式合法：1[3-9]开头 + 11 位） */
function randomPhone(): string {
  const prefix = randomChoice(PHONE_PREFIXES);
  const suffix = String(randomInt(0, 99999999)).padStart(8, '0');
  return prefix + suffix;
}

/** 生成随机地址 */
function randomAddress(): string {
  const city = randomChoice(CITIES);
  const street = randomChoice(STREETS);
  const num = randomInt(1, 999);
  const building = randomInt(1, 30);
  const room = randomInt(101, 5099);
  return `${city}${street}${num}号${building}栋${room}室`;
}

// ============================================================
// 步骤 1：生成并插入 SKU 主数据
// ============================================================

async function seedSkuMaster(): Promise<string[]> {
  console.log('\n--- 步骤 1: 生成 SKU 主数据 ---');
  console.log(`目标: ${SKU_COUNT} 条 SKU 主数据`);

  if (!supabaseAdmin) {
    console.error('❌ supabaseAdmin 未配置，请检查 .env.local 中的 SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  // 1. 清理旧数据（可重复执行）
  console.log('清理旧的 SKU 主数据 (SKU_ 开头)...');
  const { error: deleteError } = await supabaseAdmin
    .from('v3_sku_master')
    .delete()
    .like('sku_code', 'SKU\\_%');

  if (deleteError) {
    console.warn(`⚠ 清理旧数据失败（可能表为空）: ${deleteError.message}`);
  } else {
    console.log('✓ 旧数据已清理');
  }

  // 2. 生成 SKU 数据
  console.log(`生成 ${SKU_COUNT} 条 SKU 主数据...`);
  const skuRecords: Array<{ sku_code: string; name: string; spec: string; unit: string }> = [];
  const skuCodes: string[] = [];

  for (let i = 1; i <= SKU_COUNT; i++) {
    const skuCode = formatSkuCode(i);
    const category = randomChoice(PRODUCT_CATEGORIES);
    const brandNum = randomInt(1000, 9999);

    skuRecords.push({
      sku_code: skuCode,
      name: `${category}-${brandNum}`,
      spec: randomChoice(SPECS),
      unit: randomChoice(UNITS),
    });
    skuCodes.push(skuCode);
  }

  // 3. 分批插入（每批 INSERT_CHUNK_SIZE 条）
  console.log(`分批插入（每批 ${INSERT_CHUNK_SIZE} 条）...`);
  let insertedCount = 0;

  for (let i = 0; i < skuRecords.length; i += INSERT_CHUNK_SIZE) {
    const chunk = skuRecords.slice(i, i + INSERT_CHUNK_SIZE);
    const { error: insertError } = await supabaseAdmin
      .from('v3_sku_master')
      .insert(chunk);

    if (insertError) {
      console.error(`❌ 插入失败 (批次 ${i / INSERT_CHUNK_SIZE + 1}): ${insertError.message}`);
      process.exit(1);
    }
    insertedCount += chunk.length;

    // 进度日志（每 5000 条打印一次）
    if (insertedCount % 5000 === 0 || insertedCount === SKU_COUNT) {
      console.log(`  进度: ${insertedCount}/${SKU_COUNT}`);
    }
  }

  console.log(`✓ SKU 主数据插入完成: ${insertedCount} 条`);
  return skuCodes;
}

// ============================================================
// 步骤 2：生成订单 Excel 文件
// ============================================================

function generateOrdersExcel(skuCodes: string[]): void {
  console.log('\n--- 步骤 2: 生成订单 Excel 文件 ---');
  console.log(`目标: ${ORDER_COUNT} 行订单记录 → ${OUTPUT_FILE}`);

  // 确保输出目录存在
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`创建目录: ${OUTPUT_DIR}`);
  }

  const invalidCount = Math.round(ORDER_COUNT * INVALID_SKU_RATIO);
  const validCount = ORDER_COUNT - invalidCount;
  console.log(`合法 SKU 行: ${validCount}，非法 SKU 行: ${invalidCount}（约 ${(INVALID_SKU_RATIO * 100).toFixed(0)}%）`);

  // 表头（与 V2 SYSTEM_FIELDS 的 label 对应，规则引擎通过 FIELD_ALIASES 匹配）
  const headers = [
    '外部编码',
    '收货门店',
    '收件人姓名',
    '收件人电话',
    '收件人地址',
    'SKU物品编码',
    'SKU物品名称',
    'SKU发货数量',
    'SKU规格型号',
    '备注',
  ];

  const rows: any[][] = [headers];

  for (let i = 1; i <= ORDER_COUNT; i++) {
    // 判断当前行是否为非法 SKU 行
    const isInvalid = i <= invalidCount;

    let skuCode: string;
    let skuName: string;
    let skuSpec: string;

    if (isInvalid) {
      // 非法 SKU：使用主数据范围外的编码（SKU_20001+），不会命中校验
      skuCode = formatSkuCode(SKU_COUNT + i);
      skuName = `非法商品-${i}`;
      skuSpec = '未知规格';
    } else {
      // 合法 SKU：从主数据中随机抽取
      skuCode = randomChoice(skuCodes);
      const category = randomChoice(PRODUCT_CATEGORIES);
      skuName = `${category}-${randomInt(1000, 9999)}`;
      skuSpec = randomChoice(SPECS);
    }

    rows.push([
      `WB_${String(i).padStart(5, '0')}`,  // 外部编码
      randomChoice(STORE_NAMES),             // 收货门店
      randomName(),                           // 收件人姓名
      randomPhone(),                          // 收件人电话
      randomAddress(),                        // 收件人地址
      skuCode,                                // SKU物品编码
      skuName,                                // SKU物品名称
      String(randomInt(1, 100)),              // SKU发货数量
      skuSpec,                                // SKU规格型号
      i % 10 === 0 ? '加急配送' : '',         // 备注（10% 概率有备注）
    ]);
  }

  // 构建工作簿
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '订单记录');

  // 写入文件
  XLSX.writeFile(workbook, OUTPUT_FILE);

  const fileSize = fs.statSync(OUTPUT_FILE).size;
  console.log(`✓ Excel 文件已生成: ${OUTPUT_FILE}`);
  console.log(`  文件大小: ${(fileSize / 1024).toFixed(1)} KB`);
  console.log(`  总行数: ${rows.length - 1}（不含表头）`);
  console.log(`  非法 SKU 行: ${invalidCount} 行（约 ${(INVALID_SKU_RATIO * 100).toFixed(0)}%）`);
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const startTime = Date.now();

  console.log('============================================');
  console.log('  V3 压测数据生成脚本');
  console.log('============================================');
  console.log(`SKU 主数据:  ${SKU_COUNT} 条`);
  console.log(`订单记录:    ${ORDER_COUNT} 行`);
  console.log(`非法 SKU 占比: ${(INVALID_SKU_RATIO * 100).toFixed(0)}%`);
  console.log(`输出文件:    ${OUTPUT_FILE}`);
  console.log('');

  // 步骤 1：生成并插入 SKU 主数据
  const skuCodes = await seedSkuMaster();

  // 步骤 2：生成订单 Excel 文件
  generateOrdersExcel(skuCodes);

  // 汇总
  const duration = Date.now() - startTime;
  console.log('');
  console.log('============================================');
  console.log('  生成完成');
  console.log('============================================');
  console.log(`SKU 主数据:  ${SKU_COUNT} 条 → v3_sku_master 表`);
  console.log(`订单 Excel:  ${ORDER_COUNT} 行 → ${OUTPUT_FILE}`);
  console.log(`非法 SKU:    ${Math.round(ORDER_COUNT * INVALID_SKU_RATIO)} 行（验证错误定位用）`);
  console.log(`总耗时:      ${(duration / 1000).toFixed(2)}s`);
  console.log('');
  console.log('下一步:');
  console.log('  1. 启动 Worker:  npx tsx --env-file=.env.local worker/local-worker.ts');
  console.log('  2. 启动服务:    npm run dev');
  console.log('  3. 执行压测:    npm run stress:v3');
  console.log('============================================');
}

main().catch((err) => {
  console.error('脚本异常:', err);
  process.exit(1);
});
