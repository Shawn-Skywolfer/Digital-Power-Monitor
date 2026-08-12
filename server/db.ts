import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FieldDefinition, SourceRecord } from "./types";

const DATA_DIR = path.resolve(process.env.DPM_DATA_DIR ?? "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "documents"), { recursive: true });
fs.mkdirSync(path.resolve("outputs"), { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "monitor.db"));
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA foreign_keys=ON");

const schema = [
  `CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL,
    headers_json TEXT NOT NULL DEFAULT '{}', config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS search_providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'POST', headers_json TEXT NOT NULL DEFAULT '{}',
    config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, url TEXT,
    command TEXT, args_json TEXT NOT NULL DEFAULT '[]', headers_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1, allow_tools_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fields (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL, unit TEXT,
    description TEXT, aliases_json TEXT NOT NULL DEFAULT '[]', extraction_hint TEXT,
    required INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, coverage TEXT,
    url TEXT NOT NULL, country TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    rate_limit_ms INTEGER NOT NULL DEFAULT 1000, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL,
    progress_json TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, source_id TEXT, url TEXT NOT NULL,
    canonical_url TEXT NOT NULL, title TEXT, published_at TEXT, fetched_at TEXT NOT NULL,
    content_type TEXT, status_code INTEGER, hash TEXT NOT NULL, text TEXT,
    markdown TEXT, raw_path TEXT, markdown_path TEXT, error TEXT,
    UNIQUE(scan_id, canonical_url)
  )`,
  `CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, document_id TEXT,
    fields_json TEXT NOT NULL, primary_url TEXT, candidate_urls_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL, conflicts_json TEXT NOT NULL, score REAL NOT NULL,
    status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, decision_note TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS document_assessments (
    document_id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, classification TEXT NOT NULL,
    confidence REAL NOT NULL, reasoning TEXT NOT NULL, mention_count INTEGER NOT NULL,
    model_used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, canonical_key TEXT NOT NULL,
    fields_json TEXT NOT NULL, primary_document_id TEXT, primary_url TEXT,
    source_urls_json TEXT NOT NULL, evidence_json TEXT NOT NULL, conflicts_json TEXT NOT NULL,
    score REAL NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    decision_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(scan_id, canonical_key)
  )`,
  `CREATE TABLE IF NOT EXISTS project_mentions (
    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, project_id TEXT, document_id TEXT NOT NULL,
    mention_index INTEGER NOT NULL, fields_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
    confidence REAL NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(document_id, mention_index)
  )`,
  `CREATE TABLE IF NOT EXISTS project_sources (
    project_id TEXT NOT NULL, document_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, PRIMARY KEY(project_id, document_id)
  )`,
  `CREATE TABLE IF NOT EXISTS scan_logs (
    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    level TEXT NOT NULL, stage TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
    UNIQUE(scan_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS crawl_queue (
    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, source_id TEXT, url TEXT NOT NULL,
    method TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0, date_hint TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(scan_id, url)
  )`,
  `CREATE TABLE IF NOT EXISTS provider_diagnostics (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT, ok INTEGER NOT NULL,
    report_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, result_ids_json TEXT NOT NULL,
    field_ids_json TEXT NOT NULL, include_flagged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, directory TEXT NOT NULL,
    files_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS skill_iterations (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, scan_id TEXT,
    version INTEGER NOT NULL, status TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}', proposal_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, reviewed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS browser_rendering (
    id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    endpoint TEXT NOT NULL DEFAULT '',
    backend_order_json TEXT NOT NULL DEFAULT '["local","lightpanda"]',
    connect_timeout_ms INTEGER NOT NULL DEFAULT 8000,
    updated_at TEXT NOT NULL
  )`,
];
for (const statement of schema) db.exec(statement);
db.exec("CREATE INDEX IF NOT EXISTS idx_skill_iterations_skill_created ON skill_iterations(skill_id,created_at DESC)");
db.exec("PRAGMA optimize");

function addColumnIfMissing(table: string, definition: string) {
  const column = definition.trim().split(/\s+/)[0];
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

addColumnIfMissing("mcp_servers", "env_keys_json TEXT NOT NULL DEFAULT '[]'");
// sources 建表时漏了 updated_at，而 updateSource 会写它——缺列导致来源编辑接口整体报错
addColumnIfMissing("sources", "updated_at TEXT");
addColumnIfMissing("documents", "date_status TEXT NOT NULL DEFAULT 'date_unknown'");
addColumnIfMissing("documents", "date_evidence TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("documents", "date_candidates_json TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("documents", "fetch_mode TEXT NOT NULL DEFAULT 'static'");
addColumnIfMissing("documents", "rendered INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("documents", "discovery_method TEXT NOT NULL DEFAULT 'page-link'");
addColumnIfMissing("documents", "warnings_json TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("documents", "page_type TEXT NOT NULL DEFAULT 'unknown'");
addColumnIfMissing("documents", "extraction_method TEXT NOT NULL DEFAULT 'basic'");
addColumnIfMissing("documents", "attempt_count INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("documents", "failure_code TEXT");
addColumnIfMissing("projects", "generated_fields_json TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("project_mentions", "generated_fields_json TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("projects", "original_fields_json TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("projects", "evidence_translations_json TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("projects", "source_language TEXT NOT NULL DEFAULT 'zh'");
addColumnIfMissing("projects", "unit_checks_json TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("project_mentions", "original_fields_json TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("project_mentions", "evidence_translations_json TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("project_mentions", "source_language TEXT NOT NULL DEFAULT 'zh'");
addColumnIfMissing("project_mentions", "unit_checks_json TEXT NOT NULL DEFAULT '{}'");

const builtInFields: FieldDefinition[] = [
  { id: "country", label: "国家", type: "text", aliases: ["国家/地区", "country"], required: true, position: 1 },
  { id: "project_name", label: "项目名称", type: "text", aliases: ["项目", "project"], required: true, position: 2 },
  { id: "pv_capacity_mw", label: "光伏容量\nMW", type: "number", unit: "MW", aliases: ["光伏容量", "solar capacity"], required: false, position: 3 },
  { id: "storage_capacity_mwh", label: "储能容量\nMWh", type: "number", unit: "MWh", aliases: ["储能容量", "storage capacity"], required: false, position: 4 },
  { id: "owner", label: "业主", type: "text", aliases: ["项目业主", "owner", "developer"], required: false, position: 5 },
  { id: "address", label: "地址", type: "text", aliases: ["地点", "location"], required: false, position: 6 },
  { id: "published_month", label: "报道时间", type: "date", aliases: ["发布时间", "date"], required: true, position: 7 },
  { id: "chinese_client", label: "中资客户", type: "text", aliases: ["中方参与方", "Chinese participant"], required: false, position: 8 },
  { id: "progress", label: "项目进展", type: "text", aliases: ["进展", "milestone"], required: false, position: 9 },
  { id: "category", label: "投资与EPC分类", type: "text", aliases: ["分类", "category"], required: false, position: 10 },
  { id: "project_type", label: "项目类型", type: "text", aliases: ["技术类型", "technology"], required: false, position: 11 },
  { id: "storage_power_mw", label: "储能功率\nMW", type: "number", unit: "MW", aliases: ["储能功率", "storage power"], required: false, position: 12 },
  { id: "developer", label: "开发商", type: "text", aliases: ["developer"], required: false, position: 13 },
  { id: "epc", label: "EPC方", type: "text", aliases: ["EPC contractor", "承包商"], required: false, position: 14 },
  { id: "event_date", label: "项目事件日期", type: "date", aliases: ["里程碑日期", "event date"], required: false, position: 15 },
];

{
  const insert = db.prepare(`INSERT OR IGNORE INTO fields
    (id,label,type,unit,description,aliases_json,extraction_hint,required,position)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const field of builtInFields) {
    insert.run(field.id, field.label, field.type, field.unit ?? null, field.description ?? null,
      JSON.stringify(field.aliases), field.extractionHint ?? null, field.required ? 1 : 0, field.position);
  }
}

export function now() {
  return new Date().toISOString();
}

export function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function listFields(): FieldDefinition[] {
  return (db.prepare("SELECT * FROM fields ORDER BY position").all() as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), label: String(row.label), type: row.type as FieldDefinition["type"],
    unit: row.unit ? String(row.unit) : undefined,
    description: row.description ? String(row.description) : undefined,
    aliases: jsonParse<string[]>(row.aliases_json, []),
    extractionHint: row.extraction_hint ? String(row.extraction_hint) : undefined,
    required: Boolean(row.required), position: Number(row.position),
  }));
}

export function listSources(): SourceRecord[] {
  return (db.prepare("SELECT * FROM sources ORDER BY name").all() as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), name: String(row.name), type: String(row.type),
    coverage: String(row.coverage ?? ""), url: String(row.url), country: String(row.country ?? ""),
    enabled: Boolean(row.enabled), rateLimitMs: Number(row.rate_limit_ms), createdAt: String(row.created_at),
  }));
}

export function audit(entityType: string, entityId: string, action: string, payload: unknown = {}) {
  db.prepare("INSERT INTO audit_log VALUES (?,?,?,?,?,?)")
    .run(randomUUID(), entityType, entityId, action, JSON.stringify(payload), now());
}

export { DATA_DIR };
