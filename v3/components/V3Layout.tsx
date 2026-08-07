'use client';

/**
 * V3 共享布局组件
 * 复用 V2 的青色主题 + Layout + Header + Sider 设计风格
 * 左侧菜单栏支持页面间切换
 */

import { useState, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { ConfigProvider, Layout, Menu, Breadcrumb } from 'antd';
import {
  ThunderboltOutlined,
  NodeIndexOutlined,
  DatabaseOutlined,
  UnorderedListOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  HomeOutlined,
  FileTextOutlined,
  ImportOutlined,
  FundViewOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import type { MenuProps } from 'antd';

const { Header, Sider, Content } = Layout;

// 主题配置（与 V2 保持一致）
export const V3_THEME_TOKEN = {
  cssVar: { prefix: 'ant', key: '' },
  token: {
    colorPrimary: '#0fc6c2',
    colorInfo: '#0fc6c2',
    colorLink: '#0fc6c2',
    borderRadius: 6,
    colorBgContainer: '#ffffff',
    colorBorder: '#e5e7eb',
  },
  components: {
    Table: {
      headerBg: '#f0fbfb',
      headerColor: '#1f2937',
      rowHoverBg: '#f0fdfa',
    },
    Menu: {
      itemSelectedBg: '#e6fffb',
      itemActiveBg: '#f0fbfb',
      itemHoverBg: '#f0fbfb',
    },
    Button: {
      primaryShadow: '0 2px 4px rgba(15, 198, 194, 0.2)',
    },
  },
};

// 菜单项定义（仪表盘单独置顶 + 功能分组）
const MENU_ITEMS: MenuProps['items'] = [
  // 仪表盘单独置顶展示（融合原仪表盘 + 监控看板）
  { key: '/v3/dashboard', icon: <HomeOutlined />, label: '仪表盘' },
  {
    key: 'group-import',
    icon: <ImportOutlined />,
    label: '导入操作',
    children: [
      { key: '/v3', icon: <ThunderboltOutlined />, label: '新建导入' },
      { key: '/v3/tasks', icon: <UnorderedListOutlined />, label: '任务列表' },
    ],
  },
  {
    key: 'group-data',
    icon: <DatabaseOutlined />,
    label: '数据管理',
    children: [
      { key: '/v3/orders', icon: <FileTextOutlined />, label: '订单记录' },
      { key: '/v3/rules', icon: <DatabaseOutlined />, label: '解析规则' },
    ],
  },
  {
    key: 'group-monitor',
    icon: <FundViewOutlined />,
    label: '监控追踪',
    children: [
      { key: '/v3/traces', icon: <NodeIndexOutlined />, label: 'Trace 检索' },
    ],
  },
];

// 路径 → 所属分组映射（用于自动展开当前分组，null 表示不在分组内）
const PATH_TO_GROUP: Record<string, string> = {
  '/v3': 'group-import',
  '/v3/tasks': 'group-import',
  '/v3/orders': 'group-data',
  '/v3/rules': 'group-data',
  '/v3/traces': 'group-monitor',
};

// 所有分组 key（默认全部展开）
const ALL_GROUP_KEYS = ['group-import', 'group-data', 'group-monitor'];

// 面包屑映射
const BREADCRUMB_MAP: Record<string, { title: string; parent?: string }[]> = {
  '/v3': [{ title: '异步导入 V3' }, { title: '新建导入' }],
  '/v3/dashboard': [{ title: '异步导入 V3' }, { title: '仪表盘' }],
  '/v3/tasks': [{ title: '异步导入 V3' }, { title: '任务列表' }],
  '/v3/orders': [{ title: '异步导入 V3' }, { title: '订单记录' }],
  '/v3/rules': [{ title: '异步导入 V3' }, { title: '解析规则' }],
  '/v3/traces': [{ title: '异步导入 V3' }, { title: 'Trace 检索' }],
};

interface V3LayoutProps {
  children: React.ReactNode;
  /** 自定义面包屑（任务详情页等动态页面使用） */
  breadcrumbItems?: { title: string }[];
}

export default function V3Layout({ children, breadcrumbItems }: V3LayoutProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>(ALL_GROUP_KEYS);

  // 根据当前路径推断选中的菜单项
  const getSelectedKey = () => {
    // /v3/tasks/[taskId] → /v3/tasks
    if (pathname === '/v3/tasks' || pathname.match(/^\/v3\/tasks\/[^/]+$/)) return '/v3/tasks';
    // /v3/tasks/[taskId]/errors → /v3/tasks
    if (pathname.match(/^\/v3\/tasks\/.+\/errors$/)) return '/v3/tasks';
    if (pathname.startsWith('/v3/dashboard')) return '/v3/dashboard';
    if (pathname.startsWith('/v3/orders')) return '/v3/orders';
    if (pathname.startsWith('/v3/rules')) return '/v3/rules';
    if (pathname.startsWith('/v3/traces')) return '/v3/traces';
    return '/v3';
  };

  // 导航时自动展开当前页面对应的分组（不折叠其他分组）
  useEffect(() => {
    const currentKey = getSelectedKey();
    const currentGroup = PATH_TO_GROUP[currentKey];
    if (currentGroup && !openKeys.includes(currentGroup)) {
      setOpenKeys(prev => [...prev, currentGroup]);
    }
  }, [pathname]);

  // 面包屑
  const breadcrumb = breadcrumbItems || BREADCRUMB_MAP[getSelectedKey()] || [{ title: '异步导入 V3' }];

  return (
    <ConfigProvider locale={zhCN} theme={V3_THEME_TOKEN}>
      <Layout className="v2-layout" style={{ minHeight: '100vh', background: '#f5f7fa' }}>
        {/* 顶部导航栏 */}
        <Header
          className="v2-header"
          style={{
            background: 'linear-gradient(90deg, #0fc6c2 0%, #0bb5ae 100%)',
            height: 56,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            boxShadow: '0 2px 8px rgba(15, 198, 194, 0.15)',
            flexShrink: 0,
            position: 'sticky',
            top: 0,
            zIndex: 100,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', color: '#fff', fontSize: 18, fontWeight: 600 }}>
            <ThunderboltOutlined style={{ fontSize: 22, marginRight: 10 }} />
            异步批量导入 V3
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, color: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <UserOutlined />
              <span>管理员</span>
            </div>
          </div>
        </Header>

        <Layout>
          {/* 左侧菜单 */}
          <Sider
            width={200}
            className="v2-sider-menu"
            style={{
              background: '#fff',
              borderRight: '1px solid #e5e7eb',
              overflow: 'auto',
              height: 'calc(100vh - 56px)',
              position: 'sticky',
              top: 56,
            }}
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            trigger={null}
          >
            <Menu
              mode="inline"
              className="v2-sider-menu"
              selectedKeys={[getSelectedKey()]}
              openKeys={collapsed ? [] : openKeys}
              onOpenChange={(keys) => setOpenKeys(keys as string[])}
              onClick={(e) => router.push(e.key)}
              items={MENU_ITEMS as any}
              style={{ height: '100%', borderRight: 0, paddingTop: 12 }}
            />
            {/* 折叠按钮 */}
            <div
              className="v2-sider-toggle"
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </div>
          </Sider>

          {/* 主内容区 */}
          <Content style={{ padding: 16, minHeight: 'calc(100vh - 56px)' }}>
            <Breadcrumb items={breadcrumb} style={{ marginBottom: 16 }} />
            <div className="v2-page-content">{children}</div>
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
