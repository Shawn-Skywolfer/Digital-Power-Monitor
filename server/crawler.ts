import * as cheerio from "cheerio";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import type {
  CrawledDocument, DateStatus, DiscoveryMethod, DiscoveryReport, FieldDefinition,
  JsonObject, SourceRecord,
} from "./types";
import { DATA_DIR } from "./db";

const USER_AGENT = process.env.DPM_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CONTENT_PATH = /news|press|media|article|story|project|blog|insight|announcement|release|20\d{2}[/-]\d{1,2}/i;
const ARCHIVE_PATH = /news|press|media|articles?|archive|category|page|posts?|updates?|search|20\d{2}/i;
const FILE_PATH = /\.(?:jpg|jpeg|png|gif|svg|webp|ico|css|js|woff2?|ttf|zip|rar|xlsx?|docx?|pptx?|mp4|mp3)(?:$|\?)/i;
const ENERGY_TERMS = /光伏|储能|新能源|太阳能|风电|电站|EPC|solar|photovoltaic|battery|storage|renewable|wind\s*(?:farm|power|energy)|energy project/i;
const PROJECT_TERMS = /项目|电站|电场|园区|基地|中标|开工|投产|并网|签署|合同|收购|融资|获批|project|plant|farm|facility|site|award|contract|construction|commission|acqui|financ|approv/i;

let browserPromise: Promise<Browser> | null = null;
const browserContexts = new Map<string, Promise<BrowserContext>>();
const robotsCache = new Map<string, { expiresAt: number; sitemapUrls: string[]; disallowed: string[] }>();

const BLOCK_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "BOT_CHALLENGE", pattern: /captcha|verify (?:that )?you are human|checking your browser|just a moment|cloudflare|人机验证|验证码|安全验证/i },
  { code: "ACCESS_DENIED", pattern: /access denied|request (?:has been )?blocked|permission denied|forbidden|拒绝访问|访问被拒绝|无权访问/i },
];

export function normalizeUrl(input: string, base?: string) {
  let value = input.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value) && !base) value = `https://${value}`;
  try {
    const url = new URL(value, base);
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(spm|from|source|ref|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return ""; }
}

async function readRobots(target: URL) {
  const cached = robotsCache.get(target.origin);
  if (cached && cached.expiresAt > Date.now()) {
    return { sitemapUrls: [...cached.sitemapUrls], disallowed: [...cached.disallowed] };
  }
  const sitemapUrls: string[] = [];
  const disallowed: string[] = [];
  try {
    const response = await fetch(`${target.origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      robotsCache.set(target.origin, { expiresAt: Date.now() + 10 * 60_000, sitemapUrls, disallowed });
      return { sitemapUrls, disallowed };
    }
    const lines = (await response.text()).split(/\r?\n/);
    let active = false;
    for (const raw of lines) {
      const line = raw.split("#")[0].trim();
      if (/^sitemap:/i.test(line)) {
        const sitemap = normalizeUrl(line.split(":").slice(1).join(":").trim(), target.origin);
        if (sitemap) sitemapUrls.push(sitemap);
      } else if (/^user-agent:/i.test(line)) {
        const agent = line.split(":").slice(1).join(":").trim();
        active = agent === "*" || /DigitalPowerMonitor/i.test(agent);
      } else if (active && /^disallow:/i.test(line)) {
        const value = line.split(":").slice(1).join(":").trim();
        if (value) disallowed.push(value);
      }
    }
  } catch { /* coverage report records page-level failures */ }
  robotsCache.set(target.origin, { expiresAt: Date.now() + 30 * 60_000, sitemapUrls, disallowed });
  return { sitemapUrls, disallowed };
}

async function robotsAllowed(target: URL) {
  const { disallowed } = await readRobots(target);
  return !disallowed.some((item) => target.pathname.startsWith(item));
}

function dateFromText(value?: string | null) {
  if (!value) return null;
  const match = value.match(/(20\d{2})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${(match[3] ?? "01").padStart(2, "0")}`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function hintCouldBeInRange(value: string | undefined, startDate: string, endDate: string) {
  const normalized = dateFromText(value);
  return !normalized || (normalized >= startDate && normalized <= endDate);
}

function networkErrorDetail(error: unknown, url: string) {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      if (current.message && !parts.includes(current.message)) parts.push(current.message);
      const record = current as Error & { code?: string; address?: string; port?: number; cause?: unknown };
      if (record.code) parts.push(record.code);
      if (record.address) parts.push(`${record.address}${record.port ? `:${record.port}` : ""}`);
      current = record.cause;
    } else { break; }
  }
  const joined = parts.join(" · ") || String(error);
  if (/198\.(?:18|19)\.\d+\.\d+/.test(joined)) {
    return `代理或 DNS 不可达：${url} · ${joined}。目标解析到了 198.18.0.0/15 Fake-IP 保留网段，请检查代理/TUN 的路由、规则和进程权限`;
  }
  if (/EACCES|EPERM|ECONNREFUSED|ENETUNREACH/i.test(joined)) {
    return `网络或代理连接失败：${url} · ${joined}`;
  }
  return joined;
}

async function fetchText(url: string, accept = "text/html,application/xml,text/xml,*/*") {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(25_000), redirect: "follow",
    });
  } catch (error) {
    throw new Error(networkErrorDetail(error, url));
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { text: await response.text(), url: response.url, contentType: response.headers.get("content-type") ?? "" };
}

function browserExecutableCandidates() {
  const local = process.env.LOCALAPPDATA ?? "";
  const program = process.env.PROGRAMFILES ?? "";
  const programX86 = process.env["PROGRAMFILES(X86)"] ?? "";
  return [
    process.env.DPM_BROWSER_PATH ?? "",
    path.join(program, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(program, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright-core");
      const executablePath = browserExecutableCandidates().find((candidate) => fs.existsSync(candidate));
      if (!executablePath) throw new Error("未找到可用的 Chrome 或 Edge；可通过 DPM_BROWSER_PATH 指定浏览器");
      const proxyServer = process.env.DPM_BROWSER_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
      return chromium.launch({
        executablePath, headless: true,
        ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
      });
    })();
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

export async function closeCrawlerBrowser() {
  const contexts = [...browserContexts.values()];
  browserContexts.clear();
  await Promise.allSettled(contexts.map(async (context) => (await context).close()));
  const current = browserPromise;
  browserPromise = null;
  if (!current) return;
  try { await (await current).close(); } catch { /* browser may already be unavailable */ }
}

async function getBrowserContext(url: string) {
  const origin = new URL(url).origin;
  let context = browserContexts.get(origin);
  if (!context) {
    context = getBrowser().then((browser) => browser.newContext({
      userAgent: USER_AGENT,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    }));
    context.catch(() => browserContexts.delete(origin));
    browserContexts.set(origin, context);
  }
  return context;
}

async function retireBrowserContext(url: string) {
  const origin = new URL(url).origin;
  const context = browserContexts.get(origin);
  browserContexts.delete(origin);
  if (context) await (await context).close().catch(() => undefined);
}

async function renderHtml(url: string) {
  const context = await getBrowserContext(url);
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    return { html: await page.content(), url: page.url(), statusCode: response?.status() ?? 0 };
  } finally {
    await page.close();
  }
}

export function detectAccessBlock(statusCode: number, title: string, text: string) {
  if (statusCode === 429) return { code: "RATE_LIMITED", reason: "远端站点返回 HTTP 429（请求过多）" };
  const sample = `${title}\n${text.slice(0, 8_000)}`;
  for (const item of BLOCK_PATTERNS) {
    if (item.pattern.test(sample)) return { code: item.code, reason: `页面内容命中 ${item.code} 阻断特征` };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { code: "ACCESS_DENIED", reason: `远端站点返回 HTTP ${statusCode}` };
  }
  return null;
}

function needsBrowser(html: string, force = false) {
  if (force) return true;
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const links = $("a[href]").length;
  return bodyText.length < 500 || links < 3 ||
    /enable javascript|javascript is required|id=["'](?:root|app|__next)["'][^>]*>\s*<\/div>/i.test(html);
}

async function discoveryHtml(url: string, forceBrowser = false) {
  let result: Awaited<ReturnType<typeof fetchText>> | null = null;
  let staticError = "";
  try {
    result = await fetchText(url);
  } catch (error) {
    staticError = error instanceof Error ? error.message : String(error);
  }
  if (result && !needsBrowser(result.text, forceBrowser)) {
    const blocked = detectAccessBlock(200, "", result.text);
    if (!blocked) return { html: result.text, url: result.url, rendered: false, statusCode: 200 };
  }
  try {
    const rendered = await renderHtml(result?.url ?? url);
    const parsed = parseHtml(rendered.html, rendered.url);
    const blocked = detectAccessBlock(rendered.statusCode, parsed.title, parsed.text);
    if (blocked) throw new Error(`${blocked.code}：${blocked.reason}`);
    if (rendered.statusCode >= 400) throw new Error(`HTTP ${rendered.statusCode}`);
    return { ...rendered, rendered: true };
  } catch (error) {
    if (result) return { html: result.text, url: result.url, rendered: false, statusCode: 200 };
    const browserError = error instanceof Error ? error.message : String(error);
    throw new Error(`静态请求失败：${staticError || "未知错误"}；浏览器回退失败：${browserError}`);
  }
}

function nearbyDate($: cheerio.CheerioAPI, element: unknown) {
  const node = $(element as never);
  const container = node.closest("article,li,div").first();
  const text = `${node.text()} ${container.text()}`.replace(/\s+/g, " ").slice(0, 600);
  return dateFromText(text) ?? undefined;
}

export async function discoverSourcePages(
  source: SourceRecord, startDate: string, endDate: string, maxPages: number,
): Promise<DiscoveryReport> {
  const startUrl = normalizeUrl(source.url);
  const report: DiscoveryReport = {
    pages: [], strategies: [], discoveryPagesFetched: 0, truncated: false, failures: [],
  };
  if (!startUrl || maxPages <= 0) return report;
  const origin = new URL(startUrl).origin;
  const candidates = new Map<string, { method: DiscoveryMethod; dateHint?: string; label?: string }>();
  const methodCounts = new Map<DiscoveryMethod, number>();
  const perMethodPool = Math.min(500, Math.max(60, maxPages * 8));
  const add = (url: string, method: DiscoveryMethod, dateHint?: string, label?: string) => {
    const normalized = normalizeUrl(url, startUrl);
    if (!normalized || FILE_PATH.test(normalized)) return;
    try {
      if (new URL(normalized).origin !== origin || candidates.has(normalized) ||
        (methodCounts.get(method) ?? 0) >= perMethodPool) return;
      const normalizedHint = dateFromText(dateHint);
      // Sitemap lastmod is not a publication date. It can safely deprioritize pages
      // that were last changed before the range, but pages updated after the range
      // still need article-level publication-date verification.
      const eligible = method === "sitemap"
        ? !normalizedHint || normalizedHint >= startDate
        : hintCouldBeInRange(dateHint, startDate, endDate);
      if (eligible) {
        candidates.set(normalized, { method, dateHint, label });
        methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
      }
    } catch { /* ignore malformed links */ }
  };

  const robots = await readRobots(new URL(startUrl));
  const sitemapQueue = [...new Set([...robots.sitemapUrls, `${origin}/sitemap.xml`])];
  const seenSitemaps = new Set<string>();
  for (let index = 0; index < sitemapQueue.length && index < 30 &&
    (methodCounts.get("sitemap") ?? 0) < perMethodPool; index++) {
    const sitemapUrl = normalizeUrl(sitemapQueue[index]);
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    try {
      const { text } = await fetchText(sitemapUrl);
      report.discoveryPagesFetched++;
      const $ = cheerio.load(text, { xmlMode: true });
      const isIndex = $("sitemapindex").length > 0;
      if (isIndex) {
        $("sitemap > loc").each((_, element) => {
          const child = normalizeUrl($(element).text(), sitemapUrl);
          if (child && !seenSitemaps.has(child)) sitemapQueue.push(child);
        });
      } else {
        $("url").each((_, element) => {
          const loc = $(element).find("loc").first().text().trim();
          const lastmod = $(element).find("lastmod").first().text().trim();
          add(loc, "sitemap", lastmod);
        });
      }
    } catch (error) {
      if (sitemapUrl !== `${origin}/sitemap.xml`) report.failures.push(`Sitemap ${sitemapUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (seenSitemaps.size) report.strategies.push("sitemap");

  let home: Awaited<ReturnType<typeof discoveryHtml>> | null = null;
  try {
    home = await discoveryHtml(startUrl, /dynamic|spa|javascript/i.test(source.type));
    report.discoveryPagesFetched++;
  } catch (error) {
    report.failures.push(`入口页 ${startUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Only probe conventional feed paths after the entry page is reachable.
  // Otherwise three sequential network timeouts can consume minutes for one
  // unavailable source and prevent the remaining sources from being scanned.
  const feedUrls = new Set<string>(home ? [`${origin}/feed`, `${origin}/rss.xml`, `${origin}/feed.xml`] : []);
  if (home) {
    const $ = cheerio.load(home.html);
    $("link[rel='alternate'][href]").each((_, element) => {
      const type = String($(element).attr("type") ?? "");
      if (/rss|atom|xml/i.test(type)) feedUrls.add(normalizeUrl(String($(element).attr("href")), home!.url));
    });
  }
  for (const feedUrl of [...feedUrls].filter(Boolean).slice(0, 8)) {
    if ((methodCounts.get("rss") ?? 0) >= perMethodPool) break;
    try {
      const { text } = await fetchText(feedUrl);
      report.discoveryPagesFetched++;
      const $ = cheerio.load(text, { xmlMode: true });
      let found = 0;
      $("item,entry").each((_, element) => {
        const node = $(element);
        const link = node.find("link").first().attr("href") || node.find("link").first().text();
        const date = node.find("pubDate,published,updated,date").first().text();
        if (link) { add(link, "rss", date); found++; }
      });
      if (found) report.strategies.push("rss");
    } catch { /* common feed candidates are best-effort */ }
  }

  if (home) {
    report.strategies.push(home.rendered ? "browser-archive" : "archive");
    const queue: string[] = [home.url];
    const visited = new Set<string>();
    const maxDiscoveryPages = Math.min(60, Math.max(8, Math.ceil(maxPages / 15)));
    while (queue.length && visited.size < maxDiscoveryPages &&
      ((methodCounts.get("archive") ?? 0) + (methodCounts.get("page-link") ?? 0)) < perMethodPool * 2) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      try {
        const loaded = current === home.url ? home : await discoveryHtml(current);
        if (current !== home.url) report.discoveryPagesFetched++;
        const $ = cheerio.load(loaded.html);
        $("a[href]").each((_, element) => {
          const href = normalizeUrl(String($(element).attr("href") ?? ""), loaded.url);
          if (!href || FILE_PATH.test(href)) return;
          let url: URL;
          try { url = new URL(href); } catch { return; }
          if (url.origin !== origin) return;
          const label = $(element).text().replace(/\s+/g, " ").trim();
          const hint = nearbyDate($, element);
          const archiveLike = ARCHIVE_PATH.test(`${url.pathname} ${label}`) &&
            /page|archive|category|news|press|media|older|next|下一|更多|20\d{2}/i.test(`${url.pathname} ${label}`);
          if (archiveLike && !visited.has(href) && !queue.includes(href)) queue.push(href);
          const contentLike = Boolean(hint) || CONTENT_PATH.test(url.pathname) ||
            (label.length >= 8 && !archiveLike && url.pathname.split("/").filter(Boolean).length >= 2);
          if (contentLike) add(href, archiveLike ? "archive" : "page-link", hint, label);
        });
      } catch (error) {
        report.failures.push(`列表页 ${current}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (queue.length) report.truncated = true;
  }

  if (!candidates.size) add(startUrl, "source");
  const methodScore: Record<DiscoveryMethod, number> = {
    rss: 45, "page-link": 35, archive: 25, sitemap: 20, search: 18, mcp: 18, source: 0,
  };
  const ranked = [...candidates.entries()].map(([url, value]) => {
    const parsed = new URL(url);
    const normalizedDate = dateFromText(value.dateHint);
    const dateScore = normalizedDate && normalizedDate >= startDate && normalizedDate <= endDate ? 80 :
      normalizedDate && normalizedDate >= startDate ? 20 : 0;
    const contentScore = CONTENT_PATH.test(parsed.pathname) ? 18 : 0;
    const signalScore = ENERGY_TERMS.test(`${parsed.pathname} ${value.label ?? ""}`) ||
      PROJECT_TERMS.test(`${parsed.pathname} ${value.label ?? ""}`) ? 22 : 0;
    const listingPenalty = /(?:^|\/)(?:archive|category|search|list|page)(?:\/|$)/i.test(parsed.pathname) ? 25 : 0;
    return { url, method: value.method, dateHint: value.dateHint, score: methodScore[value.method] + dateScore + contentScore + signalScore - listingPenalty };
  }).sort((left, right) => right.score - left.score || String(right.dateHint ?? "").localeCompare(String(left.dateHint ?? "")));
  if (ranked.length > maxPages) report.truncated = true;
  report.pages = ranked.slice(0, maxPages).map((page) => ({
    url: page.url, method: page.method, dateHint: page.dateHint,
  }));
  report.strategies = [...new Set(report.strategies)];
  return report;
}

function jsonLdDates(value: unknown, output: string[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => jsonLdDates(item, output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(datePublished|dateCreated)$/i.test(key) && typeof item === "string") output.push(item);
      else jsonLdDates(item, output);
    }
  }
}

function parseHtml(html: string, responseUrl: string) {
  const $ = cheerio.load(html);
  let structuredArticle = false;
  let structuredBody = "";
  let structuredTitle = "";
  const inspectStructured = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(inspectStructured);
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    const types = Array.isArray(item["@type"]) ? item["@type"].map(String) : [String(item["@type"] ?? "")];
    if (types.some((type) => /Article|NewsArticle|Report|BlogPosting/i.test(type))) structuredArticle = true;
    if (typeof item.articleBody === "string" && item.articleBody.length > structuredBody.length) structuredBody = item.articleBody;
    if (typeof item.headline === "string" && !structuredTitle) structuredTitle = item.headline;
    Object.values(item).forEach(inspectStructured);
  };
  const dateValues: string[] = [
    $("meta[property='article:published_time']").attr("content"),
    $("meta[name='publishdate']").attr("content"),
    $("meta[name='date']").attr("content"),
    $("meta[name='DC.date.issued']").attr("content"),
    $("time[datetime]").first().attr("datetime"),
  ].filter(Boolean) as string[];
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      const value = JSON.parse($(element).text());
      jsonLdDates(value, dateValues);
      inspectStructured(value);
    } catch { /* invalid JSON-LD */ }
  });
  if (!dateValues.length) {
    const urlDate = new URL(responseUrl).pathname.match(/20\d{2}[/-]\d{1,2}[/-]\d{1,2}/)?.[0];
    const bodyDate = $("body").text().match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/)?.[0];
    if (urlDate) dateValues.push(urlDate);
    else if (bodyDate) dateValues.push(bodyDate);
  }
  const dateCandidates = [...new Set(dateValues.map((item) => dateFromText(item)).filter(Boolean) as string[])];
  const publishedAt = dateCandidates[0] ?? null;
  const title = structuredTitle || $("meta[property='og:title']").attr("content") || $("h1").first().text().trim() ||
    $("title").first().text().trim() || responseUrl;
  const originalArticleCount = $("article").length;
  const datedBlocks = $("time,[datetime]").length + ($("body").text().match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/g)?.length ?? 0);
  const originalLinkCount = $("a[href]").length;
  const ogArticle = /article/i.test(String($("meta[property='og:type']").attr("content") ?? ""));
  $("script,style,noscript,svg,nav,footer,form,aside").remove();
  $("[aria-hidden='true'],.nav,.navbar,.menu,.footer,.sidebar,.related,.recommend,.breadcrumb,.share,.advertisement,.cookie").remove();
  const candidates = $("article,main,[role='main'],.article-content,.article-body,.post-content,.entry-content,.detail-content,.news-content,.TRS_Editor,#zoom,[class*='article_content'],[class*='article-content'],.content").toArray();
  let best = $("body");
  let bestScore = -Infinity;
  let extractionMethod = "body-fallback";
  for (const element of candidates) {
    const node = $(element);
    const content = node.text().replace(/\s+/g, " ").trim();
    if (content.length < 120) continue;
    const linkText = node.find("a").text().replace(/\s+/g, " ").length;
    const paragraphs = node.find("p").length;
    const headings = node.find("h1,h2,h3").length;
    const score = content.length + paragraphs * 180 + headings * 60 - linkText * 2.5;
    if (score > bestScore) { best = node; bestScore = score; extractionMethod = "content-density"; }
  }
  const domText = best.text().replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
  const text = (structuredBody.length > domText.length * 0.7 ? structuredBody : domText).slice(0, 250_000);
  if (structuredBody.length > domText.length * 0.7) extractionMethod = "json-ld-articleBody";
  const url = new URL(responseUrl);
  const isRoot = url.pathname === "/" || url.pathname === "";
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const lastPathSegment = pathSegments.at(-1) ?? "";
  const listingPath = /^(?:archive|category|news|press|media|projects?|search|list)$/i.test(lastPathSegment) ||
    /(?:^|\/)(?:archive|category|search|list|page)(?:\/|$)/i.test(url.pathname);
  const articleSignal = structuredArticle || ogArticle ||
    (originalArticleCount === 1 && best.find("p").length >= 1 && (Boolean(publishedAt) || text.length >= 500) && !isRoot) ||
    (Boolean(publishedAt) && text.length >= 350 && datedBlocks < 8 && !isRoot && !listingPath);
  const listingSignal = originalArticleCount >= 3 || datedBlocks >= 8 ||
    (listingPath && originalLinkCount >= 12);
  const pageType: CrawledDocument["pageType"] = articleSignal ? "article" : isRoot ? "homepage" : listingSignal ? "listing" : "unknown";
  return { title, text, publishedAt, dateCandidates, dateEvidence: dateValues[0] ?? "", pageType, extractionMethod };
}

export function dateStatusFor(document: Pick<CrawledDocument, "publishedAt" | "dateCandidates">, startDate: string, endDate: string): DateStatus {
  if (document.dateCandidates.length > 1) return "date_conflict";
  if (!document.publishedAt) return "date_unknown";
  return document.publishedAt >= startDate && document.publishedAt <= endDate ? "within_range" : "outside_range";
}

export async function fetchDocument(
  url: string, sourceId: string, discoveryMethod: DiscoveryMethod = "page-link", forceBrowser = false,
): Promise<CrawledDocument> {
  const id = randomUUID();
  const canonicalUrl = normalizeUrl(url);
  const fetchedAt = new Date().toISOString();
  if (!canonicalUrl) return failed(id, url, sourceId, fetchedAt, "无效网址", discoveryMethod, "INVALID_URL");
  const parsed = new URL(canonicalUrl);
  if (!(await robotsAllowed(parsed))) return failed(id, canonicalUrl, sourceId, fetchedAt, "robots.txt 禁止抓取", discoveryMethod, "ROBOTS_DENIED");
  try {
    let response: Response | null = null;
    let attemptCount = 0;
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      attemptCount = attempt;
      try {
        response = await fetch(canonicalUrl, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/pdf,text/plain,*/*", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
          signal: AbortSignal.timeout(30_000), redirect: "follow",
        });
        if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) break;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = networkErrorDetail(error, canonicalUrl);
        // DNS, proxy and connect-timeout failures are not improved by three
        // immediate retries. Preserve retries for transient HTTP responses.
        if (/ENOTFOUND|EAI_AGAIN|EACCES|EPERM|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|Connect Timeout|198\.(?:18|19)\./i.test(lastError) || attempt === 3) {
          throw new Error(lastError);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 600));
    }
    if (!response) throw new Error(lastError || "请求未返回响应");
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    let bytes = Buffer.from(await response.arrayBuffer());
    let responseUrl = response.url;
    let effectiveStatusCode = response.status;
    let rendered = false;
    let fetchMode: "static" | "browser" = "static";
    const warnings: string[] = [];
    if (contentType.includes("html") || contentType.includes("text")) {
      const staticHtml = bytes.toString("utf8");
      if (needsBrowser(staticHtml, forceBrowser || [401, 403, 429].includes(response.status))) {
        try {
          const dynamic = await renderHtml(response.url);
          bytes = Buffer.from(dynamic.html, "utf8");
          responseUrl = dynamic.url;
          effectiveStatusCode = dynamic.statusCode || response.status;
          rendered = true;
          fetchMode = "browser";
        } catch (error) {
          warnings.push(`动态渲染失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const ext = contentType.includes("pdf") ? "pdf" : contentType.includes("html") || contentType.includes("text") ? "html" : "bin";
    const rawPath = path.join(DATA_DIR, "documents", `${hash}.${ext}`);
    if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, bytes);
    let title = responseUrl;
    let text = "";
    let markdown = "";
    let publishedAt: string | null = null;
    let dateCandidates: string[] = [];
    let dateEvidence = "";
    let pageType: CrawledDocument["pageType"] = contentType.includes("pdf") ? "document" : "unknown";
    let extractionMethod = contentType.includes("pdf") ? "pdf-archive" : "basic";
    if (contentType.includes("html") || contentType.includes("text")) {
      const parsedHtml = parseHtml(bytes.toString("utf8"), responseUrl);
      ({ title, text, publishedAt, dateCandidates, dateEvidence, pageType, extractionMethod } = parsedHtml);
      markdown = `# ${title}\n\n来源：${responseUrl}\n\n发布日期：${publishedAt ?? "未识别"}\n\n抓取方式：${fetchMode}\n\n${text}`;
      if (text.length < 200) warnings.push("正文过短，可能未完整提取");
    } else if (contentType.includes("pdf")) {
      title = path.basename(new URL(responseUrl).pathname) || "PDF 文档";
      warnings.push("PDF 已归档但尚未执行正文识别");
      markdown = `# ${title}\n\n来源：${responseUrl}\n\nPDF 原文件已归档；当前任务未对该文件执行正文识别。`;
    }
    const markdownPath = path.join(DATA_DIR, "documents", `${hash}.md`);
    if (!fs.existsSync(markdownPath)) fs.writeFileSync(markdownPath, markdown, "utf8");
    const blocked = detectAccessBlock(effectiveStatusCode, title, text);
    if (blocked) warnings.push(blocked.reason);
    if (blocked && rendered) await retireBrowserContext(responseUrl);
    const httpError = !blocked && effectiveStatusCode >= 400 ? `HTTP ${effectiveStatusCode}` : "";
    return {
      id, url: responseUrl, canonicalUrl: normalizeUrl(responseUrl), title, publishedAt, fetchedAt,
      contentType, statusCode: effectiveStatusCode, hash, text, markdown, rawPath, markdownPath, sourceId,
      dateCandidates, dateStatus: publishedAt ? "within_range" : "date_unknown", dateEvidence,
      fetchMode, rendered, discoveryMethod, warnings, pageType, extractionMethod, attemptCount,
      failureCode: blocked?.code ?? (httpError ? `HTTP_${effectiveStatusCode}` : undefined),
      error: blocked ? blocked.reason : httpError || undefined,
    };
  } catch (error) {
    const message = networkErrorDetail(error, canonicalUrl);
    const code = /198\.(?:18|19)\.|EACCES|EPERM|proxy|代理/i.test(message) ? "PROXY_OR_DNS" :
      /timeout|aborted/i.test(message) ? "TIMEOUT" : /ENOTFOUND|EAI_AGAIN|fetch failed|ECONN/i.test(message) ? "NETWORK" : "FETCH_ERROR";
    return failed(id, canonicalUrl, sourceId, fetchedAt, message, discoveryMethod, code);
  }
}

export function documentFromExternalContent(input: {
  url: string; sourceId: string; markdown?: string; html?: string; title?: string; publishedAt?: string | null;
  statusCode?: number; provider: string;
}): CrawledDocument {
  const canonicalUrl = normalizeUrl(input.url);
  const fetchedAt = new Date().toISOString();
  const id = randomUUID();
  if (!canonicalUrl) return failed(id, input.url, input.sourceId, fetchedAt, "外部采集返回无效网址", "mcp", "INVALID_URL");
  const parsedHtml = input.html ? parseHtml(input.html, canonicalUrl) : null;
  const title = input.title || parsedHtml?.title || canonicalUrl;
  const text = (parsedHtml?.text || input.markdown || "").replace(/\0/g, "").trim().slice(0, 250_000);
  const candidates = [...new Set([
    input.publishedAt ? dateFromText(input.publishedAt) : null,
    parsedHtml?.publishedAt ?? null,
    dateFromText(text.slice(0, 4_000)),
  ].filter((value): value is string => Boolean(value)))];
  const publishedAt = candidates[0] ?? null;
  const statusCode = Number(input.statusCode ?? 200);
  const blocked = detectAccessBlock(statusCode, title, text);
  if (blocked) return failed(id, canonicalUrl, input.sourceId, fetchedAt, blocked.reason, "mcp", blocked.code);
  if (!text || statusCode >= 400) return failed(id, canonicalUrl, input.sourceId, fetchedAt,
    statusCode >= 400 ? `外部采集返回 HTTP ${statusCode}` : "外部采集没有返回正文", "mcp", statusCode >= 400 ? `HTTP_${statusCode}` : "FETCH_ERROR");
  const archive = `# ${title}\n\n来源：${canonicalUrl}\n\n发布日期：${publishedAt ?? "未识别"}\n\n采集方式：${input.provider}\n\n${text}`;
  const hash = crypto.createHash("sha256").update(archive).digest("hex");
  const rawPath = path.join(DATA_DIR, "documents", `${hash}.external.md`);
  if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, archive, "utf8");
  const url = new URL(canonicalUrl);
  const isRoot = url.pathname === "/" || url.pathname === "";
  return {
    id, url: canonicalUrl, canonicalUrl, title, publishedAt, fetchedAt, contentType: "text/markdown", statusCode,
    hash, text, markdown: archive, rawPath, markdownPath: rawPath, sourceId: input.sourceId,
    dateCandidates: candidates, dateStatus: publishedAt ? "within_range" : "date_unknown", dateEvidence: publishedAt ?? "",
    fetchMode: "browser", rendered: true, discoveryMethod: "mcp", warnings: [`通过 ${input.provider} 回退采集`],
    pageType: parsedHtml?.pageType ?? (isRoot ? "homepage" : text.length >= 400 ? "article" : "unknown"),
    extractionMethod: parsedHtml?.extractionMethod ?? "external-markdown", attemptCount: 1,
  };
}

function failed(
  id: string, url: string, sourceId: string, fetchedAt: string, error: string, discoveryMethod: DiscoveryMethod,
  failureCode = "FETCH_ERROR",
): CrawledDocument {
  return {
    id, url, canonicalUrl: normalizeUrl(url), title: url, publishedAt: null, fetchedAt,
    contentType: "", statusCode: 0, hash: crypto.createHash("sha256").update(`${url}:${error}`).digest("hex"),
    text: "", markdown: "", rawPath: "", markdownPath: "", sourceId, error,
    dateCandidates: [], dateStatus: "date_unknown", dateEvidence: "", fetchMode: "static",
    rendered: false, discoveryMethod, warnings: [], pageType: "unknown", extractionMethod: "none",
    attemptCount: 1, failureCode,
  };
}

const COUNTRIES = ["菲律宾","马来西亚","塔吉克斯坦","缅甸","乌兹别克斯坦","新加坡","阿联酋","沙特","赞比亚","南非","坦桑尼亚","萨尔瓦多","哥伦比亚","罗马尼亚","芬兰","波兰","意大利","波黑","埃及","圭亚那","吉尔吉斯斯坦","格鲁吉亚","新西兰","越南","莱索托","蒙古国","印度尼西亚","澳大利亚","老挝","泰国","日本","埃塞俄比亚","智利","布基纳法索","柬埔寨","阿曼","哈萨克斯坦","匈牙利","科摩罗","美国","英国","德国","法国","西班牙","葡萄牙","希腊","土耳其","巴西","墨西哥","加拿大","印度","巴基斯坦"];

export function ruleExtract(document: CrawledDocument, fields: FieldDefinition[]): {
  fields: Record<string, unknown>; evidence: Record<string, string>; conflicts: string[];
} {
  const text = `${document.title}\n${document.text}`;
  const values: Record<string, unknown> = {};
  const evidence: Record<string, string> = {};
  const country = COUNTRIES.find((item) => text.includes(item));
  const pv = findCapacity(text, /(?:光伏|太阳能|solar|photovoltaic)[^\n。]{0,60}?(\d+(?:\.\d+)?)\s*(GW|MW|兆瓦|吉瓦)/i)
    ?? findCapacity(text, /(\d+(?:\.\d+)?)\s*(GW|MW|兆瓦|吉瓦)[^\n。]{0,40}?(?:光伏|太阳能|solar|photovoltaic)/i);
  const storage = findCapacity(text, /(?:储能|battery|storage)[^\n。]{0,60}?(\d+(?:\.\d+)?)\s*(GWh|MWh|兆瓦时|吉瓦时)/i, true)
    ?? findCapacity(text, /(\d+(?:\.\d+)?)\s*(GWh|MWh|兆瓦时|吉瓦时)[^\n。]{0,40}?(?:储能|battery|storage)/i, true);
  const storagePower = findCapacity(text, /(?:储能|battery|storage)[^\n。]{0,60}?(\d+(?:\.\d+)?)\s*(GW|MW|兆瓦|吉瓦)(?!时)/i);
  const milestone = text.match(/签(?:署|订)?[^。；\n]{0,30}(?:合同|协议|备忘录)|中标|开工|投产|并网|招标|获得环境审批|融资闭环/i)?.[0];
  const type = pv && storage ? "光储" : pv ? "光伏" : storage || storagePower ? "储能" : /风电|wind/i.test(text) ? "风电" : "";
  for (const field of fields) {
    let value: unknown = "";
    if (field.id === "country") value = country ?? "";
    else if (field.id === "project_name") value = cleanProjectName(document.title);
    else if (field.id === "project_type") value = type;
    else if (field.id === "pv_capacity_mw") value = pv ?? null;
    else if (field.id === "storage_power_mw") value = storagePower ?? null;
    else if (field.id === "storage_capacity_mwh") value = storage ?? null;
    else if (field.id === "published_month") value = document.publishedAt ?? "";
    else if (field.id === "progress") value = milestone ?? "";
    else if (field.id === "category") value = /EPC/i.test(text) ? "EPC" : "";
    values[field.id] = value;
    if (value !== "" && value !== null) evidence[field.id] = evidenceSnippet(text, String(value));
  }
  return { fields: values, evidence, conflicts: [] };
}

function cleanProjectName(title: string) {
  return title.split(/\s*[|｜]\s*|\s+[-–—]\s+/)[0].trim();
}

export function ruleProjectLikelihood(document: CrawledDocument) {
  const text = `${document.title}\n${document.text.slice(0, 20_000)}`;
  const energy = ENERGY_TERMS.test(text);
  const concrete = PROJECT_TERMS.test(text);
  const capacity = /\d+(?:\.\d+)?\s*(?:GW|MW|GWh|MWh|兆瓦|吉瓦|兆瓦时|吉瓦时)/i.test(text);
  let hasListingUrl = false;
  try {
    hasListingUrl = /(?:^|\/)(?:archive|category|search|list|page)(?:\/|$)/i.test(new URL(document.url).pathname);
  } catch { /* malformed URLs remain ineligible unless explicitly typed as an article */ }
  const eligiblePage = ["article", "document"].includes(document.pageType) ||
    (document.pageType === "unknown" && Boolean(document.publishedAt) && document.text.length >= 350 && !hasListingUrl);
  return { isProject: eligiblePage && energy && concrete && (capacity || /中标|开工|投产|并网|合同|award|construction|commission/i.test(text)), energy, concrete, capacity, eligiblePage };
}

function findCapacity(text: string, regex: RegExp, storage = false) {
  const match = text.match(regex);
  if (!match) return null;
  let value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.includes("gw")) value *= 1000;
  if (storage && unit.includes("gwh")) value *= 1000;
  return value;
}

function evidenceSnippet(text: string, value: string) {
  const index = text.toLowerCase().indexOf(value.toLowerCase());
  if (index < 0) return text.slice(0, 240);
  return text.slice(Math.max(0, index - 90), Math.min(text.length, index + value.length + 150)).replace(/\s+/g, " ");
}

export function extractionSchema(fields: FieldDefinition[]): JsonObject {
  const properties: JsonObject = {};
  for (const field of fields) {
    properties[field.id] = {
      type: field.type === "number" ? ["number", "null"] : ["string", "null"],
      description: `${field.label}${field.unit ? `，单位 ${field.unit}` : ""}${field.extractionHint ? `。${field.extractionHint}` : ""}`,
    };
  }
  return { type: "object", properties, required: fields.map((field) => field.id), additionalProperties: false };
}

export function scoreResult(fields: Record<string, unknown>, document: CrawledDocument, sourceUrl: string) {
  const has = (key: string) => fields[key] !== "" && fields[key] !== null && fields[key] !== undefined;
  let score = 0;
  if (has("project_name")) score += 20;
  if (has("country") || has("address")) score += 15;
  if (has("pv_capacity_mw") || has("storage_capacity_mwh") || has("storage_power_mw")) score += 25;
  if (has("owner") || has("developer") || has("epc") || has("chinese_client")) score += 15;
  if (has("progress")) score += 10;
  if (document.publishedAt) score += 10;
  try {
    if (new URL(document.url).hostname === new URL(sourceUrl).hostname) score += 5;
  } catch { /* leave authority score at zero */ }
  return score;
}
