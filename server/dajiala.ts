import type { CrawledDocument } from "./types";
import { dateStatusFor, documentFromExternalContent, normalizeUrl } from "./crawler";
import { spawn } from "node:child_process";

export const DAJIALA_SOURCE_ID = "dajiala-wechat";
export const DAJIALA_BASE_URL = "https://www.dajiala.com";
export const DAJIALA_KEYWORD_PRICE_CNY = 0.02;
export const DAJIALA_KEYWORD_PAGE_PRICE_CNY = 0.4;
export const DAJIALA_DETAIL_PRICE_CNY = 0.03;
/** 历史接口实际费用以响应 cost_money 为准；调用前用保守估值保护用户上限。 */
export const DAJIALA_HISTORY_ESTIMATE_CNY = 0.16;

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 3;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DajialaCredentials {
  key: string;
  verifycode?: string;
}

export interface DajialaArticle {
  title: string;
  url: string;
  shortLink: string;
  content: string;
  richContent?: string;
  publishedAt: string | null;
  accountName: string;
  accountId: string;
  ghid: string;
  author: string;
  original: boolean | null;
  ipWording: string;
  category: string;
  read?: number;
  praise?: number;
  looking?: number;
  hashId?: string;
}

export interface DajialaSearchOptions {
  credentials: DajialaCredentials;
  kw: string;
  anyKw?: string;
  excludeKw?: string;
  startDate: string;
  endDate: string;
  maxArticles: number;
  maxCostCny: number;
  originalOnly?: boolean;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  delay?: (milliseconds: number) => Promise<void>;
  shouldStop?: () => Promise<void>;
  onPage?: (progress: {
    page: number; totalPages: number; availableTotal: number; accepted: number;
    examined: number; costCny: number; remainMoney?: number;
  }) => void;
}

export interface DajialaSearchResult {
  articles: DajialaArticle[];
  pagesFetched: number;
  availableTotal: number;
  examined: number;
  costCny: number;
  remainMoney?: number;
  truncated: boolean;
}

export interface DajialaAccountReference {
  url?: string;
  ghid?: string;
}

export interface DajialaHistoryArticle extends DajialaArticle {
  position: number;
  deleted: boolean;
  messageStatus?: number;
}

type JsonRecord = Record<string, unknown>;

function curlConfigValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/** Windows 的原生 fetch 不读取系统代理；curl 配置经 stdin 传入，密钥不会出现在进程参数中。 */
async function windowsSystemFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const marker = "\nDPM_HTTP_STATUS:";
  const method = String(init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" ? init.body : "";
  const config = [
    "silent", "show-error", "location", "compressed", "connect-timeout = 20", "max-time = 90",
    `write-out = "${curlConfigValue(`${marker}%{http_code}`)}"`,
    `url = "${curlConfigValue(String(input))}"`,
    `request = "${curlConfigValue(method)}"`,
    ...[...headers].map(([name, value]) => `header = "${curlConfigValue(`${name}: ${value}`)}"`),
    ...(body ? [`data-binary = "${curlConfigValue(body)}"`] : []),
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", ["--config", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const raw = Buffer.concat(stdout).toString("utf8");
      const markerIndex = raw.lastIndexOf(marker);
      if (code !== 0 || markerIndex < 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `系统网络客户端退出码 ${code}`));
        return;
      }
      const status = Number(raw.slice(markerIndex + marker.length).trim());
      if (!Number.isInteger(status) || status < 100 || status > 599) return reject(new Error(`系统网络客户端返回无效状态：${status}`));
      resolve(new Response(raw.slice(0, markerIndex), { status, headers: { "content-type": "application/json" } }));
    });
    child.stdin.end(config, "utf8");
  });
}

async function systemAwareFetch(input: string | URL, init?: RequestInit) {
  try { return await fetch(input, init); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    return windowsSystemFetch(input, init);
  }
}

function text(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function number(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function dajialaDate(value: unknown, fallback?: unknown): string | null {
  for (const candidate of [value, fallback]) {
    const raw = text(candidate);
    const matched = raw.replace(/[./]/g, "-").match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    if (matched) return `${matched[1]}-${matched[2].padStart(2, "0")}-${matched[3].padStart(2, "0")}`;
    const timestamp = Number(candidate);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000;
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(milliseconds));
      const found = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      if (found.year && found.month && found.day) return `${found.year}-${found.month}-${found.day}`;
    }
  }
  return null;
}

function normalizeOriginal(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1" || /原创/.test(text(value))) return true;
  if (value === false || value === 0 || value === "0" || /非原创|转载/.test(text(value))) return false;
  return null;
}

function keywordArticle(row: JsonRecord): DajialaArticle {
  return {
    title: text(row.title), url: normalizeUrl(text(row.url) || text(row.short_link)), shortLink: text(row.short_link),
    content: text(row.content), publishedAt: dajialaDate(row.publish_time_str, row.publish_time),
    accountName: text(row.wx_name), accountId: text(row.wx_id), ghid: text(row.ghid), author: "",
    original: normalizeOriginal(row.is_original), ipWording: text(row.ip_wording), category: text(row.classify),
    read: number(row.read), praise: number(row.praise), looking: number(row.looking),
  };
}

function detailArticle(row: JsonRecord, requestedUrl: string): DajialaArticle {
  return {
    title: text(row.title), url: normalizeUrl(text(row.url) || requestedUrl), shortLink: "",
    content: text(row.content), richContent: text(row.content_multi_text),
    publishedAt: dajialaDate(row.pubtime, row.create_time), accountName: text(row.nick_name),
    accountId: text(row.alias), ghid: text(row.user_name), author: text(row.author),
    original: Number(row.copyright_stat) === 1 ? true : Number(row.copyright_stat) === 0 || Number(row.copyright_stat) === 2 ? false : null,
    ipWording: text(row.ip_wording), category: text(row.item_show_type), hashId: text(row.hashid),
  };
}

function errorFor(payload: JsonRecord) {
  const code = Number(payload.code);
  const message = text(payload.msg || payload.message) || `接口状态码 ${code}`;
  if (code === 10002) return new Error("大家啦 API Key 或附加码不正确");
  if (code === 20001) return new Error("大家啦 API 余额不足，请先充值");
  if (code === 20002 || code === 20003) return new Error("微信文章链接无效，请检查链接格式");
  if (code === 101) return new Error("微信文章已删除、违规或公众号已迁移");
  if (code === 105 || code === 107) return new Error("未找到该公众号；请改用该账号任意一篇文章链接或 ghid 精确定位");
  if (code === 106) return new Error(`微信文章解析失败（${code}）`);
  if (code === 110) return new Error("该公众号暂无历史文章");
  if (code === 115) return new Error("该公众号其余历史文章已删除");
  return new Error(`大家啦 API 返回错误：${message}`);
}

function retryable(payload: JsonRecord) {
  const code = Number(payload.code);
  return [-1, 107, 111, 112, 113, 2003, 2005, 50000].includes(code) || /Internal Server Error/i.test(text(payload.message));
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  delay: (milliseconds: number) => Promise<void>,
  acceptedCodes: number[] = [0],
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const raw = await response.text();
      let payload: JsonRecord;
      try { payload = JSON.parse(raw) as JsonRecord; }
      catch { throw new Error(`大家啦 API 返回了非 JSON 响应（HTTP ${response.status}）`); }
      if (!response.ok) throw new Error(`大家啦 API 返回 HTTP ${response.status}`);
      if (acceptedCodes.includes(Number(payload.code))) return payload;
      if (!retryable(payload)) throw errorFor(payload);
      lastError = errorFor(payload);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /API Key|余额不足|链接无效|已删除|解析失败（10[156]）/.test(error.message)) throw error;
    }
    if (attempt < MAX_RETRIES - 1) await delay(2_000 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error("大家啦 API 请求失败");
}

function historyArticle(row: JsonRecord): DajialaHistoryArticle {
  return {
    title: text(row.title), url: normalizeUrl(text(row.url)), shortLink: text(row.url), content: "",
    publishedAt: dajialaDate(row.post_time_str, row.post_time), accountName: "", accountId: "", ghid: "", author: "",
    original: normalizeOriginal(row.original), ipWording: "", category: text(row.item_show_type),
    position: Number(row.position ?? 0), deleted: Boolean(Number(row.is_deleted ?? 0)),
    messageStatus: number(row.msg_status),
  };
}

export async function fetchDajialaAccountHistoryPage(options: {
  credentials: DajialaCredentials; account: DajialaAccountReference; offset?: string; baseUrl?: string;
  fetchImpl?: FetchLike; delay?: (milliseconds: number) => Promise<void>;
}) {
  if (!options.credentials.key.trim()) throw new Error("尚未配置大家啦 API Key");
  if (![options.account.url, options.account.ghid].some((value) => text(value))) {
    throw new Error("公众号账号定位信息为空");
  }
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const payload = await requestJson(`${options.baseUrl ?? DAJIALA_BASE_URL}/fbmain/monitor/v3/post_history`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      ghid: text(options.account.ghid), url: text(options.account.url), offset: text(options.offset), key: options.credentials.key,
      verifycode: options.credentials.verifycode ?? "",
    }),
  }, options.fetchImpl ?? systemAwareFetch, delay, [0, 110, 115]);
  const rows = Array.isArray(payload.data) ? payload.data as JsonRecord[] : [];
  const articles = rows.map(historyArticle).filter((article) => article.url && article.title && !article.deleted && (article.messageStatus == null || article.messageStatus === 2));
  return {
    articles,
    nextOffset: text(payload.offset), isEnd: Boolean(Number(payload.is_end ?? 0)) || Number(payload.code) === 110 || Number(payload.code) === 115,
    totalArticles: Math.max(0, Number(payload.now_page_articles_num ?? articles.length)),
    accountName: text(payload.nickname || payload.mp_nickname), accountId: text(payload.mp_wxid), ghid: text(payload.ghid || payload.mp_ghid),
    costCny: Math.max(0, Number(payload.cost_money ?? 0)), remainMoney: number(payload.remain_money),
    terminal: Number(payload.code) === 110 || Number(payload.code) === 115,
  };
}

function periodDays(startDate: string) {
  const today = new Date();
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const difference = Math.ceil((today.getTime() - start.getTime()) / 86_400_000) + 2;
  return Math.max(1, Math.min(3_650, difference));
}

export async function testDajialaConnection(
  credentials: DajialaCredentials,
  options: { baseUrl?: string; fetchImpl?: FetchLike; delay?: (milliseconds: number) => Promise<void> } = {},
) {
  if (!credentials.key.trim()) throw new Error("尚未配置大家啦 API Key");
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? systemAwareFetch;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const payload = await requestJson(`${options.baseUrl ?? DAJIALA_BASE_URL}/fbmain/monitor/v3/get_remain_money`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ key: credentials.key, verifycode: credentials.verifycode ?? "" }),
  }, fetchImpl, delay);
  return {
    ok: true, latencyMs: Date.now() - startedAt, remainMoney: number(payload.remain_money) ?? 0,
    yesterdayMoney: number(payload.yesterday_money), requestTime: text(payload.request_time),
  };
}

export async function searchDajialaArticles(options: DajialaSearchOptions): Promise<DajialaSearchResult> {
  if (![options.kw, options.anyKw, options.excludeKw].some((value) => text(value))) {
    throw new Error("关键词、扩展关键词和排除关键词至少填写一项");
  }
  if (!options.credentials.key.trim()) throw new Error("尚未配置大家啦 API Key");
  const fetchImpl = options.fetchImpl ?? systemAwareFetch;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxArticles = Math.max(1, Math.floor(options.maxArticles));
  const maxCostCny = Math.max(DAJIALA_KEYWORD_PRICE_CNY, Number(options.maxCostCny));
  const accepted: DajialaArticle[] = [];
  const seen = new Set<string>();
  let page = 1;
  let pagesFetched = 0;
  let totalPages = 1;
  let availableTotal = 0;
  let examined = 0;
  let costCny = 0;
  let remainMoney: number | undefined;
  let exhaustedByDate = false;

  while (page <= totalPages && accepted.length < maxArticles) {
    await options.shouldStop?.();
    // kw_search 固定每页返回 20 条并按返回条数计费；即使只需要 1 条，也要为完整一页预留费用。
    const estimatedNextCost = DAJIALA_KEYWORD_PAGE_PRICE_CNY;
    if (costCny + estimatedNextCost > maxCostCny + 1e-9) break;
    const payload = await requestJson(`${options.baseUrl ?? DAJIALA_BASE_URL}/fbmain/monitor/v3/kw_search`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        kw: text(options.kw), any_kw: text(options.anyKw), ex_kw: text(options.excludeKw),
        sort_type: 1, mode: 1, period: periodDays(options.startDate), page,
        key: options.credentials.key, verifycode: options.credentials.verifycode ?? "", type: 1,
      }),
    }, fetchImpl, delay);
    const rows = Array.isArray(payload.data) ? payload.data as JsonRecord[] : [];
    pagesFetched++;
    totalPages = Math.max(1, Number(payload.total_page ?? 1));
    availableTotal = Math.max(availableTotal, Number(payload.total ?? rows.length));
    costCny += Math.max(0, Number(payload.cost_money ?? 0));
    remainMoney = number(payload.remain_money) ?? remainMoney;
    examined += rows.length;
    const articles = rows.map(keywordArticle).filter((article) => article.url);
    for (const article of articles) {
      if (!article.publishedAt || article.publishedAt < options.startDate || article.publishedAt > options.endDate) continue;
      if (options.originalOnly && article.original !== true) continue;
      if (seen.has(article.url)) continue;
      seen.add(article.url);
      accepted.push(article);
      if (accepted.length >= maxArticles) break;
    }
    const dated = articles.map((article) => article.publishedAt).filter((value): value is string => Boolean(value));
    exhaustedByDate = dated.length > 0 && dated.every((date) => date < options.startDate);
    options.onPage?.({ page, totalPages, availableTotal, accepted: accepted.length, examined, costCny, remainMoney });
    if (!rows.length || exhaustedByDate) break;
    page++;
    if (page <= totalPages && accepted.length < maxArticles) await delay(1_000);
  }
  return {
    articles: accepted, pagesFetched, availableTotal, examined, costCny, remainMoney,
    truncated: accepted.length >= maxArticles || page <= totalPages && !exhaustedByDate,
  };
}

export async function fetchDajialaArticleDetail(options: {
  credentials: DajialaCredentials; url: string; baseUrl?: string; fetchImpl?: FetchLike;
  delay?: (milliseconds: number) => Promise<void>;
}) {
  if (!options.credentials.key.trim()) throw new Error("尚未配置大家啦 API Key");
  const articleUrl = normalizeUrl(options.url);
  if (!/^https?:\/\/mp\.weixin\.qq\.com\//i.test(articleUrl)) throw new Error("请输入有效的微信公众号文章链接");
  const endpoint = new URL(`${options.baseUrl ?? DAJIALA_BASE_URL}/fbmain/monitor/v3/article_detail`);
  endpoint.searchParams.set("url", articleUrl);
  endpoint.searchParams.set("key", options.credentials.key);
  endpoint.searchParams.set("mode", "2");
  endpoint.searchParams.set("verifycode", options.credentials.verifycode ?? "");
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const payload = await requestJson(endpoint.toString(), { method: "GET", headers: { Accept: "application/json" } }, options.fetchImpl ?? systemAwareFetch, delay);
  return {
    article: detailArticle(payload, articleUrl), costCny: Math.max(0, Number(payload.cost_money ?? DAJIALA_DETAIL_PRICE_CNY)),
    remainMoney: number(payload.remain_money),
  };
}

export function dajialaArticleToDocument(article: DajialaArticle, startDate: string, endDate: string, sourceId = DAJIALA_SOURCE_ID): CrawledDocument {
  const metadata = [
    `微信公众号：${article.accountName || "未知"}`,
    article.accountId ? `微信号：${article.accountId}` : "",
    article.author ? `作者：${article.author}` : "",
    article.original == null ? "" : `原创状态：${article.original ? "原创" : "非原创或转载"}`,
    article.ipWording ? `发布地区：${article.ipWording}` : "",
    article.category ? `内容分类：${article.category}` : "",
    Number.isFinite(article.read) ? `阅读数：${article.read}` : "",
    Number.isFinite(article.praise) ? `点赞数：${article.praise}` : "",
    Number.isFinite(article.looking) ? `在看数：${article.looking}` : "",
  ].filter(Boolean).join("\n");
  const document = documentFromExternalContent({
    url: article.url, sourceId, title: article.title,
    publishedAt: article.publishedAt, provider: "大家啦微信内容 API",
    markdown: `${metadata}\n\n正文：\n${article.content}`,
  });
  document.dateStatus = dateStatusFor(document, startDate, endDate);
  document.fetchMode = "static";
  document.rendered = false;
  document.discoveryMethod = "account-history";
  document.pageType = "article";
  document.extractionMethod = "dajiala-wechat-api";
  document.warnings = [
    "正文与公众号元数据来自大家啦 API；请遵守微信和接口服务商的内容使用条款",
    ...(article.accountName ? [`公众号：${article.accountName}`] : []),
  ];
  return document;
}
