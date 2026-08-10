export type JsonObject = Record<string, unknown>;

export type ProviderKind =
  | "openai"
  | "openai-compatible"
  | "azure-openai"
  | "anthropic"
  | "gemini";

export interface ModelProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  headers: Record<string, string>;
  config: JsonObject;
  enabled: boolean;
  hasSecret?: boolean;
}

export interface SearchProviderRecord {
  id: string;
  name: string;
  kind: "tavily" | "generic-rest" | "mcp";
  endpoint: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  config: JsonObject;
  enabled: boolean;
  hasSecret?: boolean;
}

export type RenderBackend = "local" | "lightpanda";

export interface BrowserRenderingRecord {
  enabled: boolean;
  /** ws:// 或 wss:// 的 CDP 端点（cloud token 拼接后可能带 query） */
  endpoint: string;
  backendOrder: RenderBackend[];
  connectTimeoutMs: number;
  /** vault 中是否存在 cloud token；接口只回此标记，永不回 token 本体 */
  hasToken?: boolean;
  /** 配置来源：db 设置行 / 环境变量 / 未配置 */
  source?: "db" | "env" | "none";
}

export interface FieldDefinition {
  id: string;
  label: string;
  type: "text" | "number" | "date" | "url";
  unit?: string;
  description?: string;
  aliases: string[];
  extractionHint?: string;
  required: boolean;
  position: number;
}

export interface SourceRecord {
  id: string;
  name: string;
  type: string;
  coverage: string;
  url: string;
  country: string;
  enabled: boolean;
  rateLimitMs: number;
  createdAt?: string;
}

export interface ScanBudget {
  maxPages: number;
  maxSearches: number;
  maxMinutes: number;
  maxConcurrency: number;
  maxCostUsd: number;
}

export interface ScanRequest {
  startDate: string;
  endDate: string;
  fieldIds: string[];
  sourceIds: string[];
  providerId?: string;
  modelId?: string;
  searchProviderIds?: string[];
  mcpServerIds?: string[];
  mcpToolNames?: string[];
  budget: ScanBudget;
  referenceRows?: Record<string, unknown>[];
}

export type DateStatus = "within_range" | "outside_range" | "date_unknown" | "date_conflict";
export type ArticleClassification = "project_report" | "non_project" | "uncertain";
export type DiscoveryMethod = "source" | "sitemap" | "rss" | "archive" | "page-link" | "search" | "mcp";
export type FetchMode = "static" | "browser";
export type PageType = "article" | "homepage" | "listing" | "document" | "unknown";
export type ScanStatus = "queued" | "running" | "paused" | "stopping" | "stopped" | "completed" | "failed";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface CrawledDocument {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  publishedAt: string | null;
  fetchedAt: string;
  contentType: string;
  statusCode: number;
  hash: string;
  text: string;
  markdown: string;
  rawPath: string;
  markdownPath: string;
  sourceId: string;
  dateCandidates: string[];
  dateStatus: DateStatus;
  dateEvidence: string;
  fetchMode: FetchMode;
  rendered: boolean;
  discoveryMethod?: DiscoveryMethod;
  warnings: string[];
  pageType: PageType;
  extractionMethod: string;
  attemptCount: number;
  failureCode?: string;
  error?: string;
}

export interface DiscoveredPage {
  url: string;
  method: DiscoveryMethod;
  dateHint?: string;
}

export interface DiscoveryReport {
  pages: DiscoveredPage[];
  strategies: string[];
  discoveryPagesFetched: number;
  truncated: boolean;
  failures: string[];
}

export interface ArticleAssessment {
  classification: ArticleClassification;
  confidence: number;
  reasoning: string;
  sourceLanguage?: string;
  mentions: Array<{
    fields: Record<string, unknown>;
    originalFields?: Record<string, string>;
    evidence: Record<string, string>;
    evidenceTranslations?: Record<string, string>;
    confidence: number;
  }>;
}

export interface ResultRecord {
  id: string;
  scanId: string;
  documentId: string;
  fields: Record<string, unknown>;
  primaryUrl: string;
  candidateUrls: string[];
  evidence: Record<string, string>;
  conflicts: string[];
  score: number;
  status: "auto_approved" | "review" | "rejected" | "approved";
  revision: number;
  decisionNote?: string;
  generatedFields?: string[];
  originalFields?: Record<string, string>;
  evidenceTranslations?: Record<string, string>;
  sourceLanguage?: string;
  unitChecks?: Record<string, string>;
}

export interface ScanLogRecord {
  id: string;
  scanId: string;
  sequence: number;
  level: "debug" | "info" | "warn" | "error";
  stage: string;
  event: string;
  message: string;
  context: JsonObject;
  createdAt: string;
}
