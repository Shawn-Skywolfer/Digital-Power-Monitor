import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { ArticleAssessment, SourceRecord } from "../server/types";

// 2026-06 扫描（ff4027b4）对比手工清单暴露的三类召回缺口的回归测试：
// 1) 项目周报/双周报被判 listing → 规则层直接 non_project，模型从未看到正文
// 2) 央企官网 /col/colXXXX/index_N.html 栏目归档页不被识别，BFS 翻不到目标月
// 3) 国内项目混入海外口径结果

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-june-recall-"));
process.env.DPM_DATA_DIR = testDataDir;

let origin = "";
let server: http.Server;

const weeklyEntry = (date: string, company: string, project: string, event: string) =>
  `<div class="entry"><h3>${company}${project}</h3><p>${date}，${company}${project}${event}。` +
  `该项目位于"一带一路"沿线重点国别，是当地能源结构转型的标志性工程，建设内容涵盖设备供货、安装调试与并网验收，建成后预计年均发电量可满足数十万户家庭用电需求，并为当地创造数百个就业岗位。</p></div>`;

// 仿一带一路网"中企海外项目双周报"：标题命中周报特征
const WEEKLY_TITLED = `<!doctype html><html><head>
<meta property="article:published_time" content="2026-06-26"><title>中企海外项目双周报（2026.6.13-2026.6.26）</title></head>
<body><div class="TRS_Editor"><h1>中企海外项目双周报（2026.6.13-2026.6.26）</h1>
${weeklyEntry("2026年6月19日", "中水电公司", "承建莱索托微电网储能项目", "举行开工仪式，项目包含 30MW 光伏与 60MWh 储能")}
${weeklyEntry("2026年6月18日", "中国能建安徽电建二公司", "承建蒙古乌兰巴托 50MW/200MWh 储能电站", "正式开工")}
${weeklyEntry("2026年6月16日", "三一重能", "承建塞尔维亚阿利布纳尔 168MW 风电项目", "举行开工仪式")}
${weeklyEntry("2026年6月15日", "山东电建", "中标沙特红海 380 千伏架空线路项目", "收到中标通知书")}
${weeklyEntry("2026年6月14日", "中铁十八局", "承建马达加斯加 12 号国道一期", "竣工通车")}
${weeklyEntry("2026年6月13日", "中交一公局", "承建加蓬奥耶姆市政项目", "第一阶段主体完工")}
${weeklyEntry("2026年6月13日", "江西国际", "中标卢旺达中压配网项目", "签署合同")}
${weeklyEntry("2026年6月13日", "中国路桥", "承建塞尔维亚跨多瑙河大桥", "顺利合龙")}
</div></body></html>`;

// 无周报标题、但正文日期块与项目事件密度足够高 → 也应识别为 roundup
const WEEKLY_DENSE = `<!doctype html><html><head><title>海外工程动态</title></head>
<body><div class="TRS_Editor"><h1>海外工程动态</h1>
${weeklyEntry("2026年6月19日", "中水电公司", "承建莱索托微电网储能项目", "举行开工仪式，项目包含 30MW 光伏与 60MWh 储能")}
${weeklyEntry("2026年6月18日", "中国能建", "承建蒙古乌兰巴托 50MW/200MWh 储能电站", "正式开工")}
${weeklyEntry("2026年6月16日", "三一重能", "承建塞尔维亚 168MW 风电项目", "举行开工仪式")}
${weeklyEntry("2026年6月15日", "山东电建", "中标沙特红海架空线路项目", "收到中标通知书")}
${weeklyEntry("2026年6月14日", "中铁十八局", "承建马达加斯加 12 号国道", "竣工通车")}
${weeklyEntry("2026年6月13日", "中交一公局", "承建加蓬奥耶姆市政项目", "第一阶段主体完工")}
${weeklyEntry("2026年6月12日", "江西国际", "中标卢旺达中压配网项目", "签署合同")}
${weeklyEntry("2026年6月11日", "中国路桥", "承建塞尔维亚跨河大桥", "顺利合龙")}
</div></body></html>`;

const articlePage = (title: string, body: string, date: string) => `<!doctype html><html><head>
<meta property="article:published_time" content="${date}"><title>${title}</title></head>
<body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      return void response.end("User-agent: *\nDisallow: /private/\n");
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (pathname === "/p/weekly-titled") return void response.end(WEEKLY_TITLED);
    if (pathname === "/p/weekly-dense") return void response.end(WEEKLY_DENSE);
    // 央企官网栏目归档结构：首页 → /col/col11018/index.html → index_1.html → 6 月文章
    if (pathname === "/") {
      return void response.end(`<html><body><nav><a href="/col/col11018/index.html">企业要闻</a></nav>
        <div><a href="/art/2026/8/5/art_11018_999.html">集团召开八月工作会议 2026-08-05</a></div></body></html>`);
    }
    if (pathname === "/col/col11018/index.html") {
      return void response.end(`<html><body><ul>
        <li><a href="/art/2026/7/20/art_11018_100.html">七月项目签约 2026-07-20</a></li>
        <li><a href="/art/2026/7/10/art_11018_101.html">七月工程进展 2026-07-10</a></li>
        </ul><a href="/col/col11018/index_1.html">下一页</a></body></html>`);
    }
    if (pathname === "/col/col11018/index_1.html") {
      return void response.end(`<html><body><ul>
        <li><a href="/art/2026/6/15/art_11018_200.html">蒙古乌兰巴托储能电站开工 2026-06-15</a></li>
        <li><a href="/art/2026/6/5/art_11018_201.html">越南光伏项目并网 2026-06-05</a></li>
        </ul><a href="/col/col11018/index_2.html">下一页</a></body></html>`);
    }
    if (pathname === "/col/col11018/index_2.html") {
      return void response.end(`<html><body><ul>
        <li><a href="/art/2026/5/8/art_11018_300.html">五月工作会议 2026-05-08</a></li></ul></body></html>`);
    }
    if (pathname === "/art/2026/6/15/art_11018_200.html") {
      return void response.end(articlePage("蒙古乌兰巴托储能电站开工",
        "The 50 MW / 200 MWh battery storage project in Ulaanbaatar, Mongolia broke ground in June 2026. 中国能建承建该储能项目。",
        "2026-06-15"));
    }
    if (pathname === "/art/2026/6/5/art_11018_201.html") {
      return void response.end(articlePage("越南光伏项目并网",
        "The 100 MW solar plant in Vietnam was connected to the grid in June 2026. 光伏项目顺利并网发电。",
        "2026-06-05"));
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
  const crawler = await import("../server/crawler");
  await crawler.closeCrawlerBrowser();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { db } = await import("../server/db");
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("roundup: 周报标题页识别为 roundup 页型", async () => {
  const crawler = await import("../server/crawler");
  const doc = await crawler.fetchDocument(`${origin}/p/weekly-titled`, "src-weekly", "page-link");
  assert.equal(doc.error, undefined);
  assert.equal(doc.pageType, "roundup", `带周报标题的聚合页应为 roundup，实际 ${doc.pageType}`);
});

test("roundup: 无周报标题但日期块+项目事件密度足够时也识别为 roundup", async () => {
  const crawler = await import("../server/crawler");
  const doc = await crawler.fetchDocument(`${origin}/p/weekly-dense`, "src-weekly", "page-link");
  assert.equal(doc.pageType, "roundup", `高密度项目事件聚合页应为 roundup，实际 ${doc.pageType}`);
});

test("roundup: 规则层放行模型评估，纯规则兜底判 uncertain 而非 non_project", async () => {
  const crawler = await import("../server/crawler");
  const { ruleAssessment } = await import("../server/projects");
  const doc = await crawler.fetchDocument(`${origin}/p/weekly-titled`, "src-weekly", "page-link");
  const likelihood = crawler.ruleProjectLikelihood(doc);
  assert.equal(likelihood.eligiblePage, true, "roundup 页应允许进入模型评估");
  assert.equal(likelihood.energy, true, "周报正文含储能/风电，应命中能源词");
  const assessment = ruleAssessment(doc, []);
  assert.equal(assessment.classification, "uncertain",
    `纯规则兜底不得把周报判死为 non_project，也不得拼出伪项目，实际 ${assessment.classification}`);
  assert.equal(assessment.mentions.length, 0, "规则层不逐条拆分，不产生 mention");
});

test("archive: BFS 穿过 /col/ 栏目页与 index_N 翻页到达目标月文章", async () => {
  const crawler = await import("../server/crawler");
  const source: SourceRecord = {
    id: "src-col", name: "栏目页测试源", type: "网址", coverage: "",
    url: `${origin}/`, country: "", enabled: true, rateLimitMs: 0,
  };
  const report = await crawler.discoverSourcePages(source, "2026-06-01", "2026-06-30", 50);
  const urls = report.pages.map((page) => page.url);
  assert.ok(urls.some((url) => url.includes("art_11018_200")),
    `应发现 6 月文章（穿过 index_1 翻页），实际发现：${urls.join(", ")}`);
  assert.ok(urls.some((url) => url.includes("art_11018_201")), "应发现另一篇 6 月文章");
  assert.ok(!urls.some((url) => url.includes("art_11018_999") || url.includes("art_11018_100")),
    "7 月/8 月文章带日期提示、超出窗口，不应进入候选");
});

const mention = (country: string | null): ArticleAssessment["mentions"][number] => ({
  fields: { project_name: "某储能项目", country },
  originalFields: {}, evidence: {}, evidenceTranslations: {}, confidence: 0.8,
});

const report = (mentions: ArticleAssessment["mentions"]): ArticleAssessment => ({
  classification: "project_report", confidence: 0.9, reasoning: "模型抽取", sourceLanguage: "zh", mentions,
});

test("overseasOnly: 中国境内 mention 被剔除，其余保留", async () => {
  const { filterDomesticMentions } = await import("../server/projects");
  const mixed = report([mention("中国"), mention("乌兹别克斯坦"), mention(null)]);
  const filtered = filterDomesticMentions(mixed);
  assert.equal(filtered.classification, "project_report");
  assert.equal(filtered.mentions.length, 2, "国内剔除、海外与国别未知保留");
  assert.match(filtered.reasoning, /海外口径/);
});

test("overseasOnly: 全部为境内项目时降级为 non_project", async () => {
  const { filterDomesticMentions } = await import("../server/projects");
  const filtered = filterDomesticMentions(report([mention("中国 新疆"), mention("China"), mention("中国香港")]));
  assert.equal(filtered.classification, "non_project");
  assert.equal(filtered.mentions.length, 0);
});
