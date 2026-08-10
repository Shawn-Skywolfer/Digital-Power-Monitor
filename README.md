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
- 静态抓取优先，正文不足或 JavaScript 渲染网站自动使用本机 Chrome/Edge 兜底；可叠加 Lightpanda 无头浏览器（CDP）作为第二渲染后端
- Firecrawl 云端枚举与正文回退，与 Lightpanda、本机浏览器组成多层防失效链
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

## 浏览器渲染兜底

渲染兜底链：静态抓取 → Firecrawl（如已配置）→ 本机 Chrome/Edge → Lightpanda（如已启用）。在「能力设置 → 浏览器渲染」面板配置，也可用环境变量兜底：

- `DPM_LIGHTPANDA_CDP_URL`：Lightpanda CDP 端点（`ws://127.0.0.1:9222` 或 Cloud `wss://euwest.cloud.lightpanda.io/ws`）
- `DPM_LIGHTPANDA_TOKEN`：Cloud token（设置页保存的 token 经 DPAPI 加密，优先级更高）

Lightpanda 没有 Windows 原生二进制：本机运行需 WSL2 或 Docker（`lightpanda serve --host 127.0.0.1 --port 9222`），或直接使用 Lightpanda Cloud。端点 60 秒连不上会自动熔断跳过，不影响本机浏览器渲染。

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
