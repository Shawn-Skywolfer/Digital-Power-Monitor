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
const requestedPaths: string[] = [];

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
    requestedPaths.push(pathname);
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
    // 华润电力型栏目页：列表里混入 PDF 公告链接（2026-08-11 事故源，
    // 几十 MB PDF 被当 HTML 解析曾把事件循环卡死 83s 触发看门狗强杀）
    if (pathname === "/col/col2200/index.html") {
      return void response.end(`<html><body><ul>
        <li><a href="/kcxfzbg/2026-06-21/P020190412858756863432.pdf">项目公告 2026-06-21</a></li>
        <li><a href="/art/2026/6/15/art_11018_200.html">蒙古乌兰巴托储能电站开工 2026-06-15</a></li>
        </ul><a href="/col/col3300/index">下游栏目</a></body></html>`);
    }
    if (pathname === "/kcxfzbg/2026-06-21/P020190412858756863432.pdf") {
      response.setHeader("Content-Type", "application/pdf");
      return void response.end(Buffer.from("%PDF-1.4 fake binary for guard test"));
    }
    // 无扩展名的栏目页路径却返回 PDF（错配/魔数护栏）
    if (pathname === "/col/col3300/index") {
      response.setHeader("Content-Type", "application/pdf");
      return void response.end(Buffer.from("%PDF-1.7 extensionless binary"));
    }
    // 正泰式假厚页面：bodyText 8000+ 字却全是导航目录（bodyText≥2000、无内容容器、
    // 无 ≥300 字成段文字），正文由 JS 注入，静态抓取只能拿到菜单
    if (pathname === "/p/fake-thick") {
      const catalog = Array.from({ length: 90 }, (_, i) =>
        `<p class="item"><a href="/about/${i}">关于我们 · 正泰简介 · 数说正泰 · 集团简介 · 正泰荣誉 · 发展历程 ${i}</a></p>`).join("");
      return void response.end(`<!doctype html><html><head><title>新闻中心-详情</title></head>
        <body><div id="header-nav"><ul>${catalog}</ul></div><div id="news-detail"></div></body></html>`);
    }
    // 正常厚文章页（article 容器内 2000+ 字成段正文），假厚检测不应误伤
    if (pathname === "/p/normal-article") {
      const para = "2026年6月，中国企业承建的蒙古国乌兰巴托 50MW/200MWh 储能电站项目举行开工仪式，项目建成后将显著提升当地电网调峰能力，支撑新能源消纳。";
      return void response.end(`<!doctype html><html><head><title>乌兰巴托储能电站开工</title>
        <meta property="article:published_time" content="2026-06-15"></head>
        <body><header><a href="/">首页</a> <a href="/news">新闻</a> <a href="/about">关于</a> <a href="/contact">联系</a></header>
        <article><h1>乌兰巴托储能电站开工</h1>${`<p>${para}</p>`.repeat(12)}</article></body></html>`);
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

test("binary: 栏目页中的 PDF 链接不进 BFS 队列也不进候选，同页文章不受影响", async () => {
  const crawler = await import("../server/crawler");
  const source: SourceRecord = {
    id: "src-pdf", name: "PDF 拦截测试源", type: "网址", coverage: "",
    url: `${origin}/col/col2200/index.html`, country: "", enabled: true, rateLimitMs: 0,
  };
  const before = requestedPaths.length;
  const report = await crawler.discoverSourcePages(source, "2026-06-01", "2026-06-30", 50);
  const urls = report.pages.map((page) => page.url);
  assert.ok(!urls.some((url) => url.endsWith(".pdf")), "PDF 不应成为候选");
  assert.ok(!requestedPaths.slice(before).some((p) => p.endsWith(".pdf")),
    "PDF 不应被作为发现页抓取（2026-08-11 华润电力事故回归）");
  assert.ok(urls.some((url) => url.includes("art_11018_200")), "同栏目页的正常 6 月文章仍应发现");
});

test("binary: 无扩展名栏目页返回 PDF 时按非 HTML 资源快速失败，不触发解析", async () => {
  const crawler = await import("../server/crawler");
  const source: SourceRecord = {
    id: "src-pdf2", name: "错配类型测试源", type: "网址", coverage: "",
    url: `${origin}/col/col2200/index.html`, country: "", enabled: true, rateLimitMs: 0,
  };
  const report = await crawler.discoverSourcePages(source, "2026-06-01", "2026-06-30", 50);
  const failure = report.failures.find((f) => f.includes("col3300"));
  assert.ok(failure, "扩展名缺失的二进制栏目页应记录失败");
  assert.match(failure!, /非 HTML 资源/);
});

test("fakeThick: 导航模板堆出的假厚页面强制浏览器渲染，拿到真实正文", async () => {
  const crawler = await import("../server/crawler");
  let renders = 0;
  crawler.__setBackendRendererForTests("local", async (url) => {
    renders++;
    return {
      html: `<!doctype html><html><head><title>蒙古布尔干 50MW/100MWh 储能项目并网</title>
        <meta property="article:published_time" content="2026-06-20"></head><body><article><h1>蒙古布尔干储能项目并网</h1>
        <p>2026年6月20日，正泰新能源承建的蒙古国布尔干 50MW/100MWh 储能电站项目正式并网投运，项目位于布尔干省，是当地电网调峰的重要支撑。</p></article></body></html>`,
      url, statusCode: 200, backend: "local" as const,
    };
  });
  try {
    const doc = await crawler.fetchDocument(`${origin}/p/fake-thick`, "src-fake");
    assert.equal(renders, 1, "假厚页面应触发一次浏览器渲染");
    assert.equal(doc.fetchMode, "browser");
    assert.match(doc.text, /布尔干/);
    assert.ok(!/正泰简介/.test(doc.text), "正文不应再是导航目录");
    assert.ok(doc.warnings.some((w) => w.includes("假厚页面")), "应记录假厚页面警告");
  } finally {
    crawler.__setBackendRendererForTests("local", null);
  }
});

test("fakeThick: 正常厚文章页不误触发浏览器渲染", async () => {
  const crawler = await import("../server/crawler");
  let renders = 0;
  crawler.__setBackendRendererForTests("local", async (url) => {
    renders++;
    return { html: "<html><body>should not be used</body></html>", url, statusCode: 200, backend: "local" as const };
  });
  try {
    const doc = await crawler.fetchDocument(`${origin}/p/normal-article`, "src-normal");
    assert.equal(renders, 0, "正常文章页不应触发渲染");
    assert.equal(doc.fetchMode, "static");
    assert.match(doc.text, /乌兰巴托/);
  } finally {
    crawler.__setBackendRendererForTests("local", null);
  }
});

test("dedupe: 国别简写与全称视为同国，跨来源重复项目可合并", async () => {
  const { projectMatchScore } = await import("../server/projects");
  const full = { project_name: "沙特阿拉伯哈登2吉瓦光伏电站项目", country: "沙特阿拉伯", pv_capacity_mw: 2000 };
  const abbr = { project_name: "沙特哈登2吉瓦光伏电站项目", country: "沙特" };
  assert.ok(projectMatchScore(full, abbr) >= 0.58, `哈登一对应可合并，实际 ${projectMatchScore(full, abbr)}`);
  const alFull = { project_name: "沙特阿拉伯阿尔舒巴赫2.6吉瓦光伏电站项目", country: "沙特阿拉伯", pv_capacity_mw: 2600 };
  const alAbbr = { project_name: "沙特阿尔舒巴赫2.6吉瓦光伏电站项目", country: "沙特" };
  assert.ok(projectMatchScore(alFull, alAbbr) >= 0.58, "阿尔舒巴赫一对应可合并（一侧缺容量也不应阻断）");
  const uzb = { project_name: "乌兹别克斯坦赛莱斯特储能电站项目", country: "乌兹别克斯坦", storage_capacity_mwh: 300 };
  const uzbAbbr = { ...uzb, country: "乌兹" };
  assert.ok(projectMatchScore(uzb, uzbAbbr) >= 0.58, "乌兹/乌兹别克斯坦包含式匹配");
});

test("dedupe: 不同国别或不同项目不误并", async () => {
  const { projectMatchScore } = await import("../server/projects");
  const haden = { project_name: "沙特哈登2吉瓦光伏电站项目", country: "沙特", pv_capacity_mw: 2000 };
  assert.equal(projectMatchScore(haden, { ...haden, country: "越南" }), 0, "同名不同国必须否决");
  const shubah = { project_name: "沙特阿尔舒巴赫2.6吉瓦光伏电站项目", country: "沙特", pv_capacity_mw: 2600 };
  assert.ok(projectMatchScore(haden, shubah) < 0.58, "同国不同项目不应合并");
});
