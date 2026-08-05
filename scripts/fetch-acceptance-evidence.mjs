import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import archiver from "archiver";
import * as cheerio from "cheerio";

const ROOT = "C:/Users/perfe/Documents/Digital-Power-Monitor";
const OUTPUT_DIR = path.join(ROOT, "outputs/acceptance");
const JSON_PATH = path.join(OUTPUT_DIR, "项目汇总列表-V1-核验结果.json");
const REPORT_PATH = path.join(OUTPUT_DIR, "项目汇总列表-V1-核验报告.md");
const EVIDENCE_DIR = path.join(OUTPUT_DIR, "网页全文证据包");
const ZIP_PATH = path.join(OUTPUT_DIR, "项目汇总列表-V1_网页全文证据包.zip");

function safeName(value) {
  return String(value || "未命名")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 48);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function decodeBody(bytes, contentType) {
  const declared = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.trim();
  for (const encoding of [declared, "utf-8"].filter(Boolean)) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      // Try the next encoding.
    }
  }
  return Buffer.from(bytes).toString("utf8");
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

async function fetchWithTimeout(url, timeoutMs = 25000) {
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

async function fetchOne(project) {
  const folderName = `${String(project.record).padStart(3, "0")}-${safeName(project["项目名称"] || project["国家"])}`;
  const folder = path.join(EVIDENCE_DIR, folderName);
  await fsp.mkdir(folder, { recursive: true });
  const metadata = {
    record: project.record,
    project_name: project["项目名称"] || "",
    country: project["国家"] || "",
    requested_url: project.original_url,
    final_url: project.original_url,
    fetched_at: new Date().toISOString(),
    http_status: null,
    content_type: "",
    sha256: "",
    raw_file: "",
    markdown_file: "cleaned.md",
    error: "",
  };
  try {
    const response = await fetchWithTimeout(project.original_url);
    metadata.final_url = response.url || project.original_url;
    metadata.http_status = response.status;
    metadata.content_type = response.headers.get("content-type") || "";
    const bytes = Buffer.from(await response.arrayBuffer());
    metadata.sha256 = sha256(bytes);
    if (metadata.content_type.toLowerCase().includes("pdf") || /\.pdf(?:$|\?)/i.test(metadata.final_url)) {
      metadata.raw_file = "raw.pdf";
      await fsp.writeFile(path.join(folder, "raw.pdf"), bytes);
      await fsp.writeFile(
        path.join(folder, "cleaned.md"),
        `# ${project.source_title}\n\n- 原始链接：${project.original_url}\n- 最终链接：${metadata.final_url}\n- HTTP 状态：${response.status}\n- SHA-256：${metadata.sha256}\n\n该页面为 PDF，原始文件已完整保存在同目录。\n`,
        "utf8",
      );
    } else {
      metadata.raw_file = "raw.html";
      await fsp.writeFile(path.join(folder, "raw.html"), bytes);
      const cleaned = htmlToMarkdown(decodeBody(bytes, metadata.content_type), metadata.final_url);
      metadata.page_title = cleaned.title;
      metadata.published_at = cleaned.published;
      await fsp.writeFile(path.join(folder, "cleaned.md"), cleaned.markdown, "utf8");
    }
    if (!response.ok) metadata.error = `HTTP ${response.status}`;
  } catch (error) {
    metadata.error = error instanceof Error ? error.message : String(error);
    await fsp.writeFile(
      path.join(folder, "cleaned.md"),
      `# 抓取失败记录\n\n- 原始链接：${project.original_url}\n- 抓取时间：${metadata.fetched_at}\n- 失败原因：${metadata.error}\n\n应用未绕过登录、验证码、付费墙或站点访问限制。\n`,
      "utf8",
    );
  }
  await fsp.writeFile(path.join(folder, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

async function runPool(items, concurrency = 5) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fetchOne(items[index]);
      process.stdout.write(`\r网页证据 ${index + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
  process.stdout.write("\n");
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

const result = JSON.parse(await fsp.readFile(JSON_PATH, "utf8"));
await fsp.rm(EVIDENCE_DIR, { recursive: true, force: true });
await fsp.mkdir(EVIDENCE_DIR, { recursive: true });
const evidence = await runPool(result.records, 5);
const evidenceStats = {
  attempted: evidence.length,
  succeeded: evidence.filter((item) => item.http_status && item.http_status < 400).length,
  failed_or_restricted: evidence.filter((item) => !item.http_status || item.http_status >= 400).length,
};
result.snapshot.evidence_stats = evidenceStats;
result.evidence_index = evidence;
await fsp.writeFile(JSON_PATH, JSON.stringify(result, null, 2), "utf8");
await fsp.writeFile(
  path.join(EVIDENCE_DIR, "总索引.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), stats: evidenceStats, pages: evidence }, null, 2),
  "utf8",
);
let report = await fsp.readFile(REPORT_PATH, "utf8");
report = report.replace(
  /- 网页正文抓取成功：\d+ 条；失败或受限：\d+ 条。/,
  `- 网页正文抓取成功：${evidenceStats.succeeded} 条；失败或受限：${evidenceStats.failed_or_restricted} 条。`,
);
await fsp.writeFile(REPORT_PATH, report, "utf8");
await zipDirectory(EVIDENCE_DIR, ZIP_PATH);
console.log(JSON.stringify(evidenceStats));
