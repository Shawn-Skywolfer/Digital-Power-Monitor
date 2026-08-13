import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-wechat-export-"));
process.env.DPM_DATA_DIR = path.join(root, "data");

const { db, now } = await import("../server/db");
const { exportSnapshot } = await import("../server/exporter");

test("全文归档模式导出固定四列且不依赖项目结果", async () => {
  const timestamp = now();
  db.prepare("INSERT INTO sources (id,name,type,coverage,url,country,enabled,rate_limit_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("wx-source", "海外电力观察", "微信公众号", "", "wechat://ghid/gh_example", "", 1, 1000, timestamp);
  db.prepare("INSERT INTO scans (id,request_json,status,progress_json,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("wx-scan", JSON.stringify({ acquisitionMode: "wechat", wechat: { outputMode: "fulltext" } }), "completed", JSON.stringify({ fullTextSucceeded: 1 }), null, timestamp, timestamp);
  db.prepare(`INSERT INTO documents (id,scan_id,source_id,url,canonical_url,title,published_at,fetched_at,content_type,status_code,hash,text,markdown,raw_path,markdown_path,error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "wx-doc", "wx-scan", "wx-source", "https://mp.weixin.qq.com/s/example", "https://mp.weixin.qq.com/s/example",
      "示例文章", "2026-08-12", timestamp, "text/html", 200, "hash", "微信公众号：海外电力观察\n\n正文：\n这是文章正文。", "微信公众号：海外电力观察\n\n正文：\n这是文章正文。", "", "", null,
    );
  db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?,?)").run("wx-snapshot", "wx-scan", "[]", "[]", 0, timestamp);
  const outputDir = path.join(root, "output");
  const exported = await exportSnapshot("wx-snapshot", outputDir);
  assert.equal(Object.keys(exported.files).length, 4);
  const json = JSON.parse(fs.readFileSync(exported.files.json, "utf8")) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(json[0]), ["公众号账号", "发布日期", "文章标题", "正文"]);
  assert.deepEqual(json[0], { 公众号账号: "海外电力观察", 发布日期: "2026-08-12", 文章标题: "示例文章", 正文: "这是文章正文。" });
  assert.ok(Object.values(exported.verification).every((entry) => entry.exists && entry.size > 0));
});
