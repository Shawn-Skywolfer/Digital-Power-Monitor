import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test, { after, before } from "node:test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-p0-"));
process.env.DPM_DATA_DIR = testDataDir;

let origin = "";
let server: http.Server;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("Content-Type", pathname.endsWith(".xml") ? "application/xml" : "text/html; charset=utf-8");
    if (pathname === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end(`User-agent: *\nSitemap: ${origin}/sitemap.xml`);
    } else if (pathname === "/sitemap.xml") {
      response.end(`<?xml version="1.0"?><urlset>
        <url><loc>${origin}/dynamic-project</loc><lastmod>2026-07-10</lastmod></url>
        <url><loc>${origin}/old-story</loc><lastmod>2024-01-01</lastmod></url>
      </urlset>`);
    } else if (pathname === "/dynamic-project") {
      response.end(`<!doctype html><html><head>
        <meta property="article:published_time" content="2026-07-10">
        <title>Alpha Solar Project reaches construction</title></head>
        <body><div id="root"></div><script>
          setTimeout(() => { document.querySelector("#root").innerHTML =
            "<article><h1>Alpha Solar Project</h1><p>The 120 MW Alpha solar project in Spain has started construction for owner SolCo. This is a concrete renewable energy project with grid connection planned next year.</p></article>";
          }, 50);
        </script></body></html>`);
    } else if (pathname === "/old-story") {
      response.end(`<article><time datetime="2024-01-01"></time><h1>Old project</h1><p>100 MW solar project.</p></article>`);
    } else if (pathname === "/blocked") {
      response.statusCode = 403;
      response.end(`<html><head><title>Access Denied</title></head><body><h1>Access denied</h1><p>Request has been blocked.</p></body></html>`);
    } else {
      response.end(`<html><body><a href="/news">News</a></body></html>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const { closeCrawlerBrowser } = await import("../server/crawler");
  await closeCrawlerBrowser();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { db } = await import("../server/db");
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("discovers date-bounded sitemap content and renders dynamic article text", async () => {
  const { dateStatusFor, discoverSourcePages, fetchDocument, ruleProjectLikelihood } =
    await import("../server/crawler");
  const source = {
    id: "source-1", name: "Test", type: "dynamic", coverage: "", url: origin,
    country: "", enabled: true, rateLimitMs: 0,
  };
  const discovery = await discoverSourcePages(source, "2026-07-01", "2026-07-31", 20);
  assert.ok(discovery.pages.some((page) => page.url === `${origin}/dynamic-project`));
  assert.ok(!discovery.pages.some((page) => page.url === `${origin}/old-story`));
  assert.ok(discovery.strategies.includes("sitemap"));

  const document = await fetchDocument(`${origin}/dynamic-project`, source.id, "sitemap", true);
  document.dateStatus = dateStatusFor(document, "2026-07-01", "2026-07-31");
  assert.equal(document.error, undefined);
  assert.equal(document.fetchMode, "browser");
  assert.equal(document.rendered, true);
  assert.equal(document.dateStatus, "within_range");
  assert.match(document.text, /120 MW Alpha solar project/);
  assert.equal(ruleProjectLikelihood(document).isProject, true);
});

test("merges two article mentions into one project with two source links", async () => {
  const [{ db, listFields }, { saveAssessment }] = await Promise.all([
    import("../server/db"), import("../server/projects"),
  ]);
  const { fetchDocument, dateStatusFor } = await import("../server/crawler");
  const first = await fetchDocument(`${origin}/dynamic-project`, "source-1", "sitemap", true);
  const second = { ...first, id: crypto.randomUUID(), url: `${origin}/dynamic-project?followup=1`, canonicalUrl: `${origin}/dynamic-project?followup=1` };
  first.dateStatus = dateStatusFor(first, "2026-07-01", "2026-07-31");
  const fields = listFields();
  const mention = {
    classification: "project_report" as const,
    confidence: 0.9,
    reasoning: "test",
    mentions: [{
      confidence: 0.9,
      fields: { project_name: "Alpha Solar Project", country: "Spain", pv_capacity_mw: 120, owner: "SolCo", published_month: "2026-07-10" },
      evidence: { project_name: "Alpha Solar Project", pv_capacity_mw: "120 MW", owner: "owner SolCo" },
    }],
  };
  const scanId = crypto.randomUUID();
  saveAssessment(scanId, first, mention, fields, origin, false);
  saveAssessment(scanId, second, mention, fields, origin, false);
  const projects = db.prepare("SELECT * FROM projects WHERE scan_id=?").all(scanId);
  assert.equal(projects.length, 1);
  const projectId = String((projects[0] as { id: string }).id);
  const sources = db.prepare("SELECT * FROM project_sources WHERE project_id=?").all(projectId);
  assert.equal(sources.length, 2);
});

test("rejects company homepages and synthesizes a missing project name from core fields", async () => {
  const [{ ruleProjectLikelihood }, { synthesizeProjectName }] = await Promise.all([
    import("../server/crawler"), import("../server/projects"),
  ]);
  const homepage = {
    pageType: "homepage", title: "中国广核集团有限公司", text: "中国广核集团有限公司 200 MW 光伏 储能 项目 新闻 中标",
  } as Parameters<typeof ruleProjectLikelihood>[0];
  assert.equal(ruleProjectLikelihood(homepage).isProject, false);
  assert.equal(synthesizeProjectName({
    chinese_client: "中国能建", country: "沙特", storage_capacity_mwh: 1000, project_type: "光伏配储",
  }), "中国能建+沙特+1GWh+光伏配储");
});

test("normalizes source units and blocks implausible storage magnitudes", async () => {
  const [{ normalizeMeasurementFields, extractQuantities }, { listFields }] = await Promise.all([
    import("../server/units"), import("../server/db"),
  ]);
  assert.deepEqual(extractQuantities("项目配置500千瓦/5吉瓦时储能").map((item) => item.unit), ["kW", "GWh"]);
  const corrected = normalizeMeasurementFields(
    { storage_capacity_mwh: 5_000_000, storage_power_mw: 500 }, listFields(),
    { storage_capacity_mwh: "5 GWh", storage_power_mw: "500 kW" },
    { storage_capacity_mwh: "a 5 GWh battery", storage_power_mw: "rated at 500 kW" },
  );
  assert.equal(corrected.fields.storage_capacity_mwh, 5_000);
  assert.equal(corrected.fields.storage_power_mw, 0.5);
  assert.match(corrected.checks.storage_capacity_mwh, /修正模型值 5000000 MWh/);

  const blocked = normalizeMeasurementFields(
    { storage_capacity_mwh: 5_000_000 }, listFields(),
    { storage_capacity_mwh: "5,000,000 MWh" }, { storage_capacity_mwh: "5,000,000 MWh storage system" },
  );
  assert.equal(blocked.fields.storage_capacity_mwh, null);
  assert.match(blocked.checks.storage_capacity_mwh, /数量级异常/);
});

test("persists translated fields with original-language evidence", async () => {
  const [{ db, listFields }, { mapProject, saveAssessment }] = await Promise.all([
    import("../server/db"), import("../server/projects"),
  ]);
  const scanId = crypto.randomUUID();
  const document = {
    id: crypto.randomUUID(), url: `${origin}/english-project`, canonicalUrl: `${origin}/english-project`,
    title: "Orion Battery Project", publishedAt: "2026-07-11", fetchedAt: new Date().toISOString(),
    contentType: "text/html", statusCode: 200, hash: "bilingual", text: "The 5 GWh Orion Battery Project in Spain reached financial close.",
    markdown: "", rawPath: "", markdownPath: "", sourceId: "source-1", dateCandidates: ["2026-07-11"],
    dateStatus: "within_range", dateEvidence: "2026-07-11", fetchMode: "static", rendered: false,
    warnings: [], pageType: "article", extractionMethod: "test", attemptCount: 1,
  } as const;
  const assessment = {
    classification: "project_report" as const, confidence: 0.95, reasoning: "test", sourceLanguage: "en",
    mentions: [{ confidence: 0.95,
      fields: { project_name: "猎户座储能项目", country: "西班牙", storage_capacity_mwh: 5_000_000, published_month: "2026-07-11" },
      originalFields: { project_name: "Orion Battery Project", country: "Spain", storage_capacity_mwh: "5 GWh", published_month: "2026-07-11" },
      evidence: { project_name: "The 5 GWh Orion Battery Project", country: "in Spain", storage_capacity_mwh: "5 GWh" },
      evidenceTranslations: { project_name: "5吉瓦时猎户座储能项目", country: "位于西班牙", storage_capacity_mwh: "5吉瓦时" },
    }],
  };
  const [projectId] = saveAssessment(scanId, document, assessment, listFields(), origin, true);
  const row = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Record<string, unknown>;
  const project = mapProject(row);
  assert.equal(project.fields.storage_capacity_mwh, 5_000);
  assert.equal(project.originalFields?.project_name, "Orion Battery Project");
  assert.equal(project.sourceLanguage, "en");
  assert.match(project.evidenceTranslations?.project_name ?? "", /猎户座储能项目/);
});

test("does not treat a browser-rendered Access Denied page as a successful document", async () => {
  const { detectAccessBlock, fetchDocument } = await import("../server/crawler");
  assert.equal(detectAccessBlock(403, "Access Denied", "Request blocked")?.code, "ACCESS_DENIED");
  const document = await fetchDocument(`${origin}/blocked`, "source-1", "page-link");
  assert.equal(document.failureCode, "ACCESS_DENIED");
  assert.match(document.error ?? "", /阻断特征|HTTP 403/);
});

test("allows dated article-like unknown pages into deterministic project assessment", async () => {
  const { ruleProjectLikelihood } = await import("../server/crawler");
  const document = {
    url: "https://example.test/project/alpha", pageType: "unknown", publishedAt: "2026-07-20",
    title: "Alpha 项目开工", text: `${"正文".repeat(200)} 120 MW 光伏项目已开工并签署 EPC 合同`,
  } as Parameters<typeof ruleProjectLikelihood>[0];
  const likelihood = ruleProjectLikelihood(document);
  assert.equal(likelihood.eligiblePage, true);
  assert.equal(likelihood.isProject, true);
});

test("reports a useful message when a model catalog cannot be reached", async () => {
  const { listProviderModels } = await import("../server/providers");
  await assert.rejects(
    () => listProviderModels({
      id: "unreachable-provider",
      name: "Unreachable",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      headers: {},
      config: { timeoutMs: 500 },
      enabled: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /无法连接远端服务/);
      assert.match(error.message, /检查网络、代理、DNS 和 Base URL/);
      assert.doesNotMatch(error.message, /^fetch failed$/i);
      return true;
    },
  );
});

test("turns Firecrawl markdown into an auditable crawled document", async () => {
  const { documentFromExternalContent, dateStatusFor } = await import("../server/crawler");
  const document = documentFromExternalContent({
    url: "https://example.test/news/2026/project", sourceId: "source-firecrawl", provider: "Firecrawl",
    title: "Atlas Solar Project reaches financial close", publishedAt: "2026-08-03",
    markdown: "The 320 MW Atlas Solar Project in Oman reached financial close and will start construction this year.",
    statusCode: 200,
  });
  document.dateStatus = dateStatusFor(document, "2026-08-01", "2026-08-31");
  assert.equal(document.dateStatus, "within_range");
  assert.equal(document.discoveryMethod, "mcp");
  assert.equal(document.error, undefined);
  assert.match(document.warnings.join(" "), /Firecrawl/);
  assert.ok(fs.existsSync(document.rawPath));
});
