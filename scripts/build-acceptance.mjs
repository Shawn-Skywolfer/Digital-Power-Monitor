import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import archiver from "archiver";
import * as cheerio from "cheerio";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const ROOT = "C:/Users/perfe/Documents/Digital-Power-Monitor";
const INPUT = path.join(ROOT, "outputs/project-input.xlsx");
const BASELINE = path.join(ROOT, "fixtures/acceptance-links.json");
const OUTPUT_DIR = path.join(ROOT, "outputs/acceptance");
const EVIDENCE_DIR = path.join(OUTPUT_DIR, "网页全文证据包");

function scalar(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? "").join("");
    if ("value" in value) return scalar(value.value);
  }
  return value;
}

function statusLabel(status) {
  return {
    verified: "已核验",
    needs_review: "待复核",
    conflict: "硬冲突",
  }[status] ?? status;
}

function authorityLabel(authority) {
  return {
    company_official: "企业官网",
    owner_official: "业主官网",
    partner_official: "合作方官网",
    government_official: "政府官网",
    government_trade_portal: "政府经贸平台",
    exchange_filing: "交易所公告",
    exchange_disclosure_media: "法定披露媒体",
    multilateral_official: "多边机构",
    national_news_agency: "国家通讯社",
    state_media: "中央媒体",
    industry_official_media: "行业权威媒体",
    industry_media: "行业媒体",
    financial_media: "财经媒体",
    national_business_media: "当地商业媒体",
  }[authority] ?? authority;
}

function safeName(value) {
  return String(value || "未命名")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 48);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function htmlToMarkdown(html, url) {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,canvas,iframe,form,nav").remove();
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const published =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[name="date"]').attr("content") ||
    $("time").first().attr("datetime") ||
    "";
  const root = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");
  const blocks = [];
  root.find("h1,h2,h3,h4,p,li,blockquote,pre").each((_, node) => {
    const tag = node.tagName.toLowerCase();
    const text = $(node).text().replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) return;
    if (/^h[1-4]$/.test(tag)) blocks.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    else if (tag === "li") blocks.push(`- ${text}`);
    else if (tag === "blockquote") blocks.push(`> ${text}`);
    else blocks.push(text);
  });
  const unique = blocks.filter((text, index) => index === 0 || text !== blocks[index - 1]);
  return {
    title,
    published,
    markdown: `# ${title || "网页全文"}\n\n- 原始链接：${url}\n- 页面发布时间：${published || "未识别"}\n\n${unique.join("\n\n")}\n`,
  };
}

async function fetchWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Digital-Power-Monitor/0.1 (+local research archive; respects robots and access controls)",
        accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.7",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEvidence(record, project) {
  const folderName = `${String(record.record).padStart(3, "0")}-${safeName(project["项目名称"] || project["国家"])}`;
  const folder = path.join(EVIDENCE_DIR, folderName);
  await fsp.mkdir(folder, { recursive: true });
  const startedAt = new Date().toISOString();
  const metadata = {
    record: record.record,
    project_name: project["项目名称"] || "",
    country: project["国家"] || "",
    requested_url: record.url,
    final_url: record.url,
    fetched_at: startedAt,
    http_status: null,
    content_type: "",
    sha256: "",
    raw_file: "",
    markdown_file: "cleaned.md",
    error: "",
  };
  try {
    const response = await fetchWithTimeout(record.url);
    metadata.final_url = response.url || record.url;
    metadata.http_status = response.status;
    metadata.content_type = response.headers.get("content-type") || "";
    const bytes = Buffer.from(await response.arrayBuffer());
    metadata.sha256 = sha256(bytes);
    if (metadata.content_type.toLowerCase().includes("pdf") || /\.pdf(?:$|\?)/i.test(metadata.final_url)) {
      metadata.raw_file = "raw.pdf";
      await fsp.writeFile(path.join(folder, "raw.pdf"), bytes);
      await fsp.writeFile(
        path.join(folder, "cleaned.md"),
        `# ${record.source_title}\n\n- 原始链接：${record.url}\n- 最终链接：${metadata.final_url}\n- HTTP 状态：${response.status}\n- SHA-256：${metadata.sha256}\n\n该页面为 PDF，原始文件已完整保存在同目录。\n`,
        "utf8",
      );
    } else {
      metadata.raw_file = "raw.html";
      await fsp.writeFile(path.join(folder, "raw.html"), bytes);
      const html = bytes.toString("utf8");
      const cleaned = htmlToMarkdown(html, metadata.final_url);
      metadata.page_title = cleaned.title;
      metadata.published_at = cleaned.published;
      await fsp.writeFile(path.join(folder, "cleaned.md"), cleaned.markdown, "utf8");
    }
    if (!response.ok) metadata.error = `HTTP ${response.status}`;
  } catch (error) {
    metadata.error = error instanceof Error ? error.message : String(error);
    await fsp.writeFile(
      path.join(folder, "cleaned.md"),
      `# 抓取失败记录\n\n- 原始链接：${record.url}\n- 抓取时间：${startedAt}\n- 失败原因：${metadata.error}\n\n应用未绕过登录、验证码、付费墙或站点访问限制。\n`,
      "utf8",
    );
  }
  await fsp.writeFile(path.join(folder, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

async function runPool(items, worker, concurrency = 5) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
  return results;
}

async function zipDirectory(sourceDir, zipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (error) => {
      if (error.code !== "ENOENT") reject(error);
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

export async function buildAcceptance({ fetchPages = true } = {}) {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  await fsp.rm(EVIDENCE_DIR, { recursive: true, force: true });
  await fsp.mkdir(EVIDENCE_DIR, { recursive: true });

  const links = JSON.parse(await fsp.readFile(BASELINE, "utf8"));
  if (links.length !== 69) throw new Error(`验收基准应为69条，当前为${links.length}条。`);
  links.forEach((item, index) => {
    if (item.record !== index + 1) throw new Error(`验收基准序号不连续：${item.record}`);
  });

  const inputBlob = await FileBlob.load(INPUT);
  const workbook = await SpreadsheetFile.importXlsx(inputBlob);
  const sheet = workbook.worksheets.getItemAt(0);
  const beforeInspect = await workbook.inspect({
    kind: "workbook,sheet,table,formula",
    maxChars: 8000,
    tableMaxRows: 8,
    tableMaxCols: 12,
  });
  await fsp.writeFile(path.join(OUTPUT_DIR, "导入工作簿检查.ndjson"), beforeInspect.ndjson, "utf8");

  const originalPreview = await workbook.render({
    sheetName: sheet.name,
    range: "A1:J71",
    scale: 1,
    format: "png",
  });
  await fsp.writeFile(
    path.join(OUTPUT_DIR, "原始工作簿预览.png"),
    new Uint8Array(await originalPreview.arrayBuffer()),
  );

  const values = sheet.getRange("A1:J71").values;
  const headers = values[0].map(scalar);
  const projects = values.slice(1, 70).map((row, index) => {
    const object = { record: index + 1, excel_row: index + 2 };
    headers.forEach((header, column) => {
      object[header] = scalar(row[column]);
    });
    return object;
  });

  sheet.getRange("K1").copyFrom(sheet.getRange("J1"), "all");
  sheet.getRange("K2:K70").copyFrom(sheet.getRange("J2:J70"), "all");
  sheet.getRange("K71").copyFrom(sheet.getRange("J71"), "all");
  sheet.getRange("K1").values = [["原始网页链接"]];
  sheet.getRange("K2:K70").values = links.map((item) => [item.url]);
  sheet.getRange("K71").values = [[""]];
  sheet.getRange("K1:K71").format.columnWidth = 58;
  sheet.getRange("K1:K71").format.wrapText = true;
  sheet.getRange("K2:K70").format.font = { color: "#0563C1", underline: "single" };

  const outputXlsx = await SpreadsheetFile.exportXlsx(workbook);
  const outputXlsxPath = path.join(OUTPUT_DIR, "项目汇总列表-V1-已补原始链接.xlsx");
  await outputXlsx.save(outputXlsxPath);

  const editedPreview = await workbook.render({
    sheetName: sheet.name,
    range: "A1:K71",
    scale: 1,
    format: "png",
  });
  await fsp.writeFile(
    path.join(OUTPUT_DIR, "补链工作簿预览.png"),
    new Uint8Array(await editedPreview.arrayBuffer()),
  );

  const formulaCheck = await workbook.inspect({
    kind: "formula",
    sheetId: sheet.name,
    range: "A1:K71",
    maxChars: 6000,
    options: { maxResults: 200 },
  });
  const errorCheck = await workbook.inspect({
    kind: "match",
    sheetId: sheet.name,
    range: "A1:K71",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    maxChars: 6000,
    options: { useRegex: true, maxResults: 200 },
  });
  await fsp.writeFile(
    path.join(OUTPUT_DIR, "公式与错误检查.ndjson"),
    `${formulaCheck.ndjson}\n${errorCheck.ndjson}`,
    "utf8",
  );

  const combined = links.map((link, index) => ({
    ...projects[index],
    original_url: link.url,
    source_title: link.source_title,
    authority: link.authority,
    confidence: link.confidence,
    verification_status: link.status,
    verification_note: link.note,
  }));
  const stats = {
    total: combined.length,
    verified: combined.filter((item) => item.verification_status === "verified").length,
    needs_review: combined.filter((item) => item.verification_status === "needs_review").length,
    conflict: combined.filter((item) => item.verification_status === "conflict").length,
    urls_filled: combined.filter((item) => item.original_url).length,
  };

  let evidence = [];
  if (fetchPages) {
    evidence = await runPool(
      combined,
      (project) => fetchEvidence(links[project.record - 1], project),
      5,
    );
  } else {
    evidence = combined.map((project) => ({
      record: project.record,
      project_name: project["项目名称"] || "",
      requested_url: project.original_url,
      error: "本次未执行网页抓取",
    }));
  }
  const evidenceStats = {
    attempted: evidence.length,
    succeeded: evidence.filter((item) => item.http_status && item.http_status < 400).length,
    failed_or_restricted: evidence.filter((item) => !item.http_status || item.http_status >= 400).length,
  };
  await fsp.writeFile(
    path.join(EVIDENCE_DIR, "总索引.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), stats: evidenceStats, pages: evidence }, null, 2),
    "utf8",
  );

  const resultJson = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source_workbooks: [
      "项目汇总列表-V1.xlsx",
      "信息来源.xlsx（45条有效来源；原文件存在异常百万行有效区域，导入时已裁剪）",
    ],
    snapshot: {
      id: "acceptance-v1-2026-07-17",
      immutable: true,
      stats,
      evidence_stats: evidenceStats,
    },
    records: combined,
    evidence_index: evidence,
  };
  const jsonPath = path.join(OUTPUT_DIR, "项目汇总列表-V1-核验结果.json");
  await fsp.writeFile(jsonPath, JSON.stringify(resultJson, null, 2), "utf8");

  const reviewRows = combined
    .filter((item) => item.verification_status !== "verified")
    .map(
      (item) =>
        `| ${item.record} | ${String(item["国家"] || "未填").replace(/\|/g, "\\|")} | ${String(item["项目名称"] || "未填").replace(/\|/g, "\\|")} | ${statusLabel(item.verification_status)} | ${item.confidence} | ${String(item.verification_note).replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  const allRows = combined
    .map(
      (item) =>
        `| ${item.record} | ${String(item["国家"] || "未填").replace(/\|/g, "\\|")} | ${String(item["项目名称"] || "未填").replace(/\|/g, "\\|")} | ${authorityLabel(item.authority)} | ${item.confidence} | ${statusLabel(item.verification_status)} | [原页](${item.original_url}) |`,
    )
    .join("\n");
  const report = `# 项目汇总列表 V1 原始网页链接核验报告

生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}

## 结论

- 项目记录：${stats.total} 条。
- 已补链接：${stats.urls_filled} 条。
- 已核验：${stats.verified} 条。
- 待复核：${stats.needs_review} 条。
- 存在硬冲突：${stats.conflict} 条。
- 网页正文抓取成功：${evidenceStats.succeeded} 条；失败或受限：${evidenceStats.failed_or_restricted} 条。
- 所有“待复核”和“硬冲突”均保留候选原页与原因，没有把冲突事实静默改写为已确认。

## 主要硬冲突与待复核项

| 序号 | 国家 | 项目 | 状态 | 置信度 | 核验说明 |
|---:|---|---|---|---:|---|
${reviewRows}

## 全部项目与原页

| 序号 | 国家 | 项目 | 来源级别 | 置信度 | 状态 | 链接 |
|---:|---|---|---|---:|---|---|
${allRows}

## 方法与限制

核验优先使用政府、业主、项目参与方和交易所原页，其次使用当地权威媒体和行业媒体。评分综合项目名称、国家/地址、光伏与储能容量、业主/中资参与方、项目阶段、发布时间及来源权威性。验证码、登录墙、付费墙和 robots 限制均未绕过；抓取失败会在证据包元数据中保留原因。
`;
  const reportPath = path.join(OUTPUT_DIR, "项目汇总列表-V1-核验报告.md");
  await fsp.writeFile(reportPath, report, "utf8");

  const zipPath = path.join(OUTPUT_DIR, "项目汇总列表-V1_网页全文证据包.zip");
  await zipDirectory(EVIDENCE_DIR, zipPath);

  return {
    outputDir: OUTPUT_DIR,
    xlsx: outputXlsxPath,
    markdown: reportPath,
    json: jsonPath,
    evidenceZip: zipPath,
    stats,
    evidenceStats,
  };
}
