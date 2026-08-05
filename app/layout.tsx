import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "海外能源雷达 · Digital Power Monitor",
  description: "可配置多模型、搜索 API 与 MCP 的海外新能源项目监测工作台。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
