import crypto, { randomUUID } from "node:crypto";
import type {
  ArticleAssessment, CrawledDocument, FieldDefinition, JsonObject, ModelProviderRecord, ResultRecord,
} from "./types";
import { callModel } from "./providers";
import { db, jsonParse, now } from "./db";
import { ruleExtract, ruleProjectLikelihood, scoreResult } from "./crawler";
import { normalizeMeasurementFields } from "./units";

function fieldProperties(fields: FieldDefinition[]) {
  return Object.fromEntries(fields.map((field) => [field.id, {
    type: field.type === "number" ? ["number", "null"] : ["string", "null"],
    description: `${field.label}${field.unit ? `，必须根据原文单位换算为 ${field.unit}；不能仅复制数字或猜测单位` : ""}`,
  }]));
}

export function articleAnalysisSchema(fields: FieldDefinition[]): JsonObject {
  const properties = fieldProperties(fields);
  const evidenceProperties = Object.fromEntries(fields.map((field) => [field.id, {
    type: ["string", "null"], description: `${field.label}对应的原文短句；正文没有证据时为 null`,
  }]));
  const originalProperties = Object.fromEntries(fields.map((field) => [field.id, {
    type: ["string", "null"], description: `${field.label}在网页原语言中的原始写法；数值字段必须包含原数字和单位`,
  }]));
  const translatedEvidenceProperties = Object.fromEntries(fields.map((field) => [field.id, {
    type: ["string", "null"], description: `${field.label}原文证据的中文翻译；中文网页可与 evidence 相同`,
  }]));
  return {
    type: "object",
    properties: {
      classification: { type: "string", enum: ["project_report", "non_project", "uncertain"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasoning: { type: "string" },
      sourceLanguage: { type: "string", description: "网页正文主要语言的 ISO 639-1 代码，例如 zh、en、es" },
      mentions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fields: { type: "object", properties, required: fields.map((field) => field.id), additionalProperties: false },
            originalFields: { type: "object", properties: originalProperties, required: fields.map((field) => field.id), additionalProperties: false },
            evidence: {
              type: "object", properties: evidenceProperties,
              required: fields.map((field) => field.id), additionalProperties: false,
            },
            evidenceTranslations: {
              type: "object", properties: translatedEvidenceProperties,
              required: fields.map((field) => field.id), additionalProperties: false,
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["fields", "originalFields", "evidence", "evidenceTranslations", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["classification", "confidence", "reasoning", "sourceLanguage", "mentions"],
    additionalProperties: false,
  };
}

function normalizeAssessment(value: unknown, document: CrawledDocument, fields: FieldDefinition[]): ArticleAssessment {
  if (!value || typeof value !== "object") return ruleAssessment(document, fields);
  const item = value as Record<string, unknown>;
  const validClassification = ["project_report", "non_project", "uncertain"].includes(String(item.classification));
  const mentions = Array.isArray(item.mentions) ? item.mentions.map((mention) => {
    const raw = mention as Record<string, unknown>;
    const rawFields = raw.fields && typeof raw.fields === "object" ? raw.fields as Record<string, unknown> : {};
    const rawOriginalFields = raw.originalFields && typeof raw.originalFields === "object" ? raw.originalFields as Record<string, unknown> : {};
    const rawEvidence = raw.evidence && typeof raw.evidence === "object" ? raw.evidence as Record<string, unknown> : {};
    const rawEvidenceTranslations = raw.evidenceTranslations && typeof raw.evidenceTranslations === "object" ? raw.evidenceTranslations as Record<string, unknown> : {};
    return {
      fields: Object.fromEntries(fields.map((field) => [field.id, rawFields[field.id] ?? null])),
      originalFields: Object.fromEntries(fields.map((field) => [field.id,
        typeof rawOriginalFields[field.id] === "string" ? String(rawOriginalFields[field.id]) : ""])),
      evidence: Object.fromEntries(Object.entries(rawEvidence)
        .filter(([, evidence]) => typeof evidence === "string" && evidence.trim())
        .map(([key, evidence]) => [key, String(evidence)])),
      evidenceTranslations: Object.fromEntries(Object.entries(rawEvidenceTranslations)
        .filter(([, evidence]) => typeof evidence === "string" && evidence.trim())
        .map(([key, evidence]) => [key, String(evidence)])),
      confidence: clamp(Number(raw.confidence ?? item.confidence ?? 0.5)),
    };
  }) : [];
  return {
    classification: validClassification ? item.classification as ArticleAssessment["classification"] : "uncertain",
    confidence: clamp(Number(item.confidence ?? 0.5)),
    reasoning: String(item.reasoning ?? "模型未提供判定理由"),
    sourceLanguage: String(item.sourceLanguage ?? detectSourceLanguage(document)),
    mentions,
  };
}

export function detectSourceLanguage(document: CrawledDocument) {
  const sample = `${document.title}\n${document.text.slice(0, 20_000)}`;
  const letters = sample.match(/[\p{L}]/gu)?.length ?? 0;
  const chinese = sample.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latin = sample.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters > 100 && chinese / letters < 0.15) return latin / letters >= 0.55 ? "en" : "foreign";
  return "zh";
}

function clamp(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

export function ruleAssessment(document: CrawledDocument, fields: FieldDefinition[]): ArticleAssessment {
  const likelihood = ruleProjectLikelihood(document);
  if (!likelihood.eligiblePage) {
    return {
      classification: "non_project", confidence: 0.96,
      reasoning: `页面类型为 ${document.pageType}，属于首页或聚合列表，禁止直接生成项目`, sourceLanguage: detectSourceLanguage(document), mentions: [],
    };
  }
  if (!likelihood.energy) {
    return { classification: "non_project", confidence: 0.86, reasoning: "正文未出现新能源技术或资产信息", sourceLanguage: detectSourceLanguage(document), mentions: [] };
  }
  if (!likelihood.isProject) {
    return { classification: "uncertain", confidence: 0.55, reasoning: "涉及新能源，但缺少足以确认具体项目的事件或规模证据", sourceLanguage: detectSourceLanguage(document), mentions: [] };
  }
  const extracted = ruleExtract(document, fields);
  return {
    classification: "project_report", confidence: likelihood.capacity ? 0.78 : 0.65,
    reasoning: "正文同时包含新能源技术、具体项目事件以及容量或里程碑证据", sourceLanguage: detectSourceLanguage(document),
    mentions: [{ fields: extracted.fields, originalFields: Object.fromEntries(Object.entries(extracted.fields).map(([key, value]) => [key, String(value ?? "")])),
      evidence: extracted.evidence, evidenceTranslations: detectSourceLanguage(document) === "zh" ? extracted.evidence : {}, confidence: likelihood.capacity ? 0.78 : 0.65 }],
  };
}

type PriorProjectHint = { fields: Record<string, unknown>; primaryUrl: string };

function verifiedHintAssessment(document: CrawledDocument, fields: FieldDefinition[], hints: PriorProjectHint[]) {
  const body = `${document.title}\n${document.text}`;
  const normalizedBody = normalizedText(body);
  const mentions = hints.flatMap((hint) => {
    const projectName = String(hint.fields.project_name ?? "").trim();
    const normalizedName = normalizedText(projectName);
    if (!normalizedName || !normalizedBody.includes(normalizedName)) return [];
    const start = Math.max(0, body.toLowerCase().indexOf(projectName.toLowerCase()) - 100);
    const snippet = body.slice(start, start + projectName.length + 320).replace(/\s+/g, " ").trim();
    const values = Object.fromEntries(fields.map((field) => [field.id, hint.fields[field.id] ?? null]));
    const originalFields = Object.fromEntries(fields.map((field) => [field.id,
      values[field.id] === null || values[field.id] === undefined ? "" : String(values[field.id])]));
    const evidence = Object.fromEntries(fields.flatMap((field) => {
      const value = values[field.id];
      if (field.id === "project_name") return [[field.id, snippet]];
      if (value === null || value === undefined || value === "") return [];
      return body.includes(String(value)) ? [[field.id, snippet]] : [];
    }));
    return [{ fields: values, originalFields, evidence, evidenceTranslations: { ...evidence }, confidence: 0.86 }];
  });
  if (!mentions.length) return null;
  return {
    classification: "project_report" as const,
    confidence: 0.86,
    reasoning: "当前正文逐字命中已确认历史项目名称；沿用历史结构化字段并以本次正文重新建立证据，结果进入质量复核",
    sourceLanguage: detectSourceLanguage(document),
    mentions,
  };
}

function modelAssessmentPayloadIsComplete(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["project_report", "non_project", "uncertain"].includes(String(item.classification)) &&
    Number.isFinite(Number(item.confidence)) && typeof item.reasoning === "string" && item.reasoning.trim().length >= 4 &&
    typeof item.sourceLanguage === "string" && Array.isArray(item.mentions);
}

export function bilingualAssessmentGaps(assessment: ArticleAssessment, fields: FieldDefinition[]) {
  if (!assessment.sourceLanguage || /^zh(?:-|$)/i.test(assessment.sourceLanguage) || assessment.classification !== "project_report") return [];
  const translatedTextFields = new Set(["project_name", "country", "address", "progress", "category", "project_type"]);
  const gaps: string[] = [];
  assessment.mentions.forEach((mention, index) => {
    for (const field of fields) {
      const translated = String(mention.fields[field.id] ?? "").trim();
      const original = String(mention.originalFields?.[field.id] ?? "").trim();
      const evidence = String(mention.evidence[field.id] ?? "").trim();
      const evidenceTranslation = String(mention.evidenceTranslations?.[field.id] ?? "").trim();
      if ((translated || evidence) && !original) gaps.push(`${index}:${field.id}:original`);
      if (evidence && !evidenceTranslation) gaps.push(`${index}:${field.id}:evidence_translation`);
      if (translatedTextFields.has(field.id) && translated && original && translated.toLowerCase() === original.toLowerCase() &&
        /[A-Za-z]{4}/.test(original) && !/[\u3400-\u9fff]/.test(translated)) gaps.push(`${index}:${field.id}:field_translation`);
    }
  });
  return [...new Set(gaps)];
}

async function repairBilingualAssessment(
  assessment: ArticleAssessment, document: CrawledDocument, fields: FieldDefinition[],
  provider: ModelProviderRecord, modelId: string,
) {
  const gaps = bilingualAssessmentGaps(assessment, fields);
  if (!gaps.length) return assessment;
  const repaired = await callModel(provider, modelId, `修复下面外文网页的结构化项目结果，使其完整满足中英双语要求。

必须遵守：
1. fields 是准确中文提炼；originalFields 是网页原语言写法。专有机构名可保留原名，但描述性项目名、国家、地点、进展和项目类型必须翻译成中文。
2. evidence 逐字保留网页原文；每条非空 evidence 都必须有对应的中文 evidenceTranslations。
3. 数值字段 fields 使用规定标准单位，originalFields 保留原数字和原单位；不得猜测正文没有的数据。
4. 保留原项目数量和分类，只修复双语缺口。只返回 JSON。

待修复缺口：${gaps.join("、")}
现有结果：${JSON.stringify(assessment)}
网页标题：${document.title}
网页正文：${document.text.slice(0, 24_000)}`, articleAnalysisSchema(fields));
  if (!modelAssessmentPayloadIsComplete(repaired)) throw new Error("双语修复返回结构不完整");
  const normalized = normalizeAssessment(repaired, document, fields);
  if (normalized.classification !== "project_report" || !normalized.mentions.length) throw new Error("双语修复丢失了项目实体");
  const remaining = bilingualAssessmentGaps(normalized, fields);
  if (remaining.length) {
    normalized.reasoning = `${normalized.reasoning}；仍有 ${remaining.length} 个双语字段待人工复核`;
    normalized.confidence = Math.min(normalized.confidence, 0.58);
    normalized.mentions = normalized.mentions.map((mention) => ({ ...mention, confidence: Math.min(mention.confidence, 0.58) }));
  }
  return normalized;
}

export async function assessArticle(
  document: CrawledDocument, fields: FieldDefinition[], provider?: ModelProviderRecord, modelId?: string,
  priorProjectHints: PriorProjectHint[] = [],
) {
  const fallback = ruleAssessment(document, fields);
  const verifiedHints = verifiedHintAssessment(document, fields, priorProjectHints);
  if (!provider || !modelId || !document.text) return { assessment: verifiedHints ?? fallback, modelUsed: false, error: "" };
  const likelihood = ruleProjectLikelihood(document);
  // Keep the model budget for plausible project articles. Homepage, listing and
  // clearly non-energy pages are deterministically classified by the rule layer.
  if (!likelihood.eligiblePage || !likelihood.energy) {
    return { assessment: fallback, modelUsed: false, error: "" };
  }
  const priorHintText = priorProjectHints.length
    ? `\n\n历史同口径任务曾在当前网页识别出以下候选项目。它们只用于防漏提示，不是事实来源；请逐一用当前正文核验，正文没有证据的候选必须丢弃，也要继续发现未列出的项目：\n${JSON.stringify(
      priorProjectHints.slice(0, 12).map((hint) => ({
        project_name: hint.fields.project_name ?? null,
        country: hint.fields.country ?? null,
        address: hint.fields.address ?? null,
        pv_capacity_mw: hint.fields.pv_capacity_mw ?? null,
        storage_power_mw: hint.fields.storage_power_mw ?? null,
        storage_capacity_mwh: hint.fields.storage_capacity_mwh ?? null,
        owner: hint.fields.owner ?? null,
      })),
    )}\n\n当前网页正文：\n`
    : "";
  try {
    const result = await callModel(
      provider,
      modelId,
      `判断下面的完整网页正文是否在报道现实中的光伏、储能、风电或其他新能源项目，并抽取其中的每一个项目。

判定要求：
1. project_report：至少存在一个可识别的现实项目或资产，并描述建设、开发、招标、中标、签约、融资、收购、开工、并网、投产等具体事件。
2. 行业评论、政策、市场预测、公司财报、产品发布以及泛泛提到项目组合但无法识别具体项目的内容，不属于 project_report。
3. 一篇文章包含多个项目时，mentions 必须逐个输出；不要把多个项目拼成一条。
4. 只使用正文证据。缺失字段返回 null，不推测。
5. project_report 至少尽力抽取项目名称，以及国家/地点、容量、业主/开发商/EPC方、事件或报道时间中的可用字段。
6. 当前页面类型为 ${document.pageType}。homepage/listing 页面必须判为 non_project，不能把公司名、网站名、栏目名当成项目名。
7. 正文没有直接给出项目名称时，project_name 必须返回 null；不要自行把企业名称当项目名称，系统会按参与方、区域、规模和项目类型生成显示名。
8. 检测网页主要语言并返回 sourceLanguage。若正文主要语言不是中文：fields 返回准确中文译名/译文，originalFields 返回网页中的原语言写法；evidence 必须逐字引用原文，evidenceTranslations 必须给出对应中文翻译。中文网页的 originalFields 可与 fields 相同，evidenceTranslations 可与 evidence 相同。
9. 每个数值字段的 originalFields 必须保留“原数字+原单位”，例如 5 GWh、500 kW。fields 中功率统一换算为 MW、能量/储能容量统一换算为 MWh：1 GW=1000 MW，1 kW=0.001 MW，1 GWh=1000 MWh，1 kWh=0.001 MWh。不得把 5 GWh 写成 5000000 MWh。
10. 严格区分功率 MW 与能量 MWh；储能若同时给出功率和容量，核对两者相除得到的时长。原文没有单位时不要输出数值。

标题：${document.title}
网址：${document.url}
发布日期：${document.publishedAt ?? "未知"}
正文：
${priorHintText}${document.text.slice(0, 100_000)}`,
      articleAnalysisSchema(fields),
    );
    if (!modelAssessmentPayloadIsComplete(result)) {
      throw new Error("模型返回的结构化结果缺少 classification、reasoning、sourceLanguage 或 mentions，已拒绝空壳结果");
    }
    let assessment = normalizeAssessment(result, document, fields);
    if (bilingualAssessmentGaps(assessment, fields).length) {
      assessment = await repairBilingualAssessment(assessment, document, fields, provider, modelId);
    }
    if (assessment.classification === "project_report" && !assessment.mentions.length) {
      return {
        assessment: { ...assessment, classification: "uncertain" as const, reasoning: `${assessment.reasoning}；模型未返回项目实体` },
        modelUsed: true, error: "",
      };
    }
    if (verifiedHints) {
      const existingNames = new Set(assessment.mentions.map((mention) => normalizedText(mention.fields.project_name)));
      const missingVerifiedMentions = verifiedHints.mentions.filter((mention) => !existingNames.has(normalizedText(mention.fields.project_name)));
      if (assessment.classification !== "project_report" || missingVerifiedMentions.length) {
        return {
          assessment: {
            ...verifiedHints,
            mentions: assessment.classification === "project_report"
              ? [...assessment.mentions, ...missingVerifiedMentions]
              : verifiedHints.mentions,
            reasoning: assessment.classification === "project_report"
              ? `${assessment.reasoning}；并补回 ${missingVerifiedMentions.length} 个正文已逐字命中的已确认历史项目`
              : `${assessment.reasoning}；但当前正文逐字命中已确认历史项目名称，按可审计召回保护规则保留`,
          },
          modelUsed: true,
          error: "",
        };
      }
    }
    return { assessment, modelUsed: true, error: "" };
  } catch (error) {
    const primaryError = error instanceof Error ? error.message : String(error);
    try {
      const recovery = await callModel(provider, modelId, `从下面外文或中文网页中抽取现实新能源项目。只返回符合 JSON Schema 的对象；外文网页必须让 fields 为中文、originalFields 为原文、evidence 为原文证据、evidenceTranslations 为中文证据翻译。数值标准化为 MW/MWh，originalFields 保留原单位。\n标题：${document.title}\n正文：${document.text.slice(0, 14_000)}`, articleAnalysisSchema(fields));
      if (!modelAssessmentPayloadIsComplete(recovery)) throw new Error("精简恢复结果结构不完整");
      let recovered = normalizeAssessment(recovery, document, fields);
      if (bilingualAssessmentGaps(recovered, fields).length) recovered = await repairBilingualAssessment(recovered, document, fields, provider, modelId);
      return { assessment: recovered, modelUsed: true, error: `首次抽取失败后已通过精简双语模式恢复：${primaryError}` };
    } catch (recoveryError) {
      const assessment = verifiedHints ?? fallback;
      const gaps = bilingualAssessmentGaps(assessment, fields);
      if (gaps.length) {
        assessment.reasoning = `${assessment.reasoning}；外文双语自动修复失败，结果仅供人工复核`;
        assessment.confidence = Math.min(assessment.confidence, 0.5);
        assessment.mentions = assessment.mentions.map((mention) => ({ ...mention, confidence: Math.min(mention.confidence, 0.5) }));
      }
      return { assessment, modelUsed: false, error: `${primaryError}；精简双语恢复失败：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}` };
    }
  }
}

export function saveAssessment(
  scanId: string, document: CrawledDocument, assessment: ArticleAssessment, fields: FieldDefinition[],
  sourceUrl: string, modelUsed: boolean,
) {
  db.prepare(`INSERT OR REPLACE INTO document_assessments
    (document_id,scan_id,classification,confidence,reasoning,mention_count,model_used,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      document.id, scanId, assessment.classification, assessment.confidence, assessment.reasoning,
      assessment.mentions.length, modelUsed ? 1 : 0, now(),
    );
  if (assessment.classification !== "project_report") return [];
  const projectIds: string[] = [];
  assessment.mentions.forEach((mention, index) => {
    const originalFields = Object.fromEntries(fields.map((field) => [field.id, String(mention.originalFields?.[field.id] ?? "")]));
    const initialFields = Object.fromEntries(fields.map((field) => [field.id, mention.fields[field.id] ?? null]));
    const measurementValidation = normalizeMeasurementFields(initialFields, fields, originalFields, mention.evidence);
    const normalizedFields = measurementValidation.fields;
    for (const warning of measurementValidation.warnings) if (!document.warnings.includes(warning)) document.warnings.push(warning);
    const evidenceTranslations = mention.evidenceTranslations ?? {};
    const sourceLanguage = assessment.sourceLanguage ?? detectSourceLanguage(document);
    const bilingualGaps = bilingualAssessmentGaps({ ...assessment, mentions: [mention] }, fields);
    if (bilingualGaps.length) {
      const warning = `外文双语字段不完整（${bilingualGaps.length}项），已强制进入人工复核`;
      if (!document.warnings.includes(warning)) document.warnings.push(warning);
    }
    const generatedFields: string[] = [];
    if (!hasValue(normalizedFields.project_name) || invalidProjectName(normalizedFields.project_name, normalizedFields, document)) {
      normalizedFields.project_name = synthesizeProjectName(normalizedFields);
      generatedFields.push("project_name");
      const supporting = ["epc", "chinese_client", "developer", "owner", "country", "address", "pv_capacity_mw", "storage_power_mw", "storage_capacity_mwh", "project_type"]
        .map((key) => mention.evidence[key]).filter(Boolean).join("；");
      mention.evidence.project_name = `【系统提炼，非原文项目名】${supporting || "依据正文已抽取字段组合"}`;
    }
    if (!hasValue(normalizedFields.published_month)) normalizedFields.published_month = document.publishedAt;
    const mentionId = randomUUID();
    const project = findMatchingProject(scanId, normalizedFields);
    const score = scoreResult(normalizedFields, document, sourceUrl);
    const projectId = project ? mergeProject(project, normalizedFields, originalFields, mention.evidence, evidenceTranslations,
      measurementValidation.checks, sourceLanguage, document, score, generatedFields) :
      createProject(scanId, normalizedFields, originalFields, mention.evidence, evidenceTranslations,
        measurementValidation.checks, sourceLanguage, document, score, `${mentionId}:${index}`, generatedFields);
    db.prepare(`INSERT OR REPLACE INTO project_mentions
      (id,scan_id,project_id,document_id,mention_index,fields_json,evidence_json,confidence,created_at,generated_fields_json,
       original_fields_json,evidence_translations_json,source_language,unit_checks_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        mentionId, scanId, projectId, document.id, index, JSON.stringify(normalizedFields),
        JSON.stringify(mention.evidence), mention.confidence, now(), JSON.stringify(generatedFields),
        JSON.stringify(originalFields), JSON.stringify(evidenceTranslations), sourceLanguage, JSON.stringify(measurementValidation.checks),
      );
    db.prepare(`INSERT OR REPLACE INTO project_sources(project_id,document_id,is_primary,created_at)
      VALUES (?,?,?,?)`).run(projectId, document.id, project ? 0 : 1, now());
    projectIds.push(projectId);
  });
  db.prepare("UPDATE documents SET warnings_json=? WHERE id=?").run(JSON.stringify(document.warnings), document.id);
  return projectIds;
}

export function applyBilingualRepair(projectId: string, assessment: ArticleAssessment, fields: FieldDefinition[]) {
  const row = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("项目结果不存在");
  if (assessment.classification !== "project_report" || !assessment.mentions.length) throw new Error("双语修复未返回项目实体");
  const currentFields = jsonParse<Record<string, unknown>>(row.fields_json, {});
  const ranked = assessment.mentions.map((mention) => ({
    mention, score: nameSimilarity(currentFields.project_name, mention.fields.project_name),
  })).sort((left, right) => right.score - left.score);
  const mention = ranked[0].mention;
  const remaining = bilingualAssessmentGaps({ ...assessment, mentions: [mention] }, fields);
  if (remaining.length) throw new Error(`双语修复仍缺少 ${remaining.length} 项，未覆盖现有结果`);
  const existingOriginal = jsonParse<Record<string, string>>(row.original_fields_json, {});
  const nextFields = { ...currentFields };
  const nextOriginal = { ...existingOriginal };
  for (const field of fields) {
    if (hasValue(mention.fields[field.id])) nextFields[field.id] = mention.fields[field.id];
    if (mention.originalFields?.[field.id]) nextOriginal[field.id] = mention.originalFields[field.id];
  }
  const measurementValidation = normalizeMeasurementFields(nextFields, fields, nextOriginal, mention.evidence);
  const unitChecks = {
    ...jsonParse<Record<string, string>>(row.unit_checks_json, {}),
    ...measurementValidation.checks,
  };
  const conflicts = jsonParse<string[]>(row.conflicts_json, []).filter((item) => !item.includes("外文双语字段不完整"));
  const sourceUrl = String(row.primary_url ?? "");
  db.prepare(`UPDATE projects SET fields_json=?,original_fields_json=?,evidence_json=?,evidence_translations_json=?,
    source_language=?,unit_checks_json=?,conflicts_json=?,status='review',revision=revision+1,updated_at=? WHERE id=?`).run(
      JSON.stringify(measurementValidation.fields), JSON.stringify(nextOriginal), JSON.stringify(evidenceWithSource(mention.evidence, sourceUrl)),
      JSON.stringify(evidenceWithSource(mention.evidenceTranslations ?? {}, sourceUrl)), String(assessment.sourceLanguage ?? row.source_language ?? "foreign"),
      JSON.stringify(unitChecks), JSON.stringify(conflicts), now(), projectId,
    );
  return mapProject(db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Record<string, unknown>);
}

function invalidProjectName(value: unknown, fields: Record<string, unknown>, document: CrawledDocument) {
  const name = String(value ?? "").trim();
  if (!name || ["homepage", "listing"].includes(document.pageType)) return true;
  const parties = [fields.epc, fields.chinese_client, fields.developer, fields.owner]
    .filter(hasValue).map((item) => normalizedText(item));
  if (parties.includes(normalizedText(name))) return true;
  const hasProjectSignal = /项目|电站|电场|园区|基地|工程|储能|光伏|风电|project|plant|farm|facility|park/i.test(name) ||
    /\d+(?:\.\d+)?\s*(?:GW|MW|GWh|MWh|兆瓦|吉瓦)/i.test(name);
  return /首页|官网|集团有限公司\s*$|股份有限公司\s*$|corporation\s*$|company\s*$/i.test(name) && !hasProjectSignal;
}

function compactCapacity(value: unknown, unit: "MW" | "MWh") {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (number >= 1000) return `${Math.round(number / 100) / 10}${unit === "MWh" ? "GWh" : "GW"}`;
  return `${Math.round(number * 10) / 10}${unit}`;
}

export function synthesizeProjectName(fields: Record<string, unknown>) {
  const party = String(fields.epc || fields.chinese_client || fields.developer || fields.owner || "未识别中标方").trim();
  const region = String(fields.country || fields.address || "未识别区域").trim();
  const scale = compactCapacity(fields.storage_capacity_mwh, "MWh") ||
    compactCapacity(fields.pv_capacity_mw, "MW") || compactCapacity(fields.storage_power_mw, "MW") || "规模待核实";
  const type = String(fields.project_type || (hasValue(fields.storage_capacity_mwh) && hasValue(fields.pv_capacity_mw) ? "光伏配储" :
    hasValue(fields.storage_capacity_mwh) || hasValue(fields.storage_power_mw) ? "储能电站" :
      hasValue(fields.pv_capacity_mw) ? "光伏项目" : "新能源项目")).trim();
  return `${party}+${region}+${scale}+${type}`;
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function normalizedText(value: unknown) {
  return String(value ?? "").toLowerCase().normalize("NFKC")
    .replace(/\b(?:solar|pv|photovoltaic|battery|energy|storage|project|power|plant|farm)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokens(value: unknown) {
  return new Set(String(value ?? "").toLowerCase().normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2 &&
      !["solar", "pv", "photovoltaic", "battery", "energy", "storage", "project", "power", "plant", "farm"].includes(item)));
}

function nameSimilarity(left: unknown, right: unknown) {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const intersection = [...leftTokens].filter((item) => rightTokens.has(item)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function capacitySimilarity(left: Record<string, unknown>, right: Record<string, unknown>) {
  const keys = ["pv_capacity_mw", "storage_power_mw", "storage_capacity_mwh"];
  let compared = 0;
  let matched = 0;
  for (const key of keys) {
    const a = Number(left[key]);
    const b = Number(right[key]);
    if (a > 0 && b > 0) {
      compared++;
      if (Math.abs(a - b) / Math.max(a, b) <= 0.05) matched++;
    }
  }
  return compared ? matched / compared : 0;
}

function projectMatchScore(left: Record<string, unknown>, right: Record<string, unknown>) {
  const name = nameSimilarity(left.project_name, right.project_name);
  const leftCountry = normalizedText(left.country);
  const rightCountry = normalizedText(right.country);
  if (leftCountry && rightCountry && leftCountry !== rightCountry) return 0;
  let score = name * 0.6;
  if (leftCountry && rightCountry && leftCountry === rightCountry) score += 0.15;
  score += capacitySimilarity(left, right) * 0.2;
  const ownerLeft = normalizedText(left.owner || left.developer);
  const ownerRight = normalizedText(right.owner || right.developer);
  if (ownerLeft && ownerRight && (ownerLeft.includes(ownerRight) || ownerRight.includes(ownerLeft))) score += 0.1;
  const addressLeft = normalizedText(left.address);
  const addressRight = normalizedText(right.address);
  if (addressLeft && addressRight && (addressLeft.includes(addressRight) || addressRight.includes(addressLeft))) score += 0.1;
  return Math.min(1, score);
}

function findMatchingProject(scanId: string, fields: Record<string, unknown>) {
  const rows = db.prepare("SELECT * FROM projects WHERE scan_id=?").all(scanId) as Record<string, unknown>[];
  return rows.map((row) => ({
    row, score: projectMatchScore(fields, jsonParse<Record<string, unknown>>(row.fields_json, {})),
  })).sort((a, b) => b.score - a.score).find((candidate) => candidate.score >= 0.58)?.row;
}

function canonicalKey(fields: Record<string, unknown>, fallback: string) {
  const raw = [
    normalizedText(fields.project_name), normalizedText(fields.country),
    normalizedText(fields.address), capacitySignature(fields),
  ].filter(Boolean).join("|") || fallback;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function capacitySignature(fields: Record<string, unknown>) {
  return ["pv_capacity_mw", "storage_power_mw", "storage_capacity_mwh"]
    .map((key) => Number(fields[key]) > 0 ? `${key}:${Math.round(Number(fields[key]) * 10) / 10}` : "")
    .filter(Boolean).join(",");
}

function evidenceWithSource(evidence: Record<string, string>, url: string) {
  return Object.fromEntries(Object.entries(evidence).filter(([, value]) => value)
    .map(([key, value]) => [key, `[${url}] ${value}`]));
}

function createProject(
  scanId: string, fields: Record<string, unknown>, originalFields: Record<string, string>, evidence: Record<string, string>,
  evidenceTranslations: Record<string, string>, unitChecks: Record<string, string>, sourceLanguage: string,
  document: CrawledDocument, score: number, fallback: string, generatedFields: string[],
) {
  const id = randomUUID();
  const conflicts = document.warnings.map((warning) => `来源警告：${warning}`);
  const status = score >= 85 && !conflicts.length ? "auto_approved" : "review";
  db.prepare(`INSERT INTO projects
    (id,scan_id,canonical_key,fields_json,primary_document_id,primary_url,source_urls_json,evidence_json,
     conflicts_json,score,status,revision,decision_note,created_at,updated_at,original_fields_json,
     evidence_translations_json,source_language,unit_checks_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, scanId, canonicalKey(fields, fallback), JSON.stringify(fields), document.id, document.url,
      JSON.stringify([document.url]), JSON.stringify(evidenceWithSource(evidence, document.url)),
      JSON.stringify(conflicts), score, status, 1, null, now(), now(), JSON.stringify(originalFields),
      JSON.stringify(evidenceWithSource(evidenceTranslations, document.url)), sourceLanguage, JSON.stringify(unitChecks),
    );
  if (generatedFields.length) db.prepare("UPDATE projects SET generated_fields_json=? WHERE id=?")
    .run(JSON.stringify(generatedFields), id);
  return id;
}

function equivalentValue(left: unknown, right: unknown) {
  if (typeof left === "number" || typeof right === "number") {
    const a = Number(left);
    const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b)) <= 0.02;
  }
  const a = normalizedText(left);
  const b = normalizedText(right);
  return a === b || (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a)));
}

function mergeProject(
  row: Record<string, unknown>, incoming: Record<string, unknown>, incomingOriginalFields: Record<string, string>,
  incomingEvidence: Record<string, string>, incomingEvidenceTranslations: Record<string, string>, incomingUnitChecks: Record<string, string>,
  incomingSourceLanguage: string, document: CrawledDocument, incomingScore: number, incomingGeneratedFields: string[],
) {
  const fields = jsonParse<Record<string, unknown>>(row.fields_json, {});
  const originalFields = jsonParse<Record<string, string>>(row.original_fields_json, {});
  const evidence = jsonParse<Record<string, string>>(row.evidence_json, {});
  const evidenceTranslations = jsonParse<Record<string, string>>(row.evidence_translations_json, {});
  const unitChecks = jsonParse<Record<string, string>>(row.unit_checks_json, {});
  const conflicts = jsonParse<string[]>(row.conflicts_json, []);
  for (const [key, value] of Object.entries(incoming)) {
    if (!hasValue(value)) continue;
    if (!hasValue(fields[key])) fields[key] = value;
    else if (!equivalentValue(fields[key], value) && !["progress", "published_month", "project_name"].includes(key)) {
      const message = `${key}存在冲突：${String(fields[key])} / ${String(value)}`;
      if (!conflicts.includes(message)) conflicts.push(message);
    }
    if (incomingEvidence[key]) {
      const sourced = `[${document.url}] ${incomingEvidence[key]}`;
      if (!evidence[key]) evidence[key] = sourced;
      else if (!evidence[key].includes(sourced)) evidence[key] = `${evidence[key]}\n${sourced}`;
    }
    if (incomingOriginalFields[key] && !originalFields[key]) originalFields[key] = incomingOriginalFields[key];
    if (incomingEvidenceTranslations[key]) {
      const translated = `[${document.url}] ${incomingEvidenceTranslations[key]}`;
      if (!evidenceTranslations[key]) evidenceTranslations[key] = translated;
      else if (!evidenceTranslations[key].includes(translated)) evidenceTranslations[key] = `${evidenceTranslations[key]}\n${translated}`;
    }
    if (incomingUnitChecks[key]) unitChecks[key] = incomingUnitChecks[key];
  }
  for (const warning of document.warnings) {
    const message = `来源警告：${warning}`;
    if (!conflicts.includes(message)) conflicts.push(message);
  }
  const urls = [...new Set([...jsonParse<string[]>(row.source_urls_json, []), document.url])];
  const generatedFields = [...new Set([...jsonParse<string[]>(row.generated_fields_json, []), ...incomingGeneratedFields])];
  const score = Math.min(100, Math.max(Number(row.score), incomingScore) + Math.min(5, Math.max(0, urls.length - 1) * 2));
  const primaryImproved = incomingScore > Number(row.score);
  const status = score >= 85 && !conflicts.length ? "auto_approved" : "review";
  db.prepare(`UPDATE projects SET fields_json=?,primary_document_id=?,primary_url=?,source_urls_json=?,
    evidence_json=?,conflicts_json=?,score=?,status=?,revision=revision+1,updated_at=?,generated_fields_json=?,
    original_fields_json=?,evidence_translations_json=?,source_language=?,unit_checks_json=? WHERE id=?`).run(
      JSON.stringify(fields), primaryImproved ? document.id : String(row.primary_document_id ?? ""),
      primaryImproved ? document.url : String(row.primary_url ?? ""), JSON.stringify(urls), JSON.stringify(evidence),
      JSON.stringify(conflicts), score, status, now(), JSON.stringify(generatedFields), JSON.stringify(originalFields),
      JSON.stringify(evidenceTranslations), String(row.source_language ?? "zh") === "zh" ? incomingSourceLanguage : String(row.source_language),
      JSON.stringify({ ...unitChecks, ...incomingUnitChecks }), String(row.id),
    );
  return String(row.id);
}

export function mapProject(row: Record<string, unknown>): ResultRecord {
  return {
    id: String(row.id), scanId: String(row.scan_id), documentId: String(row.primary_document_id ?? ""),
    fields: jsonParse<Record<string, unknown>>(row.fields_json, {}),
    primaryUrl: String(row.primary_url ?? ""),
    candidateUrls: jsonParse<string[]>(row.source_urls_json, []),
    evidence: jsonParse<Record<string, string>>(row.evidence_json, {}),
    conflicts: jsonParse<string[]>(row.conflicts_json, []),
    score: Number(row.score), status: row.status as ResultRecord["status"],
    revision: Number(row.revision), decisionNote: String(row.decision_note ?? ""),
    generatedFields: jsonParse<string[]>(row.generated_fields_json, []),
    originalFields: jsonParse<Record<string, string>>(row.original_fields_json, {}),
    evidenceTranslations: jsonParse<Record<string, string>>(row.evidence_translations_json, {}),
    sourceLanguage: String(row.source_language ?? "zh"),
    unitChecks: jsonParse<Record<string, string>>(row.unit_checks_json, {}),
  };
}
