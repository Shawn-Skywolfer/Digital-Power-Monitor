import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "./types";
import { db, jsonParse, listFields, listSources } from "./db";

type McpProfile = ReturnType<typeof mapMcpRow>;
export interface McpInvocationResult {
  serverId: string; serverName: string; tool: string; ok: boolean;
  latencyMs: number; result?: unknown; error?: string;
}

export interface McpActions {
  startScan(args: JsonObject): Promise<unknown>;
  getScanStatus(id: string): unknown;
  getResults(scanId: string): unknown;
  getArticles(scanId: string): unknown;
  getScanDiagnostics(scanId: string): unknown;
  deepExpand(resultId: string, args: JsonObject): Promise<unknown>;
  reviewResult(resultId: string, args: JsonObject): unknown;
  confirmSnapshot(args: JsonObject): unknown;
  exportSnapshot(snapshotId: string): Promise<unknown>;
}

const toolDefinitions = [
  { name: "list_fields", description: "列出可勾选的项目字段", inputSchema: { type: "object", properties: {} } },
  { name: "list_sources", description: "列出已配置的信息来源", inputSchema: { type: "object", properties: {} } },
  { name: "start_scan", description: "按时间、字段和来源启动监测", inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" }, fieldIds: { type: "array", items: { type: "string" } }, sourceIds: { type: "array", items: { type: "string" } } }, required: ["startDate", "endDate", "fieldIds", "sourceIds"] } },
  { name: "get_scan_status", description: "读取监测进度", inputSchema: { type: "object", properties: { scanId: { type: "string" } }, required: ["scanId"] } },
  { name: "get_results", description: "读取按项目归并后的扫描结果", inputSchema: { type: "object", properties: { scanId: { type: "string" } }, required: ["scanId"] } },
  { name: "get_articles", description: "读取全部抓取文章的日期状态、项目判定与失败原因", inputSchema: { type: "object", properties: { scanId: { type: "string" } }, required: ["scanId"] } },
  { name: "get_scan_diagnostics", description: "读取扫描漏斗、来源分布、枚举日志、阻断原因、模型可审计反馈和下一轮策略", inputSchema: { type: "object", properties: { scanId: { type: "string" } }, required: ["scanId"] } },
  { name: "start_deep_expansion", description: "对一条可疑结果启动定向扩散监测", inputSchema: { type: "object", properties: { resultId: { type: "string" } }, required: ["resultId"] } },
  { name: "review_result", description: "审核一条结果；此工具会改变审核状态", annotations: { destructiveHint: false }, inputSchema: { type: "object", properties: { resultId: { type: "string" }, decision: { type: "string", enum: ["approved", "review", "rejected"] }, note: { type: "string" } }, required: ["resultId", "decision"] } },
  { name: "confirm_snapshot", description: "确认结果并创建不可变快照", inputSchema: { type: "object", properties: { scanId: { type: "string" }, resultIds: { type: "array", items: { type: "string" } }, fieldIds: { type: "array", items: { type: "string" } }, includeFlagged: { type: "boolean" } }, required: ["scanId", "resultIds", "fieldIds"] } },
  { name: "export_snapshot", description: "导出已确认快照", inputSchema: { type: "object", properties: { snapshotId: { type: "string" } }, required: ["snapshotId"] } },
];

export async function handleMcpRequest(body: JsonObject, actions: McpActions) {
  const id = body.id ?? null;
  const method = String(body.method ?? "");
  try {
    if (method === "initialize") return success(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: "digital-power-monitor", version: "0.1.0" },
    });
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return success(id, { tools: toolDefinitions });
    if (method === "resources/list") {
      const scans = db.prepare("SELECT id,status,created_at FROM scans ORDER BY created_at DESC LIMIT 50").all() as Record<string, unknown>[];
      return success(id, { resources: scans.map((scan) => ({ uri: `scan://${scan.id}/results`, name: `监测 ${scan.id}`, mimeType: "application/json", description: `${scan.status} · ${scan.created_at}` })) });
    }
    if (method === "resources/read") {
      const uri = String((body.params as JsonObject | undefined)?.uri ?? "");
      const match = uri.match(/^scan:\/\/([^/]+)\/results$/);
      if (!match) throw new Error("未知资源");
      return success(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(actions.getResults(match[1]), null, 2) }] });
    }
    if (method === "prompts/list") return success(id, { prompts: [
      { name: "monitor-projects", description: "按时间段监测海外能源项目", arguments: [{ name: "startDate", required: true }, { name: "endDate", required: true }] },
      { name: "verify-record", description: "审核并扩散验证一条项目记录", arguments: [{ name: "resultId", required: true }] },
    ] });
    if (method === "prompts/get") {
      const params = body.params as JsonObject;
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as JsonObject;
      const text = name === "verify-record"
        ? `请检查结果 ${args.resultId} 的字段证据；如有疑问先调用 start_deep_expansion，不要擅自确认。`
        : `请监测 ${args.startDate} 至 ${args.endDate} 发布的海外能源项目，先列出字段与来源，再启动任务。`;
      return success(id, { description: name, messages: [{ role: "user", content: { type: "text", text } }] });
    }
    if (method === "tools/call") {
      const params = body.params as JsonObject;
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as JsonObject;
      const result = await callTool(name, args, actions);
      return success(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
    }
    throw new Error(`不支持的 MCP 方法：${method}`);
  } catch (error) {
    return failure(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(name: string, args: JsonObject, actions: McpActions) {
  if (name === "list_fields") return listFields();
  if (name === "list_sources") return listSources();
  if (name === "start_scan") return actions.startScan(args);
  if (name === "get_scan_status") return actions.getScanStatus(String(args.scanId));
  if (name === "get_results") return actions.getResults(String(args.scanId));
  if (name === "get_articles") return actions.getArticles(String(args.scanId));
  if (name === "get_scan_diagnostics") return actions.getScanDiagnostics(String(args.scanId));
  if (name === "start_deep_expansion") return actions.deepExpand(String(args.resultId), args);
  if (name === "review_result") return actions.reviewResult(String(args.resultId), args);
  if (name === "confirm_snapshot") return actions.confirmSnapshot(args);
  if (name === "export_snapshot") return actions.exportSnapshot(String(args.snapshotId));
  throw new Error(`未知工具：${name}`);
}

function success(id: unknown, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function failure(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

export async function catalogMcpServer(profile: JsonObject) {
  if (profile.transport === "stdio") return catalogStdio(profile);
  const url = String(profile.url ?? "");
  const headers = { "Content-Type": "application/json", ...(profile.headers as Record<string, string> ?? {}) };
  let sequence = 1;
  const rpc = async (method: string, params: JsonObject = {}) => {
    const response = await fetch(url, {
      method: "POST", headers, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: sequence++, method, params }),
    });
    const data = await response.json() as JsonObject;
    if (!response.ok || data.error) throw new Error(String((data.error as JsonObject | undefined)?.message ?? `HTTP ${response.status}`));
    return data.result as JsonObject;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "digital-power-monitor", version: "0.1.0" } });
  const tools = await rpc("tools/list");
  const [resources, prompts] = await Promise.all([
    rpc("resources/list").catch((error) => ({ resources: [], unavailable: error instanceof Error ? error.message : String(error) })),
    rpc("prompts/list").catch((error) => ({ prompts: [], unavailable: error instanceof Error ? error.message : String(error) })),
  ]);
  return { tools: tools.tools ?? [], resources: resources.resources ?? [], prompts: prompts.prompts ?? [],
    warnings: [resources.unavailable && `Resources：${resources.unavailable}`, prompts.unavailable && `Prompts：${prompts.unavailable}`].filter(Boolean) };
}

function parseRpcPayload(text: string) {
  if (/^\s*data:/m.test(text)) {
    const payloads = text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).filter(Boolean);
    return JSON.parse(payloads.at(-1) ?? "{}") as JsonObject;
  }
  return JSON.parse(text || "{}") as JsonObject;
}

async function httpSession(profile: McpProfile) {
  let sequence = 1;
  let sessionId = "";
  const rpc = async (method: string, params: JsonObject = {}) => {
    const response = await fetch(profile.url, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}), ...profile.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: sequence++, method, params }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const payload = parseRpcPayload(await response.text());
    if (!response.ok || payload.error) throw new Error(String((payload.error as JsonObject | undefined)?.message ?? `HTTP ${response.status}`));
    return payload.result as JsonObject;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "digital-power-monitor", version: "0.2.0" } });
  return { rpc, close: async () => undefined };
}

function stdioSession(profile: McpProfile) {
  const runtime = resolveStdioCommand(profile.command, profile.args);
  const environment = { ...process.env, ...profile.env } as NodeJS.ProcessEnv;
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "Path";
  environment[pathKey] = [path.dirname(process.execPath), environment[pathKey]].filter(Boolean).join(path.delimiter);
  const child = spawn(runtime.command, runtime.args, {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: environment,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let sequence = 1;
  let buffer = "";
  let stderr = "";
  const pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as JsonObject;
        const id = Number(message.id); const waiter = pending.get(id); if (!waiter) continue;
        clearTimeout(waiter.timer); pending.delete(id);
        if (message.error) waiter.reject(new Error(String((message.error as JsonObject).message ?? "MCP error")));
        else waiter.resolve(message.result as JsonObject);
      } catch { /* stdio server log line */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  child.on("error", (error) => rejectPending(error));
  child.on("exit", (code, signal) => {
    if (!pending.size) return;
    const detail = stderr.trim();
    rejectPending(new Error(`MCP 进程提前退出（${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}）${detail ? `：${detail}` : ""}`));
  });
  const rpc = (method: string, params: JsonObject = {}) => new Promise<JsonObject>((resolve, reject) => {
    const id = sequence++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} 超时；${runtime.label} 在 60 秒内没有响应`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const notify = (method: string, params: JsonObject = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { rpc, notify, runtime: runtime.label, close: async () => { if (!child.killed) child.kill(); } };
}

function resolveStdioCommand(command: string, args: string[]) {
  if (/^npx(?:\.cmd)?$/i.test(command)) {
    const pnpmEntry = path.resolve(path.dirname(process.execPath), "..", "node_modules", "pnpm", "bin", "pnpm.mjs");
    if (fs.existsSync(pnpmEntry)) return {
      command: process.execPath, args: [pnpmEntry, "dlx", ...args.filter((arg) => !["-y", "--yes"].includes(arg))],
      label: "内置 pnpm dlx（兼容 npx 配置）",
    };
  }
  return { command, args, label: `${command} ${args.join(" ")}`.trim() };
}

function buildToolArgs(schema: JsonObject, context: JsonObject) {
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const sourceUrls = Array.isArray(context.sourceUrls) ? context.sourceUrls.map(String) : [];
  const values: JsonObject = {};
  for (const key of Object.keys(properties)) {
    if (/^(url|website|startUrl)$/i.test(key) && sourceUrls[0]) values[key] = sourceUrls[0];
    else if (/^(urls|websites|startUrls)$/i.test(key)) values[key] = sourceUrls;
    else if (/^(query|q|searchQuery)$/i.test(key)) values[key] = String(context.query ?? "");
    else if (/^start(Date|_date)$/i.test(key)) values[key] = context.startDate;
    else if (/^end(Date|_date)$/i.test(key)) values[key] = context.endDate;
    else if (/^(limit|maxPages|max_pages)$/i.test(key)) values[key] = context.maxPages;
  }
  const missing = required.filter((key) => values[key] === undefined);
  return { values, missing };
}

export async function invokeMcpServersParallel(
  profiles: McpProfile[], requestedToolNames: string[], context: JsonObject,
): Promise<McpInvocationResult[]> {
  const jobs = profiles.map(async (profile) => {
    const session = profile.transport === "stdio" ? stdioSession(profile) : await httpSession(profile);
    try {
      if (profile.transport === "stdio") await session.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "digital-power-monitor", version: "0.2.0" } });
      const catalog = await session.rpc("tools/list");
      const tools = Array.isArray(catalog.tools) ? catalog.tools as JsonObject[] : [];
      const allowed = requestedToolNames.length ? tools.filter((tool) => requestedToolNames.includes(String(tool.name))) :
        tools.filter((tool) => /crawl|scrape|map|search|scan/i.test(String(tool.name))).slice(0, 3);
      const calls = allowed.map(async (tool): Promise<McpInvocationResult> => {
        const toolName = String(tool.name); const started = Date.now();
        const { values, missing } = buildToolArgs((tool.inputSchema ?? {}) as JsonObject, context);
        if (missing.length) return { serverId: profile.id, serverName: profile.name, tool: toolName, ok: false, latencyMs: 0, error: `缺少必填参数：${missing.join(", ")}` };
        try {
          const result = await session.rpc("tools/call", { name: toolName, arguments: values });
          return { serverId: profile.id, serverName: profile.name, tool: toolName, ok: true, latencyMs: Date.now() - started, result };
        } catch (error) {
          return { serverId: profile.id, serverName: profile.name, tool: toolName, ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
        }
      });
      return await Promise.all(calls);
    } finally { await session.close(); }
  });
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((item, index) => item.status === "fulfilled" ? item.value : [{
    serverId: profiles[index].id, serverName: profiles[index].name, tool: "connect", ok: false,
    latencyMs: 0, error: item.reason instanceof Error ? item.reason.message : String(item.reason),
  }]);
}

async function catalogStdio(profile: JsonObject) {
  const normalized = {
    id: String(profile.id ?? "catalog"), name: String(profile.name ?? "MCP"), transport: "stdio",
    url: "", command: String(profile.command ?? ""), args: Array.isArray(profile.args) ? profile.args.map(String) : [],
    headers: {}, env: (profile.env ?? {}) as Record<string, string>, enabled: true, allowTools: [], envKeys: [],
  } as McpProfile;
  const session = stdioSession(normalized);
  try {
    await session.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "digital-power-monitor", version: "0.2.0" } });
    session.notify("notifications/initialized");
    const tools = await session.rpc("tools/list");
    const [resources, prompts] = await Promise.all([
      session.rpc("resources/list").catch((error) => ({ resources: [], unavailable: error instanceof Error ? error.message : String(error) })),
      session.rpc("prompts/list").catch((error) => ({ prompts: [], unavailable: error instanceof Error ? error.message : String(error) })),
    ]);
    return { runtime: session.runtime, tools: tools.tools ?? [], resources: resources.resources ?? [], prompts: prompts.prompts ?? [],
      warnings: [resources.unavailable && `Resources：${resources.unavailable}`, prompts.unavailable && `Prompts：${prompts.unavailable}`].filter(Boolean) };
  } finally { await session.close(); }
}

export function diagnoseMcpError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/method not found/i.test(message)) return "该服务不支持所请求的 MCP 目录方法，可能是协议版本或服务实现不兼容。";
  if (/ENOENT|not recognized|not found/i.test(message)) return "启动命令不存在。npx 配置会自动使用应用内置的 pnpm 兼容运行器；其他命令请填写完整路径。";
  if (/EACCES|EPERM|permission/i.test(message)) return "本机拒绝启动进程或连接远端服务，请检查安全软件、代理和目录权限。";
  if (/401|unauthorized|api.?key|authentication/i.test(message)) return "认证失败，请编辑该 MCP 并重新填写 API Key。留空只会保留旧密钥。";
  if (/403|forbidden|access denied/i.test(message)) return "远端服务拒绝访问，请核实 API Key 权限、套餐与服务区域。";
  if (/timeout|超时|ETIMEDOUT/i.test(message)) return "服务启动或联网超过时限。首次下载 MCP 包可能较慢，请检查网络/代理后重试。";
  if (/提前退出|code [1-9]/i.test(message)) return "MCP 进程启动后异常退出；请展开完整错误，通常是依赖下载、环境变量或运行版本问题。";
  return "MCP 初始化或目录读取失败。请展开完整错误，检查命令、参数、环境变量和远端地址。";
}

export function mapMcpRow(row: Record<string, unknown>, env: Record<string, string> = {}) {
  return {
    id: String(row.id), name: String(row.name), transport: String(row.transport), url: String(row.url ?? ""),
    command: String(row.command ?? ""), args: jsonParse<string[]>(row.args_json, []),
    headers: jsonParse<Record<string, string>>(row.headers_json, {}),
    enabled: Boolean(row.enabled), allowTools: jsonParse<string[]>(row.allow_tools_json, []),
    envKeys: jsonParse<string[]>(row.env_keys_json, []), env,
  };
}
