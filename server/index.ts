import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { db, DATA_DIR, audit, jsonParse, listFields, listSources, now } from "./db";
import { vault } from "./vault";
import type {
  CrawledDocument, JsonObject, ModelProviderRecord, ResultRecord,
  ScanBudget, ScanRequest, SearchProviderRecord, SourceRecord,
} from "./types";
import { listProviderModels, searchWeb, testProvider } from "./providers";
import {
  dateStatusFor, discoverSourcePages, documentContentQuality, failedDocument, fetchDocument, normalizeUrl,
  rankDiscoveredUrls, setIgnoreRobots,
} from "./crawler";
import { applyBilingualRepair, assessArticle, mapProject, saveAssessment } from "./projects";
import {
  ScanStoppedError, controlScan, getScanLogs, logScan, markScanActive, scanControlPoint,
} from "./scan-runtime";
import { catalogMcpServer, diagnoseMcpError, handleMcpRequest, invokeMcpServersParallel, mapMcpRow, type McpActions } from "./mcp";
import { exportSnapshot } from "./exporter";
import { pickExportDirectory, resolveExportDirectory } from "./export-directory";
import retrievalPolicy from "../skills/scan-overseas-energy-projects/references/retrieval-policy.json";
import { getRetrievalSkill, proposeRetrievalSkillIteration, reviewRetrievalSkillIteration } from "./skills";
import { firecrawlKeyFromProfiles, mapWithFirecrawl, scrapeWithFirecrawl } from "./firecrawl";
import {
  LIGHTPANDA_VAULT_KEY, probeLightpanda, resetLightpanda, resolveLightpandaConfig, upsertBrowserRendering,
} from "./lightpanda";
import { chooseRecallBaseline, recallComparison, type ComparableScan } from "./recall";
import { runAllSourceJobs } from "./source-scheduler";

const HOST = process.env.DPM_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DPM_API_PORT ?? 8765);
const MODEL_CACHE = new Map<string, { expires: number; data: unknown }>();
const MCP_TOKEN_PATH = path.join(DATA_DIR, "mcp-token.txt");
if (!fs.existsSync(MCP_TOKEN_PATH)) fs.writeFileSync(MCP_TOKEN_PATH, randomBytes(24).toString("hex"), { mode: 0o600 });
const MCP_TOKEN = fs.readFileSync(MCP_TOKEN_PATH, "utf8").trim();

const DEFAULT_BUDGET: ScanBudget = {
  maxPages: 100, maxSearches: 30, maxMinutes: 10, maxConcurrency: 3, maxCostUsd: 2,
};
type SourceCoverageState = {
  sourceId: string;
  name: string;
  url: string;
  status: "pending" | "running" | "completed" | "failed";
  discovered: number;
  fetched: number;
  succeeded: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};
const RETRIEVAL_POLICY_PATH = path.resolve("skills", "scan-overseas-energy-projects", "references", "retrieval-policy.json");
function currentRetrievalPolicy() {
  try { return JSON.parse(fs.readFileSync(RETRIEVAL_POLICY_PATH, "utf8")) as typeof retrievalPolicy; }
  catch { return retrievalPolicy; }
}

/** 对外返回 CDP 端点前抹掉 token query 参数 */
function redactTokenParam(endpoint: string) {
  try {
    const parsed = new URL(endpoint);
    if (parsed.searchParams.has("token")) parsed.searchParams.set("token", "***");
    return parsed.toString();
  } catch { return endpoint; }
}

function mapProvider(row: Record<string, unknown>): ModelProviderRecord {
  const id = String(row.id);
  return {
    id, name: String(row.name), kind: row.kind as ModelProviderRecord["kind"],
    baseUrl: String(row.base_url), headers: jsonParse<Record<string, string>>(row.headers_json, {}),
    config: jsonParse<JsonObject>(row.config_json, {}), enabled: Boolean(row.enabled),
    hasSecret: vault.has(`provider:${id}`),
  };
}

function mapSearchProvider(row: Record<string, unknown>): SearchProviderRecord {
  const id = String(row.id);
  return {
    id, name: String(row.name), kind: row.kind as SearchProviderRecord["kind"],
    endpoint: String(row.endpoint), method: row.method as "GET" | "POST",
    headers: jsonParse<Record<string, string>>(row.headers_json, {}),
    config: jsonParse<JsonObject>(row.config_json, {}), enabled: Boolean(row.enabled),
    hasSecret: vault.has(`search:${id}`),
  };
}

function mapResult(row: Record<string, unknown>): ResultRecord {
  return {
    id: String(row.id), scanId: String(row.scan_id), documentId: String(row.document_id ?? ""),
    fields: jsonParse<Record<string, unknown>>(row.fields_json, {}),
    primaryUrl: String(row.primary_url ?? ""), candidateUrls: jsonParse<string[]>(row.candidate_urls_json, []),
    evidence: jsonParse<Record<string, string>>(row.evidence_json, {}),
    conflicts: jsonParse<string[]>(row.conflicts_json, []), score: Number(row.score),
    status: row.status as ResultRecord["status"], revision: Number(row.revision),
    decisionNote: String(row.decision_note ?? ""),
    generatedFields: jsonParse<string[]>(row.generated_fields_json, []),
  };
}

function getProvider(id?: string) {
  if (!id) return undefined;
  const row = db.prepare("SELECT * FROM providers WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? mapProvider(row) : undefined;
}

function getSearchProvider(id: string) {
  const row = db.prepare("SELECT * FROM search_providers WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? mapSearchProvider(row) : undefined;
}

function hydrateMcpRow(row: Record<string, unknown>) {
  const id = String(row.id);
  const keys = jsonParse<string[]>(row.env_keys_json, []);
  const env = Object.fromEntries(keys.map((key) => [key, vault.get(`mcp:${id}:env:${key}`)]));
  return mapMcpRow(row, env);
}

function getScan(id: string) {
  const row = db.prepare("SELECT * FROM scans WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id), request: jsonParse<ScanRequest>(row.request_json, {} as ScanRequest),
    status: String(row.status), progress: jsonParse<JsonObject>(row.progress_json, {}),
    error: row.error ? String(row.error) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function storedDocument(row: Record<string, unknown>): CrawledDocument {
  return {
    id: String(row.id), url: String(row.url), canonicalUrl: String(row.canonical_url), title: String(row.title ?? ""),
    publishedAt: row.published_at ? String(row.published_at) : null, fetchedAt: String(row.fetched_at),
    contentType: String(row.content_type ?? "text/html"), statusCode: Number(row.status_code ?? 200), hash: String(row.hash),
    text: String(row.text ?? ""), markdown: String(row.markdown ?? ""), rawPath: String(row.raw_path ?? ""),
    markdownPath: String(row.markdown_path ?? ""), sourceId: String(row.source_id ?? ""),
    dateCandidates: jsonParse<string[]>(row.date_candidates_json, []),
    dateStatus: String(row.date_status ?? "date_unknown") as CrawledDocument["dateStatus"],
    dateEvidence: String(row.date_evidence ?? ""), fetchMode: String(row.fetch_mode ?? "static") as CrawledDocument["fetchMode"],
    rendered: Boolean(row.rendered), discoveryMethod: String(row.discovery_method ?? "source") as CrawledDocument["discoveryMethod"],
    warnings: jsonParse<string[]>(row.warnings_json, []), pageType: String(row.page_type ?? "article") as CrawledDocument["pageType"],
    extractionMethod: String(row.extraction_method ?? "archive"), attemptCount: Number(row.attempt_count ?? 1),
    failureCode: row.failure_code ? String(row.failure_code) : undefined, error: row.error ? String(row.error) : undefined,
  };
}

function deleteScan(scanId: string) {
  const scan = getScan(scanId);
  if (!scan) throw new Error("监测任务不存在");
  if (!["completed", "failed", "stopped"].includes(scan.status)) throw new Error("只能删除已完成、失败或已停止的任务");
  const documents = db.prepare("SELECT id,raw_path,markdown_path FROM documents WHERE scan_id=?").all(scanId) as Record<string, unknown>[];
  const projectIds = (db.prepare("SELECT id FROM projects WHERE scan_id=?").all(scanId) as { id: string }[]).map((row) => row.id);
  const resultIds = (db.prepare("SELECT id FROM results WHERE scan_id=?").all(scanId) as { id: string }[]).map((row) => row.id);
  const snapshotIds = (db.prepare("SELECT id FROM snapshots WHERE scan_id=?").all(scanId) as { id: string }[]).map((row) => row.id);
  const exportDirs = snapshotIds.length ? (db.prepare(`SELECT directory FROM exports WHERE snapshot_id IN (${snapshotIds.map(() => "?").join(",")})`)
    .all(...snapshotIds) as { directory: string }[]).map((row) => row.directory) : [];
  const removeIds = (table: string, column: string, ids: string[]) => {
    for (let index = 0; index < ids.length; index += 500) {
      const batch = ids.slice(index, index + 500);
      db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${batch.map(() => "?").join(",")})`).run(...batch);
    }
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    removeIds("exports", "snapshot_id", snapshotIds);
    db.prepare("DELETE FROM snapshots WHERE scan_id=?").run(scanId);
    removeIds("project_sources", "project_id", projectIds);
    db.prepare("DELETE FROM project_mentions WHERE scan_id=?").run(scanId);
    db.prepare("DELETE FROM projects WHERE scan_id=?").run(scanId);
    db.prepare("DELETE FROM document_assessments WHERE scan_id=?").run(scanId);
    db.prepare("DELETE FROM results WHERE scan_id=?").run(scanId);
    db.prepare("DELETE FROM scan_logs WHERE scan_id=?").run(scanId);
    db.prepare("DELETE FROM crawl_queue WHERE scan_id=?").run(scanId);
    db.prepare("DELETE FROM documents WHERE scan_id=?").run(scanId);
    removeIds("audit_log", "entity_id", [...projectIds, ...resultIds, ...snapshotIds, scanId]);
    db.prepare("DELETE FROM scans WHERE id=?").run(scanId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const evidenceRoot = path.resolve(DATA_DIR, "documents");
  const evidencePaths = [...new Set(documents.flatMap((row) => [row.raw_path, row.markdown_path]).filter(Boolean).map(String))];
  let filesRemoved = 0;
  for (const filePath of evidencePaths) {
    const stillUsed = db.prepare("SELECT 1 FROM documents WHERE raw_path=? OR markdown_path=? LIMIT 1").get(filePath, filePath);
    const resolved = path.resolve(filePath); const relative = path.relative(evidenceRoot, resolved);
    if (!stillUsed && relative && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(resolved)) {
      fs.rmSync(resolved, { force: true }); filesRemoved++;
    }
  }
  const outputsRoot = path.resolve("outputs");
  let exportsRemoved = 0;
  for (const directory of exportDirs) {
    const resolved = path.resolve(directory); const relative = path.relative(outputsRoot, resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true }); exportsRemoved++;
    }
  }
  return { ok: true, scanId, documentsRemoved: documents.length, filesRemoved, exportsRemoved };
}

function getResults(scanId: string) {
  const projects = db.prepare("SELECT * FROM projects WHERE scan_id=? ORDER BY score DESC, created_at")
    .all(scanId) as Record<string, unknown>[];
  if (projects.length) return projects.map(mapProject);
  return (db.prepare("SELECT * FROM results WHERE scan_id=? ORDER BY score DESC, created_at")
    .all(scanId) as Record<string, unknown>[]).map(mapResult).filter(legacyResultEligible);
}

function getRecallBaseline(scanId: string, request: ScanRequest) {
  const current = db.prepare("SELECT created_at FROM scans WHERE id=?").get(scanId) as { created_at: string } | undefined;
  const rows = db.prepare(`SELECT id,request_json,created_at FROM scans
    WHERE id<>? AND status='completed' AND created_at<? ORDER BY created_at DESC LIMIT 100`)
    .all(scanId, current?.created_at ?? now()) as Array<Record<string, unknown>>;
  const candidates: ComparableScan[] = rows.map((row) => ({
    id: String(row.id),
    createdAt: String(row.created_at),
    request: jsonParse<ScanRequest>(row.request_json, {} as ScanRequest),
    results: getResults(String(row.id)),
  }));
  return chooseRecallBaseline(request, candidates);
}

function legacyResultEligible(result: ReturnType<typeof mapResult>) {
  const name = String(result.fields.project_name ?? "").trim();
  const obviousPageTitle = /首页|官网|^项目[_-]|共建一带一路项目|https?:\/\//i.test(name);
  const genericName = /集团有限公司\s*$|股份有限公司\s*$|corporation\s*$|company\s*$|limited\s*$/i.test(name);
  const projectSignal = /项目|电站|电场|园区|基地|工程|储能|光伏|风电|project|plant|farm|facility|park/i.test(name) ||
    /\d+(?:\.\d+)?\s*(?:GW|MW|GWh|MWh|兆瓦|吉瓦)/i.test(name);
  return Boolean(name) && !obviousPageTitle && !(genericName && !projectSignal);
}

function getArticles(scanId: string) {
  return (db.prepare(`SELECT d.id,d.url,d.canonical_url,d.title,d.published_at,d.date_status,d.fetch_mode,
      d.rendered,d.discovery_method,d.warnings_json,d.error,d.failure_code,d.attempt_count,d.page_type,d.extraction_method,
      a.classification,a.confidence,a.reasoning,a.mention_count
    FROM documents d LEFT JOIN document_assessments a ON a.document_id=d.id
    WHERE d.scan_id=? ORDER BY d.published_at DESC,d.fetched_at`).all(scanId) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id), url: String(row.url), canonicalUrl: String(row.canonical_url),
      title: String(row.title ?? ""), publishedAt: row.published_at ? String(row.published_at) : null,
      dateStatus: String(row.date_status), fetchMode: String(row.fetch_mode), rendered: Boolean(row.rendered),
      discoveryMethod: String(row.discovery_method), warnings: jsonParse<string[]>(row.warnings_json, []),
      error: row.error ? String(row.error) : null, failureCode: row.failure_code ? String(row.failure_code) : null,
      attemptCount: Number(row.attempt_count ?? 1), pageType: String(row.page_type), extractionMethod: String(row.extraction_method),
      classification: row.classification ? String(row.classification) : null,
      confidence: row.confidence == null ? null : Number(row.confidence),
      reasoning: row.reasoning ? String(row.reasoning) : "",
      mentionCount: Number(row.mention_count ?? 0),
    }));
}

function getScanDiagnostics(scanId: string) {
  const scan = getScan(scanId);
  if (!scan) throw new Error("监测任务不存在");
  const articles = getArticles(scanId);
  const logs = getScanLogs(scanId, 0, 2000);
  const sourceRows = db.prepare(`SELECT source_id,COUNT(*) AS pages,
      SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS succeeded
    FROM documents WHERE scan_id=? GROUP BY source_id ORDER BY pages DESC`).all(scanId) as Array<Record<string, unknown>>;
  const sourceNames = new Map(listSources().map((source) => [source.id, source.name]));
  const totalPages = sourceRows.reduce((sum, row) => sum + Number(row.pages), 0);
  const distribution = sourceRows.map((row) => ({
    sourceId: String(row.source_id ?? ""), source: sourceNames.get(String(row.source_id)) ?? String(row.source_id ?? "未知来源"),
    pages: Number(row.pages), succeeded: Number(row.succeeded), share: totalPages ? Number(row.pages) / totalPages : 0,
  }));
  const blocked = articles.filter((article) => ["ACCESS_DENIED", "BOT_CHALLENGE", "RATE_LIMITED"].includes(String(article.failureCode)) ||
    /access denied|request (?:has been )?blocked|verify (?:that )?you are human|captcha|拒绝访问|访问被拒绝|验证码/i
      .test(`${article.title}\n${article.error ?? ""}`));
  const assessed = articles.filter((article) => article.classification);
  const modelErrors = logs.filter((log) => log.stage === "model" && log.level === "error");
  const discoveryErrors = logs.filter((log) => log.stage === "discovery" && ["warn", "error"].includes(log.level));
  const causes: Array<{ code: string; severity: "critical" | "warning" | "info"; evidence: string }> = [];
  if (Number(scan.progress.withinRange ?? 0) > 0 && assessed.length === 0) causes.push({
    code: "CLASSIFICATION_STARVATION", severity: "critical",
    evidence: `${scan.progress.withinRange} 个范围内页面，但文章评估数为 0；抓取阶段耗尽了任务时间或任务在分类前停止。`,
  });
  if ((distribution[0]?.share ?? 0) > Number(currentRetrievalPolicy().iteration?.maximum_single_source_share ?? 0.5)) causes.push({
    code: "SOURCE_BUDGET_MONOPOLY", severity: "critical",
    evidence: `${distribution[0].source} 占全部页面的 ${(distribution[0].share * 100).toFixed(1)}%。`,
  });
  if (blocked.length) causes.push({
    code: "ACCESS_BLOCKED", severity: "warning",
    evidence: `${blocked.length} 个页面被识别为 Access Denied、机器人挑战或限流。`,
  });
  if (discoveryErrors.length) causes.push({
    code: "DISCOVERY_FAILURES", severity: "warning", evidence: `站点枚举阶段记录 ${discoveryErrors.length} 条警告或错误。`,
  });
  if (!modelErrors.length && assessed.length === 0) causes.push({
    code: "MODEL_NOT_INVOKED", severity: "info", evidence: "没有模型抽取错误，也没有文章评估记录；证据表明问题发生在模型调用之前。",
  });
  const request = scan.request as unknown as JsonObject;
  const providerId = String(request.providerId ?? "");
  const providerDiagnostic = providerId ? db.prepare(
    "SELECT model_id,ok,report_json,created_at FROM provider_diagnostics WHERE provider_id=? ORDER BY created_at DESC LIMIT 1",
  ).get(providerId) as Record<string, unknown> | undefined : undefined;
  return {
    scan,
    funnel: {
      pages: totalPages, fetchedSuccessfully: articles.filter((article) => !article.error).length,
      withinRange: Number(scan.progress.withinRange ?? 0), assessed: assessed.length,
      modelExtractions: Number(scan.progress.modelExtractions ?? 0), projects: getResults(scanId).length,
    },
    sourceDistribution: distribution,
    failureCodes: Object.fromEntries(articles.filter((article) => article.failureCode).reduce((map, article) => {
      const code = String(article.failureCode); map.set(code, (map.get(code) ?? 0) + 1); return map;
    }, new Map<string, number>())),
    causes,
    modelEvidence: {
      note: "系统仅保存模型返回的简短判定理由、结构化结果和错误，不请求也不暴露模型私密思维链。",
      latestProviderDiagnostic: providerDiagnostic ? {
        modelId: providerDiagnostic.model_id, ok: Boolean(providerDiagnostic.ok),
        report: jsonParse(providerDiagnostic.report_json, {}), createdAt: providerDiagnostic.created_at,
      } : null,
      assessmentReasons: assessed.slice(0, 100).map((article) => ({
        url: article.url, classification: article.classification, confidence: article.confidence, reasoning: article.reasoning,
      })),
      errors: modelErrors,
    },
    nextStrategy: {
      version: 1,
      rules: [
        "每个来源保留公平页面配额，单站不得提前耗尽全局页面预算。",
        "抓取最多使用 60% 时间，已抓页面必须全部完成规则评估；模型只处理候选文章。",
        "阻断页不得计为成功正文；依次回退到 RSS、站点地图、站内搜索索引、持久浏览器会话和已配置 MCP 抓取服务。",
        "策略变更必须引用本诊断中的量化证据；自动调整只允许缩小并发、调整配额和改变回退顺序。",
      ],
      requiresReview: ["绕过登录或验证码", "新增代理或付费服务", "放宽 robots.txt", "扩大成本或时间预算"],
    },
    discoveryLogs: discoveryErrors.slice(0, 200),
  };
}

function setProgress(scanId: string, patch: JsonObject, status?: string) {
  const current = getScan(scanId);
  if (!current) return;
  const progress = { ...current.progress, ...patch };
  db.prepare("UPDATE scans SET progress_json=?, status=COALESCE(?,status), updated_at=? WHERE id=?")
    .run(JSON.stringify(progress), status ?? null, now(), scanId);
}

async function createScan(payload: JsonObject) {
  const request = normalizeScanRequest(payload);
  const id = randomUUID();
  const created = now();
  db.prepare("INSERT INTO scans VALUES (?,?,?,?,?,?,?)").run(
    id, JSON.stringify(request), "queued",
    JSON.stringify({
      sourcesTotal: request.sourceIds.length, sourcesScanned: 0, pagesDiscovered: 0,
      pagesFetched: 0, fullTextSucceeded: 0, withinRange: 0, outsideRange: 0,
      dateUnknown: 0, dateConflict: 0, projectArticles: 0, nonProjectArticles: 0,
      uncertainArticles: 0, projectMentions: 0, results: 0, failures: 0,
      dynamicPages: 0, discoveryTruncated: 0, percent: 0,
    }),
    null, created, created,
  );
  audit("scan", id, "created", request);
  logScan(id, "info", "lifecycle", "created", "监测任务已创建", {
    sourceCount: request.sourceIds.length, startDate: request.startDate, endDate: request.endDate,
    maxPages: request.budget.maxPages, modelId: request.modelId ?? "rules-only",
  });
  void runScan(id, request);
  return getScan(id);
}

function normalizeScanRequest(payload: JsonObject): ScanRequest {
  const rawBudget = { ...DEFAULT_BUDGET, ...((payload.budget ?? {}) as Partial<ScanBudget>) };
  const startDate = String(payload.startDate ?? "");
  const endDate = String(payload.endDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    throw new Error("日期范围无效");
  }
  const sourceIds = Array.isArray(payload.sourceIds) ? [...new Set(payload.sourceIds.map(String))] : [];
  const natural = (name: string, value: unknown, minimum: number, maximum: number) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new Error(`${name}必须是 ${minimum} 至 ${maximum} 的整数`);
    }
    return number;
  };
  const budget: ScanBudget = {
    maxPages: natural("最大抓取页数", rawBudget.maxPages, 1, 10_000),
    maxSearches: natural("最大搜索次数", rawBudget.maxSearches, 0, 1_000),
    maxMinutes: natural("最长运行时间", rawBudget.maxMinutes, 1, 1_440),
    maxConcurrency: natural("并发数", rawBudget.maxConcurrency, 1, 20),
    maxCostUsd: Number(rawBudget.maxCostUsd),
  };
  if (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0) throw new Error("模型费用上限必须是非负数");
  if (sourceIds.length && budget.maxPages < sourceIds.length) {
    throw new Error(`已选择 ${sourceIds.length} 个来源，最大抓取页数至少应为 ${sourceIds.length}，才能为每个来源保留 1 页额度`);
  }
  return {
    startDate, endDate,
    fieldIds: Array.isArray(payload.fieldIds) ? payload.fieldIds.map(String) : listFields().map((field) => field.id),
    sourceIds,
    providerId: payload.providerId ? String(payload.providerId) : undefined,
    modelId: payload.modelId ? String(payload.modelId) : undefined,
    searchProviderIds: Array.isArray(payload.searchProviderIds) ? payload.searchProviderIds.map(String) : [],
    mcpServerIds: Array.isArray(payload.mcpServerIds) ? payload.mcpServerIds.map(String) : [],
    mcpToolNames: Array.isArray(payload.mcpToolNames) ? payload.mcpToolNames.map(String) : [],
    budget,
    ignoreRobots: payload.ignoreRobots === true,
    referenceRows: Array.isArray(payload.referenceRows) ? payload.referenceRows as Record<string, unknown>[] : undefined,
  };
}

async function runScan(scanId: string, request: ScanRequest) {
  setIgnoreRobots(request.ignoreRobots === true);
  if (request.ignoreRobots) {
    logScan(scanId, "warn", "lifecycle", "robots_ignored",
      "已按任务设置忽略 robots.txt 抓取限制，改用浏览器模拟真人访问公开页面（个人研究用途）");
  }
  const fields = listFields();
  const sourceCatalog = new Map(listSources().map((source) => [source.id, source]));
  const sources = request.sourceIds.map((id) => sourceCatalog.get(id)).filter((source): source is SourceRecord => Boolean(source));
  const sourceCoverageStates: SourceCoverageState[] = request.sourceIds.map((sourceId) => {
    const source = sourceCatalog.get(sourceId);
    return {
      sourceId,
      name: source?.name ?? `已删除的信息源（${sourceId.slice(0, 8)}）`,
      url: source?.url ?? "",
      status: source ? "pending" : "failed",
      discovered: 0,
      fetched: 0,
      succeeded: 0,
      error: source ? undefined : "任务开始前该信息源已被删除，无法扫描",
      completedAt: source ? undefined : now(),
    };
  });
  const provider = getProvider(request.providerId);
  const searchProviders = (request.searchProviderIds ?? []).map(getSearchProvider).filter(Boolean) as SearchProviderRecord[];
  const documents = new Map<string, CrawledDocument>();
  const fetchedUrls = new Set<string>();
  let discovered = 0;
  let fetched = 0;
  let failures = sourceCoverageStates.filter((state) => state.status === "failed").length;
  let completedSources = failures;
  let modelExtractions = 0;
  let searches = 0;
  let fullTextSucceeded = 0;
  let withinRange = 0;
  let outsideRange = 0;
  let dateUnknown = 0;
  let dateConflict = 0;
  let dynamicPages = 0;
  let discoveryTruncated = 0;
  let projectArticles = 0;
  let nonProjectArticles = 0;
  let uncertainArticles = 0;
  let projectMentions = 0;
  let mcpCalls = 0;
  let mcpFailures = 0;
  let mcpFetched = 0;
  let baselineUrlsAttempted = 0;
  let baselineUrlsRevalidated = 0;
  const discoveryStrategies = new Set<string>();
  const failureReasons: Record<string, number> = {};
  const addFailure = (code: string) => { failureReasons[code] = (failureReasons[code] ?? 0) + 1; };
  for (let index = 0; index < failures; index++) addFailure("SOURCE_MISSING");
  const sourceCoverageProgress = () => {
    const succeeded = sourceCoverageStates.filter((state) => state.status === "completed").length;
    const failed = sourceCoverageStates.filter((state) => state.status === "failed").length;
    const running = sourceCoverageStates.filter((state) => state.status === "running").length;
    return {
      total: sourceCoverageStates.length,
      settled: succeeded + failed,
      succeeded,
      failed,
      running,
      pending: sourceCoverageStates.length - succeeded - failed - running,
      allSettled: succeeded + failed === sourceCoverageStates.length,
      sources: sourceCoverageStates,
    };
  };
  const retainForAssessment = (doc: CrawledDocument) => {
    if (doc.error || !doc.text) return;
    if (doc.dateStatus === "within_range") {
      documents.set(doc.canonicalUrl, doc);
    } else if (doc.dateStatus === "date_unknown" && !request.referenceRows?.length) {
      const warning = "发布日期无法确认；若识别为项目，只进入人工审核，不自动通过";
      if (!doc.warnings.includes(warning)) doc.warnings.push(warning);
      documents.set(doc.canonicalUrl, doc);
    } else if (doc.dateStatus === "date_conflict" && !request.referenceRows?.length) {
      const warning = "页面存在多个日期候选；保留进入结构化评估，但结果必须人工复核发布日期";
      if (!doc.warnings.includes(warning)) doc.warnings.push(warning);
      documents.set(doc.canonicalUrl, doc);
    }
  };
  markScanActive(scanId, true);
  try {
    setProgress(scanId, {
      startedAt: now(), sourcesTotal: request.sourceIds.length,
      sourcesScanned: completedSources, sourceCoverage: sourceCoverageProgress(),
    }, "running");
    logScan(scanId, "info", "lifecycle", "started", "任务开始执行", { sources: request.sourceIds.length });
    for (const state of sourceCoverageStates.filter((item) => item.status === "failed")) {
      logScan(scanId, "error", "discovery", "source_missing", state.error ?? "信息源不存在", {
        sourceId: state.sourceId, source: state.name, url: state.url,
      });
    }
    const mcpProfiles = (request.mcpServerIds ?? []).map((id) => {
      const row = db.prepare("SELECT * FROM mcp_servers WHERE id=? AND enabled=1").get(id) as Record<string, unknown> | undefined;
      return row ? hydrateMcpRow(row) : undefined;
    }).filter(Boolean) as ReturnType<typeof mapMcpRow>[];
    const firecrawlApiKey = firecrawlKeyFromProfiles(mcpProfiles);
    const genericMcpProfiles = mcpProfiles.filter((profile) => !(firecrawlApiKey && /firecrawl/i.test(profile.name)));
    const recallBaseline = getRecallBaseline(scanId, request);
    const baselineHints = new Map<string, Array<{ fields: Record<string, unknown>; primaryUrl: string }>>();
    const baselineEvidenceByUrl = new Map<string, ResultRecord>();
    for (const result of recallBaseline?.results ?? []) {
      if (!["approved", "auto_approved"].includes(result.status)) continue;
      for (const url of [result.primaryUrl, ...result.candidateUrls]) {
        const normalized = normalizeUrl(url);
        if (!normalized) continue;
        const hints = baselineHints.get(normalized) ?? [];
        hints.push({ fields: result.fields, primaryUrl: result.primaryUrl });
        baselineHints.set(normalized, hints);
        if (!baselineEvidenceByUrl.has(normalized)) baselineEvidenceByUrl.set(normalized, result);
      }
    }
    if (recallBaseline) {
      setProgress(scanId, { recall: {
        status: "revalidating", baselineScanId: recallBaseline.scanId,
        baselineResultCount: recallBaseline.resultCount, baselineAcceptedCount: recallBaseline.acceptedCount,
        baselineUrls: recallBaseline.urls.length, baselineUrlsAttempted: 0, baselineUrlsRevalidated: 0,
      } });
      logScan(scanId, "info", "recall", "baseline_selected",
        `已选择同日期、同来源集合的历史任务作为召回基线：${recallBaseline.resultCount} 个项目，其中 ${recallBaseline.acceptedCount} 个已确认`, {
          baselineScanId: recallBaseline.scanId, baselineUrls: recallBaseline.urls.length,
        });
    }
    if (firecrawlApiKey) logScan(scanId, "info", "mcp", "firecrawl_fallback_enabled",
      "已启用 Firecrawl 云端枚举与正文回退；本机超时、反爬或动态页面将自动切换", { sources: sources.length });
    if (genericMcpProfiles.length) {
      logScan(scanId, "info", "mcp", "parallel_started", `并行调用 ${genericMcpProfiles.length} 个 MCP 服务器`, {
        servers: genericMcpProfiles.map((profile) => profile.name), tools: request.mcpToolNames ?? [],
      });
      const mcpResults = await invokeMcpServersParallel(genericMcpProfiles, request.mcpToolNames ?? [], {
        startDate: request.startDate, endDate: request.endDate, sourceUrls: sources.map((source) => source.url),
        maxPages: request.budget.maxPages,
        query: `${request.startDate.slice(0, 4)}-${request.endDate.slice(0, 4)} 海外 光伏 储能 风电 EPC 项目 solar battery wind project`,
      });
      mcpCalls = mcpResults.length;
      for (const result of mcpResults) {
        if (!result.ok) {
          mcpFailures++; failures++; addFailure("MCP_CALL_ERROR");
          logScan(scanId, "error", "mcp", "tool_failed", `${result.serverName} / ${result.tool}：${result.error}`, { latencyMs: result.latencyMs });
          continue;
        }
        logScan(scanId, "info", "mcp", "tool_completed", `${result.serverName} / ${result.tool} 调用完成`, { latencyMs: result.latencyMs });
        const mcpPageLimit = Math.max(0, Math.min(request.budget.maxPages - fetched - sources.length,
          Math.floor(request.budget.maxPages * Number(currentRetrievalPolicy().mcp_page_share ?? 0.2))));
        for (const url of extractMcpUrls(result.result)) {
          await scanControlPoint(scanId);
          if (mcpFetched >= mcpPageLimit) break;
          const normalized = normalizeUrl(url);
          if (!normalized || fetchedUrls.has(normalized) || fetched >= request.budget.maxPages) continue;
          fetchedUrls.add(normalized); discovered++;
          const doc = await fetchDocument(url, `mcp:${result.serverId}`, "mcp");
          fetched++; mcpFetched++; doc.dateStatus = dateStatusFor(doc, request.startDate, request.endDate);
          if (doc.error) { failures++; addFailure(doc.failureCode ?? "FETCH_ERROR"); }
          else {
            fullTextSucceeded++;
            if (doc.rendered) dynamicPages++;
            if (doc.dateStatus === "within_range") withinRange++;
            else if (doc.dateStatus === "outside_range") outsideRange++;
            else if (doc.dateStatus === "date_conflict") dateConflict++;
            else dateUnknown++;
            retainForAssessment(doc);
          }
          saveDocument(scanId, doc);
        }
      }
      setProgress(scanId, { mcpCalls, mcpFailures, pagesDiscovered: discovered, pagesFetched: fetched, failures, failureReasons });
    }
    // Firecrawl 熔断：402（额度耗尽）/429（限流）出现时，本次扫描后续不再调用 Firecrawl，
    // 避免数百页每页都白调一次（402 在额度周期内不会自愈）
    let firecrawlDisabled = false;
    const fetchWithFallback = async (...args: Parameters<typeof fetchDocument>) => {
      if (firecrawlApiKey && !firecrawlDisabled) {
        mcpCalls++;
        try {
          const external = await scrapeWithFirecrawl(firecrawlApiKey, args[0], args[1]);
          const externalQuality = documentContentQuality(external, args[0]);
          if (externalQuality.reliable) return external;
          logScan(scanId, "warn", "fetch", "external_content_quality_rejected",
            `Firecrawl 返回了可访问页面，但正文质量未通过：${externalQuality.reasons.join("、") || "低质量正文"}；切换本机浏览器复核`, {
              url: args[0], title: external.title, score: externalQuality.score, reasons: externalQuality.reasons,
            });
          const local = await fetchDocument(args[0], args[1], args[2], true);
          const localQuality = documentContentQuality(local, args[0]);
          const selected = localQuality.score > externalQuality.score ? local : external;
          selected.warnings.push(`正文质量门控：Firecrawl ${externalQuality.score} 分，本机浏览器 ${localQuality.score} 分，已保留较高质量版本`);
          return selected;
        } catch (error) {
          mcpFailures++;
          const message = error instanceof Error ? error.message : String(error);
          if (/HTTP (402|429)/.test(message)) {
            firecrawlDisabled = true;
            logScan(scanId, "warn", "mcp", "firecrawl_circuit_open",
              `Firecrawl 配额耗尽或限流（${message.slice(0, 80)}），本次扫描已停用 Firecrawl 回退，改用本机采集`, {});
          } else {
            logScan(scanId, "warn", "mcp", "firecrawl_scrape_fallback_failed",
              `Firecrawl 正文回退失败，继续使用本机采集：${message}`,
              { url: args[0], sourceId: args[1] });
          }
        }
      }
      return fetchDocument(...args);
    };
    const sourceForUrl = (url: string) => {
      let host = "";
      try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return sources[0]; }
      return sources.find((source) => {
        try {
          const sourceHost = new URL(source.url).hostname.replace(/^www\./, "");
          return host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`);
        } catch { return false; }
      }) ?? sources[0];
    };
    const baselineAllowance = Math.max(0, request.budget.maxPages - fetched - sources.length);
    const baselineUrls = (recallBaseline?.urls ?? []).slice(0,
      Math.min(baselineAllowance, Math.max(1, Math.floor(request.budget.maxPages * 0.2))));
    for (const url of baselineUrls) {
      await scanControlPoint(scanId);
      const normalized = normalizeUrl(url);
      if (!normalized || fetchedUrls.has(normalized) || fetched >= request.budget.maxPages - sources.length) continue;
      fetchedUrls.add(normalized);
      baselineUrlsAttempted++;
      discovered++;
      const source = sourceForUrl(url);
      let doc = await fetchWithFallback(url, source?.id ?? "baseline", "source");
      fetched++;
      doc.dateStatus = dateStatusFor(doc, request.startDate, request.endDate);
      const acceptedBaseline = baselineEvidenceByUrl.get(normalized);
      const liveQuality = documentContentQuality(doc, url);
      if (acceptedBaseline?.documentId && !liveQuality.reliable) {
        const row = db.prepare("SELECT * FROM documents WHERE id=? AND scan_id=?")
          .get(acceptedBaseline.documentId, String(recallBaseline?.scanId ?? "")) as Record<string, unknown> | undefined;
        if (row?.text) {
          const archivedCandidates = jsonParse<string[]>(row.date_candidates_json, []);
          const archived: CrawledDocument = {
            id: randomUUID(),
            url: String(row.url), canonicalUrl: String(row.canonical_url), title: String(row.title),
            publishedAt: row.published_at ? String(row.published_at) : null, fetchedAt: now(),
            contentType: String(row.content_type), statusCode: Number(row.status_code), hash: String(row.hash),
            text: String(row.text), markdown: String(row.markdown), rawPath: String(row.raw_path), markdownPath: String(row.markdown_path),
            sourceId: source?.id ?? String(row.source_id), dateCandidates: archivedCandidates,
            dateStatus: "date_unknown", dateEvidence: String(row.date_evidence ?? ""),
            fetchMode: String(row.fetch_mode) as CrawledDocument["fetchMode"], rendered: Boolean(row.rendered),
            discoveryMethod: "source", warnings: [...jsonParse<string[]>(row.warnings_json, []),
              `实时页面正文质量退化（${liveQuality.reasons.join("、") || `${liveQuality.score}分`}）；已使用同口径已确认任务的原文归档重新评估`],
            pageType: String(row.page_type) as CrawledDocument["pageType"], extractionMethod: `baseline-archive:${row.extraction_method}`,
            attemptCount: doc.attemptCount, failureCode: undefined, error: undefined,
          };
          archived.dateStatus = dateStatusFor(archived, request.startDate, request.endDate);
          doc = archived;
          logScan(scanId, "warn", "recall", "baseline_archive_restored",
            `实时页面正文与目标文章不一致，已恢复已确认原文归档：${archived.title}`, {
              url, baselineScanId: recallBaseline?.scanId, liveQuality, archivedLength: archived.text.length,
            });
        }
      }
      if (doc.error) {
        failures++; addFailure(doc.failureCode ?? "FETCH_ERROR");
        logScan(scanId, "warn", "recall", "baseline_url_failed", `历史项目页面回查失败：${doc.error}`, {
          url, source: source?.name ?? "",
        });
      } else {
        baselineUrlsRevalidated++;
        fullTextSucceeded++;
        if (doc.rendered) dynamicPages++;
        if (doc.dateStatus === "within_range") withinRange++;
        else if (doc.dateStatus === "outside_range") outsideRange++;
        else if (doc.dateStatus === "date_conflict") dateConflict++;
        else dateUnknown++;
        retainForAssessment(doc);
        const hints = baselineHints.get(normalized);
        if (hints && doc.canonicalUrl !== normalized) baselineHints.set(doc.canonicalUrl, hints);
        logScan(scanId, "info", "recall", "baseline_url_revalidated", `已回查历史项目页面：${doc.title}`, {
          url: doc.url, dateStatus: doc.dateStatus,
        });
      }
      saveDocument(scanId, doc);
      setProgress(scanId, { recall: {
        status: "revalidating", baselineScanId: recallBaseline?.scanId,
        baselineResultCount: recallBaseline?.resultCount ?? 0,
        baselineAcceptedCount: recallBaseline?.acceptedCount ?? 0,
        baselineUrls: recallBaseline?.urls.length ?? 0,
        baselineUrlsAttempted, baselineUrlsRevalidated,
      } });
    }
    const sourcePageBudget = Math.max(0, request.budget.maxPages - fetched);
    const baseSourceQuota = Math.floor(sourcePageBudget / Math.max(1, sources.length));
    const extraSourceSlots = sourcePageBudget % Math.max(1, sources.length);
    let activeSourceFetches = 0;
    const fetchWithinBudget = async (...args: Parameters<typeof fetchDocument>) => {
      if (fetched + activeSourceFetches >= request.budget.maxPages) return undefined;
      activeSourceFetches++;
      try { return await fetchWithFallback(...args); }
      finally { activeSourceFetches--; fetched++; }
    };
    // 页级看门狗：任何单页处理（静态抓取→浏览器渲染→解析）不得超过上限。
    // 2026-08-10 事故：某站点页面让渲染永久挂起，整个扫描停滞 1.8 小时且停止请求无法生效。
    // 超时按失败跳过该页；底层挂起的 Promise 不再可信，但不做任何数据库写入，扫描继续。
    const pageWatchdogMs = Number(process.env.DPM_PAGE_WATCHDOG_MS) || 240_000;
    const fetchWithWatchdog = async (...args: Parameters<typeof fetchDocument>): Promise<CrawledDocument | undefined> => {
      const [pageUrl, pageSourceId, pageMethod] = args;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fetchWithinBudget(...args),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("页面处理看门狗超时")), pageWatchdogMs);
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/看门狗/.test(message)) throw error;
        return failedDocument(pageUrl, pageSourceId,
          `页面处理超过 ${Math.round(pageWatchdogMs / 1000)}s 未完成（可能遭遇反爬挂起或浏览器卡死），已跳过该页`,
          pageMethod ?? "page-link", "WATCHDOG_TIMEOUT");
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const processSource = async (sourceIndex: number) => {
      await scanControlPoint(scanId);
      const source = sources[sourceIndex];
      const coverageState = sourceCoverageStates.find((state) => state.sourceId === source.id)!;
      coverageState.status = "running";
      coverageState.startedAt = now();
      setProgress(scanId, { sourceCoverage: sourceCoverageProgress() });
      logScan(scanId, "info", "discovery", "source_started", `开始枚举来源：${source.name}`, { sourceId: source.id, url: source.url });
      const sourceQuota = Math.max(1, baseSourceQuota + (sourceIndex < extraSourceSlots ? 1 : 0));
      let discovery: Awaited<ReturnType<typeof discoverSourcePages>> | undefined;
      if (firecrawlApiKey && !firecrawlDisabled) {
        try {
          const sourcePath = new URL(source.url).pathname;
          const looksLikeArticle = /\.(?:s?html?|pdf)$|\/detail|\/content|\/doc-|\/news\//i.test(sourcePath);
          let mapped: string[];
          if (looksLikeArticle) mapped = [source.url];
          else {
            mcpCalls++;
            mapped = await mapWithFirecrawl(firecrawlApiKey, source.url, Math.max(12, sourceQuota * 6),
              `${request.startDate.slice(0, 4)} 光伏 储能 风电 项目 solar battery wind project`);
          }
          mapped = rankDiscoveredUrls(mapped, source.url, request.startDate, request.endDate);
          if (mapped.length) discovery = {
            pages: mapped.slice(0, sourceQuota).map((url) => ({ url, method: "mcp" as const })),
            strategies: ["firecrawl-map"], discoveryPagesFetched: 1, truncated: mapped.length > sourceQuota, failures: [],
          };
        } catch (error) {
          mcpFailures++;
          const message = error instanceof Error ? error.message : String(error);
          if (/HTTP (402|429)/.test(message)) {
            firecrawlDisabled = true;
            logScan(scanId, "warn", "mcp", "firecrawl_circuit_open",
              `Firecrawl 配额耗尽或限流（${message.slice(0, 80)}），本次扫描已停用 Firecrawl 枚举与回退`, {});
          } else {
            logScan(scanId, "warn", "mcp", "firecrawl_map_failed",
              `Firecrawl 枚举失败，切换本机 Sitemap/浏览器策略：${message}`,
              { sourceId: source.id, source: source.name, url: source.url });
          }
        }
      }
      discovery ??= await discoverSourcePages(source, request.startDate, request.endDate, sourceQuota);
      for (const failure of discovery.failures) {
        addFailure("DISCOVERY_ERROR");
        logScan(scanId, "warn", "discovery", "strategy_failed", failure, { sourceId: source.id, source: source.name });
      }
      discovery.strategies.forEach((strategy) => discoveryStrategies.add(strategy));
      failures += discovery.failures.length;
      if (discovery.truncated) discoveryTruncated++;
      discovered += discovery.pages.length;
      const enqueue = db.prepare(`INSERT OR IGNORE INTO crawl_queue
        (id,scan_id,source_id,url,method,status,attempts,priority,date_hint,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',0,0,?,?,?,?)`);
      for (const page of discovery.pages) enqueue.run(
        randomUUID(), scanId, source.id, page.url, page.method, page.dateHint ?? null, null, now(), now(),
      );
      logScan(scanId, discovery.truncated ? "warn" : "info", "discovery", "source_completed",
        `${source.name} 发现 ${discovery.pages.length} 个候选页面${discovery.truncated ? "，候选池已按来源公平配额截取" : ""}`,
        { strategies: discovery.strategies, discoveryPagesFetched: discovery.discoveryPagesFetched, truncated: discovery.truncated });
      let fetchedForSource = 0;
      let successfulForSource = 0;
      let relevantForSource = 0;
      for (const page of discovery.pages) {
        await scanControlPoint(scanId);
        if (fetched >= request.budget.maxPages || fetchedForSource >= sourceQuota) break;
        const normalized = normalizeUrl(page.url);
        if (!normalized || fetchedUrls.has(normalized)) continue;
        fetchedUrls.add(normalized);
        db.prepare("UPDATE crawl_queue SET status='in_progress',attempts=attempts+1,updated_at=? WHERE scan_id=? AND url=?")
          .run(now(), scanId, page.url);
        const doc = await fetchWithWatchdog(page.url, source.id, page.method, /dynamic|spa|javascript/i.test(source.type));
        if (!doc) break;
        doc.dateStatus = dateStatusFor(doc, request.startDate, request.endDate);
        if (doc.error) {
          failures++; addFailure(doc.failureCode ?? "FETCH_ERROR");
          fetchedForSource++;
          db.prepare("UPDATE crawl_queue SET status='failed',last_error=?,updated_at=? WHERE scan_id=? AND url=?")
            .run(doc.error, now(), scanId, page.url);
          logScan(scanId, "error", "fetch", "page_failed", `${doc.failureCode ?? "FETCH_ERROR"}：${doc.error}`, {
            source: source.name, url: page.url, attempts: doc.attemptCount, method: page.method,
          });
        } else {
          successfulForSource++;
          // 配额按有效产出：列表/首页类聚合页不产生项目，不计入每来源正文配额，
          // 让 sourceQuota 真正花在文章页上（全局 fetched 仍计数，防超预算）
          const isAggregatorPage = ["listing", "homepage"].includes(doc.pageType) || doc.extractionMethod === "body-fallback";
          if (!isAggregatorPage) fetchedForSource++;
          const quality = documentContentQuality(doc, page.url);
          if (quality.reliable && ["within_range", "date_unknown", "date_conflict"].includes(doc.dateStatus)) {
            const signal = `${doc.title}\n${doc.text.slice(0, 20_000)}`;
            if (/光伏|储能|新能源|太阳能|风电|电站|EPC|solar|photovoltaic|battery|storage|renewable|wind\s*(?:farm|power|energy)|energy project/i.test(signal) &&
              /项目|电站|电场|园区|基地|中标|开工|投产|并网|签署|合同|收购|融资|获批|project|plant|farm|facility|award|contract|construction|commission|financ|approv/i.test(signal)) {
              relevantForSource++;
            }
          }
          db.prepare("UPDATE crawl_queue SET status='done',last_error=NULL,updated_at=? WHERE scan_id=? AND url=?")
            .run(now(), scanId, page.url);
          logScan(scanId, "info", "fetch", "page_fetched", `${doc.title} · ${doc.pageType} · ${doc.fetchMode}`, {
            url: doc.url, statusCode: doc.statusCode, textLength: doc.text.length, attempts: doc.attemptCount,
            dateStatus: doc.dateStatus, extractionMethod: doc.extractionMethod,
          });
        }
        if (doc.rendered) dynamicPages++;
        if (!doc.error && doc.text) {
          fullTextSucceeded++;
          if (doc.dateStatus === "within_range") withinRange++;
          else if (doc.dateStatus === "outside_range") outsideRange++;
          else if (doc.dateStatus === "date_conflict") dateConflict++;
          else dateUnknown++;
          retainForAssessment(doc);
        }
        saveDocument(scanId, doc);
        await delay(source.rateLimitMs);
      }
      if (relevantForSource === 0 && searchProviders.length && searches < request.budget.maxSearches) {
        let hostname = "";
        try { hostname = new URL(source.url).hostname; } catch { /* discovery already recorded the invalid URL */ }
        const query = `site:${hostname} (光伏 OR 储能 OR 风电 OR solar OR battery) after:${request.startDate} before:${request.endDate}`;
        logScan(scanId, "warn", "discovery", "search_fallback_started",
          `${source.name} 直接枚举未取得合格项目候选正文，切换到站内搜索索引回退`, { sourceId: source.id, query });
        for (const searchProvider of searchProviders) {
          const reservedCoverageSlots = sourceCoverageStates.filter((state) =>
            state.sourceId !== source.id && ["pending", "running"].includes(state.status)).length;
          if (searches >= request.budget.maxSearches ||
            fetched + activeSourceFetches + reservedCoverageSlots >= request.budget.maxPages) break;
          searches++;
          try {
            const hits = await searchWeb(searchProvider, query, 5);
            for (const hit of hits) {
              const liveReservedSlots = sourceCoverageStates.filter((state) =>
                state.sourceId !== source.id && ["pending", "running"].includes(state.status)).length;
              if (fetched + activeSourceFetches + liveReservedSlots >= request.budget.maxPages || relevantForSource > 0) break;
              const normalized = normalizeUrl(hit.url);
              if (!normalized || fetchedUrls.has(normalized)) continue;
              fetchedUrls.add(normalized); discovered++;
              const doc = await fetchWithWatchdog(hit.url, source.id, "search");
              if (!doc) break;
              fetchedForSource++;
              doc.dateStatus = dateStatusFor(doc, request.startDate, request.endDate);
              if (doc.error) { failures++; addFailure(doc.failureCode ?? "FETCH_ERROR"); }
              else {
                successfulForSource++; fullTextSucceeded++;
                if (doc.rendered) dynamicPages++;
                if (doc.dateStatus === "within_range") withinRange++;
                else if (doc.dateStatus === "outside_range") outsideRange++;
                else if (doc.dateStatus === "date_conflict") dateConflict++;
                else dateUnknown++;
                retainForAssessment(doc);
                const quality = documentContentQuality(doc, hit.url);
                const signal = `${doc.title}\n${doc.text.slice(0, 20_000)}`;
                if (quality.reliable && ["within_range", "date_unknown", "date_conflict"].includes(doc.dateStatus) &&
                  /光伏|储能|新能源|太阳能|风电|电站|EPC|solar|photovoltaic|battery|storage|renewable|wind/i.test(signal) &&
                  /项目|电站|电场|园区|基地|中标|开工|投产|并网|签署|合同|融资|project|plant|farm|facility|award|contract|construction|commission|financ/i.test(signal)) {
                  relevantForSource++;
                }
              }
              saveDocument(scanId, doc);
            }
          } catch (error) {
            failures++; addFailure("SEARCH_FALLBACK_ERROR");
            logScan(scanId, "error", "discovery", "search_fallback_failed",
              error instanceof Error ? error.message : String(error), { sourceId: source.id, provider: searchProvider.name });
          }
        }
      }
      return { discovered: discovery.pages.length, fetched: fetchedForSource, succeeded: successfulForSource };
    };
    const sourceConcurrency = Math.max(1, Math.min(request.budget.maxConcurrency, sources.length));
    logScan(scanId, "info", "discovery", "parallel_sources_started", `并发监测 ${sourceConcurrency} 个网站`, {
      selectedSources: sources.length, maxConcurrency: sourceConcurrency,
    });
    await runAllSourceJobs(sources, sourceConcurrency, async (_source, sourceIndex) => processSource(sourceIndex), (outcome) => {
      const state = sourceCoverageStates.find((item) => item.sourceId === outcome.item.id)!;
      completedSources++;
      state.completedAt = now();
      if (outcome.status === "fulfilled") {
        state.discovered = outcome.value.discovered;
        state.fetched = outcome.value.fetched;
        state.succeeded = outcome.value.succeeded;
        if (outcome.value.succeeded > 0) {
          state.status = "completed";
        } else {
          state.status = "failed";
          state.error = "已完成枚举和抓取尝试，但未取得可用网页正文";
          failures++;
          addFailure("SOURCE_NO_CONTENT");
          logScan(scanId, "warn", "discovery", "source_no_content", `${outcome.item.name} 已完成扫描，但未取得可用正文`, {
            sourceId: outcome.item.id, source: outcome.item.name, url: outcome.item.url,
          });
        }
      } else {
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        state.status = "failed";
        state.error = message;
        failures++;
        addFailure("SOURCE_SCAN_ERROR");
        logScan(scanId, "error", "discovery", "source_scan_failed", `来源扫描发生未预期错误，已隔离并继续处理其他网站：${message}`, {
          sourceId: outcome.item.id, source: outcome.item.name, url: outcome.item.url,
        });
      }
      setProgress(scanId, {
        sourcesScanned: completedSources, sourceCoverage: sourceCoverageProgress(),
        pagesDiscovered: discovered, pagesFetched: fetched,
        fullTextSucceeded, withinRange, outsideRange, dateUnknown, dateConflict, dynamicPages,
        discoveryTruncated, discoveryStrategies: [...discoveryStrategies], failures, failureReasons,
        percent: Math.min(65, Math.round((completedSources / Math.max(1, request.sourceIds.length)) * 60)),
      });
    }, (error) => error instanceof ScanStoppedError);
    if (completedSources !== request.sourceIds.length || !sourceCoverageProgress().allSettled) {
      throw new Error(`来源覆盖不完整：仅结算 ${completedSources}/${request.sourceIds.length} 个选定网站，任务禁止标记为完成`);
    }
    logScan(scanId, sourceCoverageProgress().failed ? "warn" : "info", "discovery", "all_sources_settled",
      `所有选定网站均已处理：${completedSources}/${request.sourceIds.length}，成功 ${sourceCoverageProgress().succeeded}，失败 ${sourceCoverageProgress().failed}`,
      { sourceCoverage: sourceCoverageProgress() });
    if (request.referenceRows?.length && searchProviders.length) {
      for (const reference of request.referenceRows) {
        if (searches >= request.budget.maxSearches || fetched >= request.budget.maxPages) break;
        const query = buildReferenceQuery(reference);
        for (const searchProvider of searchProviders) {
          if (searches >= request.budget.maxSearches) break;
          searches++;
          try {
            const hits = await searchWeb(searchProvider, query, 8);
            for (const hit of hits.slice(0, 5)) {
              if (fetched >= request.budget.maxPages) break;
              const doc = await fetchDocument(hit.url, "search", "search");
              fetched++;
              doc.dateStatus = dateStatusFor(doc, request.startDate, request.endDate);
              if (doc.error) failures++;
              else if (doc.dateStatus === "within_range") documents.set(doc.canonicalUrl, doc);
              saveDocument(scanId, doc);
            }
          } catch { failures++; }
        }
      }
    }
    const documentList = [...documents.values()];
    if (request.referenceRows?.length) {
      for (const reference of request.referenceRows) {
        const match = findBestReferenceMatch(reference, documentList, sources);
        insertReferenceResult(scanId, reference, match);
      }
    } else {
      logScan(scanId, "info", "classification", "started", `开始评估 ${documentList.length} 个范围内页面`, {
        modelEnabled: Boolean(provider && request.modelId), modelTimeLimitDisabled: true,
      });
      for (const doc of documentList) {
        await scanControlPoint(scanId);
        const source = sources.find((item) => item.id === doc.sourceId);
        const analyzed = await assessArticle(doc, fields, provider, request.modelId,
          baselineHints.get(doc.canonicalUrl) ?? baselineHints.get(normalizeUrl(doc.url) ?? "") ?? []);
        if (analyzed.modelUsed) modelExtractions++;
        if (analyzed.error) {
          doc.warnings.push(`模型判定失败，已使用规则兜底：${analyzed.error}`);
          addFailure("MODEL_EXTRACTION_ERROR");
          logScan(scanId, "error", "model", "extraction_failed", `模型抽取失败，规则兜底：${analyzed.error}`, {
            url: doc.url, title: doc.title, modelId: request.modelId ?? "",
          });
        }
        if (analyzed.assessment.classification === "project_report") projectArticles++;
        else if (analyzed.assessment.classification === "non_project") nonProjectArticles++;
        else uncertainArticles++;
        projectMentions += analyzed.assessment.mentions.length;
        saveAssessment(scanId, doc, analyzed.assessment, fields, source?.url ?? "", analyzed.modelUsed);
        logScan(scanId, analyzed.assessment.classification === "uncertain" ? "warn" : "info", "classification", "article_classified",
          `${analyzed.assessment.classification}：${doc.title}`, {
            url: doc.url, confidence: analyzed.assessment.confidence, reasoning: analyzed.assessment.reasoning,
            mentions: analyzed.assessment.mentions.length, pageType: doc.pageType,
          });
        setProgress(scanId, {
          projectArticles, nonProjectArticles, uncertainArticles, projectMentions, modelExtractions,
          percent: Math.min(95, 65 + Math.round(((projectArticles + nonProjectArticles + uncertainArticles) /
            Math.max(1, documentList.length)) * 30)),
        });
      }
    }
    const resultCount = request.referenceRows?.length
      ? Number((db.prepare("SELECT COUNT(*) AS count FROM results WHERE scan_id=?").get(scanId) as { count: number }).count)
      : Number((db.prepare("SELECT COUNT(*) AS count FROM projects WHERE scan_id=?").get(scanId) as { count: number }).count);
    const recall = recallComparison(getResults(scanId), recallBaseline);
    const recallProgress = {
      ...recall,
      baselineUrls: recallBaseline?.urls.length ?? 0,
      baselineUrlsAttempted,
      baselineUrlsRevalidated,
    };
    if (recall.status === "regressed") {
      logScan(scanId, "warn", "recall", "regression_detected",
        `结果仍低于同口径基线：当前 ${recall.resultCount} 个/已确认 ${recall.acceptedCount} 个，基线 ${recall.baselineResultCount} 个/已确认 ${recall.baselineAcceptedCount} 个`, recallProgress);
    } else if (recallBaseline) {
      logScan(scanId, "info", "recall", "comparison_completed", `召回对比完成：${recall.status}`, recallProgress);
    }
    setProgress(scanId, {
      pagesDiscovered: discovered, pagesFetched: fetched, modelExtractions, searches,
      mcpCalls, mcpFailures,
      fullTextSucceeded, withinRange, outsideRange, dateUnknown, dateConflict, dynamicPages,
      discoveryTruncated, discoveryStrategies: [...discoveryStrategies],
      projectArticles, nonProjectArticles, uncertainArticles, projectMentions,
      results: resultCount, failures, failureReasons, recall: recallProgress, percent: 100, completedAt: now(),
      sourcesScanned: completedSources, sourceCoverage: sourceCoverageProgress(),
    }, "completed");
    logScan(scanId, "info", "lifecycle", "completed", `任务完成，生成 ${resultCount} 个项目`, {
      pagesFetched: fetched, failures, failureReasons, projectArticles, projectMentions: projectMentions,
    });
    audit("scan", scanId, "completed", {
      resultCount, fetched, failures, withinRange, outsideRange, dateUnknown, dateConflict,
      projectArticles, nonProjectArticles, uncertainArticles, projectMentions, dynamicPages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ScanStoppedError) {
      setProgress(scanId, { stoppedAt: now(), failureReasons, sourcesScanned: completedSources, sourceCoverage: sourceCoverageProgress() }, "stopped");
      logScan(scanId, "warn", "lifecycle", "stopped", "任务已停止，已完成的数据和日志均已保留");
      audit("scan", scanId, "stopped", { message });
    } else {
      setProgress(scanId, { failedAt: now(), failureReasons, sourcesScanned: completedSources, sourceCoverage: sourceCoverageProgress() }, "failed");
      db.prepare("UPDATE scans SET status='failed', error=?, updated_at=? WHERE id=?").run(message, now(), scanId);
      logScan(scanId, "error", "lifecycle", "failed", `任务失败：${message}`, { failureReasons });
      audit("scan", scanId, "failed", { message });
    }
  } finally {
    setIgnoreRobots(false);
    markScanActive(scanId, false);
  }
}

function extractMcpUrls(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const matches = serialized.match(/https?:\/\/[^\s"'<>}\])]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:]+$/, "")))].slice(0, 500);
}

function saveDocument(scanId: string, doc: CrawledDocument) {
  const existing = db.prepare("SELECT id FROM documents WHERE scan_id=? AND canonical_url=?")
    .get(scanId, doc.canonicalUrl) as { id: string } | undefined;
  if (existing) {
    doc.id = existing.id;
    return;
  }
  db.prepare(`INSERT OR IGNORE INTO documents
    (id,scan_id,source_id,url,canonical_url,title,published_at,fetched_at,content_type,status_code,hash,text,markdown,
     raw_path,markdown_path,error,date_status,date_evidence,date_candidates_json,fetch_mode,rendered,discovery_method,warnings_json,
     page_type,extraction_method,attempt_count,failure_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      doc.id, scanId, doc.sourceId, doc.url, doc.canonicalUrl, doc.title, doc.publishedAt, doc.fetchedAt,
      doc.contentType, doc.statusCode, doc.hash, doc.text, doc.markdown, doc.rawPath, doc.markdownPath, doc.error ?? null,
      doc.dateStatus, doc.dateEvidence, JSON.stringify(doc.dateCandidates), doc.fetchMode, doc.rendered ? 1 : 0,
      doc.discoveryMethod ?? "page-link", JSON.stringify(doc.warnings),
      doc.pageType, doc.extractionMethod, doc.attemptCount, doc.failureCode ?? null,
    );
}

function insertResult(
  scanId: string, documentId: string, fields: Record<string, unknown>, primaryUrl: string,
  candidateUrls: string[], evidence: Record<string, string>, conflicts: string[], score: number,
) {
  const id = randomUUID();
  const status = score >= 85 && conflicts.length === 0 ? "auto_approved" : score >= 60 ? "review" : "rejected";
  db.prepare("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id, scanId, documentId || null, JSON.stringify(fields), primaryUrl, JSON.stringify([...new Set(candidateUrls)]),
    JSON.stringify(evidence), JSON.stringify(conflicts), score, status, 1, null, now(), now(),
  );
  return id;
}

function buildReferenceQuery(reference: Record<string, unknown>) {
  return [
    reference.project_name ?? reference["项目名称"], reference.country ?? reference["国家"],
    reference.pv_capacity_mw ?? reference["光伏容量\nMW"], reference.storage_capacity_mwh ?? reference["储能容量\nMWh"],
    reference.owner ?? reference["业主"], reference.chinese_client ?? reference["中资客户"],
  ].filter((value) => value !== null && value !== undefined && value !== "").join(" ");
}

function referenceValue(reference: Record<string, unknown>, id: string, label: string) {
  return reference[id] ?? reference[label] ?? "";
}

function normalizeReference(reference: Record<string, unknown>) {
  const fields = listFields();
  return Object.fromEntries(fields.map((field) => [field.id, referenceValue(reference, field.id, field.label)]));
}

function findBestReferenceMatch(reference: Record<string, unknown>, documents: CrawledDocument[], sources: SourceRecord[]) {
  const normalized = normalizeReference(reference);
  const candidates = documents.map((doc) => {
    const source = sources.find((item) => item.id === doc.sourceId);
    const { score, conflicts, evidence } = scoreAgainstReference(normalized, doc, source);
    return { doc, score, conflicts, evidence };
  }).sort((a, b) => b.score - a.score);
  return { best: candidates[0], candidates: candidates.slice(0, 5) };
}

function scoreAgainstReference(reference: Record<string, unknown>, doc: CrawledDocument, source?: SourceRecord) {
  const text = `${doc.title}\n${doc.text}`.toLowerCase();
  const conflicts: string[] = [];
  const evidence: Record<string, string> = {};
  let score = 0;
  const projectName = String(reference.project_name ?? "").trim();
  const nameTokens = projectName.toLowerCase().split(/[\s（）()，,、/]+/).filter((token) => token.length >= 2);
  const nameHits = nameTokens.filter((token) => text.includes(token)).length;
  if (nameTokens.length && nameHits / nameTokens.length >= 0.45) score += 20;
  const country = String(reference.country ?? "");
  const address = String(reference.address ?? "");
  if ((country && text.includes(country.toLowerCase())) || (address && text.includes(address.toLowerCase()))) score += 15;
  const pv = Number(reference.pv_capacity_mw);
  const storage = Number(reference.storage_capacity_mwh);
  let capacityMatched = false;
  if (Number.isFinite(pv) && pv > 0) capacityMatched ||= capacityInText(text, pv, false);
  if (Number.isFinite(storage) && storage > 0) capacityMatched ||= capacityInText(text, storage, true);
  if (capacityMatched) score += 25;
  else if ((Number.isFinite(pv) && pv > 0) || (Number.isFinite(storage) && storage > 0)) conflicts.push("容量未在页面中得到一致验证");
  const owner = String(reference.owner ?? "");
  const client = String(reference.chinese_client ?? "");
  if ((owner && text.includes(owner.toLowerCase().slice(0, 6))) || (client && text.includes(client.toLowerCase().slice(0, 6)))) score += 15;
  const progress = String(reference.progress ?? "");
  if (progress && progress.split(/[（(]/)[0] && text.includes(progress.split(/[（(]/)[0].toLowerCase().slice(0, 4))) score += 10;
  const month = String(reference.published_month ?? "").replace(".", "-").slice(0, 7);
  if (doc.publishedAt?.startsWith(month)) score += 10;
  try {
    if (source && new URL(doc.url).hostname === new URL(normalizeUrl(source.url)).hostname) score += 5;
  } catch { /* no authority points */ }
  if (projectName) evidence.project_name = doc.title;
  if (country) evidence.country = doc.text.match(new RegExp(`.{0,50}${escapeRegex(country)}.{0,80}`, "i"))?.[0] ?? "";
  if (capacityMatched) evidence.capacity = doc.text.match(/.{0,80}\d+(?:\.\d+)?\s*(?:GW|MW|GWh|MWh|兆瓦|兆瓦时).{0,100}/i)?.[0] ?? "";
  return { score, conflicts, evidence };
}

function capacityInText(text: string, value: number, storage: boolean) {
  const variants = [String(value), value.toFixed(1), value.toFixed(2)].map((item) => item.replace(/\.0+$/, ""));
  const units = storage ? "(?:mwh|兆瓦时)" : "(?:mw|兆瓦)";
  if (variants.some((item) => new RegExp(`${escapeRegex(item)}\\s*${units}`, "i").test(text))) return true;
  if (value >= 1000) {
    const gw = value / 1000;
    return new RegExp(`${escapeRegex(String(gw))}\\s*${storage ? "(?:gwh|吉瓦时)" : "(?:gw|吉瓦)"}`, "i").test(text);
  }
  return false;
}

function insertReferenceResult(
  scanId: string, reference: Record<string, unknown>,
  match: ReturnType<typeof findBestReferenceMatch>,
) {
  const fields = normalizeReference(reference);
  const best = match.best;
  insertResult(
    scanId, best?.doc.id ?? "", fields, best?.doc.url ?? "",
    match.candidates.map((candidate) => candidate.doc.url),
    best?.evidence ?? {}, best?.conflicts ?? ["未找到可靠候选页面"], best?.score ?? 0,
  );
}

async function deepExpand(resultId: string, args: JsonObject) {
  const projectRow = db.prepare("SELECT * FROM projects WHERE id=?").get(resultId) as Record<string, unknown> | undefined;
  if (projectRow) return deepExpandProject(projectRow, args);
  const row = db.prepare("SELECT * FROM results WHERE id=?").get(resultId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("结果不存在");
  const result = mapResult(row);
  const scan = getScan(result.scanId);
  if (!scan) throw new Error("扫描任务不存在");
  const searchProviders = (scan.request.searchProviderIds ?? []).map(getSearchProvider).filter(Boolean) as SearchProviderRecord[];
  if (!searchProviders.length) throw new Error("未配置可用的搜索 API");
  const reference = result.fields;
  const baseQuery = buildReferenceQuery(reference);
  const queries = [
    baseQuery,
    `${baseQuery} contract EPC`,
    `${baseQuery} agreement award`,
    `${baseQuery} site:gov`,
    `${String(reference.project_name ?? "")} ${String(reference.owner ?? "")}`,
    `${String(reference.address ?? "")} ${String(reference.pv_capacity_mw ?? "")} solar`,
  ].filter(Boolean).slice(0, Number(args.maxQueries ?? 12));
  const documents: CrawledDocument[] = [];
  for (const query of queries) {
    for (const searchProvider of searchProviders) {
      const hits = await searchWeb(searchProvider, query, 10);
      for (const hit of hits) {
        if (documents.length >= Number(args.maxPages ?? 20)) break;
        const doc = await fetchDocument(hit.url, "deep-search");
        saveDocument(result.scanId, doc);
        if (!doc.error) documents.push(doc);
      }
    }
    if (documents.length >= Number(args.maxPages ?? 20)) break;
  }
  const sources = listSources();
  const match = findBestReferenceMatch(reference, documents, sources);
  const best = match.best;
  const candidateUrls = [...new Set([...result.candidateUrls, ...match.candidates.map((candidate) => candidate.doc.url)])];
  const revision = result.revision + 1;
  db.prepare(`UPDATE results SET document_id=?, primary_url=?, candidate_urls_json=?, evidence_json=?,
    conflicts_json=?, score=?, status=?, revision=?, updated_at=? WHERE id=?`).run(
      best?.doc.id ?? result.documentId, best?.doc.url ?? result.primaryUrl, JSON.stringify(candidateUrls),
      JSON.stringify(best?.evidence ?? result.evidence), JSON.stringify(best?.conflicts ?? result.conflicts),
      Math.max(result.score, best?.score ?? 0), (best?.score ?? 0) >= 85 ? "auto_approved" : "review",
      revision, now(), resultId,
    );
  audit("result", resultId, "deep_expansion", { queries, pages: documents.length, revision });
  return mapResult(db.prepare("SELECT * FROM results WHERE id=?").get(resultId) as Record<string, unknown>);
}

async function deepExpandProject(row: Record<string, unknown>, args: JsonObject) {
  const result = mapProject(row);
  const scan = getScan(result.scanId);
  if (!scan) throw new Error("扫描任务不存在");
  const searchProviders = (scan.request.searchProviderIds ?? []).map(getSearchProvider).filter(Boolean) as SearchProviderRecord[];
  if (!searchProviders.length) throw new Error("未配置可用的搜索 API");
  const provider = getProvider(scan.request.providerId);
  const fields = listFields();
  const baseQuery = buildReferenceQuery(result.fields);
  const queries = [
    baseQuery, `${baseQuery} contract EPC`, `${baseQuery} agreement award`,
    `${baseQuery} construction commissioning`, `${String(result.fields.project_name ?? "")} ${String(result.fields.owner ?? "")}`,
  ].filter(Boolean).slice(0, Number(args.maxQueries ?? 8));
  let pages = 0;
  for (const query of queries) {
    for (const searchProvider of searchProviders) {
      const hits = await searchWeb(searchProvider, query, 10);
      for (const hit of hits) {
        if (pages >= Number(args.maxPages ?? 20)) break;
        const doc = await fetchDocument(hit.url, "deep-search", "search");
        doc.dateStatus = dateStatusFor(doc, scan.request.startDate, scan.request.endDate);
        saveDocument(result.scanId, doc);
        pages++;
        if (doc.error || doc.dateStatus !== "within_range") continue;
        const analyzed = await assessArticle(doc, fields, provider, scan.request.modelId);
        saveAssessment(result.scanId, doc, analyzed.assessment, fields, "", analyzed.modelUsed);
      }
    }
    if (pages >= Number(args.maxPages ?? 20)) break;
  }
  audit("project", result.id, "deep_expansion", { queries, pages });
  const updated = db.prepare("SELECT * FROM projects WHERE id=?").get(result.id) as Record<string, unknown> | undefined;
  if (!updated) throw new Error("项目在扩散过程中不存在");
  return mapProject(updated);
}

function reviewResult(resultId: string, payload: JsonObject) {
  const decision = String(payload.decision ?? "");
  if (!["approved", "review", "rejected"].includes(decision)) throw new Error("审核决定无效");
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(resultId) as Record<string, unknown> | undefined;
  if (project) {
    db.prepare("UPDATE projects SET status=?, decision_note=?, updated_at=? WHERE id=?")
      .run(decision, String(payload.note ?? ""), now(), resultId);
    audit("project", resultId, "review", payload);
    return mapProject(db.prepare("SELECT * FROM projects WHERE id=?").get(resultId) as Record<string, unknown>);
  }
  db.prepare("UPDATE results SET status=?, decision_note=?, updated_at=? WHERE id=?")
    .run(decision, String(payload.note ?? ""), now(), resultId);
  audit("result", resultId, "review", payload);
  const row = db.prepare("SELECT * FROM results WHERE id=?").get(resultId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("结果不存在");
  return mapResult(row);
}

function confirmSnapshot(payload: JsonObject) {
  const scanId = String(payload.scanId ?? "");
  const resultIds = Array.isArray(payload.resultIds) ? payload.resultIds.map(String) : getResults(scanId).map((result) => result.id);
  const fieldIds = Array.isArray(payload.fieldIds) ? payload.fieldIds.map(String) : listFields().map((field) => field.id);
  const includeFlagged = Boolean(payload.includeFlagged);
  const unresolved = resultIds.map((id) =>
    (db.prepare("SELECT status FROM projects WHERE id=?").get(id) ??
      db.prepare("SELECT status FROM results WHERE id=?").get(id)) as { status: string } | undefined)
    .filter((row) => row && !["approved", "auto_approved"].includes(row.status));
  if (unresolved.length && !includeFlagged) throw new Error(`仍有 ${unresolved.length} 条待审核或已驳回结果`);
  const id = randomUUID();
  db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?,?)")
    .run(id, scanId, JSON.stringify(resultIds), JSON.stringify(fieldIds), includeFlagged ? 1 : 0, now());
  audit("snapshot", id, "confirmed", { scanId, resultIds, fieldIds, includeFlagged });
  return { id, scanId, resultIds, fieldIds, includeFlagged, createdAt: now() };
}

function buildReferenceRows(workbook: ExcelJS.Workbook) {
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = String(cell.text).trim(); });
  const fields = listFields();
  const rows: Record<string, unknown>[] = [];
  const effectiveLimit = Math.min(sheet.actualRowCount || sheet.rowCount, 10_000);
  for (let index = 2; index <= effectiveLimit; index++) {
    const row = sheet.getRow(index);
    const values = headers.map((header, col) => normalizeCellValue(row.getCell(col + 1).value));
    if (!values.some((value) => value !== null && value !== "")) continue;
    const record: Record<string, unknown> = {};
    headers.forEach((header, col) => {
      const field = fields.find((item) => item.label.replace(/\n/g, "") === header.replace(/\n/g, "") || item.aliases.includes(header));
      record[field?.id ?? header] = values[col];
    });
    if (!record.country && !record.project_name && !record.published_month) continue;
    rows.push(record);
  }
  return { headers, rows };
}

function normalizeCellValue(value: ExcelJS.CellValue) {
  if (value && typeof value === "object") {
    if ("result" in value) return value.result;
    if ("text" in value) return value.text;
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
  }
  return value ?? null;
}

async function importWorkbook(base64: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, "base64") as unknown as ArrayBuffer);
  return buildReferenceRows(workbook);
}

async function importSources(payload: JsonObject) {
  const fileName = String(payload.fileName ?? "");
  const base64 = String(payload.base64 ?? "");
  let rows: Record<string, unknown>[] = [];
  if (/\.csv$/i.test(fileName)) {
    const csv = Buffer.from(base64, "base64").toString("utf8");
    rows = parseCsv(csv);
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(base64, "base64") as unknown as ArrayBuffer);
    const parsed = buildReferenceRows(workbook);
    const sheet = workbook.worksheets[0];
    rows = [];
    for (let index = 2; index <= Math.min(sheet.actualRowCount || sheet.rowCount, 10_000); index++) {
      const row = sheet.getRow(index);
      const cells = Array.from({ length: 5 }, (_, col) => normalizeCellValue(row.getCell(col + 1).value));
      if (!cells.some(Boolean)) continue;
      rows.push({ name: cells[0], type: cells[1], coverage: cells[2], url: cells[3], proposer: cells[4] });
    }
    void parsed;
  }
  let inserted = 0;
  for (const row of rows) {
    const url = normalizeUrl(String(row.url ?? row["网址"] ?? ""));
    if (!url) continue;
    const existing = db.prepare("SELECT id FROM sources WHERE url=?").get(url);
    if (existing) continue;
    db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)").run(
      randomUUID(), String(row.name ?? row["信息源名称"] ?? new URL(url).hostname),
      String(row.type ?? row["信息源类型"] ?? "网址"), String(row.coverage ?? row["覆盖范围"] ?? ""),
      url, String(row.country ?? row["国家"] ?? ""), 1, 1000, now(),
    );
    inserted++;
  }
  return { inserted, total: rows.length, sources: listSources() };
}

function parseCsv(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const parseLine = (line: string) => {
    const values: string[] = []; let current = ""; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { values.push(current); current = ""; }
      else current += ch;
    }
    values.push(current); return values;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseLine(line)[index] ?? ""])));
}

const actions: McpActions = {
  startScan: createScan,
  getScanStatus: getScan,
  getResults,
  getArticles,
  getScanDiagnostics,
  deepExpand,
  reviewResult,
  confirmSnapshot,
  exportSnapshot,
};

async function route(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return sendJson(res, 403, { error: "不允许的 Origin" });
  setCors(res, origin);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  try {
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, name: "Digital Power Monitor API", version: "0.1.0" });
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${MCP_TOKEN}`) return sendJson(res, 401, { error: "MCP 令牌无效" });
      const body = await readJson(req);
      const response = await handleMcpRequest(body, actions);
      if (response === null) { res.writeHead(202); return res.end(); }
      return sendJson(res, 200, response);
    }
    if (!url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
    const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readJson(req) : {};

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      return sendJson(res, 200, {
        sources: count("sources"), providers: count("providers"), scans: count("scans"),
        results: count("results") + count("projects"),
        pending: count("results", "status='review'") + count("projects", "status='review'"),
        recentScans: (db.prepare("SELECT id,status,progress_json,created_at FROM scans ORDER BY created_at DESC LIMIT 6").all() as Record<string, unknown>[]).map((row) => ({
          id: row.id, status: row.status, progress: jsonParse(row.progress_json, {}), createdAt: row.created_at,
        })),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/fields") return sendJson(res, 200, listFields());
    if (req.method === "GET" && url.pathname === "/api/sources") return sendJson(res, 200, listSources());
    if (req.method === "POST" && url.pathname === "/api/sources") return sendJson(res, 201, createSource(body));
    const sourceRecord = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
    if (req.method === "PUT" && sourceRecord) return sendJson(res, 200, updateSource(sourceRecord[1], body));
    if (req.method === "DELETE" && sourceRecord) return sendJson(res, 200, deleteSource(sourceRecord[1]));
    const sourceCheck = url.pathname.match(/^\/api\/sources\/([^/]+)\/check$/);
    if (req.method === "POST" && sourceCheck) {
      const row = db.prepare("SELECT * FROM sources WHERE id=?").get(sourceCheck[1]) as Record<string, unknown> | undefined;
      if (!row) throw new Error("信息源不存在");
      const startedAt = Date.now();
      const doc = await fetchDocument(String(row.url), String(row.id), "source");
      return sendJson(res, 200, {
        ok: !doc.error && doc.text.length >= 200, latencyMs: Date.now() - startedAt,
        statusCode: doc.statusCode, failureCode: doc.failureCode, error: doc.error,
        title: doc.title, textLength: doc.text.length, rendered: doc.rendered,
        fetchMode: doc.fetchMode, pageType: doc.pageType, warnings: doc.warnings.slice(0, 5),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/sources/import") return sendJson(res, 200, await importSources(body));
    if (req.method === "POST" && url.pathname === "/api/reference/import") return sendJson(res, 200, await importWorkbook(String(body.base64 ?? "")));

    if (req.method === "GET" && url.pathname === "/api/skills/scan-overseas-energy-projects") {
      return sendJson(res, 200, getRetrievalSkill());
    }
    if (req.method === "POST" && url.pathname === "/api/skills/scan-overseas-energy-projects/propose") {
      const scanId = String(body.scanId ?? "");
      const scan = getScan(scanId); if (!scan) throw new Error("监测任务不存在");
      const providerId = String(scan.request.providerId ?? "");
      return sendJson(res, 201, await proposeRetrievalSkillIteration(
        scanId, getScanDiagnostics(scanId) as JsonObject, getProvider(providerId), String(scan.request.modelId ?? ""),
      ));
    }
    const skillReview = url.pathname.match(/^\/api\/skill-iterations\/([^/]+)\/(apply|reject)$/);
    if (req.method === "POST" && skillReview) return sendJson(res, 200,
      reviewRetrievalSkillIteration(skillReview[1], skillReview[2] as "apply" | "reject"));

    if (req.method === "GET" && url.pathname === "/api/providers") {
      const rows = db.prepare("SELECT * FROM providers ORDER BY name").all() as Record<string, unknown>[];
      return sendJson(res, 200, rows.map(mapProvider));
    }
    if (req.method === "POST" && url.pathname === "/api/providers") return sendJson(res, 201, saveProvider(body));
    const providerRecord = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (req.method === "DELETE" && providerRecord) return sendJson(res, 200, deleteProvider(providerRecord[1]));
    const providerSecret = url.pathname.match(/^\/api\/providers\/([^/]+)\/secret$/);
    if (req.method === "DELETE" && providerSecret) return sendJson(res, 200, clearProviderSecret(providerSecret[1]));
    const providerModels = url.pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
    if (req.method === "POST" && providerModels) {
      const provider = getProvider(providerModels[1]); if (!provider) throw new Error("供应商不存在");
      const force = Boolean(body.force); const cached = MODEL_CACHE.get(provider.id);
      if (!force && cached && cached.expires > Date.now()) return sendJson(res, 200, cached.data);
      const data = await listProviderModels(provider); MODEL_CACHE.set(provider.id, { expires: Date.now() + 15 * 60_000, data });
      return sendJson(res, 200, data);
    }
    const providerTest = url.pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (req.method === "POST" && providerTest) {
      const provider = getProvider(providerTest[1]); if (!provider) throw new Error("供应商不存在");
      const modelId = String(body.modelId ?? "");
      const report = await testProvider(provider, modelId);
      db.prepare("INSERT INTO provider_diagnostics VALUES (?,?,?,?,?,?)")
        .run(randomUUID(), provider.id, modelId || null, report.ok ? 1 : 0, JSON.stringify(report), now());
      return sendJson(res, 200, report);
    }
    const providerDiagnostics = url.pathname.match(/^\/api\/providers\/([^/]+)\/diagnostics$/);
    if (req.method === "GET" && providerDiagnostics) {
      const rows = db.prepare("SELECT * FROM provider_diagnostics WHERE provider_id=? ORDER BY created_at DESC LIMIT 20")
        .all(providerDiagnostics[1]) as Record<string, unknown>[];
      return sendJson(res, 200, rows.map((row) => ({
        id: row.id, modelId: row.model_id, ok: Boolean(row.ok), report: jsonParse(row.report_json, {}), createdAt: row.created_at,
      })));
    }

    if (req.method === "GET" && url.pathname === "/api/search-providers") {
      const rows = db.prepare("SELECT * FROM search_providers ORDER BY name").all() as Record<string, unknown>[];
      return sendJson(res, 200, rows.map(mapSearchProvider));
    }
    if (req.method === "POST" && url.pathname === "/api/search-providers") return sendJson(res, 201, saveSearchProvider(body));
    const searchTest = url.pathname.match(/^\/api\/search-providers\/([^/]+)\/test$/);
    if (req.method === "POST" && searchTest) {
      const provider = getSearchProvider(searchTest[1]); if (!provider) throw new Error("搜索供应商不存在");
      const started = Date.now(); const results = await searchWeb(provider, String(body.query ?? "海外光伏储能项目"), 5);
      return sendJson(res, 200, { ok: true, latencyMs: Date.now() - started, results });
    }

    if (req.method === "GET" && url.pathname === "/api/mcp-servers") {
      const rows = db.prepare("SELECT * FROM mcp_servers ORDER BY name").all() as Record<string, unknown>[];
      return sendJson(res, 200, rows.map((row) => mapMcpRow(row)));
    }
    if (req.method === "POST" && url.pathname === "/api/mcp-servers/import") return sendJson(res, 201, importMcpServers(body));
    if (req.method === "POST" && url.pathname === "/api/mcp-servers") return sendJson(res, 201, saveMcpServer(body));
    const mcpServer = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)$/);
    if (req.method === "DELETE" && mcpServer) return sendJson(res, 200, deleteMcpServer(mcpServer[1]));
    const mcpCatalog = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/(?:catalog|test)$/);
    if (req.method === "POST" && mcpCatalog) {
      const row = db.prepare("SELECT * FROM mcp_servers WHERE id=?").get(mcpCatalog[1]) as Record<string, unknown> | undefined;
      if (!row) throw new Error("MCP 服务器不存在");
      const startedAt = Date.now();
      try {
        const catalog = await catalogMcpServer(hydrateMcpRow(row) as unknown as JsonObject);
        return sendJson(res, 200, { ok: true, status: "healthy", latencyMs: Date.now() - startedAt, catalog });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(res, 200, { ok: false, status: "failed", latencyMs: Date.now() - startedAt,
          error: message, diagnosis: diagnoseMcpError(error) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/mcp-token") return sendJson(res, 200, { token: MCP_TOKEN, endpoint: `http://${HOST}:${PORT}/mcp` });

    if (req.method === "GET" && url.pathname === "/api/browser-rendering") {
      const config = resolveLightpandaConfig();
      return sendJson(res, 200, {
        enabled: config.enabled, endpoint: redactTokenParam(config.endpoint), backendOrder: config.backendOrder,
        connectTimeoutMs: config.connectTimeoutMs, hasToken: config.hasToken ?? false,
        source: config.source ?? "none", envEndpoint: Boolean(process.env.DPM_LIGHTPANDA_CDP_URL),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/browser-rendering") {
      const order = Array.isArray(body.backendOrder) ? body.backendOrder : ["local", "lightpanda"];
      const backendOrder = order.filter((item): item is "local" | "lightpanda" => item === "local" || item === "lightpanda");
      if (!backendOrder.length) throw new Error("后端顺序至少包含 local 或 lightpanda 之一");
      upsertBrowserRendering({
        enabled: Boolean(body.enabled), endpoint: String(body.endpoint ?? ""),
        backendOrder: [...new Set(backendOrder)], connectTimeoutMs: Number(body.connectTimeoutMs ?? 8_000),
      });
      if (typeof body.token === "string" && body.token.trim()) vault.set(LIGHTPANDA_VAULT_KEY, body.token.trim());
      if (body.clearToken === true) vault.remove(LIGHTPANDA_VAULT_KEY);
      await resetLightpanda();
      audit("browser_rendering", "default", "saved", { ...body, token: body.token ? "***" : undefined });
      const config = resolveLightpandaConfig();
      return sendJson(res, 200, {
        ok: true, enabled: config.enabled, endpoint: redactTokenParam(config.endpoint),
        backendOrder: config.backendOrder, hasToken: config.hasToken ?? false,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/browser-rendering/test") {
      const report = await probeLightpanda({
        endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
        token: typeof body.token === "string" ? body.token : undefined,
      });
      return sendJson(res, 200, report);
    }

    if (req.method === "GET" && url.pathname === "/api/scans") {
      const rows = db.prepare("SELECT id FROM scans ORDER BY created_at DESC LIMIT 100").all() as { id: string }[];
      return sendJson(res, 200, rows.map((row) => getScan(row.id)));
    }
    if (req.method === "POST" && url.pathname === "/api/scans") return sendJson(res, 202, await createScan(body));
    const scanMatch = url.pathname.match(/^\/api\/scans\/([^/]+)$/);
    if (req.method === "GET" && scanMatch) return sendJson(res, 200, getScan(scanMatch[1]));
    if (req.method === "DELETE" && scanMatch) return sendJson(res, 200, deleteScan(scanMatch[1]));
    const scanResults = url.pathname.match(/^\/api\/scans\/([^/]+)\/results$/);
    if (req.method === "GET" && scanResults) return sendJson(res, 200, getResults(scanResults[1]));
    const scanArticles = url.pathname.match(/^\/api\/scans\/([^/]+)\/articles$/);
    if (req.method === "GET" && scanArticles) return sendJson(res, 200, getArticles(scanArticles[1]));
    const scanDiagnostics = url.pathname.match(/^\/api\/scans\/([^/]+)\/diagnostics$/);
    if (req.method === "GET" && scanDiagnostics) return sendJson(res, 200, getScanDiagnostics(scanDiagnostics[1]));
    const scanLogs = url.pathname.match(/^\/api\/scans\/([^/]+)\/logs$/);
    if (req.method === "GET" && scanLogs) return sendJson(res, 200, getScanLogs(
      scanLogs[1], Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 500),
    ));
    const scanControl = url.pathname.match(/^\/api\/scans\/([^/]+)\/(pause|resume|stop)$/);
    if (req.method === "POST" && scanControl) return sendJson(res, 200, controlScan(
      scanControl[1], scanControl[2] as "pause" | "resume" | "stop",
    ));

    const deepMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/deep-expand$/);
    if (req.method === "POST" && deepMatch) return sendJson(res, 200, await deepExpand(deepMatch[1], body));
    const bilingualRepair = url.pathname.match(/^\/api\/results\/([^/]+)\/repair-bilingual$/);
    if (req.method === "POST" && bilingualRepair) {
      const project = db.prepare("SELECT * FROM projects WHERE id=?").get(bilingualRepair[1]) as Record<string, unknown> | undefined;
      if (!project) throw new Error("项目结果不存在");
      const scan = getScan(String(project.scan_id));
      if (!scan) throw new Error("项目所属监测任务不存在");
      const provider = getProvider(String(scan.request.providerId ?? ""));
      const modelId = String(scan.request.modelId ?? "");
      if (!provider || !modelId) throw new Error("该任务没有可用的大模型配置，无法补齐双语字段");
      const documentRow = db.prepare("SELECT * FROM documents WHERE id=?").get(String(project.primary_document_id ?? "")) as Record<string, unknown> | undefined;
      if (!documentRow?.text) throw new Error("项目原始网页正文存档不存在");
      const analyzed = await assessArticle(storedDocument(documentRow), listFields(), provider, modelId);
      const repaired = applyBilingualRepair(bilingualRepair[1], analyzed.assessment, listFields());
      audit("project", bilingualRepair[1], "bilingual_repaired", { modelId, modelUsed: analyzed.modelUsed });
      return sendJson(res, 200, repaired);
    }
    const decisionMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/decision$/);
    if (req.method === "POST" && decisionMatch) return sendJson(res, 200, reviewResult(decisionMatch[1], body));
    if (req.method === "POST" && url.pathname === "/api/snapshots") return sendJson(res, 201, confirmSnapshot(body));
    if (req.method === "POST" && url.pathname === "/api/export-directories/pick") {
      return sendJson(res, 200, await pickExportDirectory());
    }
    const exportMatch = url.pathname.match(/^\/api\/snapshots\/([^/]+)\/export$/);
    if (req.method === "POST" && exportMatch) {
      const directoryToken = String(body.directoryToken ?? "");
      const directory = directoryToken ? resolveExportDirectory(directoryToken) : undefined;
      return sendJson(res, 200, await exportSnapshot(exportMatch[1], directory));
    }
    const exportFile = url.pathname.match(/^\/api\/exports\/([^/]+)\/files\/([^/]+)$/);
    if (req.method === "GET" && exportFile) return sendExportFile(res, exportFile[1], exportFile[2]);
    const exportStaging = url.pathname.match(/^\/api\/exports\/([^/]+)\/staging$/);
    if (req.method === "DELETE" && exportStaging) return sendJson(res, 200, cleanupExportStaging(exportStaging[1]));

    return sendJson(res, 404, { error: "接口不存在" });
  } catch (error) {
    return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function count(table: string, where?: string) {
  const allowed = ["sources", "providers", "scans", "results", "projects"];
  if (!allowed.includes(table)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`).get() as { count: number }).count);
}

function createSource(body: JsonObject) {
  const id = randomUUID(); const url = normalizeUrl(String(body.url ?? ""));
  if (!url) throw new Error("网址无效");
  db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)").run(
    id, String(body.name ?? new URL(url).hostname), String(body.type ?? "网址"), String(body.coverage ?? ""),
    url, String(body.country ?? ""), body.enabled === false ? 0 : 1, Number(body.rateLimitMs ?? 1000), now(),
  );
  audit("source", id, "created", body);
  return listSources().find((source) => source.id === id);
}

function updateSource(id: string, body: JsonObject) {
  const existing = db.prepare("SELECT * FROM sources WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!existing) throw new Error("信息源不存在或已删除");
  const url = normalizeUrl(String(body.url ?? existing.url ?? ""));
  if (!url) throw new Error("网址无效");
  db.prepare(`UPDATE sources SET name=?,type=?,coverage=?,url=?,country=?,enabled=?,rate_limit_ms=?,updated_at=? WHERE id=?`).run(
    String(body.name ?? existing.name), String(body.type ?? existing.type), String(body.coverage ?? existing.coverage), url,
    String(body.country ?? existing.country), body.enabled == null ? Number(existing.enabled) : body.enabled === false ? 0 : 1,
    Number(body.rateLimitMs ?? existing.rate_limit_ms ?? 1000), now(), id,
  );
  audit("source", id, "updated", { name: body.name, url, coverage: body.coverage });
  return listSources().find((source) => source.id === id);
}

function deleteSource(id: string) {
  const existing = db.prepare("SELECT name,url FROM sources WHERE id=?").get(id) as { name: string; url: string } | undefined;
  if (!existing) throw new Error("信息源不存在或已删除");
  db.prepare("DELETE FROM sources WHERE id=?").run(id);
  audit("source", id, "deleted", existing);
  return { ok: true, id };
}

/** body.id 为空字符串时也必须生成新 UUID —— 空 id 行会让 UI 的测试/删除请求打到不存在的路由（404） */
function recordId(body: JsonObject) {
  const raw = String(body.id ?? "").trim();
  return raw || randomUUID();
}

function saveProvider(body: JsonObject) {
  const id = recordId(body); const updated = now();
  const baseUrl = String(body.baseUrl ?? "https://api.openai.com");
  const requestedKind = String(body.kind ?? "openai-compatible");
  const kind = requestedKind === "openai" && !/^https:\/\/api\.openai\.com(?:\/|$)/i.test(baseUrl)
    ? "openai-compatible"
    : requestedKind;
  if (typeof body.apiKey === "string" && body.apiKey) vault.set(`provider:${id}`, body.apiKey);
  db.prepare(`INSERT INTO providers VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,
    headers_json=excluded.headers_json,config_json=excluded.config_json,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(
      id, String(body.name ?? "模型供应商"), kind,
      baseUrl, JSON.stringify(body.headers ?? {}),
      JSON.stringify(body.config ?? {}), body.enabled === false ? 0 : 1, updated,
    );
  MODEL_CACHE.delete(id);
  audit("provider", id, "saved", { ...body, apiKey: body.apiKey ? "***" : undefined });
  return getProvider(id);
}

function deleteProvider(id: string) {
  const provider = getProvider(id);
  if (!provider) throw new Error("供应商不存在或已删除");
  db.prepare("DELETE FROM provider_diagnostics WHERE provider_id=?").run(id);
  db.prepare("DELETE FROM providers WHERE id=?").run(id);
  MODEL_CACHE.delete(id);
  vault.remove(`provider:${id}`);
  audit("provider", id, "deleted", { name: provider.name, kind: provider.kind });
  return { ok: true, id };
}

function clearProviderSecret(id: string) {
  const provider = getProvider(id);
  if (!provider) throw new Error("供应商不存在或已删除");
  vault.remove(`provider:${id}`);
  MODEL_CACHE.delete(id);
  audit("provider", id, "secret_cleared", { name: provider.name });
  return getProvider(id);
}

function saveSearchProvider(body: JsonObject) {
  const id = recordId(body); const updated = now();
  if (typeof body.apiKey === "string" && body.apiKey) vault.set(`search:${id}`, body.apiKey);
  db.prepare(`INSERT INTO search_providers VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,endpoint=excluded.endpoint,
    method=excluded.method,headers_json=excluded.headers_json,config_json=excluded.config_json,
    enabled=excluded.enabled,updated_at=excluded.updated_at`).run(
      id, String(body.name ?? "搜索供应商"), String(body.kind ?? "tavily"),
      String(body.endpoint ?? "https://api.tavily.com/search"), String(body.method ?? "POST"),
      JSON.stringify(body.headers ?? {}), JSON.stringify(body.config ?? {}),
      body.enabled === false ? 0 : 1, updated,
    );
  audit("search_provider", id, "saved", { ...body, apiKey: body.apiKey ? "***" : undefined });
  return getSearchProvider(id);
}

function saveMcpServer(body: JsonObject) {
  const id = recordId(body); const updated = now();
  const previous = db.prepare("SELECT env_keys_json FROM mcp_servers WHERE id=?").get(id) as { env_keys_json?: string } | undefined;
  const previousKeys = jsonParse<string[]>(previous?.env_keys_json, []);
  const suppliedEnv = body.env && typeof body.env === "object" && !Array.isArray(body.env)
    ? body.env as Record<string, unknown> : {};
  const requestedKeys = Array.isArray(body.envKeys)
    ? body.envKeys.map(String)
    : [...new Set([...previousKeys, ...Object.keys(suppliedEnv)])];
  const envKeys = requestedKeys.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  for (const key of previousKeys.filter((key) => !envKeys.includes(key))) vault.remove(`mcp:${id}:env:${key}`);
  for (const key of envKeys) {
    const value = suppliedEnv[key];
    if (typeof value === "string" && value) vault.set(`mcp:${id}:env:${key}`, value);
  }
  db.prepare(`INSERT INTO mcp_servers
    (id,name,transport,url,command,args_json,headers_json,enabled,allow_tools_json,updated_at,env_keys_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,transport=excluded.transport,url=excluded.url,
    command=excluded.command,args_json=excluded.args_json,headers_json=excluded.headers_json,
    enabled=excluded.enabled,allow_tools_json=excluded.allow_tools_json,updated_at=excluded.updated_at,
    env_keys_json=excluded.env_keys_json`).run(
      id, String(body.name ?? "MCP 服务器"), String(body.transport ?? "streamable-http"),
      String(body.url ?? ""), String(body.command ?? ""), JSON.stringify(body.args ?? []),
      JSON.stringify(body.headers ?? {}), body.enabled === false ? 0 : 1,
      JSON.stringify(body.allowTools ?? []), updated, JSON.stringify(envKeys),
    );
  audit("mcp_server", id, "saved", { name: body.name, transport: body.transport, envKeys });
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id=?").get(id) as Record<string, unknown>;
  return mapMcpRow(row);
}

function importMcpServers(body: JsonObject) {
  const servers = body.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("配置必须包含 mcpServers 对象");
  }
  return Object.entries(servers as Record<string, unknown>).map(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 配置无效`);
    const config = value as JsonObject;
    const existing = db.prepare("SELECT id FROM mcp_servers WHERE name=?").get(name) as { id: string } | undefined;
    return saveMcpServer({
      id: existing?.id, name, transport: config.command ? "stdio" : "streamable-http",
      command: config.command ?? "", args: config.args ?? [], url: config.url ?? "",
      headers: config.headers ?? {}, env: config.env ?? {},
      envKeys: config.env && typeof config.env === "object" ? Object.keys(config.env as JsonObject) : [],
      enabled: config.enabled !== false,
    });
  });
}

function deleteMcpServer(id: string) {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("MCP 服务不存在或已删除");
  for (const key of jsonParse<string[]>(row.env_keys_json, [])) vault.remove(`mcp:${id}:env:${key}`);
  db.prepare("DELETE FROM mcp_servers WHERE id=?").run(id);
  audit("mcp_server", id, "deleted", { name: row.name });
  return { ok: true, id };
}

function migrateLegacyMcpConfigurations() {
  // 修复历史空 id 行：空 id 会让 UI 的测试/删除请求落到 /api/mcp-servers//xxx 而 404
  const emptyIdRows = db.prepare("SELECT rowid FROM mcp_servers WHERE TRIM(id) = ''").all() as { rowid: number }[];
  for (const { rowid } of emptyIdRows) {
    db.prepare("UPDATE mcp_servers SET id=? WHERE rowid=?").run(randomUUID(), rowid);
  }
  if (emptyIdRows.length) audit("mcp_server", "-", "empty_id_repaired", { count: emptyIdRows.length });
  const rows = db.prepare("SELECT * FROM mcp_servers ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  const parsed = rows.flatMap((row) => {
    const args = jsonParse<string[]>(row.args_json, []);
    for (const candidate of [String(row.command ?? ""), args.join(" ")]) {
      if (!candidate.includes("mcpServers")) continue;
      try {
        const root = JSON.parse(candidate) as JsonObject;
        const servers = root.mcpServers as Record<string, JsonObject> | undefined;
        const entry = servers ? Object.entries(servers)[0] : undefined;
        if (entry) return [{ row, name: entry[0], config: entry[1] }];
      } catch { /* malformed legacy configuration */ }
    }
    return [];
  });
  const retainedNames = new Set<string>();
  for (const item of parsed) {
    const id = String(item.row.id);
    if (retainedNames.has(item.name)) {
      for (const key of jsonParse<string[]>(item.row.env_keys_json, [])) vault.remove(`mcp:${id}:env:${key}`);
      db.prepare("DELETE FROM mcp_servers WHERE id=?").run(id);
      audit("mcp_server", id, "legacy_duplicate_removed", { name: item.name });
      continue;
    }
    retainedNames.add(item.name);
    const env = item.config.env && typeof item.config.env === "object" && !Array.isArray(item.config.env)
      ? item.config.env as JsonObject : {};
    saveMcpServer({
      id, name: item.name, transport: item.config.command ? "stdio" : "streamable-http",
      command: item.config.command ?? "", args: item.config.args ?? [], url: item.config.url ?? "",
      headers: item.config.headers ?? {}, env, envKeys: Object.keys(env), enabled: item.config.enabled !== false,
    });
    audit("mcp_server", id, "legacy_config_migrated", { name: item.name, envKeys: Object.keys(env) });
  }
}

function readJson(req: IncomingMessage) {
  return new Promise<JsonObject>((resolve, reject) => {
    const chunks: Buffer[] = []; let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 30 * 1024 * 1024) { reject(new Error("请求体超过 30MB")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject); }
      catch { reject(new Error("JSON 请求无效")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendExportFile(res: ServerResponse, exportId: string, key: string) {
  const row = db.prepare("SELECT directory,files_json FROM exports WHERE id=?").get(exportId) as { directory: string; files_json: string } | undefined;
  if (!row) return sendJson(res, 404, { error: "导出记录不存在" });
  const files = jsonParse<Record<string, string>>(row.files_json, {});
  const filePath = files[key];
  if (!filePath) return sendJson(res, 404, { error: "导出文件不存在" });
  const directory = path.resolve(row.directory);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(`${directory}${path.sep}`) || !fs.existsSync(resolved)) return sendJson(res, 404, { error: "导出文件不可用" });
  const contentTypes: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".zip": "application/zip",
  };
  res.writeHead(200, {
    "Content-Type": contentTypes[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
    "Content-Length": fs.statSync(resolved).size,
  });
  fs.createReadStream(resolved).pipe(res);
}

function cleanupExportStaging(exportId: string) {
  const row = db.prepare("SELECT directory FROM exports WHERE id=?").get(exportId) as { directory: string } | undefined;
  if (!row) throw new Error("导出暂存记录不存在");
  const outputsRoot = path.resolve("outputs");
  const directory = path.resolve(row.directory);
  const relative = path.relative(outputsRoot, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("拒绝清理非暂存目录");
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
  db.prepare("DELETE FROM exports WHERE id=?").run(exportId);
  audit("export", exportId, "staging_cleaned", { directory: path.basename(directory) });
  return { ok: true, exportId };
}

function setCors(res: ServerResponse, origin?: string) {
  res.setHeader("Access-Control-Allow-Origin", origin || "http://127.0.0.1:3000");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(ms, 0), 5_000))); }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

migrateLegacyMcpConfigurations();
recoverInterruptedScans();
const server = http.createServer((req, res) => { void route(req, res); });
server.listen(PORT, HOST, () => {
  console.log(`Digital Power Monitor API: http://${HOST}:${PORT}`);
  console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
});

/** 进程重启后，上次运行中的扫描已无执行者，永远等不到推进——直接标记为中断，避免界面卡在"运行中/停止中" */
function recoverInterruptedScans() {
  const stale = db.prepare("SELECT id FROM scans WHERE status IN ('running','stopping','paused')").all() as { id: string }[];
  for (const scan of stale) {
    db.prepare("UPDATE scans SET status='stopped', error=?, updated_at=? WHERE id=?")
      .run("服务进程重启，扫描已中断；已完成的数据和日志均已保留", now(), scan.id);
    db.prepare("UPDATE crawl_queue SET status='failed', last_error=?, updated_at=? WHERE scan_id=? AND status='in_progress'")
      .run("服务进程重启，页面抓取已中断", now(), scan.id);
    logScan(scan.id, "warn", "lifecycle", "interrupted", "服务进程重启，扫描已中断；可重新发起监测任务");
  }
}

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
