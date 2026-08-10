import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test, { after, afterEach, before } from "node:test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-lightpanda-"));
process.env.DPM_DATA_DIR = testDataDir;
delete process.env.DPM_LIGHTPANDA_CDP_URL;
delete process.env.DPM_LIGHTPANDA_TOKEN;

const RENDERED_HTML = `<!doctype html><html><head>
  <meta property="article:published_time" content="2026-07-10">
  <title>Beta Wind Farm financing closed</title></head>
  <body><article><h1>Beta Wind Farm</h1><p>The 240 MW Beta wind farm project in Vietnam has closed financing with lender WindCo. Construction of the renewable energy project starts this year with commissioning planned for 2027.</p></article></body></html>`;

let origin = "";
let server: http.Server;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end("User-agent: *\n");
    } else if (pathname === "/js-required") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><title>JS page</title></head>
        <body><div id="root"></div><script>/* SPA renders client-side */</script></body></html>`);
    } else {
      response.statusCode = 404;
      response.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const { closeCrawlerBrowser, __setBackendRendererForTests } = await import("../server/crawler");
  __setBackendRendererForTests("local", null);
  __setBackendRendererForTests("lightpanda", null);
  await closeCrawlerBrowser();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { db } = await import("../server/db");
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

afterEach(async () => {
  const { __setBackendRendererForTests } = await import("../server/crawler");
  __setBackendRendererForTests("local", null);
  __setBackendRendererForTests("lightpanda", null);
  const { resetLightpanda, upsertBrowserRendering, LIGHTPANDA_VAULT_KEY } = await import("../server/lightpanda");
  const { vault } = await import("../server/vault");
  vault.remove(LIGHTPANDA_VAULT_KEY);
  upsertBrowserRendering({ enabled: false, endpoint: "", backendOrder: ["local", "lightpanda"], connectTimeoutMs: 8000 });
  await resetLightpanda();
  delete process.env.DPM_LIGHTPANDA_CDP_URL;
  delete process.env.DPM_LIGHTPANDA_TOKEN;
});

async function enableLightpanda(endpoint = "ws://127.0.0.1:9222", order: Array<"local" | "lightpanda"> = ["local", "lightpanda"]) {
  const { resetLightpanda, upsertBrowserRendering } = await import("../server/lightpanda");
  upsertBrowserRendering({ enabled: true, endpoint, backendOrder: order, connectTimeoutMs: 1000 });
  await resetLightpanda();
}

test("config resolution: defaults, env fallback, db wins over env", async () => {
  const { resolveLightpandaConfig, resetLightpanda, upsertBrowserRendering } = await import("../server/lightpanda");

  let config = resolveLightpandaConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.endpoint, "");
  assert.deepEqual(config.backendOrder, ["local", "lightpanda"]);
  assert.equal(config.source, "none");

  process.env.DPM_LIGHTPANDA_CDP_URL = "ws://127.0.0.1:9222";
  await resetLightpanda();
  config = resolveLightpandaConfig();
  assert.equal(config.endpoint, "ws://127.0.0.1:9222");
  assert.equal(config.source, "env");
  assert.equal(config.enabled, true, "env-only 配置应直接启用");

  upsertBrowserRendering({ enabled: false, endpoint: "ws://127.0.0.1:9223", backendOrder: ["local", "lightpanda"], connectTimeoutMs: 8000 });
  await resetLightpanda();
  config = resolveLightpandaConfig();
  assert.equal(config.endpoint, "ws://127.0.0.1:9223", "DB 端点应覆盖环境变量");
  assert.equal(config.source, "db");
  assert.equal(config.enabled, false, "设置行的 enabled 优先于 env");
});

test("cloud token appended once from vault and redacted helpers keep it out of payloads", async () => {
  const { resolveLightpandaConfig, resetLightpanda, upsertBrowserRendering, LIGHTPANDA_VAULT_KEY } = await import("../server/lightpanda");
  const { vault } = await import("../server/vault");

  upsertBrowserRendering({ enabled: true, endpoint: "wss://euwest.cloud.lightpanda.io/ws", backendOrder: ["local", "lightpanda"], connectTimeoutMs: 8000 });
  vault.set(LIGHTPANDA_VAULT_KEY, "secret-token-123");
  await resetLightpanda();
  const config = resolveLightpandaConfig();
  assert.match(config.endpoint, /token=secret-token-123/);
  assert.equal(config.hasToken, true);

  // 已在 URL 中的 token 不重复拼接
  upsertBrowserRendering({ enabled: true, endpoint: "wss://euwest.cloud.lightpanda.io/ws?token=inline-token", backendOrder: ["local", "lightpanda"], connectTimeoutMs: 8000 });
  await resetLightpanda();
  const inline = resolveLightpandaConfig();
  assert.equal((inline.endpoint.match(/token=/g) ?? []).length, 1);

  // http(s) 输入自动转 ws(s)
  upsertBrowserRendering({ enabled: true, endpoint: "https://euwest.cloud.lightpanda.io/ws", backendOrder: ["local", "lightpanda"], connectTimeoutMs: 8000 });
  await resetLightpanda();
  assert.match(resolveLightpandaConfig().endpoint, /^wss:\/\//);
});

test("backend order parsing: garbage falls back to default, unknown entries filtered", async () => {
  const { resolveLightpandaConfig, resetLightpanda } = await import("../server/lightpanda");
  const { db } = await import("../server/db");

  db.prepare(`INSERT OR REPLACE INTO browser_rendering (id, enabled, endpoint, backend_order_json, connect_timeout_ms, updated_at)
    VALUES ('default', 1, 'ws://127.0.0.1:9222', ?, 8000, ?)`).run("not json at all", new Date().toISOString());
  await resetLightpanda();
  assert.deepEqual(resolveLightpandaConfig().backendOrder, ["local", "lightpanda"]);

  db.prepare("UPDATE browser_rendering SET backend_order_json=? WHERE id='default'").run(JSON.stringify(["lightpanda", "bogus", "lightpanda"]));
  await resetLightpanda();
  assert.deepEqual(resolveLightpandaConfig().backendOrder, ["lightpanda"]);
});

test("chain fallback: local failure falls through to lightpanda renderer", async () => {
  const { __setBackendRendererForTests, fetchDocument } = await import("../server/crawler");
  const calls: string[] = [];
  __setBackendRendererForTests("local", async () => {
    calls.push("local");
    throw new Error("本机浏览器崩溃");
  });
  __setBackendRendererForTests("lightpanda", async (url) => {
    calls.push("lightpanda");
    return { html: RENDERED_HTML, url, statusCode: 200, backend: "lightpanda" };
  });
  await enableLightpanda();

  const document = await fetchDocument(`${origin}/js-required`, "source-t", "page-link", true);
  assert.deepEqual(calls, ["local", "lightpanda"]);
  assert.equal(document.error, undefined);
  assert.equal(document.rendered, true);
  assert.match(document.text, /240 MW Beta wind farm/);
  assert.ok(document.warnings.some((warning) => warning.includes("Lightpanda")));
  assert.match(document.markdown, /抓取方式：browser（lightpanda）/);
});

test("both backends failing degrades to static html with warning", async () => {
  const { __setBackendRendererForTests, fetchDocument } = await import("../server/crawler");
  const calls: string[] = [];
  __setBackendRendererForTests("local", async () => { calls.push("local"); throw new Error("local down"); });
  __setBackendRendererForTests("lightpanda", async () => { calls.push("lightpanda"); throw new Error("lightpanda down"); });
  await enableLightpanda();

  const document = await fetchDocument(`${origin}/js-required`, "source-t", "page-link", true);
  assert.deepEqual(calls, ["local", "lightpanda"]);
  assert.equal(document.fetchMode, "static");
  assert.equal(document.rendered, false);
  assert.ok(document.warnings.some((warning) => warning.includes("动态渲染失败")));
  assert.ok(document.warnings.some((warning) => warning.includes("local down")) || document.warnings.some((warning) => warning.includes("lightpanda down")));
});

test("disabled config never invokes the lightpanda backend", async () => {
  const { __setBackendRendererForTests, fetchDocument } = await import("../server/crawler");
  const calls: string[] = [];
  __setBackendRendererForTests("local", async (url) => {
    calls.push("local");
    return { html: RENDERED_HTML, url, statusCode: 200, backend: "local" };
  });
  __setBackendRendererForTests("lightpanda", async (url) => {
    calls.push("lightpanda");
    return { html: RENDERED_HTML, url, statusCode: 200, backend: "lightpanda" };
  });

  const document = await fetchDocument(`${origin}/js-required`, "source-t", "page-link", true);
  assert.deepEqual(calls, ["local"]);
  assert.equal(document.rendered, true);
  assert.match(document.markdown, /抓取方式：browser（local）/);
});

test("unreachable endpoint trips 60s circuit breaker", async () => {
  const { renderWithLightpanda } = await import("../server/lightpanda");
  await enableLightpanda("ws://127.0.0.1:1");

  const first = await renderWithLightpanda(`${origin}/js-required`).then(
    () => "", (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  assert.ok(first, "首次连接应失败");
  assert.doesNotMatch(first, /熔断/);

  const second = await renderWithLightpanda(`${origin}/js-required`).then(
    () => "", (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  assert.match(second, /熔断/, "熔断窗口内应直接拒绝而非再次连接");
});

test("probe reports ok:false with diagnosis for unreachable endpoint, ok:false for unconfigured", async () => {
  const { probeLightpanda } = await import("../server/lightpanda");

  const unconfigured = await probeLightpanda();
  assert.equal(unconfigured.ok, false);
  assert.match(unconfigured.error ?? "", /未配置/);

  const unreachable = await probeLightpanda({ endpoint: "ws://127.0.0.1:1" });
  assert.equal(unreachable.ok, false);
  assert.ok(unreachable.diagnosis, "应给出可执行的诊断建议");
  assert.match(unreachable.diagnosis ?? "", /WSL2|Docker|Cloud/);
});

test("closeLightpanda is safe with no active connection", async () => {
  const { closeLightpanda } = await import("../server/lightpanda");
  await closeLightpanda();
});
