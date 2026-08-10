import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-antistall-"));
process.env.DPM_DATA_DIR = testDataDir;

let origin = "";
let server: http.Server;

const ARTICLE = `<!doctype html><html><head><meta property="article:published_time" content="2026-04-12">
<title>乌兹别克斯坦光伏项目</title></head><body><article><h1>乌兹别克斯坦光伏项目</h1>
<p>The 300 MW solar project in Uzbekistan signed an EPC contract with a Chinese contractor in April 2026. The renewable energy plant will start construction this year and connect to the grid next year.</p>
<a href="/news/a">更多</a><a href="/news/b">列表</a><a href="/news/c">动态</a></article></body></html>`;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      return void response.end("User-agent: *\nDisallow: /private/\n");
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    // JS 壳页面：触发浏览器渲染路径
    if (pathname === "/spa") return void response.end(`<html><body><div id="root"></div><script>while(true){}</script></body></html>`);
    // 200 伪装的反爬挑战页
    if (pathname === "/challenge") return void response.end(`<html><body><p>Checking your browser, just a moment...</p></body></html>`);
    if (pathname === "/article" || pathname === "/private/article") return void response.end(ARTICLE);
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const crawler = await import("../server/crawler");
  crawler.setIgnoreRobots(false);
  crawler.__setBackendRendererForTests("local", null);
  crawler.__setRenderWatchdogForTests(null);
  crawler.__resetRenderCircuitForTests();
  await crawler.closeCrawlerBrowser();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { db } = await import("../server/db");
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("render watchdog: hanging renderer rejects and page fetch completes with warning", async () => {
  const crawler = await import("../server/crawler");
  crawler.__setRenderWatchdogForTests(300);
  crawler.__setBackendRendererForTests("local", () => new Promise(() => {})); // 永不返回，模拟卡死的浏览器
  const started = Date.now();
  const document = await crawler.fetchDocument(`${origin}/spa`, "source-w", "page-link");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `看门狗应快速兜底，实际耗时 ${elapsed}ms`);
  assert.equal(document.error, undefined, "静态壳页面仍应归档成功");
  assert.ok(
    document.warnings.some((warning) => warning.includes("动态渲染失败") && warning.includes("看门狗")),
    `应记录看门狗告警，实际：${document.warnings.join(" | ")}`,
  );
});

test("robots.txt policy: denied by default, fetched when ignoreRobots enabled", async () => {
  const crawler = await import("../server/crawler");
  crawler.setIgnoreRobots(false);
  const denied = await crawler.fetchDocument(`${origin}/private/article`, "source-r", "page-link");
  assert.equal(denied.failureCode, "ROBOTS_DENIED");
  crawler.setIgnoreRobots(true);
  const allowed = await crawler.fetchDocument(`${origin}/private/article`, "source-r", "page-link");
  assert.equal(allowed.error, undefined);
  assert.match(allowed.text, /300 MW solar project/);
  crawler.setIgnoreRobots(false);
});

test("anti-bot challenge page (200) automatically escalates to browser rendering", async () => {
  const crawler = await import("../server/crawler");
  crawler.__resetRenderCircuitForTests(); // 前序用例的渲染失败会让熔断器计数，这里显式复位
  let renderCalls = 0;
  crawler.__setBackendRendererForTests("local", async (url) => {
    renderCalls++;
    return { html: ARTICLE, url, statusCode: 200, backend: "local" as const };
  });
  const document = await crawler.fetchDocument(`${origin}/challenge`, "source-b", "page-link");
  assert.equal(renderCalls, 1, `命中挑战特征应触发一次浏览器渲染（error=${document.error} warnings=${document.warnings.join("|")}）`);
  assert.equal(document.error, undefined);
  assert.equal(document.rendered, true);
  assert.match(document.text, /300 MW solar project/);
});

test("render circuit breaker: origin stops paying render cost after repeated failures", async () => {
  const crawler = await import("../server/crawler");
  crawler.__resetRenderCircuitForTests();
  let renderCalls = 0;
  crawler.__setBackendRendererForTests("local", async () => {
    renderCalls++;
    throw new Error("模拟渲染失败");
  });
  await crawler.fetchDocument(`${origin}/spa`, "source-c", "page-link");
  await crawler.fetchDocument(`${origin}/spa`, "source-c", "page-link");
  assert.equal(renderCalls, 2, "前两次渲染应真实尝试");
  const third = await crawler.fetchDocument(`${origin}/spa`, "source-c", "page-link");
  assert.equal(renderCalls, 2, "熔断后不再尝试渲染");
  assert.ok(
    third.warnings.some((warning) => warning.includes("熔断")),
    `第三次应记录熔断告警，实际：${third.warnings.join(" | ")}`,
  );
  crawler.__resetRenderCircuitForTests();
});
