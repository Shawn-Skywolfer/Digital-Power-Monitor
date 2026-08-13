import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-dajiala-"));
process.env.DPM_DATA_DIR = testDataDir;

const dajiala = await import("../server/dajiala");

test("大家啦关键词检索按精确日期、原创状态和费用上限过滤", async () => {
  const requests: Record<string, unknown>[] = [];
  let calls = 0;
  const result = await dajiala.searchDajialaArticles({
    credentials: { key: "secret-key", verifycode: "attach" },
    kw: "海外 光伏", startDate: "2026-08-01", endDate: "2026-08-31",
    maxArticles: 50, maxCostCny: 0.4, originalOnly: true, delay: async () => undefined,
    fetchImpl: async (_input, init) => {
      calls++;
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        code: 0, cost_money: 0.4, remain_money: 19.6, total: 40, total_page: 2, page: 1,
        data: [
          { title: "范围内原创", url: "https://mp.weixin.qq.com/s/original", content: "完整正文".repeat(100), publish_time_str: "2026-08-18 10:00:00", wx_name: "能源号", is_original: 1 },
          { title: "范围内转载", url: "https://mp.weixin.qq.com/s/repost", content: "转载正文", publish_time_str: "2026-08-17", is_original: 0 },
          { title: "范围外原创", url: "https://mp.weixin.qq.com/s/old", content: "旧正文", publish_time_str: "2026-07-31", is_original: 1 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls, 1, "费用上限只允许请求一个固定 20 条的结果页");
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.costCny, 0.4);
  assert.equal(result.remainMoney, 19.6);
  assert.deepEqual(result.articles.map((article) => article.title), ["范围内原创"]);
  assert.equal(requests[0].key, "secret-key");
  assert.equal(requests[0].verifycode, "attach");
  assert.equal(requests[0].page, 1);
});

test("大家啦文章详情对 107 执行有限重试并映射全文元数据", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await dajiala.fetchDajialaArticleDetail({
    credentials: { key: "secret" }, url: "https://mp.weixin.qq.com/s/test-detail",
    delay: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) return new Response(JSON.stringify({ code: 107, msg: "retry" }), { status: 200 });
      return new Response(JSON.stringify({
        code: 0, cost_money: 0.03, remain_money: 9.97,
        title: "海外储能项目签约", url: "https://mp.weixin.qq.com/s/test-detail", content: "项目全文".repeat(100),
        pubtime: "2026-08-09 08:30:00", nick_name: "出海能源观察", alias: "energy-overseas",
        user_name: "gh_example", author: "编辑部", copyright_stat: 1, ip_wording: "中国北京", hashid: "hash-1",
      }), { status: 200 });
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
  assert.equal(result.costCny, 0.03);
  assert.equal(result.article.publishedAt, "2026-08-09");
  assert.equal(result.article.accountName, "出海能源观察");
  assert.equal(result.article.original, true);
  assert.match(result.article.content, /项目全文/);
});

test("公众号历史接口按已导入账号读取发布批次", async () => {
  let request: Record<string, unknown> = {};
  const result = await dajiala.fetchDajialaAccountHistoryPage({
    credentials: { key: "secret", verifycode: "attach" }, account: { url: "https://mp.weixin.qq.com/s/account-sample" }, offset: "cursor-1",
    delay: async () => undefined,
    fetchImpl: async (input, init) => {
      assert.match(String(input), /post_history$/);
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        code: 0, offset: "cursor-2", is_end: 0, cost_money: 0.08, remain_money: 9.92,
        nickname: "海外电力观察", ghid: "gh_example",
        data: [
          { title: "正常文章", url: "https://mp.weixin.qq.com/s/a", post_time_str: "2026-08-12 10:00:00", original: 1, position: 1, msg_status: 2, is_deleted: 0 },
          { title: "已删除文章", url: "https://mp.weixin.qq.com/s/b", post_time_str: "2026-08-12", position: 2, msg_status: 7, is_deleted: 1 },
        ],
      }), { status: 200 });
    },
  });
  assert.deepEqual(request, { ghid: "", url: "https://mp.weixin.qq.com/s/account-sample", offset: "cursor-1", key: "secret", verifycode: "attach" });
  assert.equal(result.nextOffset, "cursor-2");
  assert.equal(result.isEnd, false);
  assert.equal(result.accountName, "海外电力观察");
  assert.equal(result.costCny, 0.08);
  assert.deepEqual(result.articles.map((article) => article.title), ["正常文章"]);
  assert.equal(result.articles[0].publishedAt, "2026-08-12");
});

test("微信文章映射为可归档全文文档并保留公众号信息", () => {
  const document = dajiala.dajialaArticleToDocument({
    title: "某国 100MW 光伏项目开工", url: "https://mp.weixin.qq.com/s/document", shortLink: "",
    content: "某国 100MW 光伏项目正式开工，由 Example Energy 开发。".repeat(20), publishedAt: "2026-08-12",
    accountName: "海外电力观察", accountId: "wx-example", ghid: "gh_example", author: "张三",
    original: true, ipWording: "中国上海", category: "能源", read: 1000, praise: 20, looking: 5,
  }, "2026-08-01", "2026-08-31");
  assert.equal(document.dateStatus, "within_range");
  assert.equal(document.sourceId, "dajiala-wechat");
  assert.equal(document.pageType, "article");
  assert.equal(document.extractionMethod, "dajiala-wechat-api");
  assert.match(document.text, /微信公众号：海外电力观察/);
  assert.match(document.text, /正文：/);
  assert.match(document.text, /100MW 光伏项目正式开工/);
  assert.ok(fs.existsSync(document.rawPath));
});

test("大家啦连接检测使用免费余额接口", async () => {
  const result = await dajiala.testDajialaConnection({ key: "secret", verifycode: "" }, {
    fetchImpl: async (input, init) => {
      assert.match(String(input), /get_remain_money$/);
      assert.deepEqual(JSON.parse(String(init?.body)), { key: "secret", verifycode: "" });
      return new Response(JSON.stringify({ code: 0, remain_money: 88.5, yesterday_money: 90, request_time: "2026-08-13 10:00:00" }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.remainMoney, 88.5);
  assert.equal(result.yesterdayMoney, 90);
});
