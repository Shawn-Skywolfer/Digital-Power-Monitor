import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { FieldDefinition } from "../server/types";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-project-intel-"));
process.env.DPM_DATA_DIR = testDataDir;

const projectIntel = await import("../server/project-intel");

test("Project Intel 分页器按 recorded_at 过滤并在跨过开始日期后停止", async () => {
  const pages = [
    [
      { _index: "new", project_name: "八月项目", recorded_at: "2026-08-11 10:00:00" },
      { _index: "in-range", project_name: "月初项目", recorded_at: "2026-08-03 09:00:00" },
    ],
    [
      { _index: "old", project_name: "七月项目", recorded_at: "2026-07-31 23:59:59" },
      { _index: "older", project_name: "更早项目", recorded_at: "2026-07-01 00:00:00" },
    ],
  ];
  const requested: string[] = [];
  const result = await projectIntel.fetchProjectIntelRecords({
    startDate: "2026-08-01", endDate: "2026-08-31", maxRecords: 50, pageSize: 2,
    delay: async () => undefined,
    fetchImpl: async (input) => {
      const url = new URL(input);
      requested.push(url.toString());
      const page = Number(url.searchParams.get("current"));
      return new Response(JSON.stringify({ code: 200, data: { records: pages[page - 1] ?? [], total: 4 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result.records.map((record) => record._index), ["new", "in-range"]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(requested.length, 2);
  assert.equal(result.truncated, false);
});

test("Project Intel 对 429 执行退避后重试", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await projectIntel.fetchProjectIntelRecords({
    startDate: "2026-08-01", endDate: "2026-08-31", maxRecords: 1,
    delay: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) return new Response("limited", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({ code: 200, data: {
        records: [{ _index: "ok", project_name: "成功项目", recorded_at: "2026-08-10" }], total: 1,
      } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
  assert.equal(result.records.length, 1);
});

test("Project Intel 默认网络传输可读取真实 HTTP JSON 响应", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ code: 200, data: {
      records: [{ _index: "local", project_name: "本地传输测试", recorded_at: "2026-08-08" }], total: 1,
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await projectIntel.fetchProjectIntelRecords({
      startDate: "2026-08-01", endDate: "2026-08-31", maxRecords: 1,
      endpoint: `http://127.0.0.1:${address.port}/api/project-intel/list`,
    });
    assert.equal(result.records[0]._index, "local");
    assert.equal(result.pagesFetched, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Project Intel 记录映射为文档与结构化项目字段", () => {
  const record = {
    _index: "solar-storage-1", project_name: "海湾光储一体化项目", country: "阿联酋", region: "中东",
    industry: "光储", capacity: "100 MW / 200 MWh", location: "阿布扎比",
    stage: "建设中", developer_display: "Example Energy", epc_contractor_display: "Example EPC",
    chinese_involvement: "中国能建", content: "项目正在建设。", recorded_at: "2026-08-09 12:30:00",
  };
  const fields: FieldDefinition[] = [
    ["country", "国家", "text", true], ["project_name", "项目名称", "text", true],
    ["pv_capacity_mw", "光伏容量", "number", false], ["storage_capacity_mwh", "储能容量", "number", false],
    ["storage_power_mw", "储能功率", "number", false], ["owner", "业主", "text", false],
    ["address", "地址", "text", false], ["published_month", "报道时间", "date", true],
    ["chinese_client", "中资客户", "text", false], ["progress", "项目进展", "text", false],
    ["project_type", "项目类型", "text", false], ["developer", "开发商", "text", false],
    ["epc", "EPC方", "text", false],
  ].map(([id, label, type, required], position) => ({
    id: String(id), label: String(label), type: type as FieldDefinition["type"], required: Boolean(required),
    aliases: [], position,
  }));
  const document = projectIntel.projectIntelRecordToDocument(record, "2026-08-01", "2026-08-31");
  const assessment = projectIntel.projectIntelRecordToAssessment(record, fields);
  const extracted = assessment.mentions[0].fields;
  assert.equal(document.dateStatus, "within_range");
  assert.equal(document.fetchMode, "static");
  assert.equal(document.extractionMethod, "project-intel-api");
  assert.match(document.warnings[0], /二手聚合信息/);
  assert.equal(extracted.pv_capacity_mw, 100);
  assert.equal(extracted.storage_power_mw, 100);
  assert.equal(extracted.storage_capacity_mwh, 200);
  assert.equal(extracted.owner, "Example Energy");
  assert.equal(extracted.published_month, "2026-08-09");
  assert.equal(extracted.epc, "Example EPC");
});
