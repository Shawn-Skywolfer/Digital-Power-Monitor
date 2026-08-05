import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import archiver from "archiver";
import { db, jsonParse, listFields, now } from "./db";
import type { FieldDefinition, ResultRecord } from "./types";
import { mapProject } from "./projects";

function safeName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100);
}

function mapResult(row: Record<string, unknown>): ResultRecord {
  return {
    id: String(row.id), scanId: String(row.scan_id), documentId: String(row.document_id ?? ""),
    fields: jsonParse<Record<string, unknown>>(row.fields_json, {}),
    primaryUrl: String(row.primary_url ?? ""),
    candidateUrls: jsonParse<string[]>(row.candidate_urls_json, []),
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

export async function exportSnapshot(snapshotId: string) {
  const snapshot = db.prepare("SELECT * FROM snapshots WHERE id=?").get(snapshotId) as Record<string, unknown> | undefined;
  if (!snapshot) throw new Error("快照不存在");
  const resultIds = jsonParse<string[]>(snapshot.result_ids_json, []);
  const selectedFieldIds = jsonParse<string[]>(snapshot.field_ids_json, []);
  const fieldsById = new Map(listFields().map((field) => [field.id, field]));
  const fields = selectedFieldIds.map((id) => fieldsById.get(id)).filter(Boolean) as FieldDefinition[];
  const rows = resultIds.map((id) => {
    const project = db.prepare("SELECT * FROM projects WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (project) return mapProject(project);
    const legacy = db.prepare("SELECT * FROM results WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return legacy ? mapResult(legacy) : undefined;
  }).filter(Boolean) as ResultRecord[];
  const scanId = String(snapshot.scan_id);
  const scan = db.prepare("SELECT progress_json FROM scans WHERE id=?").get(scanId) as { progress_json?: string } | undefined;
  const coverage = jsonParse<Record<string, unknown>>(scan?.progress_json, {});
  const stamp = now().replace(/[:.]/g, "-");
  const outputDir = path.resolve("outputs", `monitor-${safeName(scanId)}-${stamp}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const base = `海外能源项目监测_${scanId.slice(0, 8)}`;
  const xlsxPath = path.join(outputDir, `${base}.xlsx`);
  const mdPath = path.join(outputDir, `${base}.md`);
  const jsonPath = path.join(outputDir, `${base}.json`);
  const zipPath = path.join(outputDir, `${base}_网页全文证据包.zip`);

  await writeWorkbook(xlsxPath, fields, rows);
  fs.writeFileSync(jsonPath, JSON.stringify({
    snapshotId, scanId, createdAt: snapshot.created_at, includeFlagged: Boolean(snapshot.include_flagged),
    coverage, fields, projects: rows, results: rows,
  }, null, 2), "utf8");
  fs.writeFileSync(mdPath, writeMarkdown(snapshotId, fields, rows, coverage), "utf8");
  await writeEvidenceZip(zipPath, scanId, rows);

  const files = { xlsx: xlsxPath, markdown: mdPath, json: jsonPath, evidenceZip: zipPath };
  const exportId = randomUUID();
  db.prepare("INSERT INTO exports VALUES (?,?,?,?,?)")
    .run(exportId, snapshotId, outputDir, JSON.stringify(files), now());
  const downloads = Object.fromEntries(Object.entries(files).map(([key, filePath]) => [key, {
    name: path.basename(filePath), url: `/api/exports/${exportId}/files/${key}`,
  }]));
  return { id: exportId, outputDir, files, downloads };
}

async function writeWorkbook(filePath: string, fields: FieldDefinition[], rows: ResultRecord[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Digital Power Monitor";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("项目汇总", { views: [{ state: "frozen", ySplit: 1 }] });
  const bilingual = new Set(fields.filter((field) => rows.some((row) => {
    const original = String(row.originalFields?.[field.id] ?? "").trim();
    return original && original.toLowerCase() !== String(row.fields[field.id] ?? "").trim().toLowerCase();
  })).map((field) => field.id));
  const columns = fields.flatMap((field) => [
    { label: field.label, field, value: (row: ResultRecord) => row.fields[field.id] ?? null },
    ...(bilingual.has(field.id) ? [{ label: `${field.label.replace(/\n/g, " ")}（原文）`, field,
      value: (row: ResultRecord) => row.originalFields?.[field.id] ?? "" }] : []),
    ...(field.unit ? [{ label: `${field.label.replace(/\n/g, " ")}（单位核验）`, field,
      value: (row: ResultRecord) => row.unitChecks?.[field.id] ?? "" }] : []),
  ]);
  const headers = [...columns.map((column) => column.label), "原始网页链接"];
  sheet.addRow(headers);
  for (const result of rows) {
    sheet.addRow([...columns.map((column) => column.value(result)), result.primaryUrl]);
  }
  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell((cell) => {
    cell.font = { name: "微软雅黑", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF173D3A" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FF9CC4BB" } } };
  });
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: "top", wrapText: true };
    row.font = { name: "微软雅黑", size: 10, color: { argb: "FF243230" } };
    if (rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F8F6" } };
      });
    }
  });
  columns.forEach((spec, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = spec.label.includes("单位核验") ? 38 : spec.field.type === "number" ? 14 : spec.field.id === "project_name" ? 42 : 24;
    if (spec.field.type === "number" && !spec.label.includes("原文") && !spec.label.includes("核验")) excelColumn.numFmt = "0.00";
  });
  sheet.getColumn(headers.length).width = 55;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
  await workbook.xlsx.writeFile(filePath);
}

function writeMarkdown(
  snapshotId: string, fields: FieldDefinition[], rows: ResultRecord[], coverage: Record<string, unknown>,
) {
  const reviewed = rows.filter((row) => row.status === "approved" || row.status === "auto_approved").length;
  const uncertain = rows.length - reviewed;
  const lines = [
    "# 海外能源项目监测报告", "",
    `- 快照：${snapshotId}`,
    `- 项目数：${rows.length}`,
    `- 已确认/自动通过：${reviewed}`,
    `- 存疑：${uncertain}`, "",
    "## 覆盖报告", "",
    `- 发现文章 URL：${coverage.pagesDiscovered ?? 0}`,
    `- 已抓取页面：${coverage.pagesFetched ?? 0}`,
    `- 全文成功：${coverage.fullTextSucceeded ?? 0}`,
    `- 时间范围内：${coverage.withinRange ?? 0}`,
    `- 时间范围外：${coverage.outsideRange ?? 0}`,
    `- 日期不明：${coverage.dateUnknown ?? 0}`,
    `- 日期冲突：${coverage.dateConflict ?? 0}`,
    `- 动态渲染页面：${coverage.dynamicPages ?? 0}`,
    `- 项目报道：${coverage.projectArticles ?? 0}`,
    `- 非项目内容：${coverage.nonProjectArticles ?? 0}`,
    `- 待复核文章：${coverage.uncertainArticles ?? 0}`,
    `- 发现策略：${Array.isArray(coverage.discoveryStrategies) ? coverage.discoveryStrategies.join("、") : ""}`, "",
    "## 项目列表", "",
    `| ${fields.map((field) => field.label.replace(/\n/g, " ")).join(" | ")} | 原始网页链接 | 置信度 | 状态 |`,
    `| ${[...fields.map(() => "---"), "---", "---:", "---"].join(" | ")} |`,
  ];
  for (const row of rows) {
    const values = fields.map((field) => {
      const translated = String(row.fields[field.id] ?? "");
      const original = String(row.originalFields?.[field.id] ?? "").trim();
      const unitCheck = String(row.unitChecks?.[field.id] ?? "").trim();
      return [translated, original && original.toLowerCase() !== translated.trim().toLowerCase() ? `原文：${original}` : "", unitCheck]
        .filter(Boolean).join("<br>").replace(/\|/g, "\\|").replace(/\n/g, " ");
    });
    lines.push(`| ${values.join(" | ")} | ${row.primaryUrl} | ${row.score} | ${row.status} |`);
  }
  lines.push("", "## 存疑与冲突", "");
  for (const row of rows.filter((item) => item.conflicts.length || item.status === "review")) {
    lines.push(`- ${String(row.fields.project_name ?? row.id)}：${row.conflicts.join("；") || "待人工确认"}`);
  }
  return lines.join("\n");
}

function writeEvidenceZip(zipPath: string, scanId: string, rows: ResultRecord[]) {
  return new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    const manifest: unknown[] = [];
    const included = new Set<string>();
    for (const result of rows) {
      const sourceRows = db.prepare("SELECT document_id FROM project_sources WHERE project_id=?").all(result.id) as { document_id: string }[];
      const documentIds = sourceRows.length ? sourceRows.map((item) => item.document_id) : [result.documentId];
      for (const documentId of documentIds) {
        if (!documentId || included.has(documentId)) continue;
        const doc = db.prepare("SELECT * FROM documents WHERE id=?").get(documentId) as Record<string, unknown> | undefined;
        if (!doc) continue;
        included.add(documentId);
        const key = String(doc.hash);
        const rawPath = String(doc.raw_path ?? "");
        const markdownPath = String(doc.markdown_path ?? "");
        if (rawPath && fs.existsSync(rawPath)) archive.file(rawPath, { name: `documents/${key}${path.extname(rawPath)}` });
        if (markdownPath && fs.existsSync(markdownPath)) archive.file(markdownPath, { name: `documents/${key}.md` });
        manifest.push({
          projectId: result.id, documentId: doc.id, url: doc.url, canonicalUrl: doc.canonical_url,
          title: doc.title, publishedAt: doc.published_at, dateStatus: doc.date_status,
          fetchedAt: doc.fetched_at, fetchMode: doc.fetch_mode, rendered: Boolean(doc.rendered),
          contentType: doc.content_type, statusCode: doc.status_code, sha256: doc.hash,
        });
      }
    }
    archive.append(JSON.stringify({ scanId, generatedAt: now(), documents: manifest }, null, 2), { name: "manifest.json" });
    void archive.finalize();
  });
}
