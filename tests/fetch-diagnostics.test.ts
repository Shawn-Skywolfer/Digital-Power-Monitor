import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-fetchdiag-"));
process.env.DPM_DATA_DIR = testDataDir;

let origin = "";
let server: http.Server;

const DIRTY_TITLE_PAGE = `<!doctype html><html><head>
  <meta property="og:title" content="CGN Energy International Holdings Co., Limited_<p class=&quot;MsoNormal&quot;>Al Dhafra 1500 MW solar project reaches full operation</p>">
  <meta property="article:published_time" content="2026-06-15">
  <title>fallback title</title></head>
  <body><article><h1>Al Dhafra milestone</h1>
  <p>The 1500 MW Al Dhafra solar project in the United Arab Emirates has reached full commercial operation.
  Owner EWEC confirmed the renewable energy project is now feeding the grid at full capacity, making it one of the largest single-site solar plants in the world.</p>
  <p>Construction began three years ago and the project uses bifacial modules with single-axis tracking.</p>
  <a href="/news/a">更多报道</a><a href="/news/b">项目列表</a><a href="/news/c">公司动态</a><a href="/news/d">联系方式</a>
  </article></body></html>`;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("Content-Type", pathname === "/robots.txt" ? "text/plain" : "text/html; charset=utf-8");
    if (pathname === "/robots.txt") response.end("User-agent: *\n");
    else if (pathname === "/dirty-title") response.end(DIRTY_TITLE_PAGE);
    else { response.statusCode = 404; response.end("not found"); }
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

test("strips embedded markup from og:title", async () => {
  const { fetchDocument } = await import("../server/crawler");
  const document = await fetchDocument(`${origin}/dirty-title`, "source-t", "page-link");
  assert.equal(document.error, undefined);
  assert.doesNotMatch(document.title, /<[a-zA-Z]/, "标题不应残留 HTML 标签");
  assert.match(document.title, /Al Dhafra 1500 MW solar project/);
});

test("detectTunFakeIp is false for normal hosts and unresolvable names", async () => {
  const { detectTunFakeIp } = await import("../server/crawler");
  assert.equal(await detectTunFakeIp("localhost"), false, "localhost 解析到 127.0.0.1，不是 Fake-IP");
  assert.equal(await detectTunFakeIp("nonexistent-host.invalid"), false, "解析失败不应误判为 Fake-IP");
});

test("resolveStdioCommand converts npx to a node-launchable shim when available", async () => {
  const { resolveStdioCommand } = await import("../server/mcp");
  const resolved = resolveStdioCommand("npx", ["-y", "firecrawl-mcp"]);
  const npxCli = path.resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (fs.existsSync(npxCli)) {
    assert.equal(resolved.command, process.execPath, "应通过 node 拉起 npx-cli.js 而不是直接 spawn npx");
    assert.ok(resolved.args.some((arg) => arg.endsWith("npx-cli.js")));
    assert.ok(resolved.args.includes("firecrawl-mcp"));
  } else {
    assert.equal(resolved.command, "npx");
  }
});

test("resolveStdioCommand strips -y only for the pnpm shim", async () => {
  const { resolveStdioCommand } = await import("../server/mcp");
  const resolved = resolveStdioCommand("npx", ["-y", "some-package"]);
  if (resolved.command === process.execPath && resolved.args.some((arg) => arg.includes("pnpm"))) {
    assert.ok(!resolved.args.includes("-y"), "pnpm dlx 路径应去掉 -y");
  }
  const other = resolveStdioCommand("python", ["server.py"]);
  assert.deepEqual(other, { command: "python", args: ["server.py"], label: "python server.py" });
});
