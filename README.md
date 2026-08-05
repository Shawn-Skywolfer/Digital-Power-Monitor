# 海外能源雷达（Digital Power Monitor）

Windows 本机单用户研究工作台，用于按时间范围扫描海外能源项目信息、核验网页证据、审核结果并导出可审计快照。应用同时提供 MCP 服务端和可安装 Codex Skill。

## 启动

要求 Node.js 22.13 或更新版本。

```powershell
pnpm install
pnpm run dev
```

浏览器打开 `http://localhost:3000`。本地 API 与 MCP 端点为 `http://127.0.0.1:8765`。

生产模式：

```powershell
pnpm run build
pnpm run start
```

## 核心能力

- Sitemap、RSS、归档页与分页联合枚举，按发布日期严格限定公开内容范围
- 静态抓取优先，正文不足或 JavaScript 渲染网站自动使用本机 Chrome/Edge 兜底
- 文章级“项目报道 / 非项目 / 待复核”判定，一篇文章支持识别多个项目
- 项目实体归并：多篇报道合并为一个项目，同时保留全部来源、字段证据与冲突
- 可审计覆盖报告：发现、抓取、全文、日期状态、分类、项目提及和唯一项目数量
- 动态字段模板、时间范围、监测来源、模型、搜索、MCP 与预算向导
- XLSX/CSV 来源导入、手工来源录入和超大有效区域裁剪
- OpenAI、Azure OpenAI、Anthropic、Gemini、OpenAI 兼容模型供应商
- Tavily、通用 REST 与 MCP 搜索工具
- HTML、PDF、重定向和正文证据归档
- 规则抽取与模型结构化抽取、字段证据、评分和冲突审核
- 二次定向深度扩散、不可变确认快照
- XLSX、Markdown、JSON 和网页全文证据包导出

扫描只会把发布日期明确位于任务范围内的文章送入项目识别。发布日期未知或互相冲突的页面会保留在审计数据中并计入覆盖报告，但不会混入最终项目列表。

API Key 通过 Windows DPAPI 加密，只绑定当前 Windows 用户。密钥不会写入 SQLite、日志或导出文件。

## Skill

项目内 Skill 位于 `skills/scan-overseas-energy-projects`。以 PowerShell 运行：

```powershell
.\skills\scan-overseas-energy-projects\scripts\install.ps1
```

Skill 通过应用 MCP 服务调用扫描、进度、审核与导出能力，不复制抓取逻辑。待审核结果不会被 Skill 擅自确认。

## 验证

```powershell
pnpm run build
pnpm test
pnpm exec tsc --noEmit
```

运行数据保存在被 Git 忽略的 `data` 目录，导出文件保存在 `outputs` 目录。
