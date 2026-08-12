import type { ArticleAssessment, CrawledDocument, FieldDefinition } from "./types";
import { dateStatusFor, documentFromExternalContent } from "./crawler";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const PROJECT_INTEL_SOURCE_ID = "project-intel";
export const PROJECT_INTEL_URL = "https://energy-overseas.com/project-intel";
export const PROJECT_INTEL_LIST_ENDPOINT = "https://energy-overseas.com/api/project-intel/list";

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const execFileAsync = promisify(execFile);
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export interface ProjectIntelRecord {
  _index?: string | number;
  project_name?: string;
  country?: string;
  region?: string;
  industry?: string;
  capacity?: string;
  investment?: string;
  cod_date?: string;
  location?: string;
  technology?: string;
  stage?: string;
  developer?: string;
  developer_display?: string;
  owner?: string;
  epc_contractor?: string;
  epc_contractor_display?: string;
  engineering_contractor?: string;
  engineering_contractor_display?: string;
  equipment_supplier?: string;
  chinese_involvement?: string;
  event?: string;
  content?: string;
  business_insight_brief?: string;
  business_insight?: string;
  recorded_at?: string;
  [key: string]: unknown;
}

interface FetchProjectIntelOptions {
  startDate: string;
  endDate: string;
  maxRecords: number;
  pageSize?: number;
  intervalMs?: number;
  endpoint?: string;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  delay?: (milliseconds: number) => Promise<void>;
  shouldStop?: () => Promise<void>;
  onPage?: (progress: { page: number; pageSize: number; total: number; accepted: number }) => void;
}

export interface FetchProjectIntelResult {
  records: ProjectIntelRecord[];
  total: number;
  pagesFetched: number;
  truncated: boolean;
}

function clean(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).join("、");
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map(clean).filter(Boolean).join("、");
  return String(value).trim();
}

export function projectIntelRecordedDate(record: ProjectIntelRecord) {
  const matched = clean(record.recorded_at).replace(/[./]/g, "-").match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (!matched) return "";
  return `${matched[1]}-${matched[2].padStart(2, "0")}-${matched[3].padStart(2, "0")}`;
}

function retryDelay(response: Response | undefined, attempt: number) {
  const header = response?.headers.get("retry-after") ?? "";
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(30_000, seconds * 1_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(30_000, Math.max(1_000, date - Date.now()));
  return Math.min(30_000, 2_000 * (2 ** attempt));
}

async function fetchPage(
  url: URL,
  fetchImpl: NonNullable<FetchProjectIntelOptions["fetchImpl"]>,
  delay: NonNullable<FetchProjectIntelOptions["delay"]>,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          referer: PROJECT_INTEL_URL,
          "user-agent": BROWSER_USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Project Intel 接口返回 HTTP ${response.status}`);
      }
      lastError = new Error(`Project Intel 接口返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /HTTP 4\d\d/.test(error.message) && !/HTTP 429/.test(error.message)) throw error;
      // 传输超时或网络中断时不自动重复同一大响应，避免在目标站点恢复期间叠加请求。
      if (!response) throw error;
    }
    if (attempt < MAX_RETRIES) await delay(retryDelay(response, attempt));
  }
  throw lastError instanceof Error ? lastError : new Error("Project Intel 接口请求失败");
}

/** Windows 的 Node fetch 不读取系统代理设置；curl.exe 会沿用系统网络路径，兼容 TUN Fake-IP 环境。 */
async function windowsSystemFetch(input: string | URL, init?: RequestInit) {
  const url = String(input);
  const marker = "\nDPM_HTTP_STATUS:";
  const { stdout } = await execFileAsync("curl.exe", [
    "--silent", "--show-error", "--location", "--compressed",
    "--connect-timeout", "20", "--max-time", "120",
    "--header", "Accept: application/json",
    "--header", `Referer: ${PROJECT_INTEL_URL}`,
    "--user-agent", BROWSER_USER_AGENT,
    "--write-out", `${marker}%{http_code}`,
    url,
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, signal: init?.signal });
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("系统网络客户端没有返回 HTTP 状态");
  const status = Number(stdout.slice(markerIndex + marker.length).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`系统网络客户端返回无效状态：${status}`);
  return new Response(stdout.slice(0, markerIndex), { status, headers: { "content-type": "application/json" } });
}

/**
 * 只访问公开列表接口：串行分页、固定间隔、429/5xx 退避，不访问每条详情页。
 * 这能显著减少请求量，但任何客户端都无法保证网站永远不会调整限流策略。
 */
export async function fetchProjectIntelRecords(options: FetchProjectIntelOptions): Promise<FetchProjectIntelResult> {
  const pageSize = Math.min(20, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
  const maxRecords = Math.min(10_000, Math.max(1, Math.floor(options.maxRecords)));
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const endpoint = options.endpoint ?? PROJECT_INTEL_LIST_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? (process.platform === "win32" ? windowsSystemFetch : fetch);
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const accepted: ProjectIntelRecord[] = [];
  let page = 1;
  let total = 0;
  let pagesFetched = 0;
  let exhaustedByDate = false;

  while (accepted.length < maxRecords) {
    await options.shouldStop?.();
    const url = new URL(endpoint);
    url.searchParams.set("current", String(page));
    url.searchParams.set("size", String(pageSize));
    const response = await fetchPage(url, fetchImpl, delay);
    const payload = await response.json() as {
      code?: number;
      message?: string;
      data?: { records?: ProjectIntelRecord[]; total?: number; current?: number; size?: number };
    };
    if (payload.code != null && payload.code !== 200) {
      throw new Error(`Project Intel 接口错误：${payload.message || payload.code}`);
    }
    const records = Array.isArray(payload.data?.records) ? payload.data.records : [];
    total = Math.max(0, Number(payload.data?.total ?? total));
    pagesFetched++;
    let oldest = "";
    for (const record of records) {
      const date = projectIntelRecordedDate(record);
      if (!date) continue;
      if (!oldest || date < oldest) oldest = date;
      if (date >= options.startDate && date <= options.endDate) accepted.push(record);
      if (accepted.length >= maxRecords) break;
    }
    options.onPage?.({ page, pageSize, total, accepted: accepted.length });
    exhaustedByDate = Boolean(oldest && oldest < options.startDate);
    const exhaustedByPage = records.length === 0 || (total > 0 && page * pageSize >= total) || records.length < pageSize;
    if (accepted.length >= maxRecords || exhaustedByDate || exhaustedByPage) break;
    page++;
    await delay(intervalMs);
  }

  return {
    records: accepted.slice(0, maxRecords), total, pagesFetched,
    truncated: accepted.length >= maxRecords || (!exhaustedByDate && total > page * pageSize),
  };
}

function recordUrl(record: ProjectIntelRecord) {
  const index = clean(record._index);
  return index ? `${PROJECT_INTEL_URL}/${encodeURIComponent(index)}` : PROJECT_INTEL_URL;
}

function recordMarkdown(record: ProjectIntelRecord) {
  const sections: Array<[string, unknown]> = [
    ["项目名称", record.project_name], ["国家", record.country], ["地区", record.region],
    ["行业", record.industry], ["规模", record.capacity], ["投资额", record.investment],
    ["项目地点", record.location], ["技术路线", record.technology], ["项目阶段", record.stage],
    ["开发商", record.developer_display || record.developer || record.owner],
    ["EPC/工程承包商", record.epc_contractor_display || record.epc_contractor || record.engineering_contractor_display || record.engineering_contractor],
    ["设备供应商", record.equipment_supplier], ["中资参与", record.chinese_involvement],
    ["项目事件", record.event], ["预计投运", record.cod_date], ["收录时间", record.recorded_at],
    ["项目内容", record.content], ["商业洞察摘要", record.business_insight_brief], ["商业洞察", record.business_insight],
  ];
  return sections.filter(([, value]) => clean(value)).map(([label, value]) => `## ${label}\n\n${clean(value)}`).join("\n\n");
}

export function projectIntelRecordToDocument(record: ProjectIntelRecord, startDate: string, endDate: string): CrawledDocument {
  const publishedAt = projectIntelRecordedDate(record) || null;
  const document = documentFromExternalContent({
    url: recordUrl(record), sourceId: PROJECT_INTEL_SOURCE_ID,
    title: clean(record.project_name) || clean(record.event) || "Project Intel 项目",
    publishedAt, markdown: recordMarkdown(record), provider: "Project Intel 公共列表接口",
  });
  document.dateStatus = dateStatusFor(document, startDate, endDate);
  document.fetchMode = "static";
  document.rendered = false;
  document.discoveryMethod = "source";
  document.pageType = "article";
  document.extractionMethod = "project-intel-api";
  document.warnings = ["Project Intel 为二手聚合信息，建议回到其引用来源复核"];
  return document;
}

function parseCapacities(record: ProjectIntelRecord) {
  const capacity = clean(record.capacity);
  const context = `${clean(record.industry)} ${clean(record.technology)} ${clean(record.project_name)}`;
  const matches = [...capacity.matchAll(/(\d[\d,.]*)(?:\s*)(GWh|MWh|GW|MW|吉瓦时|兆瓦时|吉瓦|兆瓦)/gi)];
  const values = matches.map((match) => {
    const raw = Number(match[1].replace(/,/g, ""));
    const unit = match[2].toLowerCase();
    const energy = /wh|瓦时/.test(unit);
    const giga = /^g|吉瓦/.test(unit);
    return { value: raw * (giga ? 1_000 : 1), energy, evidence: match[0] };
  }).filter((item) => Number.isFinite(item.value) && item.value > 0);
  const isStorage = /储能|光储|电池|battery|storage/i.test(context);
  const isSolar = /光伏|光储|太阳能|solar|photovoltaic|\bpv\b/i.test(context);
  const storageEnergy = values.find((item) => item.energy);
  const power = values.find((item) => !item.energy);
  return {
    pv: isSolar && power ? power.value : undefined,
    pvEvidence: isSolar && power ? `${capacity}（${power.evidence}）` : "",
    storageEnergy: isStorage && storageEnergy ? storageEnergy.value : undefined,
    storageEnergyEvidence: isStorage && storageEnergy ? `${capacity}（${storageEnergy.evidence}）` : "",
    storagePower: isStorage && power ? power.value : undefined,
    storagePowerEvidence: isStorage && power ? `${capacity}（${power.evidence}）` : "",
  };
}

export function projectIntelRecordToAssessment(record: ProjectIntelRecord, fields: FieldDefinition[]): ArticleAssessment {
  const capacities = parseCapacities(record);
  const developer = clean(record.developer_display || record.developer || record.owner);
  const epc = clean(record.epc_contractor_display || record.epc_contractor || record.engineering_contractor_display || record.engineering_contractor);
  const all: Record<string, unknown> = {
    country: clean(record.country), project_name: clean(record.project_name) || clean(record.event),
    pv_capacity_mw: capacities.pv, storage_capacity_mwh: capacities.storageEnergy,
    owner: developer, address: clean(record.location) || clean(record.region),
    published_month: projectIntelRecordedDate(record), chinese_client: clean(record.chinese_involvement),
    progress: clean(record.stage) || clean(record.event), category: "Project Intel",
    project_type: clean(record.industry) || clean(record.technology), storage_power_mw: capacities.storagePower,
    developer, epc, event_date: clean(record.cod_date),
  };
  const evidence: Record<string, string> = {
    country: clean(record.country), project_name: clean(record.project_name) || clean(record.event),
    pv_capacity_mw: capacities.pvEvidence, storage_capacity_mwh: capacities.storageEnergyEvidence,
    owner: developer, address: clean(record.location) || clean(record.region),
    published_month: clean(record.recorded_at), chinese_client: clean(record.chinese_involvement),
    progress: [clean(record.stage), clean(record.event)].filter(Boolean).join("；"),
    category: "Project Intel 结构化项目库", project_type: [clean(record.industry), clean(record.technology)].filter(Boolean).join("；"),
    storage_power_mw: capacities.storagePowerEvidence, developer, epc, event_date: clean(record.cod_date),
  };
  const selected = new Set(fields.map((field) => field.id));
  const selectedFields = Object.fromEntries(Object.entries(all).filter(([key, value]) => selected.has(key) && value !== "" && value !== undefined));
  const selectedEvidence = Object.fromEntries(Object.entries(evidence).filter(([key, value]) => selected.has(key) && value));
  return {
    classification: "project_report", confidence: 0.92, sourceLanguage: "zh",
    reasoning: "来自 Project Intel 公共结构化列表接口，已按 recorded_at 发布时间筛选；聚合信息需回到原始来源复核。",
    mentions: [{ fields: selectedFields, evidence: selectedEvidence, confidence: 0.9 }],
  };
}
