import type { Browser, BrowserContext } from "playwright-core";
import type { BrowserRenderingRecord, RenderBackend } from "./types";
import { db, jsonParse, now } from "./db";
import { vault } from "./vault";

// 与 crawler.ts 保持一致的指纹（独立维护以避免 crawler ↔ lightpanda 循环依赖）
const USER_AGENT = process.env.DPM_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const ROW_ID = "default";
const DEFAULT_ORDER: RenderBackend[] = ["local", "lightpanda"];
const CIRCUIT_BREAK_MS = 60_000;
const CONFIG_CACHE_MS = 5_000;
const VAULT_KEY = "browser:lightpanda:token";

let configCache: { expiresAt: number; config: BrowserRenderingRecord } | null = null;
let lightpandaPromise: Promise<Browser> | null = null;
let lightpandaDownUntil = 0;
const lightpandaContexts = new Map<string, Promise<BrowserContext>>();

function normalizeEndpoint(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(value)) throw new Error(`Lightpanda 端点必须是 ws:// 或 wss:// 地址：${value}`);
  return value;
}

function appendCloudToken(endpoint: string, token: string) {
  if (!token) return endpoint;
  try {
    const url = new URL(endpoint);
    if (!/(^|\.)cloud\.lightpanda\.io$/i.test(url.hostname)) return endpoint;
    if (url.searchParams.has("token")) return endpoint;
    url.searchParams.set("token", token);
    return url.toString();
  } catch { return endpoint; }
}

function parseOrder(value: unknown): RenderBackend[] {
  const parsed = jsonParse<unknown>(value, []);
  const order = (Array.isArray(parsed) ? parsed : [])
    .filter((item): item is RenderBackend => item === "local" || item === "lightpanda");
  return [...new Set(order)].length ? [...new Set(order)] : [...DEFAULT_ORDER];
}

/** 解析 Lightpanda 配置：DB 设置行优先，环境变量兜底；endpoint 为空则强制停用 */
export function resolveLightpandaConfig(): BrowserRenderingRecord {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.config;
  const row = db.prepare("SELECT * FROM browser_rendering WHERE id=?").get(ROW_ID) as Record<string, unknown> | undefined;
  const envEndpoint = process.env.DPM_LIGHTPANDA_CDP_URL ?? "";
  let endpoint = String(row?.endpoint ?? "").trim();
  let source: BrowserRenderingRecord["source"] = endpoint ? "db" : "none";
  if (!endpoint && envEndpoint) { endpoint = envEndpoint.trim(); source = "env"; }
  const token = vault.get(VAULT_KEY) || (process.env.DPM_LIGHTPANDA_TOKEN ?? "");
  if (endpoint) {
    try {
      endpoint = appendCloudToken(normalizeEndpoint(endpoint), token);
    } catch {
      endpoint = "";
      source = "none";
    }
  }
  const config: BrowserRenderingRecord = {
    // 有设置行时以行的 enabled 为准；无设置行且存在环境变量端点时，env 视为完整配置直接启用
    enabled: (row ? Boolean(row.enabled) : Boolean(envEndpoint)) && Boolean(endpoint),
    endpoint,
    backendOrder: parseOrder(row?.backend_order_json ?? JSON.stringify(DEFAULT_ORDER)),
    connectTimeoutMs: Math.max(1_000, Number(row?.connect_timeout_ms ?? 8_000) || 8_000),
    hasToken: vault.has(VAULT_KEY) || Boolean(process.env.DPM_LIGHTPANDA_TOKEN),
    source,
  };
  configCache = { expiresAt: Date.now() + CONFIG_CACHE_MS, config };
  return config;
}

async function getLightpandaBrowser(): Promise<Browser> {
  const config = resolveLightpandaConfig();
  if (!config.enabled) throw new Error("Lightpanda 未配置或未启用");
  if (Date.now() < lightpandaDownUntil) throw new Error("Lightpanda 端点暂不可用（熔断中，60 秒后自动恢复重试）");
  if (!lightpandaPromise) {
    lightpandaPromise = (async () => {
      const { chromium } = await import("playwright-core");
      // connectOverCDP 无法像 launch 一样传 proxy —— 网络发生在远端浏览器内；
      // 代理选择由 Lightpanda 服务端承担（Cloud 通过 endpoint 的 proxy=/country= 参数）
      return chromium.connectOverCDP(config.endpoint, { timeout: config.connectTimeoutMs });
    })();
    lightpandaPromise.catch(() => {
      lightpandaPromise = null;
      lightpandaDownUntil = Date.now() + CIRCUIT_BREAK_MS;
    });
  }
  return lightpandaPromise;
}

async function getLightpandaContext(url: string): Promise<BrowserContext> {
  const origin = new URL(url).origin;
  let context = lightpandaContexts.get(origin);
  if (!context) {
    context = getLightpandaBrowser().then(async (browser) => {
      try {
        return await browser.newContext({
          userAgent: USER_AGENT,
          locale: "zh-CN",
          timezoneId: "Asia/Shanghai",
          viewport: { width: 1440, height: 900 },
          extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
        });
      } catch {
        // Lightpanda 处于 Beta，Target.createBrowserContext 可能未完整实现；
        // 退回 connectOverCDP 自动创建的默认 context（指纹选项随之丢失，兜底后端可接受）
        const fallback = browser.contexts()[0];
        if (!fallback) throw new Error("Lightpanda 无法创建浏览器上下文");
        return fallback;
      }
    });
    context.catch(() => lightpandaContexts.delete(origin));
    lightpandaContexts.set(origin, context);
  }
  return context;
}

export async function retireLightpandaContext(url: string) {
  let origin = "";
  try { origin = new URL(url).origin; } catch { return; }
  const context = lightpandaContexts.get(origin);
  lightpandaContexts.delete(origin);
  if (!context) return;
  try {
    const resolved = await context;
    const browser = await lightpandaPromise?.catch(() => null);
    // 共享默认 context 不能 close（会端掉所有 origin 的会话），只移除池条目
    if (browser && resolved === browser.contexts()[0]) return;
    await resolved.close();
  } catch { /* context 可能已不可用 */ }
}

export async function renderWithLightpanda(url: string) {
  const context = await getLightpandaContext(url);
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    return { html: await page.content(), url: page.url(), statusCode: response?.status() ?? 0, backend: "lightpanda" as const };
  } finally {
    await page.close();
  }
}

function diagnoseProbeError(message: string, endpoint: string) {
  if (/401|403|unauthorized|forbidden/i.test(message)) return "云端鉴权失败：请检查 token 是否正确、是否已过期";
  if (/ECONNREFUSED|connect|timeout|aborted|ETIMEDOUT/i.test(message)) {
    if (/^wss?:\/\/(127\.0\.0\.1|localhost)/i.test(endpoint)) {
      return "连不上本机 Lightpanda：Windows 无原生二进制，请在 WSL2 或 Docker 中运行 `lightpanda serve --host 127.0.0.1 --port 9222`，或改用 Cloud 模式";
    }
    return "连不上 Lightpanda 端点：请检查地址、网络与代理设置";
  }
  return "连接失败，请检查端点配置与 token";
}

/** 设置页「测试连接」：连接 + 版本读取 + about:blank 开合；不抛异常，结果全部走返回值 */
export async function probeLightpanda(override?: { endpoint?: string; token?: string }) {
  const startedAt = Date.now();
  let endpoint = override?.endpoint?.trim() ?? "";
  if (!endpoint) endpoint = resolveLightpandaConfig().endpoint;
  const token = override?.token?.trim() || vault.get(VAULT_KEY) || (process.env.DPM_LIGHTPANDA_TOKEN ?? "");
  if (!endpoint) return { ok: false, latencyMs: 0, endpoint: "", error: "未配置 Lightpanda 端点", diagnosis: "请先填写并保存端点（Cloud wss 地址或本机 ws://127.0.0.1:9222）" };
  try {
    endpoint = appendCloudToken(normalizeEndpoint(endpoint), token);
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, endpoint: "", error: error instanceof Error ? error.message : String(error), diagnosis: "端点格式不正确" };
  }
  let browser: Browser | null = null;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const version = browser.version();
    const page = await browser.contexts()[0]?.newPage();
    await page?.close();
    return { ok: true, latencyMs: Date.now() - startedAt, endpoint: redactEndpoint(endpoint), version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, latencyMs: Date.now() - startedAt, endpoint: redactEndpoint(endpoint), error: message, diagnosis: diagnoseProbeError(message, endpoint) };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

function redactEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("token")) url.searchParams.set("token", "***");
    return url.toString();
  } catch { return endpoint; }
}

/** CDP 连接的 browser.close() 只断开不断开远端进程：共享服务器安全，Cloud 场景则结束计费会话 */
export async function closeLightpanda() {
  const contexts = [...lightpandaContexts.values()];
  lightpandaContexts.clear();
  const browser = lightpandaPromise;
  lightpandaPromise = null;
  let sharedDefault: BrowserContext | undefined;
  if (browser) sharedDefault = await browser.then((item) => item.contexts()[0]).catch(() => undefined);
  await Promise.allSettled(contexts.map(async (context) => {
    const resolved = await context;
    if (sharedDefault && resolved === sharedDefault) return;
    await resolved.close();
  }));
  if (!browser) return;
  try { await (await browser).close(); } catch { /* 连接可能已断开 */ }
}

/** 保存设置后调用：断开旧连接、清空熔断与配置缓存，使新配置立即生效 */
export async function resetLightpanda() {
  configCache = null;
  lightpandaDownUntil = 0;
  await closeLightpanda();
}

export function upsertBrowserRendering(input: {
  enabled: boolean; endpoint: string; backendOrder: RenderBackend[]; connectTimeoutMs: number;
}) {
  db.prepare(`INSERT INTO browser_rendering (id, enabled, endpoint, backend_order_json, connect_timeout_ms, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, endpoint=excluded.endpoint,
      backend_order_json=excluded.backend_order_json, connect_timeout_ms=excluded.connect_timeout_ms,
      updated_at=excluded.updated_at`)
    .run(ROW_ID, input.enabled ? 1 : 0, input.endpoint.trim(), JSON.stringify(input.backendOrder),
      Math.max(1_000, Math.round(input.connectTimeoutMs) || 8_000), now());
}

export { VAULT_KEY as LIGHTPANDA_VAULT_KEY };
