import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '订单导入系统',
  description: '多模板自动识别批量下单系统',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
