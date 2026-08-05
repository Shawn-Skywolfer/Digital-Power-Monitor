import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, audit, jsonParse, now } from "./db";
import { callModel } from "./providers";
import type { JsonObject, ModelProviderRecord } from "./types";

const SKILL_ID = "scan-overseas-energy-projects";
const SKILL_DIR = path.resolve("skills", SKILL_ID);
const POLICY_PATH = path.join(SKILL_DIR, "references", "retrieval-policy.json");
const LEARNED_PATH = path.join(SKILL_DIR, "references", "learned-practices.md");
const ALLOWED_PATHS = new Set(["mcp_page_share", "max_source_page_share", "retrieval_order"]);

type SkillChange = {
  path: string; proposedValueJson: string; reason: string; expectedEffect: string; rollbackCondition: string;
};
type SkillProposal = { summary: string; changes: SkillChange[]; learnedPractices: string[]; modelUsed?: boolean };

function readPolicy() {
  return JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")) as JsonObject;
}

function mapIteration(row: Record<string, unknown>) {
  return {
    id: String(row.id), skillId: String(row.skill_id), scanId: String(row.scan_id ?? ""), version: Number(row.version),
    status: String(row.status), evidence: jsonParse<JsonObject>(row.evidence_json, {}),
    proposal: jsonParse<SkillProposal>(row.proposal_json, { summary: "", changes: [], learnedPractices: [] }),
    createdAt: String(row.created_at), reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  };
}

export function getRetrievalSkill() {
  const iterations = (db.prepare("SELECT * FROM skill_iterations WHERE skill_id=? ORDER BY created_at DESC LIMIT 50")
    .all(SKILL_ID) as Record<string, unknown>[]).map(mapIteration);
  return {
    id: SKILL_ID, name: "海外能源项目检索 Skill", description: "从监测漏斗、失败来源和模型反馈中形成可审计的检索最佳实践。",
    content: fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8"), policy: readPolicy(),
    learnedPractices: fs.existsSync(LEARNED_PATH) ? fs.readFileSync(LEARNED_PATH, "utf8") : "",
    version: Math.max(1, ...iterations.filter((item) => item.status === "applied").map((item) => item.version)), iterations,
  };
}

function fallbackProposal(diagnostics: JsonObject): SkillProposal {
  const scan = diagnostics.scan as JsonObject;
  const progress = (scan?.progress ?? {}) as JsonObject;
  const policy = readPolicy();
  const selected = Array.isArray((scan?.request as JsonObject | undefined)?.sourceIds)
    ? ((scan.request as JsonObject).sourceIds as unknown[]).length : Number(progress.sourcesTotal ?? 0);
  const scanned = Number(progress.sourcesScanned ?? 0);
  const failureCodes = (diagnostics.failureCodes ?? {}) as JsonObject;
  const changes: SkillChange[] = [];
  if (selected > 0 && scanned < selected) {
    changes.push({ path: "retrieval_order", proposedValueJson: JSON.stringify(["rss", "sitemap", "firecrawl-map", "archive", "static", "search", "mcp", "browser-session", "official-alternative"]),
      reason: `本轮只完成 ${scanned}/${selected} 个来源`, expectedEffect: "使用完成驱动队列并优先云端映射，确保所有选中来源都会进入枚举",
      rollbackCondition: "云端调用失败率或重复候选比例显著上升" });
  }
  if (Number(failureCodes.DISCOVERY_ERROR ?? 0) > 0 || Number(failureCodes.TIMEOUT ?? 0) > 0) {
    changes.push({ path: "retrieval_order", proposedValueJson: JSON.stringify(["rss", "sitemap", "archive", "static", "search", "mcp", "browser-session", "official-alternative"]),
      reason: "直接枚举/连接失败较多", expectedEffect: "在昂贵浏览器回退前优先利用搜索与 MCP 发现候选页",
      rollbackCondition: "候选 URL 唯一性或官方来源占比下降" });
  }
  return { summary: "根据本轮监测漏斗生成的候选改进，尚未应用。", changes,
    learnedPractices: ["所有策略变更必须绑定具体扫描 ID、失败网址和前后漏斗指标。", "连接超时不应直接归类为反爬，需与 403/429/挑战页分开处理。"], modelUsed: false };
}

function normalizeProposal(value: unknown, fallback: SkillProposal): SkillProposal {
  if (!value || typeof value !== "object") return fallback;
  const raw = value as JsonObject;
  const changes = Array.isArray(raw.changes) ? raw.changes.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const change = item as JsonObject; const key = String(change.path ?? "");
    if (!ALLOWED_PATHS.has(key)) return [];
    try { JSON.parse(String(change.proposedValueJson ?? "")); } catch { return []; }
    return [{ path: key, proposedValueJson: String(change.proposedValueJson), reason: String(change.reason ?? ""),
      expectedEffect: String(change.expectedEffect ?? ""), rollbackCondition: String(change.rollbackCondition ?? "") }];
  }) : fallback.changes;
  return { summary: String(raw.summary ?? fallback.summary), changes,
    learnedPractices: Array.isArray(raw.learnedPractices) ? raw.learnedPractices.map(String).filter(Boolean).slice(0, 12) : fallback.learnedPractices,
    modelUsed: true };
}

export async function proposeRetrievalSkillIteration(
  scanId: string, diagnostics: JsonObject, provider?: ModelProviderRecord, modelId?: string,
) {
  const fallback = fallbackProposal(diagnostics);
  let proposal = fallback;
  if (provider && modelId) {
    try {
      const result = await callModel(provider, modelId, `你是检索策略审计器。请依据下面的可审计监测诊断，为“海外能源项目检索 Skill”生成一版候选迭代。
只允许修改这些策略路径：mcp_page_share、max_source_page_share、retrieval_order。
每项修改必须给出 JSON 字符串形式的 proposedValueJson、量化证据、预期效果和回滚条件。不要放宽 robots.txt、绕过登录/验证码或虚构模型思维链。没有充分证据时不要提出数值修改，但可以沉淀 learnedPractices。
诊断：${JSON.stringify(diagnostics).slice(0, 80_000)}`, {
        type: "object", properties: {
          summary: { type: "string" }, changes: { type: "array", items: { type: "object", properties: {
            path: { type: "string", enum: [...ALLOWED_PATHS] }, proposedValueJson: { type: "string" }, reason: { type: "string" },
            expectedEffect: { type: "string" }, rollbackCondition: { type: "string" },
          }, required: ["path", "proposedValueJson", "reason", "expectedEffect", "rollbackCondition"], additionalProperties: false } },
          learnedPractices: { type: "array", items: { type: "string" } },
        }, required: ["summary", "changes", "learnedPractices"], additionalProperties: false,
      });
      proposal = normalizeProposal(result, fallback);
    } catch { proposal = fallback; }
  }
  const version = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM skill_iterations WHERE skill_id=?")
    .get(SKILL_ID) as { version: number }).version);
  const id = randomUUID();
  const evidence = { scanId, funnel: diagnostics.funnel, failureCodes: diagnostics.failureCodes,
    causes: diagnostics.causes, sourceDistribution: diagnostics.sourceDistribution, generatedAt: now() };
  db.prepare("INSERT INTO skill_iterations VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, SKILL_ID, scanId, version, "proposed", JSON.stringify(evidence), JSON.stringify(proposal), now(), null);
  audit("skill_iteration", id, "proposed", { skillId: SKILL_ID, scanId, version, modelUsed: proposal.modelUsed });
  return mapIteration(db.prepare("SELECT * FROM skill_iterations WHERE id=?").get(id) as Record<string, unknown>);
}

function validatePolicyChange(pathName: string, value: unknown) {
  if (pathName === "retrieval_order") {
    if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string")) throw new Error("检索顺序必须是字符串数组");
    return value;
  }
  const number = Number(value);
  const ranges: Record<string, [number, number]> = {
    mcp_page_share: [0, 0.5], max_source_page_share: [0.05, 0.5],
  };
  const range = ranges[pathName];
  if (!range || !Number.isFinite(number) || number < range[0] || number > range[1]) throw new Error(`${pathName} 超出安全范围`);
  return number;
}

export function reviewRetrievalSkillIteration(id: string, decision: "apply" | "reject") {
  const row = db.prepare("SELECT * FROM skill_iterations WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row || row.skill_id !== SKILL_ID) throw new Error("Skill 迭代不存在");
  if (row.status !== "proposed") throw new Error("该候选迭代已经处理");
  const proposal = jsonParse<SkillProposal>(row.proposal_json, { summary: "", changes: [], learnedPractices: [] });
  if (decision === "apply") {
    const policy = readPolicy();
    for (const change of proposal.changes) policy[change.path] = validatePolicyChange(change.path, JSON.parse(change.proposedValueJson));
    policy.version = Number(policy.version ?? 1) + 1;
    fs.writeFileSync(POLICY_PATH, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    const lines = [`\n## v${row.version} · ${now().slice(0, 10)} · 扫描 ${row.scan_id}`, "", proposal.summary, "",
      ...proposal.learnedPractices.map((item) => `- ${item}`), "",
      ...proposal.changes.map((item) => `- 策略 \`${item.path}\` → \`${item.proposedValueJson}\`：${item.reason}；回滚条件：${item.rollbackCondition}`), ""];
    fs.appendFileSync(LEARNED_PATH, lines.join("\n"), "utf8");
  }
  const status = decision === "apply" ? "applied" : "rejected";
  db.prepare("UPDATE skill_iterations SET status=?,reviewed_at=? WHERE id=?").run(status, now(), id);
  audit("skill_iteration", id, status, { skillId: SKILL_ID, version: row.version });
  return mapIteration(db.prepare("SELECT * FROM skill_iterations WHERE id=?").get(id) as Record<string, unknown>);
}
