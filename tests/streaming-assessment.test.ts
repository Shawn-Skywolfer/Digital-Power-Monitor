import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// 集成测试：独立 API 端口 + 独立数据目录，不与本机 8765 开发实例冲突
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-stream-"));
process.env.DPM_DATA_DIR = testDataDir;
process.env.DPM_API_PORT = "18765";
const API = "http://127.0.0.1:18765";

let origin = "";
let fixture: http.Server;

const article = (title: string, body: string, date: string) => `<!doctype html><html><head>
  <meta property="article:published_time" content="${date}"><title>${title}</title></head>
  <body><article><h1>${title}</h1><p>${body}</p>
  <a href="/news/a">更多</a><a href="/news/b">列表</a><a href="/news/c">动态</a></article></body></html>`;

before(async () => {
  fixture = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      return void response.end(`User-agent: *\nSitemap: ${origin}/sitemap.xml`);
    }
    if (pathname === "/sitemap.xml") {
      response.setHeader("Content-Type", "application/xml");
      return void response.end(`<?xml version="1.0"?><urlset>
        <url><loc>${origin}/fast-project</loc><lastmod>2026-04-10</lastmod></url>
        <url><loc>${origin}/slow-project</loc><lastmod>2026-04-12</lastmod></url>
      </urlset>`);
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (pathname === "/fast-project") {
      return void response.end(article("乌兹别克斯坦300MW光伏项目签约",
        "The 300 MW solar project in Uzbekistan signed an EPC contract in April 2026. 中国能建承建该光伏项目，项目总投资约2亿美元，预计明年并网发电。",
        "2026-04-10"));
    }
    if (pathname === "/slow-project") {
      // 慢页面：拉长抓取阶段，让快页面的评估结果必须在任务完成前就可见
      return void setTimeout(() => {
        response.end(article("智利500MWh储能项目开工",
          "The 500 MWh battery storage project in Chile broke ground in April 2026. 天合光能参与供货，项目建成后将支撑当地电网调峰。",
          "2026-04-12"));
      }, 3_000);
    }
    response.end(`<html><body><a href="/sitemap.xml">sitemap</a></body></html>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  origin = `http://127.0.0.1:${address.port}`;

  const { db, now } = await import("../server/db");
  db.prepare("INSERT INTO sources (id,name,type,coverage,url,country,enabled,rate_limit_ms,created_at) VALUES (?,?,?,?,?,?,1,0,?)")
    .run("stream-src", "流式测试源", "网址", "", origin, "", now());
  await import("../server/index");
  // 等待 API 就绪
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("API 未能就绪");
});

after(async () => {
  const { closeCrawlerBrowser } = await import("../server/crawler");
  await closeCrawlerBrowser();
  await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
  const { db } = await import("../server/db");
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
  process.exit(0);
});

interface ScanState { id: string; status: string; progress: Record<string, unknown> }

async function createAprilScan() {
  const response = await fetch(`${API}/api/scans`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDate: "2026-04-01", endDate: "2026-04-30", sourceIds: ["stream-src"],
      budget: { maxPages: 10, maxSearches: 0, maxMinutes: 5, maxConcurrency: 1, maxCostUsd: 0 },
    }),
  });
  assert.equal(response.status, 202);
  return (await response.json()) as ScanState;
}

test("results stream into review view before the scan completes", async () => {
  const scan = await createAprilScan();
  let sawResultsWhileRunning = false;
  let finalStatus = "";
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = (await (await fetch(`${API}/api/scans/${scan.id}`)).json()) as ScanState;
    const results = (await (await fetch(`${API}/api/scans/${scan.id}/results`)).json()) as unknown[];
    if (state.status === "running" && results.length > 0) sawResultsWhileRunning = true;
    if (["completed", "failed", "stopped"].includes(state.status)) { finalStatus = state.status; break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(finalStatus, "completed");
  assert.ok(sawResultsWhileRunning, "抓取阶段进行中就应能在审核页看到已评估结果（流式评估）");
  const results = (await (await fetch(`${API}/api/scans/${scan.id}/results`)).json()) as { fields: Record<string, unknown> }[];
  assert.ok(results.length >= 2, `两个项目页面都应产出结果，实际 ${results.length}`);
});

test("assess-pending endpoint recovers assessments for interrupted scans", async () => {
  const scan = await createAprilScan();
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = (await (await fetch(`${API}/api/scans/${scan.id}`)).json()) as ScanState;
    if (["completed", "failed", "stopped"].includes(state.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // 模拟中断事故：评估与项目全部丢失，仅剩已抓正文（与 2026-08-10 停滞任务同构）
  const { db } = await import("../server/db");
  db.prepare("DELETE FROM project_mentions WHERE scan_id=?").run(scan.id);
  db.prepare("DELETE FROM project_sources WHERE project_id IN (SELECT id FROM projects WHERE scan_id=?)").run(scan.id);
  db.prepare("DELETE FROM projects WHERE scan_id=?").run(scan.id);
  db.prepare("DELETE FROM document_assessments WHERE scan_id=?").run(scan.id);
  const before = (await (await fetch(`${API}/api/scans/${scan.id}/results`)).json()) as unknown[];
  assert.equal(before.length, 0, "模拟事故后应为 0 结果");

  const kickoff = (await (await fetch(`${API}/api/scans/${scan.id}/assess-pending`, { method: "POST", body: "{}" })).json()) as
    { started: boolean; pending: number };
  assert.equal(kickoff.started, true);
  assert.ok(kickoff.pending >= 2, `应有至少 2 个待评页面，实际 ${kickoff.pending}`);
  // 补跑在后台执行，轮询直到结果恢复
  let restored = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = (await (await fetch(`${API}/api/scans/${scan.id}/results`)).json()) as unknown[];
    restored = current.length;
    if (restored >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(restored >= 2, `补跑后应恢复至少 2 条结果，实际 ${restored}`);
});

test("approve-all endpoint confirms every unresolved result in one audited operation", async () => {
  const scan = await createAprilScan();
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = (await (await fetch(`${API}/api/scans/${scan.id}`)).json()) as ScanState;
    if (["completed", "failed", "stopped"].includes(state.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const before = (await (await fetch(`${API}/api/scans/${scan.id}/results`)).json()) as Array<{ id: string; status: string }>;
  const unresolved = before.filter((result) => !["approved", "auto_approved"].includes(result.status));
  assert.ok(unresolved.length >= 1, "测试任务应至少包含一条尚未确认的结果");

  const response = await fetch(`${API}/api/scans/${scan.id}/approve-all`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  const outcome = (await response.json()) as { approved: number };
  assert.equal(outcome.approved, unresolved.length);
  const afterApproval = (await (await fetch(`${API}/api/scans/${scan.id}/results`)).json()) as Array<{ status: string }>;
  assert.ok(afterApproval.every((result) => ["approved", "auto_approved"].includes(result.status)));

  const second = await fetch(`${API}/api/scans/${scan.id}/approve-all`, { method: "POST", body: "{}" });
  assert.equal(((await second.json()) as { approved: number }).approved, 0, "重复操作应保持幂等");
  const { db } = await import("../server/db");
  const auditRow = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='scan' AND entity_id=? AND action='bulk_review'")
    .get(scan.id) as { count: number };
  assert.equal(auditRow.count, 2, "每次批量操作都应留下任务级审计记录");
});
