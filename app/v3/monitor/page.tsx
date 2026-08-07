import { redirect } from 'next/navigation';

/**
 * 监控看板已融合到仪表盘，重定向到 /v3/dashboard
 */
export default function V3MonitorRedirect() {
  redirect('/v3/dashboard');
}
