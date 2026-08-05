import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the monitoring workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>海外能源雷达 · Digital Power Monitor<\/title>/i);
  assert.match(html, /海外能源雷达/);
  assert.match(html, /新建监测/);
  assert.match(html, /大模型/);
  assert.match(html, /MCP/);
  assert.match(html, /Skill 策略/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/i);
});

test("ships the product UI and local service contract", async () => {
  const [page, layout, packageJson, skill, openaiYaml, serverIndex] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../skills/scan-overseas-energy-projects/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/scan-overseas-energy-projects/agents/openai.yaml", import.meta.url), "utf8"),
    readFile(new URL("../server/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /选择字段/);
  assert.match(page, /时间范围/);
  assert.match(page, /监测来源/);
  assert.match(page, /能力组合/);
  assert.match(page, /预算与确认/);
  assert.match(page, /二次深度扩散/);
  assert.match(page, /查看本次诊断证据/);
  assert.match(page, /应用到 Skill/);
  assert.match(page, /文件写入校验失败/);
  assert.match(page, /修改信息源/);
  assert.match(page, /检测中/);
  assert.match(page, /查看完整错误/);
  assert.match(page, /MCP 连接与目录检测通过/);
  assert.match(layout, /title:\s*"海外能源雷达 · Digital Power Monitor"/);
  assert.match(packageJson, /"start:api": "tsx server\/index\.ts"/);
  assert.match(skill, /name: scan-overseas-energy-projects/);
  assert.match(openaiYaml, /display_name: "海外能源项目监测"/);
  assert.match(serverIndex, /cleanupExportStaging/);
  assert.match(serverIndex, /reviewRetrievalSkillIteration/);
});
