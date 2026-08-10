import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-recall-"));
process.env.DPM_DATA_DIR = testDataDir;

let origin = "";
let server: http.Server;

const article = (title: string, body: string, date: string) => `<!doctype html><html><head>
  <meta property="article:published_time" content="${date}"><title>${title}</title></head>
  <body><article><h1>${title}</h1><p>${body}</p>
  <a href="/news">新闻</a><a href="/about">关于</a><a href="/contact">联系</a></article></body></html>`;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("Content-Type", pathname === "/robots.txt" ? "text/plain" : "text/html; charset=utf-8");
    if (pathname === "/robots.txt") return void response.end("User-agent: *\n");

    // 归档深翻夹具：page1 是 8 月稿，page2 是 4 月稿，page3 是 3 月稿
    if (pathname === "/news" || pathname === "/news/") {
      return void response.end(`<html><body>
        <a href="/news/2026/08/a1">2026-08-05 最新项目签约</a>
        <a href="/news/page/2">下一页</a>
        <a href="/x">其它</a><a href="/y">链接</a></body></html>`);
    }
    if (pathname === "/news/page/2") {
      return void response.end(`<html><body>
        <a href="/news/2026/04/p1">2026-04-10 四月海外光伏项目中标</a>
        <a href="/news/2026/04/p2">2026-04-15 四月储能项目开工</a>
        <a href="/news/page/3">下一页</a></body></html>`);
    }
    if (pathname === "/news/page/3") {
      return void response.end(`<html><body>
        <a href="/news/2026/03/q1">2026-03-02 三月旧闻</a></body></html>`);
    }
    if (pathname === "/news/2026/04/p1") {
      return void response.end(article("四月海外光伏项目中标", "The 200 MW solar project in Uzbekistan was awarded to a Chinese EPC contractor in April. Construction of the renewable energy plant starts this year with grid connection planned.", "2026-04-10"));
    }
    if (pathname === "/news/2026/04/p2") {
      return void response.end(article("四月储能项目开工", "The 100 MWh battery storage project broke ground in April. The facility will support the regional grid.", "2026-04-15"));
    }
    // 产品页夹具
    if (pathname === "/Case_details/15MW-PCS") {
      return void response.end(article("15MW PCS & 30MWh Microgrid Energy Storage System in Africa Mining", "Our 15MW PCS and 30MWh battery storage product powers mining microgrids. This containerised ESS product features BYD cells and outdoor cabinet design. Contact sales for pricing and datasheet.", "2026-04-20"));
    }
    response.statusCode = 404;
    response.end("not found");
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

test("date deep-flip: discovery reaches April articles behind newer listing pages", async () => {
  const { discoverSourcePages } = await import("../server/crawler");
  const source = { id: "s1", name: "Test", type: "网址", coverage: "", url: `${origin}/news`, country: "", enabled: true, rateLimitMs: 0 };
  const discovery = await discoverSourcePages(source, "2026-04-01", "2026-04-30", 20);
  const urls = discovery.pages.map((page) => page.url);
  assert.ok(urls.some((url) => url.includes("/news/2026/04/p1")), `应翻到 4 月文章 p1，实际：${urls.join(",")}`);
  assert.ok(urls.some((url) => url.includes("/news/2026/04/p2")), "应翻到 4 月文章 p2");
});

test("product/case pages are classified as non-project", async () => {
  const { fetchDocument, ruleProjectLikelihood } = await import("../server/crawler");
  const document = await fetchDocument(`${origin}/Case_details/15MW-PCS`, "s1", "page-link");
  const likelihood = ruleProjectLikelihood(document);
  assert.equal(likelihood.productPage, true, "应识别为产品页");
  assert.equal(likelihood.isProject, false, "产品页不应判为项目");
  assert.equal(likelihood.eligiblePage, false, "产品页不具备项目页资格");
});
