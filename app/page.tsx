"use client";

import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8765";

type View = "dashboard" | "new-scan" | "results" | "sources" | "models" | "search" | "mcp" | "browser" | "skills" | "exports";
type Json = Record<string, unknown>;
type Field = { id: string; label: string; type: string; unit?: string; required: boolean; position: number };
type Source = { id: string; name: string; type: string; coverage: string; url: string; enabled: boolean };
type Provider = {
  id: string; name: string; kind: string; baseUrl: string; enabled: boolean; hasSecret: boolean;
  headers?: Record<string, string>; config?: Json;
};
type SearchProvider = { id: string; name: string; kind: string; endpoint: string; enabled: boolean; hasSecret: boolean; hasVerifycode?: boolean };
type McpServer = {
  id: string; name: string; transport: string; url: string; command: string; enabled: boolean;
  args?: string[]; envKeys?: string[];
};
type McpTestResult = {
  ok: boolean; status: string; latencyMs: number; error?: string; diagnosis?: string;
  catalog?: { runtime?: string; tools?: unknown[]; resources?: unknown[]; prompts?: unknown[]; warnings?: string[] };
};
type BrowserRendering = {
  enabled: boolean; endpoint: string; backendOrder: string[]; connectTimeoutMs: number;
  hasToken: boolean; source: "db" | "env" | "none"; envEndpoint: boolean;
};
type BrowserProbe = { ok: boolean; latencyMs: number; endpoint?: string; version?: string; error?: string; diagnosis?: string };
type ConnectionTestState = { status: "running" | "success" | "failed"; startedAt: number; finishedAt?: number; result?: Json; error?: string };
type Scan = { id: string; status: string; progress: Record<string, unknown>; createdAt: string; request?: Json; error?: string };
type Result = {
  id: string; documentId?: string; fields: Record<string, unknown>; primaryUrl: string; candidateUrls: string[];
  evidence: Record<string, string>; conflicts: string[]; score: number; status: string; revision: number; generatedFields?: string[];
  originalFields?: Record<string, string>; evidenceTranslations?: Record<string, string>; sourceLanguage?: string;
  unitChecks?: Record<string, string>;
};
type ScanLog = { id: string; sequence: number; level: string; stage: string; event: string; message: string; context: Json; createdAt: string };
type SourceCoverageItem = {
  sourceId: string; name: string; url: string; status: "pending" | "running" | "completed" | "failed";
  discovered: number; fetched: number; succeeded: number; error?: string;
};
type DiagnosticCheck = { ok: boolean; label: string; message: string; latencyMs?: number; fix?: string };
type ModelDiagnostic = { ok: boolean; status: string; headline: string; recommendedAction?: string; modelId?: string; latencyMs?: number; checks?: Record<string, DiagnosticCheck> };
type ExportDownload = { name: string; url: string };
type ExportTarget =
  | { mode: "native"; token: string; path: string; name: string }
  | { mode: "browser"; handle: LocalDirectoryHandle; path: string; name: string };
type SkillChange = { path: string; proposedValueJson: string; reason: string; expectedEffect: string; rollbackCondition: string };
type SkillIteration = {
  id: string; scanId: string; version: number; status: string; createdAt: string; reviewedAt?: string | null;
  evidence: { funnel?: Json; failureCodes?: Json; causes?: unknown[]; sourceDistribution?: unknown[]; generatedAt?: string };
  proposal: { summary: string; changes: SkillChange[]; learnedPractices: string[]; modelUsed?: boolean };
};
type SkillProfile = {
  id: string; name: string; description: string; content: string; policy: Json; learnedPractices: string;
  version: number; iterations: SkillIteration[];
};
type LocalDirectoryHandle = {
  name: string;
  requestPermission?(options: { mode: "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  getFileHandle(name: string, options: { create: boolean }): Promise<{
    getFile(): Promise<File>;
    createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
};

const nav: { id: View; label: string; icon: string; group?: string }[] = [
  { id: "dashboard", label: "总览", icon: "◈" },
  { id: "new-scan", label: "新建监测", icon: "＋" },
  { id: "results", label: "结果审核", icon: "◎" },
  { id: "exports", label: "确认与导出", icon: "⇩" },
  { id: "sources", label: "监测来源", icon: "⌁", group: "能力设置" },
  { id: "models", label: "大模型", icon: "◇" },
  { id: "search", label: "搜索 API", icon: "⌕" },
  { id: "mcp", label: "MCP", icon: "⬡" },
  { id: "browser", label: "浏览器渲染", icon: "▣" },
  { id: "skills", label: "Skill 策略", icon: "✦" },
];

type ApiOptions = RequestInit & { localRetry?: number };

async function api<T>(path: string, options?: ApiOptions): Promise<T> {
  const { localRetry, ...request } = options ?? {};
  const method = String(request.method ?? "GET").toUpperCase();
  const attempts = Math.max(1, localRetry ?? (method === "GET" ? 3 : 1));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${API}${path}`, {
        ...request,
        headers: { "Content-Type": "application/json", ...(request.headers ?? {}) },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `请求失败：${response.status}`);
      return data as T;
    } catch (cause) {
      lastError = cause;
      const localConnectionFailure = cause instanceof TypeError || /failed to fetch|networkerror/i.test(cause instanceof Error ? cause.message : String(cause));
      if (!localConnectionFailure || attempt === attempts) {
        if (localConnectionFailure) throw new Error("本地 API 服务暂时断开，守护进程正在自动恢复，请稍后重试");
        throw cause;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

function providerErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/fetch failed/i.test(message)) {
    return "无法连接模型服务。请检查网络、代理、DNS、Base URL 和供应商服务状态。";
  }
  return message;
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function statusLabel(status: string) {
  return {
    queued: "排队中", running: "监测中", paused: "已暂停", stopping: "正在停止", stopped: "已停止", completed: "已完成", failed: "失败",
    auto_approved: "自动通过", approved: "已确认", review: "待审核", rejected: "低置信度",
  }[status] ?? status;
}

export default function Home() {
  const [view, setView] = useState<View>("dashboard");
  const [fields, setFields] = useState<Field[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [searchProviders, setSearchProviders] = useState<SearchProvider[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [dashboard, setDashboard] = useState<Json>({});
  const [activeScanId, setActiveScanId] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [serviceState, setServiceState] = useState<"connecting" | "connected" | "reconnecting">("connecting");

  const refresh = useCallback(async () => {
    try {
      const [f, s, p, sp, m, jobs, d] = await Promise.all([
        api<Field[]>("/api/fields"), api<Source[]>("/api/sources"), api<Provider[]>("/api/providers"),
        api<SearchProvider[]>("/api/search-providers"), api<McpServer[]>("/api/mcp-servers"),
        api<Scan[]>("/api/scans"), api<Json>("/api/dashboard"),
      ]);
      setFields(f); setSources(s); setProviders(p); setSearchProviders(sp); setMcpServers(m);
      setScans(jobs); setDashboard(d);
      setServiceState("connected"); setError("");
      if (!activeScanId && jobs[0]?.id) setActiveScanId(jobs[0].id);
    } catch (cause) {
      setServiceState("reconnecting");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [activeScanId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!activeScanId) { setResults([]); return; }
      void api<Result[]>(`/api/scans/${activeScanId}/results`).then(setResults).catch(() => setResults([]));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeScanId, scans]);

  useEffect(() => {
    const hasRunning = scans.some((scan) => ["queued", "running", "stopping"].includes(scan.status));
    if (!hasRunning) return;
    const timer = window.setInterval(() => void refresh(), 1800);
    return () => window.clearInterval(timer);
  }, [scans, refresh]);

  useEffect(() => {
    let wasDisconnected = false;
    const check = async () => {
      try {
        const response = await fetch(`${API}/health`, { cache: "no-store", signal: AbortSignal.timeout(2_500) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (wasDisconnected) void refresh();
        wasDisconnected = false;
        setServiceState("connected");
      } catch {
        wasDisconnected = true;
        setServiceState("reconnecting");
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  const activeScan = scans.find((scan) => scan.id === activeScanId);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">D</span>
          <div><strong>海外能源雷达</strong><span>Digital Power Monitor</span></div>
        </div>
        <nav>
          {nav.map((item, index) => (
            <div key={item.id}>
              {item.group && <p className="nav-group">{item.group}</p>}
              <button className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => setView(item.id)}>
                <span>{item.icon}</span>{item.label}
                {item.id === "results" && Number(dashboard.pending ?? 0) > 0 && <em>{String(dashboard.pending)}</em>}
              </button>
              {index === 3 && <div className="nav-divider" />}
            </div>
          ))}
        </nav>
        <div className={`sidebar-status ${serviceState}`}>
          <span className="pulse" />
          <div><strong>{serviceState === "connected" ? "本地服务已连接" : serviceState === "reconnecting" ? "服务自动恢复中" : "正在连接本地服务"}</strong><small>{serviceState === "connected" ? "数据仅保存在本机" : "无需重新配置模型或 API Key"}</small></div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">研究工作台 / {nav.find((item) => item.id === view)?.label}</p>
            <h1>{pageTitle(view)}</h1>
          </div>
          <div className="top-actions">
            <button className="ghost" onClick={() => void refresh()}>刷新数据</button>
            <button className="primary" onClick={() => setView("new-scan")}>＋ 新建监测</button>
          </div>
        </header>

        {error && <div className="alert error"><span>!</span><div><strong>服务提示</strong><p>{error}</p></div><button onClick={() => setError("")}>×</button></div>}
        {toast && <div className="toast">{toast}</div>}

        <div className="content">
          {view === "dashboard" && <Dashboard data={dashboard} scans={scans} setView={setView} setActiveScanId={setActiveScanId} />}
          {view === "new-scan" && <ScanWizard fields={fields} sources={sources} providers={providers} searchProviders={searchProviders} mcpServers={mcpServers} onCreated={(scan) => { setActiveScanId(scan.id); notify("监测任务已启动"); void refresh(); setView("results"); }} onError={setError} />}
          {view === "results" && <ResultsView scans={scans} activeScan={activeScan} activeScanId={activeScanId} setActiveScanId={setActiveScanId} results={results} fields={fields} refresh={refresh} notify={notify} onError={setError} onOpenSources={() => setView("sources")} onOpenSkill={() => setView("skills")} />}
          {view === "sources" && <SourcesView sources={sources} refresh={refresh} notify={notify} onError={setError} />}
          {view === "models" && <ModelsView providers={providers} refresh={refresh} notify={notify} onError={setError} />}
          {view === "search" && <SearchView providers={searchProviders} refresh={refresh} notify={notify} onError={setError} />}
          {view === "mcp" && <McpView servers={mcpServers} refresh={refresh} notify={notify} onError={setError} />}
          {view === "browser" && <BrowserView notify={notify} onError={setError} />}
          {view === "skills" && <SkillView scans={scans} activeScanId={activeScanId} notify={notify} onError={setError} />}
          {view === "exports" && <ExportsView activeScan={activeScan} results={results} fields={fields} notify={notify} onError={setError} />}
        </div>
      </main>
    </div>
  );
}

function pageTitle(view: View) {
  const titles: Record<View, string> = {
    dashboard: "今天要监测什么？", "new-scan": "配置一次新的监测",
    results: "逐条核验监测结果", sources: "维护监测来源", models: "配置大模型能力",
    search: "配置外部搜索能力", mcp: "连接 MCP 工具与资源", browser: "配置浏览器渲染兜底", skills: "加载并迭代检索 Skill", exports: "确认版本并导出",
  };
  return titles[view];
}

function Dashboard({ data, scans, setView, setActiveScanId }: {
  data: Json; scans: Scan[]; setView: (view: View) => void; setActiveScanId: (id: string) => void;
}) {
  const metrics = [
    ["监测来源", Number(data.sources ?? 0), "个已配置站点", "teal"],
    ["累计任务", Number(data.scans ?? 0), "次监测运行", "blue"],
    ["项目结果", Number(data.results ?? 0), "条结构化记录", "amber"],
    ["待人工审核", Number(data.pending ?? 0), "条需要判断", "rose"],
  ];
  return (
    <div className="stack">
      <section className="hero-card">
        <div>
          <p className="eyebrow light">可审计的全球新能源情报采集</p>
          <h2>从来源到证据，再到可交付的项目清单</h2>
          <p>选择字段、时间和来源，系统会完成检索、抓取、结构化抽取与置信度分流。每一个结论都能回到原始网页。</p>
          <div className="hero-actions">
            <button className="light-button" onClick={() => setView("new-scan")}>开始一次监测 →</button>
            <button className="text-button" onClick={() => setView("sources")}>检查来源库</button>
          </div>
        </div>
        <div className="radar-visual" aria-hidden="true"><span /><span /><span /><i /><b /></div>
      </section>
      <section className="metric-grid">
        {metrics.map(([label, value, note, tone]) => (
          <article className={`metric ${tone}`} key={String(label)}>
            <div><span>{label}</span><em>↗</em></div><strong>{String(value)}</strong><small>{note}</small>
          </article>
        ))}
      </section>
      <section className="two-col">
        <div className="panel">
          <PanelHeader title="最近的监测任务" subtitle="按创建时间排序" action="查看全部" onAction={() => setView("results")} />
          <div className="activity-list">
            {scans.length === 0 && <Empty text="还没有任务。创建一次监测后，进度会显示在这里。" />}
            {scans.slice(0, 6).map((scan) => (
              <button className="activity-row" key={scan.id} onClick={() => { setActiveScanId(scan.id); setView("results"); }}>
                <StatusDot status={scan.status} />
                <div><strong>{scan.id.slice(0, 8)} · {statusLabel(scan.status)}</strong><span>{new Date(scan.createdAt).toLocaleString("zh-CN")}</span></div>
                <div className="activity-progress"><i style={{ width: `${Number(scan.progress.percent ?? 0)}%` }} /></div>
                <b>{Number(scan.progress.results ?? 0)} 条</b>
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <PanelHeader title="工作流健康度" subtitle="当前系统准备情况" />
          <div className="health-list">
            <HealthRow label="来源库" value={Number(data.sources ?? 0) ? `${data.sources} 个来源可用` : "等待导入"} ok={Number(data.sources ?? 0) > 0} />
            <HealthRow label="大模型" value={Number(data.providers ?? 0) ? `${data.providers} 个供应商` : "可选配置"} ok={Number(data.providers ?? 0) > 0} />
            <HealthRow label="审核队列" value={Number(data.pending ?? 0) ? `${data.pending} 条待处理` : "没有积压"} ok={Number(data.pending ?? 0) === 0} />
            <HealthRow label="证据归档" value="原文、正文与哈希同步保存" ok />
          </div>
        </div>
      </section>
    </div>
  );
}

function ScanWizard({ fields, sources, providers, searchProviders, mcpServers, onCreated, onError }: {
  fields: Field[]; sources: Source[]; providers: Provider[]; searchProviders: SearchProvider[]; mcpServers: McpServer[];
  onCreated: (scan: Scan) => void; onError: (message: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [acquisitionMode, setAcquisitionMode] = useState<"web" | "project-intel" | "wechat">("web");
  const [periodMode, setPeriodMode] = useState<"month" | "custom">("month");
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
  const [fieldIds, setFieldIds] = useState<string[]>(fields.map((field) => field.id));
  const [sourceIds, setSourceIds] = useState<string[]>(sources.filter((source) => source.enabled).map((source) => source.id));
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelOptions, setModelOptions] = useState<{ id: string; name: string }[]>([]);
  const [searchIds, setSearchIds] = useState<string[]>([]);
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [budget, setBudget] = useState({ maxPages: 100, maxSearches: 30, maxMinutes: 10, maxConcurrency: 3, maxCostUsd: 2 });
  const [ignoreRobots, setIgnoreRobots] = useState(true);
  const [overseasOnly, setOverseasOnly] = useState(true);
  const [referenceRows, setReferenceRows] = useState<Record<string, unknown>[]>([]);
  const [referenceName, setReferenceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [wechatProviderId, setWechatProviderId] = useState("");
  const [wechatOutputMode, setWechatOutputMode] = useState<"fulltext" | "projects">("fulltext");
  const [wechatMaxApiCostCny, setWechatMaxApiCostCny] = useState(10);
  const wechatProviders = searchProviders.filter((provider) => provider.kind === "dajiala");
  const webSearchProviders = searchProviders.filter((provider) => provider.kind !== "dajiala");
  const websiteSources = sources.filter((source) => source.type !== "微信公众号");
  const wechatSources = sources.filter((source) => source.type === "微信公众号" && source.enabled);

  function applyMonth(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    setSelectedMonth(month);
    setStartDate(`${month}-01`);
    setEndDate(`${month}-${String(lastDay).padStart(2, "0")}`);
  }

  function chooseAcquisitionMode(mode: "web" | "project-intel" | "wechat") {
    setAcquisitionMode(mode);
    setStep(1);
    if (mode === "project-intel") {
      setPeriodMode("month");
      applyMonth(selectedMonth);
      setBudget((current) => ({ ...current, maxPages: Math.max(500, current.maxPages) }));
    } else if (mode === "wechat") {
      setBudget((current) => ({ ...current, maxPages: Math.min(200, Math.max(20, current.maxPages)), maxConcurrency: 1 }));
      setSourceIds(wechatSources.map((source) => source.id));
      if (!wechatProviderId && wechatProviders[0]?.id) setWechatProviderId(wechatProviders[0].id);
    } else {
      setSourceIds(websiteSources.filter((source) => source.enabled).map((source) => source.id));
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFieldIds((current) => current.length ? current : fields.map((field) => field.id));
      setSourceIds((current) => current.length ? current : sources.filter((source) => acquisitionMode === "wechat" ? source.type === "微信公众号" && source.enabled : source.type !== "微信公众号" && source.enabled).map((source) => source.id));
      setWechatProviderId((current) => current || searchProviders.find((provider) => provider.kind === "dajiala")?.id || "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [acquisitionMode, fields, sources, searchProviders]);

  async function chooseProvider(id: string) {
    setProviderId(id); setModelId(""); setModelOptions([]);
    if (!id) return;
    try {
      const models = await api<{ id: string; name: string }[]>(`/api/providers/${id}/models`, { method: "POST", body: JSON.stringify({}), localRetry: 3 });
      setModelOptions(models);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function loadReference(file?: File) {
    if (!file) return;
    try {
      const parsed = await api<{ rows: Record<string, unknown>[] }>("/api/reference/import", {
        method: "POST", body: JSON.stringify({ fileName: file.name, base64: await fileToBase64(file) }),
      });
      setReferenceRows(parsed.rows); setReferenceName(file.name);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function start() {
    if (acquisitionMode === "web" && sourceIds.length && budget.maxPages < sourceIds.length) {
      setStep(5);
      onError(`已选择 ${sourceIds.length} 个来源，最大抓取页数至少应为 ${sourceIds.length}，才能为每个来源保留 1 页额度。`);
      return;
    }
    if (acquisitionMode === "wechat" && (!wechatProviderId || !sourceIds.length || (wechatOutputMode === "projects" && (!providerId || !modelId)))) {
      setStep(!sourceIds.length ? 3 : 4);
      onError(!sourceIds.length ? "请先导入并选择至少一个微信公众号账号。" : "项目字段分析模式需要配置大家啦 API，并选择大模型供应商与模型。");
      return;
    }
    setBusy(true);
    try {
      const wechat = acquisitionMode === "wechat" ? {
        outputMode: wechatOutputMode, maxApiCostCny: wechatMaxApiCostCny,
      } : undefined;
      const scan = await api<Scan>("/api/scans", {
        method: "POST",
        body: JSON.stringify({ acquisitionMode, startDate, endDate, fieldIds, sourceIds: acquisitionMode === "project-intel" ? [] : sourceIds, providerId: wechatOutputMode === "fulltext" && acquisitionMode === "wechat" ? undefined : providerId, modelId: wechatOutputMode === "fulltext" && acquisitionMode === "wechat" ? undefined : modelId, searchProviderIds: searchIds, mcpServerIds: mcpIds, budget, ignoreRobots, overseasOnly, referenceRows: acquisitionMode === "web" ? referenceRows : undefined, wechatProviderId, wechat }),
      });
      onCreated(scan);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const steps = ["选择字段", "时间范围", "监测来源", "能力组合", "预算与确认"];
  const rangeDays = startDate && endDate ? Math.max(0, Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1) : 0;
  const preflightWarnings = [
    acquisitionMode === "web" && budget.maxPages < sourceIds.length ? `总页数 ${budget.maxPages} 小于来源数 ${sourceIds.length}，无法保证每站至少检查 1 页。` : "",
    rangeDays === 1 ? "当前只检索单日发布内容；多数官网并非每天发布项目消息，结果很容易为 0。" : "",
    acquisitionMode === "web" && sourceIds.length >= 20 && !searchIds.length && !mcpIds.length ? "来源较多且未启用搜索 API/MCP；官网连接失败时没有外部检索回退。" : "",
    acquisitionMode === "wechat" && !wechatProviderId ? "尚未配置大家啦微信 API；请先到“搜索 API”页面保存 API Key。" : "",
    acquisitionMode === "wechat" && !wechatSources.length ? "公众号账号库为空；请先到“监测来源”导入账号。" : "",
    acquisitionMode === "wechat" && !sourceIds.length ? "尚未选择要监测的公众号账号。" : "",
    acquisitionMode === "wechat" && wechatOutputMode === "projects" && (!providerId || !modelId) ? "项目字段分析模式尚未选择大模型。" : "",
  ].filter(Boolean);
  return (
    <div className="wizard-layout">
      <aside className="wizard-steps">
        {steps.map((label, index) => (
          <button key={label} className={step === index + 1 ? "wizard-step active" : step > index + 1 ? "wizard-step done" : "wizard-step"} onClick={() => setStep(index + 1)}>
            <span>{step > index + 1 ? "✓" : index + 1}</span><div><strong>{label}</strong><small>{wizardNote(index + 1)}</small></div>
          </button>
        ))}
      </aside>
      <section className="wizard-panel">
        <div className="scan-mode-tabs" role="tablist" aria-label="检索方式">
          <button type="button" role="tab" aria-selected={acquisitionMode === "web"} className={acquisitionMode === "web" ? "active" : ""} onClick={() => chooseAcquisitionMode("web")}>
            <span>⌁</span><div><strong>多来源网页监测</strong><small>扫描自建来源库、搜索 API 与 MCP</small></div>
          </button>
          <button type="button" role="tab" aria-selected={acquisitionMode === "project-intel"} className={acquisitionMode === "project-intel" ? "active" : ""} onClick={() => chooseAcquisitionMode("project-intel")}>
            <span>▦</span><div><strong>Project Intel 批量采集</strong><small>按发布时间范围导入结构化项目</small></div>
          </button>
          <button type="button" role="tab" aria-selected={acquisitionMode === "wechat"} className={acquisitionMode === "wechat" ? "active" : ""} onClick={() => chooseAcquisitionMode("wechat")}>
            <span>微</span><div><strong>微信公众号监测</strong><small>按已导入账号和日期归档全文或分析项目</small></div>
          </button>
        </div>
        <div className="wizard-head">
          <div><p className="eyebrow">步骤 {step} / 5</p><h2>{steps[step - 1]}</h2></div>
          <span className="step-chip">{Math.round((step / 5) * 100)}%</span>
        </div>
        {step === 1 && (
          <div>
            {acquisitionMode === "wechat" && <><div className="section-intro"><p>先选择结果形态。两种模式都会从已导入的公众号账号抓取所选时间段文章并取得完整正文。</p></div><div className="period-mode" role="tablist" aria-label="微信监测结果模式"><button type="button" className={wechatOutputMode === "fulltext" ? "active" : ""} onClick={() => setWechatOutputMode("fulltext")}>全文归档导出</button><button type="button" className={wechatOutputMode === "projects" ? "active" : ""} onClick={() => setWechatOutputMode("projects")}>按项目字段分析</button></div><div className="info-card"><span>{wechatOutputMode === "fulltext" ? "文" : "AI"}</span><div><strong>{wechatOutputMode === "fulltext" ? "原文资料库" : "项目结构化结果"}</strong><p>{wechatOutputMode === "fulltext" ? "导出只包含公众号账号、发布日期、文章标题、正文，不调用大模型，也不进行项目判断。" : "大模型阅读文章全文，判断并拆分项目，按下面选定的现有字段输出原文证据。"}</p></div></div></>}
            {(acquisitionMode !== "wechat" || wechatOutputMode === "projects") && <><div className="section-intro"><p>勾选本次需要提取并导出的字段。项目名称、国家、发布日期和证据元数据仍会在后台用于去重。</p><button className="ghost small" onClick={() => setFieldIds(fieldIds.length === fields.length ? [] : fields.map((field) => field.id))}>{fieldIds.length === fields.length ? "取消全选" : "全选"}</button></div><div className="field-grid">{fields.map((field) => <CheckCard key={field.id} checked={fieldIds.includes(field.id)} title={field.label.replace("\n", " ")} meta={`${field.type}${field.unit ? ` · ${field.unit}` : ""}`} onChange={() => setFieldIds(toggle(fieldIds, field.id))} />)}</div></>}
            {acquisitionMode === "web" && <label className="upload-box compact"><input type="file" accept=".xlsx" onChange={(event) => void loadReference(event.target.files?.[0])} /><span>⇧</span><div><strong>上传项目参考表（可选）</strong><p>{referenceName ? `${referenceName} · ${referenceRows.length} 条记录` : "用于给已有项目逐条寻找原始页面"}</p></div></label>}
          </div>
        )}
        {step === 2 && (
          <div className="form-section">
            <p className="section-copy">{acquisitionMode === "project-intel" ? "按 Project Intel 的收录发布时间（recorded_at）筛选，开始与结束日期均包含。可以直接选择整月，也可以自定义日期。" : acquisitionMode === "wechat" ? "按所选公众号账号的文章发布时间精确筛选，开始与结束日期均包含；当历史分页早于开始日期后自动停止。" : "系统按网页发布日期筛选，开始与结束日期均包含。没有可识别发布日期的页面会保留并进入人工审核。"}</p>
            {acquisitionMode === "project-intel" && <div className="period-mode">
              <button type="button" className={periodMode === "month" ? "active" : ""} onClick={() => { setPeriodMode("month"); applyMonth(selectedMonth); }}>按月</button>
              <button type="button" className={periodMode === "custom" ? "active" : ""} onClick={() => setPeriodMode("custom")}>自定义日期</button>
            </div>}
            {acquisitionMode === "project-intel" && periodMode === "month" && <label className="month-field"><span>发布月份</span><input type="month" value={selectedMonth} onChange={(event) => applyMonth(event.target.value)} /></label>}
            <div className="date-range">
              <label><span>开始日期</span><input type="date" value={startDate} disabled={acquisitionMode === "project-intel" && periodMode === "month"} onChange={(e) => setStartDate(e.target.value)} /></label>
              <i>→</i>
              <label><span>结束日期</span><input type="date" value={endDate} disabled={acquisitionMode === "project-intel" && periodMode === "month"} onChange={(e) => setEndDate(e.target.value)} /></label>
            </div>
            <div className="info-card"><span>i</span><div><strong>日期口径</strong><p>{acquisitionMode === "project-intel" ? "这里指项目进入 Project Intel 数据库的时间，不是项目开工、签约或投产日期。" : acquisitionMode === "wechat" ? "这里指公众号文章的发文日期，不是文章正文中项目开工、签约或投产日期。链接导入时日期不明的文章会保留并进入人工审核。" : "这里指信息来源网页的公开发布日期，而不是项目开工、签约或投产日期。"}</p></div></div>
          </div>
        )}
        {step === 3 && (
          acquisitionMode === "project-intel" ? <div className="project-intel-source">
            <div className="project-intel-source-head"><span>▦</span><div><strong>Project Intel · 风光氢储出海数据库</strong><p>energy-overseas.com/project-intel</p></div><em>已固定选择</em></div>
            <div className="project-intel-policy"><strong>温和采集策略</strong><p>只读取公开的结构化列表接口；沿用站点前端每页 20 条的分页、请求串行、分页间隔至少 3 秒；不逐条打开详情页，遇到限流自动退避。</p></div>
          </div> : acquisitionMode === "wechat" ? <div className="form-section">
            <div className="project-intel-source-head"><span>微</span><div><strong>公众号账号库</strong><p>只监测你在“监测来源”中已导入并启用的账号</p></div><em>{sourceIds.length} / {wechatSources.length} 个</em></div>
            <label><span>微信 API 配置</span><select value={wechatProviderId} onChange={(event) => setWechatProviderId(event.target.value)}><option value="">请选择大家啦 API</option>{wechatProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.hasSecret ? "密钥已保存" : "缺少密钥"}</option>)}</select></label>
            {wechatProviders.length === 0 && <div className="preflight-warning"><strong>尚未配置微信 API</strong><p>请先到左侧“搜索 API”，新增“大家啦微信内容”并保存 API Key；附加码如账号已启用则一并填写。</p></div>}
            <div className="section-intro"><p>选择本次要监测的公众号账号。</p><button className="ghost small" onClick={() => setSourceIds(wechatSources.length > 0 && sourceIds.length === wechatSources.length ? [] : wechatSources.map((source) => source.id))}>{wechatSources.length > 0 && sourceIds.length === wechatSources.length ? "取消全选" : "全选"}</button></div>
            <div className="source-picker">{wechatSources.length === 0 && <Empty text="公众号账号库为空。请先到“监测来源”切换到“微信公众号”，导入账号。" />}{wechatSources.map((source) => <label key={source.id} className={sourceIds.includes(source.id) ? "source-row selected" : "source-row"}><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={() => setSourceIds(toggle(sourceIds, source.id))} /><span className="source-logo">微</span><div><strong>{source.name}</strong><p>{source.coverage || "公众号历史文章"}</p></div><em>微信公众号</em></label>)}</div>
          </div> : <div>
            <div className="section-intro"><p>已选择 {sourceIds.length} / {websiteSources.length} 个来源。系统会优先扫描站点栏目、RSS 和站点地图。</p><button className="ghost small" onClick={() => setSourceIds(sourceIds.length === websiteSources.length ? [] : websiteSources.map((source) => source.id))}>切换全选</button></div>
            <div className="source-picker">
              {websiteSources.length === 0 && <Empty text="请先到“监测来源”导入信息来源.xlsx 或手工添加站点。" />}
              {websiteSources.map((source) => (
                <label key={source.id} className={sourceIds.includes(source.id) ? "source-row selected" : "source-row"}>
                  <input type="checkbox" checked={sourceIds.includes(source.id)} onChange={() => setSourceIds(toggle(sourceIds, source.id))} />
                  <span className="source-logo">{source.name.slice(0, 1)}</span>
                  <div><strong>{source.name}</strong><p>{source.coverage || new URL(source.url).hostname}</p></div><em>{source.type}</em>
                </label>
              ))}
            </div>
          </div>
        )}
        {step === 4 && (
          acquisitionMode === "project-intel" ? <div className="form-section">
            <div className="info-card project-intel-capability"><span>✓</span><div><strong>无需额外模型或搜索服务</strong><p>项目列表已经提供名称、国家、规模、开发商、EPC、阶段、正文和收录时间。本模式直接映射结构化字段，可减少外部请求和模型费用。</p></div></div>
            <div className="project-intel-policy"><strong>结果复核</strong><p>Project Intel 属于二手聚合信息，导入结果会自动进入人工复核，并保留原项目链接与完整字段证据。</p></div>
          </div> : acquisitionMode === "wechat" ? <div className="form-section">
            {wechatOutputMode === "fulltext" ? <div className="info-card project-intel-capability"><span>文</span><div><strong>全文归档无需大模型</strong><p>系统取得文章完整正文后直接归档；导出固定为账号、日期、标题、正文四列，不产生项目结果和模型费用。</p></div></div> : <>
            <div className="form-grid">
              <label><span>全文理解模型供应商（必选）</span><select value={providerId} onChange={(e) => void chooseProvider(e.target.value)}><option value="">选择模型供应商</option>{providers.filter((provider) => provider.enabled).map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.hasSecret ? "密钥已保存" : "缺少密钥"}</option>)}</select></label>
              <label><span>模型（必选）</span><select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!providerId}><option value="">选择模型</option>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>
            </div>
            <div className="info-card project-intel-capability"><span>AI</span><div><strong>全文理解与现有字段抽取</strong><p>模型会判断文章是否包含真实海外新能源项目；一篇文章可拆分为多个项目，并按现有字段逐项提取原文证据。超长文章会自动分段理解后合并去重。</p></div></div>
            <div className="project-intel-policy"><strong>可审计结果</strong><p>系统会保存文章标题、公众号、发布日期、原始链接与全文，并将每个输出字段绑定到原文证据；无关文章保留分类日志但不会形成项目结果。</p></div>
            </>}
          </div> : <div className="form-section">
            <div className="form-grid">
              <label><span>抽取模型供应商</span><select value={providerId} onChange={(e) => void chooseProvider(e.target.value)}><option value="">仅规则抽取</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
              <label><span>模型</span><select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!providerId}><option value="">选择模型</option>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>
            </div>
            <h3 className="form-subtitle">搜索 API</h3>
            <div className="check-list">{webSearchProviders.map((item) => <CheckLine key={item.id} checked={searchIds.includes(item.id)} label={item.name} meta={`${item.kind} · ${item.hasSecret ? "密钥已保存" : "未设置密钥"}`} onChange={() => setSearchIds(toggle(searchIds, item.id))} />)}{webSearchProviders.length === 0 && <Empty text="未配置通用搜索 API；仍可扫描已选网站。" />}</div>
            <h3 className="form-subtitle">MCP 服务器</h3>
            <div className="info-card"><span>⇉</span><div><strong>并行执行</strong><p>可以同时勾选多个 MCP。任务启动后会并行连接各服务器，并自动调用其 crawl、scrape、search、map 等适用工具；单个 MCP 失败不会阻断其他服务器。</p></div></div>
            <div className="check-list">{mcpServers.map((item) => <CheckLine key={item.id} checked={mcpIds.includes(item.id)} label={item.name} meta={`${item.transport} · 并行调用`} onChange={() => setMcpIds(toggle(mcpIds, item.id))} />)}{mcpServers.length === 0 && <Empty text="未连接外部 MCP；本应用自身的 MCP 服务仍然可用。" />}</div>
          </div>
        )}
        {step === 5 && (
          <div className="form-section">
            <div className="budget-grid">
              <BudgetInput label={acquisitionMode === "project-intel" ? "最大导入项目数" : acquisitionMode === "wechat" ? "最大处理文章数" : "最大抓取页数"} value={budget.maxPages} onChange={(value) => setBudget({ ...budget, maxPages: value })} />
              {acquisitionMode === "web" && <><BudgetInput label="最大搜索次数" value={budget.maxSearches} min={0} onChange={(value) => setBudget({ ...budget, maxSearches: value })} /><BudgetInput label="运行时长参考（分钟，不截断）" value={budget.maxMinutes} onChange={(value) => setBudget({ ...budget, maxMinutes: value })} /><BudgetInput label="并发数" value={budget.maxConcurrency} onChange={(value) => setBudget({ ...budget, maxConcurrency: value })} /><BudgetInput label="模型费用上限（USD）" value={budget.maxCostUsd} min={0} step={0.5} onChange={(value) => setBudget({ ...budget, maxCostUsd: value })} /></>}
              {acquisitionMode === "wechat" && <><BudgetInput label="大家啦 API 费用上限（CNY）" value={wechatMaxApiCostCny} min={0.16} step={0.1} onChange={setWechatMaxApiCostCny} />{wechatOutputMode === "projects" && <BudgetInput label="模型费用上限（USD）" value={budget.maxCostUsd} min={0} step={0.5} onChange={(value) => setBudget({ ...budget, maxCostUsd: value })} />}</>}
            </div>
            {acquisitionMode === "project-intel" && <div className="project-intel-policy"><strong>访问频率已固定为保守模式</strong><p>并发 1 · 每页 20 条 · 分页间隔至少 3 秒 · 限流后等待重试。为了保护目标站点，此处不开放提高并发或缩短间隔。</p></div>}
            {acquisitionMode === "wechat" && <div className="project-intel-policy"><strong>费用和调用保护</strong><p>每个账号先分页读取历史发布记录，再对时间范围内文章调用详情接口取得正文（约 ¥0.03/篇）。任务串行、遇到临时错误有限退避，并在费用上限前停止新增请求。</p></div>}
            {acquisitionMode === "web" && <CheckLine
              checked={ignoreRobots}
              label="模拟真人浏览器访问，忽略 robots.txt 抓取限制"
              meta="仅限公开页面、个人研究用途；遇到反爬拦截时自动切换无头浏览器完整加载页面"
              onChange={() => setIgnoreRobots(!ignoreRobots)}
            />}
            <CheckLine
              checked={overseasOnly}
              label="仅统计海外项目，自动排除中国境内项目"
              meta="国家字段为中国境内的项目不计入监测结果；项目周报/盘点页会由模型逐条拆分抽取"
              onChange={() => setOverseasOnly(!overseasOnly)}
            />
            {preflightWarnings.length > 0 && <div className="preflight-warning"><strong>启动前请检查</strong>{preflightWarnings.map((warning) => <p key={warning}>• {warning}</p>)}</div>}
            <div className="summary-card">
              <h3>本次监测摘要</h3>
              <div><span>输出</span><strong>{acquisitionMode === "wechat" && wechatOutputMode === "fulltext" ? "账号、日期、标题、正文" : `${fieldIds.length} 个项目字段`}</strong></div>
              <div><span>时间</span><strong>{startDate} 至 {endDate}</strong></div>
              <div><span>来源</span><strong>{acquisitionMode === "project-intel" ? "Project Intel" : acquisitionMode === "wechat" ? "微信公众号" : `${sourceIds.length} 个`}</strong></div>
              {acquisitionMode === "project-intel" ? <div><span>访问策略</span><strong>串行低频 · 列表接口</strong></div> : acquisitionMode === "wechat" ? <><div><span>账号</span><strong>{sourceIds.length} 个已导入公众号</strong></div><div><span>结果模式</span><strong>{wechatOutputMode === "fulltext" ? "全文归档导出" : "按项目字段分析"}</strong></div>{wechatOutputMode === "projects" && <div><span>模型</span><strong>{modelId || "未选择"}</strong></div>}<div><span>API 上限</span><strong>¥{wechatMaxApiCostCny.toFixed(2)}</strong></div></> : <><div><span>参考项目</span><strong>{referenceRows.length || "无"}</strong></div><div><span>模型</span><strong>{modelId || "仅规则抽取"}</strong></div><div><span>外部搜索</span><strong>{searchIds.length} 个</strong></div><div><span>并行 MCP</span><strong>{mcpIds.length} 个</strong></div></>}
            </div>
          </div>
        )}
        <div className="wizard-footer">
          <button className="ghost" disabled={step === 1} onClick={() => setStep((value) => Math.max(1, value - 1))}>← 上一步</button>
          {step < 5
            ? <button className="primary" onClick={() => setStep((value) => Math.min(5, value + 1))}>下一步 →</button>
            : <button className="primary launch" disabled={busy || (wechatOutputMode !== "fulltext" && !fieldIds.length) || (acquisitionMode === "web" && !sourceIds.length) || (acquisitionMode === "wechat" && (!wechatProviderId || !sourceIds.length || (wechatOutputMode === "projects" && (!providerId || !modelId))))} onClick={() => void start()}>{busy ? "正在创建…" : acquisitionMode === "project-intel" ? "启动批量采集" : acquisitionMode === "wechat" ? "启动微信公众号监测" : "启动监测与爬取"}</button>}
        </div>
      </section>
    </div>
  );
}

function ResultsView({ scans, activeScan, activeScanId, setActiveScanId, results, fields, refresh, notify, onError, onOpenSources, onOpenSkill }: {
  scans: Scan[]; activeScan?: Scan; activeScanId: string; setActiveScanId: (id: string) => void; results: Result[]; fields: Field[];
  refresh: () => Promise<void>; notify: (message: string) => void; onError: (message: string) => void;
  onOpenSources: () => void; onOpenSkill: () => void;
}) {
  const [expanded, setExpanded] = useState("");
  const [filter, setFilter] = useState("all");
  const [logs, setLogs] = useState<ScanLog[]>([]);
  const [logLevel, setLogLevel] = useState("all");
  const [logStage, setLogStage] = useState("all");
  const [selectedFailure, setSelectedFailure] = useState("");
  const [repairingBilingual, setRepairingBilingual] = useState("");
  const [assessingPending, setAssessingPending] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const [fullTexts, setFullTexts] = useState<Record<string, { title: string; url: string; publishedAt?: string; text: string; warnings?: string[] }>>({});
  const [loadingFullText, setLoadingFullText] = useState("");
  const isWechatScan = activeScan?.request?.acquisitionMode === "wechat";
  const activeWechatRequest = activeScan?.request?.wechat && typeof activeScan.request.wechat === "object" ? activeScan.request.wechat as Json : undefined;
  const isWechatFullTextMode = isWechatScan && activeWechatRequest?.outputMode === "fulltext";
  const filtered = results.filter((result) => filter === "all" || result.status === filter);
  const unresolvedResults = results.filter((result) => !["approved", "auto_approved"].includes(result.status));
  const visibleLogs = logs.filter((log) => (logLevel === "all" || log.level === logLevel) && (logStage === "all" || log.stage === logStage));
  const failureReasons = (activeScan?.progress.failureReasons && typeof activeScan.progress.failureReasons === "object"
    ? activeScan.progress.failureReasons : {}) as Record<string, number>;
  const failureDetails = selectedFailure ? logs.filter((log) => failureLogMatches(log, selectedFailure)) : [];
  const sourceCoverage = activeScan?.progress.sourceCoverage && typeof activeScan.progress.sourceCoverage === "object"
    ? activeScan.progress.sourceCoverage as Record<string, unknown> : undefined;
  const sourceCoverageItems = Array.isArray(sourceCoverage?.sources) ? sourceCoverage.sources as SourceCoverageItem[] : [];
  const serverRecall = activeScan?.progress.recall && typeof activeScan.progress.recall === "object"
    ? activeScan.progress.recall as Record<string, unknown> : undefined;
  const historicalBaseline = activeScan ? scans.filter((scan) => {
    if (scan.id === activeScan.id || scan.status !== "completed") return false;
    const activeSources = Array.isArray(activeScan.request?.sourceIds) ? [...activeScan.request.sourceIds].map(String).sort() : [];
    const scanSources = Array.isArray(scan.request?.sourceIds) ? [...scan.request.sourceIds].map(String).sort() : [];
    return activeScan.request?.startDate === scan.request?.startDate && activeScan.request?.endDate === scan.request?.endDate &&
      activeSources.length === scanSources.length && activeSources.every((id, index) => id === scanSources[index]);
  }).sort((left, right) => Number(right.progress.results ?? 0) - Number(left.progress.results ?? 0))[0] : undefined;
  const recall = serverRecall ?? (historicalBaseline && Number(historicalBaseline.progress.results ?? 0) > results.length ? {
    status: "regressed", legacy: true, resultCount: results.length,
    baselineScanId: historicalBaseline.id, baselineResultCount: Number(historicalBaseline.progress.results ?? 0),
  } : undefined);
  const recallRegression = recall?.status === "regressed";
  const zeroResultInsight = activeScan && !isWechatFullTextMode && ["completed", "failed", "stopped"].includes(activeScan.status) && results.length === 0
    ? (() => {
        const progress = activeScan.progress;
        const selected = Array.isArray(activeScan.request?.sourceIds) ? activeScan.request.sourceIds.length : Number(progress.sourcesTotal ?? 0);
        const scanned = Number(progress.sourcesScanned ?? 0);
        const fetched = Number(progress.pagesFetched ?? 0);
        const within = Number(progress.withinRange ?? 0);
        const modelCalls = Number(progress.modelExtractions ?? 0);
        if (activeScan.request?.acquisitionMode === "wechat") {
          const examined = Number(progress.wechatArticlesExamined ?? 0);
          const fullText = Number(progress.fullTextSucceeded ?? 0);
          const cost = Number(progress.dajialaApiCostCny ?? 0).toFixed(2);
          if (fullText === 0) return `大家啦 API 共检查 ${examined} 篇文章，但没有获得所选日期范围内的可用全文；本次接口花费 ¥${cost}。请检查账号定位、日期、API 余额和任务日志。`;
          if (modelCalls === 0) return `已获得 ${fullText} 篇微信全文，但模型没有完成调用；请检查模型供应商、模型选择和密钥。`;
          return `已对 ${fullText} 篇微信全文完成 ${modelCalls} 次模型理解，但没有形成满足海外项目与字段证据要求的结果。`;
        }
        const singleDay = activeScan.request?.startDate === activeScan.request?.endDate;
        if (within === 0) return `实际扫描 ${scanned}/${selected} 个来源、抓取 ${fetched} 页，但没有网页发布日期落在所选${singleDay ? "单日" : "时间范围"}内，因此模型调用为 ${modelCalls}，项目判定阶段没有输入。`;
        if (modelCalls === 0) return `已有 ${within} 篇范围内页面，但模型没有被调用；请检查模型选择和分类日志。`;
        return `已有 ${within} 篇范围内页面并完成 ${modelCalls} 次模型抽取，但没有形成满足项目事件与证据要求的结果。`;
      })()
    : "";
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectedFailure("");
      if (!activeScanId) { setLogs([]); return; }
      void api<ScanLog[]>(`/api/scans/${activeScanId}/logs?limit=2000`).then(setLogs).catch(() => setLogs([]));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeScanId, scans]);
  async function control(action: "pause" | "resume" | "stop") {
    try {
      await api(`/api/scans/${activeScanId}/${action}`, { method: "POST", body: "{}" });
      notify(action === "pause" ? "暂停指令已发送" : action === "resume" ? "任务已继续" : "停止指令已发送，已完成数据会保留");
      await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function removeScan() {
    if (!activeScan || !window.confirm(`确定删除任务 ${activeScan.id.slice(0, 8)} 吗？\n\n该任务的结果、网页正文、日志和导出文件将被永久删除。`)) return;
    try {
      await api(`/api/scans/${activeScan.id}`, { method: "DELETE" });
      const nextId = scans.find((scan) => scan.id !== activeScan.id)?.id ?? "";
      setActiveScanId(nextId); setExpanded(""); setLogs([]);
      notify("监测任务已删除");
      await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function assessPending() {
    setAssessingPending(true);
    try {
      const outcome = await api<{ started: boolean; alreadyRunning: boolean; pending: number }>(
        `/api/scans/${activeScanId}/assess-pending`, { method: "POST", body: "{}" });
      notify(outcome.started
        ? `补跑评估已开始：${outcome.pending} 个页面待评估，结果将陆续出现在下方列表`
        : outcome.alreadyRunning ? "补跑评估正在进行中" : "没有待评估的页面");
      await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAssessingPending(false); }
  }
  async function decide(id: string, decision: string) {
    try { await api(`/api/results/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) }); notify("审核决定已保存"); await refresh(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function approveAll() {
    if (!activeScanId || !unresolvedResults.length) return;
    if (!window.confirm(`确定一键确认当前任务的 ${unresolvedResults.length} 条尚未确认结果吗？\n\n其中包括“待审核”和“低置信度”结果。确认后仍可逐条重新驳回。`)) return;
    setApprovingAll(true);
    try {
      const outcome = await api<{ approved: number }>(`/api/scans/${activeScanId}/approve-all`, {
        method: "POST", body: "{}",
      });
      setExpanded("");
      notify(outcome.approved ? `已确认 ${outcome.approved} 条结果` : "当前任务没有需要确认的结果");
      await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setApprovingAll(false); }
  }
  function toggleResultDetails(id: string) {
    const opening = expanded !== id;
    setExpanded(opening ? id : "");
    if (!opening) return;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.getElementById(`result-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }
  async function deep(id: string) {
    notify("已启动定向扩散监测，请稍候");
    try { await api(`/api/results/${id}/deep-expand`, { method: "POST", body: JSON.stringify({ maxQueries: 12, maxPages: 20 }) }); notify("深度扩散已完成，结果已生成新修订"); await refresh(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function repairBilingual(id: string) {
    setRepairingBilingual(id);
    try {
      await api(`/api/results/${id}/repair-bilingual`, { method: "POST", body: "{}" });
      notify("中英双语字段与证据已重新提炼；请复核后确认结果");
      await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRepairingBilingual(""); }
  }
  async function loadFullText(result: Result) {
    if (!result.documentId || fullTexts[result.documentId]) return;
    setLoadingFullText(result.documentId);
    try {
      const content = await api<{ title: string; url: string; publishedAt?: string; text: string; warnings?: string[] }>(`/api/documents/${result.documentId}/fulltext`);
      setFullTexts((current) => ({ ...current, [result.documentId!]: content }));
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingFullText(""); }
  }
  return (
    <div className="stack">
      {recallRegression && <section className="recall-warning panel">
        <div><strong>召回结果低于同口径历史基线</strong><span>需要复核</span></div>
        {recall?.legacy
          ? <><p>本次只识别 {Number(recall?.resultCount ?? 0)} 个项目；同日期、同来源的历史任务识别到 {Number(recall?.baselineResultCount ?? 0)} 个。这次结果存在明显漏检，不能视为“项目减少”。</p><small>这是旧版任务的回溯诊断；重新发起同口径监测后，系统会自动回查历史项目网页并逐条重新验证。</small></>
          : <><p>系统已自动回查历史项目网页，但本次仍只识别 {Number(recall?.resultCount ?? 0)} 个项目（已确认 {Number(recall?.acceptedCount ?? 0)} 个）；同日期、同来源基线为 {Number(recall?.baselineResultCount ?? 0)} 个（已确认 {Number(recall?.baselineAcceptedCount ?? 0)} 个）。这不是“没有项目”的结论。</p><small>历史网页回查成功 {Number(recall?.baselineUrlsRevalidated ?? 0)}/{Number(recall?.baselineUrlsAttempted ?? 0)}；请在下方筛选 recall 与 model 日志定位剩余缺口。</small></>}
      </section>}
      <section className="task-bar panel">
        <label><span>监测任务</span><select value={activeScanId} onChange={(e) => setActiveScanId(e.target.value)}><option value="">选择任务</option>{scans.map((scan) => <option key={scan.id} value={scan.id}>{scan.id.slice(0, 8)} · {statusLabel(scan.status)}</option>)}</select></label>
        {activeScan && <><ProgressRing value={Number(activeScan.progress.percent ?? 0)} /><div className="task-summary"><strong>{statusLabel(activeScan.status)}</strong><span>{isWechatScan ? `${Number(activeScan.progress.wechatArticlesExamined ?? 0)} 篇已检查 · ${Number(activeScan.progress.fullTextSucceeded ?? 0)} 篇全文 · ${Number(activeScan.progress.withinRange ?? 0)} 篇在时间范围内${isWechatFullTextMode ? " · 全文归档模式" : ` · ${Number(activeScan.progress.results ?? 0)} 个项目`}` : `${Number(activeScan.progress.pagesDiscovered ?? 0)} 个文章链接 · ${Number(activeScan.progress.pagesFetched ?? 0)} 页已抓取 · ${Number(activeScan.progress.withinRange ?? 0)} 篇在时间范围内 · ${Number(activeScan.progress.results ?? 0)} 个项目`}</span><small>{isWechatScan ? `大家啦 API ¥${Number(activeScan.progress.dajialaApiCostCny ?? 0).toFixed(2)} · 余额 ${activeScan.progress.dajialaRemainMoney == null ? "未返回" : `¥${Number(activeScan.progress.dajialaRemainMoney).toFixed(2)}`} · ${isWechatFullTextMode ? "未调用大模型" : `模型理解 ${Number(activeScan.progress.modelExtractions ?? 0)} · 项目提及 ${Number(activeScan.progress.projectMentions ?? 0)}`} · 失败 ${Number(activeScan.progress.failures ?? 0)}` : `网站处理 ${Number(sourceCoverage?.settled ?? activeScan.progress.sourcesScanned ?? 0)}/${Number(sourceCoverage?.total ?? activeScan.progress.sourcesTotal ?? 0)} · 成功 ${Number(sourceCoverage?.succeeded ?? 0)} · 失败 ${Number(sourceCoverage?.failed ?? 0)} · 全文成功 ${Number(activeScan.progress.fullTextSucceeded ?? 0)} · 动态渲染 ${Number(activeScan.progress.dynamicPages ?? 0)} · MCP ${Number(activeScan.progress.mcpCalls ?? 0)}/${Number(activeScan.progress.mcpFailures ?? 0)} · 日期不明/冲突 ${Number(activeScan.progress.dateUnknown ?? 0)}/${Number(activeScan.progress.dateConflict ?? 0)} · 非项目/待复核 ${Number(activeScan.progress.nonProjectArticles ?? 0)}/${Number(activeScan.progress.uncertainArticles ?? 0)} · 失败事件 ${Number(activeScan.progress.failures ?? 0)}`}</small></div><div className="scan-controls">{activeScan.status === "running" && <button className="ghost small" onClick={() => void control("pause")}>Ⅱ 暂停</button>}{activeScan.status === "paused" && <button className="primary small" onClick={() => void control("resume")}>▶ 继续</button>}{["queued","running","paused"].includes(activeScan.status) && <button className="danger-ghost small" onClick={() => void control("stop")}>■ 停止</button>}{!isWechatFullTextMode && ["failed","stopped"].includes(activeScan.status) && (Number(activeScan.progress.withinRange ?? 0) + Number(activeScan.progress.dateUnknown ?? 0) + Number(activeScan.progress.dateConflict ?? 0)) > 0 && <button className="primary small" disabled={assessingPending} onClick={() => void assessPending()}>{assessingPending ? "评估中…" : "⇪ 补跑评估"}</button>}{["completed","failed","stopped"].includes(activeScan.status) && <button className="danger-ghost small" onClick={() => void removeScan()}>⌫ 删除任务</button>}</div></>}
      </section>
      {sourceCoverage && <section className={`source-coverage panel ${Number(sourceCoverage.failed ?? 0) > 0 ? "has-failures" : ""}`}>
        <div className="source-coverage-head"><div><strong>{isWechatScan ? "公众号账号处理" : "选定网站覆盖"}</strong><p>{isWechatScan ? `按已导入账号读取历史文章并取得全文；${isWechatFullTextMode ? "本任务直接归档，不进行项目分析。" : "随后由大模型按现有项目字段分析。"}` : Boolean(sourceCoverage.allSettled) ? `全部 ${Number(sourceCoverage.total ?? 0)} 个网站均已完成处理；失败网站不会被记作成功，但也不会阻断其他网站。` : `正在处理：已结算 ${Number(sourceCoverage.settled ?? 0)}/${Number(sourceCoverage.total ?? 0)} 个网站。任务只有在全部结算后才能完成。`}</p></div><div><span className="ok">成功 {Number(sourceCoverage.succeeded ?? 0)}</span><span className="bad">失败 {Number(sourceCoverage.failed ?? 0)}</span><span>运行中 {Number(sourceCoverage.running ?? 0)}</span><span>待处理 {Number(sourceCoverage.pending ?? 0)}</span></div></div>
        <details><summary>查看全部网站状态与失败原因</summary><div className="source-coverage-list">{sourceCoverageItems.map((source) => <article className={source.status} key={source.sourceId}><span>{source.status === "completed" ? "✓" : source.status === "failed" ? "!" : source.status === "running" ? "↻" : "·"}</span><div><strong>{source.name}</strong><small>{source.url || source.sourceId}</small><p>发现 {source.discovered} · 抓取 {source.fetched} · 正文成功 {source.succeeded}{source.error ? ` · ${source.error}` : ""}</p></div></article>)}</div></details>
      </section>}
      {(activeScan?.error || Object.keys(failureReasons).length > 0) && <section className="failure-summary panel"><div><span>!</span><strong>{activeScan?.status === "failed" ? "任务失败原因" : "已记录的失败分类"}</strong></div>{activeScan?.error && <p>{activeScan.error}</p>}<div className="failure-chips">{Object.entries(failureReasons).map(([reason, count]) => <button className={selectedFailure === reason ? "active" : ""} key={reason} onClick={() => setSelectedFailure(selectedFailure === reason ? "" : reason)}>{failureReasonLabel(reason)} · {count}</button>)}</div>{selectedFailure && <div className="failure-detail"><div className="failure-detail-head"><div><strong>{failureReasonLabel(selectedFailure)}明细</strong><p>显示可审计原始错误、来源和网址，可据此修订信息源或生成 Skill 迭代建议。</p></div><div><button className="ghost small" onClick={onOpenSources}>修改信息源</button><button className="primary small" onClick={onOpenSkill}>交给 Skill 优化</button></div></div>{failureDetails.length ? <div className="failure-detail-list">{failureDetails.map((log) => <details key={log.id}><summary><span>{log.context.source ? String(log.context.source) : log.stage}</span><strong>{log.message.split("\n")[0]}</strong><time>{new Date(log.createdAt).toLocaleString("zh-CN")}</time></summary><dl><div><dt>阶段/事件</dt><dd>{log.stage} / {log.event}</dd></div>{Boolean(log.context.url) && <div><dt>网址</dt><dd><a href={String(log.context.url)} target="_blank" rel="noreferrer">{String(log.context.url)}</a></dd></div>}{log.context.attempts != null && <div><dt>尝试次数</dt><dd>{String(log.context.attempts)}</dd></div>}{Boolean(log.context.method) && <div><dt>采集方式</dt><dd>{String(log.context.method)}</dd></div>}<div><dt>完整错误</dt><dd><pre>{log.message}</pre></dd></div></dl></details>)}</div> : <p className="muted">当前日志中没有与该分类逐条对应的记录；可在下方完整日志中继续筛选。</p>}</div>}</section>}
      {zeroResultInsight && <section className="zero-result-insight panel"><strong>为什么没有结果</strong><p>{zeroResultInsight}</p></section>}
      {isWechatFullTextMode && <section className="info-card panel"><span>文</span><div><strong>全文归档任务不生成项目审核结果</strong><p>已归档 {Number(activeScan?.progress.fullTextSucceeded ?? 0)} 篇文章。请到“确认与导出”输出公众号账号、发布日期、文章标题、正文四列。</p></div></section>}
      <section className="panel">
        <div className="results-toolbar" id="structured-results">
          <div><h2>结构化结果</h2><p>点击一行查看字段证据、候选链接与冲突。</p></div>
          <div className="results-toolbar-actions">
            <button className="primary small approve-all" disabled={!activeScanId || !unresolvedResults.length || approvingAll} onClick={() => void approveAll()}>
              {approvingAll ? "正在确认…" : unresolvedResults.length ? `✓ 一键确认所有结果（${unresolvedResults.length}）` : "✓ 所有结果已确认"}
            </button>
            <div className="filters">
              {[["all","全部"],["auto_approved","自动通过"],["approved","已确认"],["review","待审核"],["rejected","低置信度"]].map(([id,label]) => <button className={filter === id ? "active" : ""} key={id} onClick={() => { setFilter(id); setExpanded(""); }}>{label}</button>)}
            </div>
          </div>
        </div>
        {!activeScanId && <Empty text="请先选择一个监测任务。" />}
        {activeScanId && filtered.length === 0 && !isWechatFullTextMode && <Empty text={activeScan?.status === "running" ? "监测仍在进行，结果会自动出现。" : "该筛选条件下没有结果。"} />}
        <div className="result-list">
          {filtered.map((result) => (
            <article id={`result-${result.id}`} className={expanded === result.id ? "result-card expanded" : "result-card"} key={result.id}>
              <button className="result-main" aria-expanded={expanded === result.id} aria-controls={`result-detail-${result.id}`} onClick={() => toggleResultDetails(result.id)}>
                <span className={`score score-${Math.floor(result.score / 20)}`}>{Math.round(result.score)}</span>
                <div className="result-title"><strong>{String(result.fields.project_name ?? "未命名项目")} {result.generatedFields?.includes("project_name") && <em className="generated-badge">系统提炼</em>}{isForeignResult(result) && <em className="bilingual-badge">中英双语 · {(result.sourceLanguage ?? "原文").toUpperCase()}</em>}</strong>{isForeignResult(result) && <small className="original-title" lang={result.sourceLanguage === "foreign" ? undefined : result.sourceLanguage}>原文：{result.originalFields?.project_name || "网页未提供独立项目名，中文名称由系统基于原文证据提炼"}</small>}<p>{String(result.fields.country ?? "")} · {capacityLabel(result.fields)} · 修订 {result.revision}</p></div>
                <StatusPill status={result.status} />
                <span className="chevron">{expanded === result.id ? "⌃" : "⌄"}</span>
              </button>
              {expanded === result.id && (
                <div className="result-detail" id={`result-detail-${result.id}`}>
                  <div className="evidence-grid">
                    <section><h3>{isForeignResult(result) ? "字段双语对照与验证" : "字段与证据"}</h3>{fields.filter((field) => hasDisplayValue(result.fields[field.id]) || hasDisplayValue(result.originalFields?.[field.id])).map((field) => <div className="evidence-row" key={field.id}><span>{field.label.replace("\n"," ")}</span><strong>{isForeignResult(result) && <small className="language-label">中文提炼</small>}<b>{String(result.fields[field.id] ?? "待补齐")}</b>{result.generatedFields?.includes(field.id) && <em className="generated-badge">提炼</em>}{isForeignResult(result) ? <small lang={result.sourceLanguage === "foreign" ? undefined : result.sourceLanguage}>原文（{(result.sourceLanguage ?? "original").toUpperCase()}）：{result.originalFields?.[field.id] || "原文未单独给出"}</small> : bilingualOriginal(result, field.id) && <small>原文：{result.originalFields?.[field.id]}</small>}</strong><div className="bilingual-evidence"><p><i>原文证据</i><EvidenceText text={result.evidence[field.id] || "该字段暂无截取证据，建议人工查看原文。"} values={evidenceValues(result, field.id)} /></p>{isForeignResult(result) ? <p className={result.evidenceTranslations?.[field.id] ? "translation" : "translation missing"}><i>中文验证</i>{result.evidenceTranslations?.[field.id] || "翻译待自动补齐；当前结果应人工复核"}</p> : result.evidenceTranslations?.[field.id] && result.evidenceTranslations[field.id] !== result.evidence[field.id] && <p className="translation"><i>中文验证</i>{result.evidenceTranslations[field.id]}</p>}{result.unitChecks?.[field.id] && <p className={result.unitChecks[field.id].startsWith("未通过") ? "unit-check bad" : "unit-check"}><i>单位核验</i>{result.unitChecks[field.id]}</p>}</div></div>)}</section>
                    <section><h3>来源与判断</h3><a className="source-link" href={result.primaryUrl || undefined} target="_blank" rel="noreferrer">{result.primaryUrl || "尚未找到可靠主链接"}</a><p className="muted">候选页面：{result.candidateUrls.length} 个</p>{isWechatScan && result.documentId && <div className="wechat-fulltext"><button className="ghost small" disabled={loadingFullText === result.documentId} onClick={() => void loadFullText(result)}>{loadingFullText === result.documentId ? "正在读取全文…" : fullTexts[result.documentId] ? "已加载微信全文" : "查看存档微信全文"}</button>{fullTexts[result.documentId] && <details><summary>{fullTexts[result.documentId].title || "微信文章全文"} · {fullTexts[result.documentId].publishedAt || "日期不明"}</summary><pre>{fullTexts[result.documentId].text}</pre></details>}</div>}{result.conflicts.length > 0 && <div className="conflict-box"><strong>需要注意</strong>{result.conflicts.map((item) => <p key={item}>• {item}</p>)}</div>}</section>
                  </div>
                  <div className="result-actions">
                    {!isWechatScan && <button className="ghost" onClick={() => void deep(result.id)}>⌕ 二次深度扩散</button>}
                    {isForeignResult(result) && <button className="ghost" disabled={repairingBilingual === result.id} onClick={() => void repairBilingual(result.id)}>{repairingBilingual === result.id ? "正在补齐双语…" : "中/EN 自动补齐双语"}</button>}
                    <button className="danger-ghost" onClick={() => void decide(result.id, "rejected")}>驳回</button>
                    <button className="primary" onClick={() => void decide(result.id, "approved")}>确认结果</button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      <section className="panel log-panel">
        <div className="results-toolbar"><div><h2>监测 LOG</h2><p>记录发现、抓取、动态渲染、模型判定、MCP 调用和失败原因，便于后续迭代。</p></div><div className="log-filters"><select value={logLevel} onChange={(e) => setLogLevel(e.target.value)}><option value="all">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option></select><select value={logStage} onChange={(e) => setLogStage(e.target.value)}><option value="all">全部阶段</option>{[...new Set(logs.map((log) => log.stage))].map((stage) => <option key={stage} value={stage}>{stage}</option>)}</select></div></div>
        <div className="log-list">{visibleLogs.length === 0 && <Empty text="当前任务还没有日志。" />}{visibleLogs.slice().reverse().map((log) => <details className={`log-row ${log.level}`} key={log.id}><summary><time>{new Date(log.createdAt).toLocaleTimeString("zh-CN")}</time><span>{log.level.toUpperCase()}</span><b>{log.stage}</b><p>{log.message}</p></summary>{Object.keys(log.context ?? {}).length > 0 && <pre>{JSON.stringify(log.context, null, 2)}</pre>}</details>)}</div>
      </section>
    </div>
  );
}

function SourcesView({ sources, refresh, notify, onError }: { sources: Source[]; refresh: () => Promise<void>; notify: (message: string) => void; onError: (message: string) => void }) {
  const blankSource = { id: "", name: "", url: "", coverage: "", type: "网址", enabled: true };
  const [form, setForm] = useState(blankSource);
  const [kind, setKind] = useState<"website" | "wechat">("website");
  const [accountMode, setAccountMode] = useState<"url" | "ghid">("url");
  const [accountIdentifier, setAccountIdentifier] = useState("");
  const [accountBatch, setAccountBatch] = useState("");
  const [checks, setChecks] = useState<Record<string, Json>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  async function check(source: Source) {
    setChecking((current) => ({ ...current, [source.id]: true }));
    setChecks((current) => { const next = { ...current }; delete next[source.id]; return next; });
    try {
      const result = await api<Json>(`/api/sources/${source.id}/check`, { method: "POST", body: "{}" });
      setChecks((current) => ({ ...current, [source.id]: result }));
      if (result.ok) notify(`「${source.name}」体检通过`);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking((current) => ({ ...current, [source.id]: false })); }
  }
  async function upload(file?: File) {
    if (!file) return;
    try {
      const result = await api<{ inserted: number }>("/api/sources/import", { method: "POST", body: JSON.stringify({ fileName: file.name, base64: await fileToBase64(file) }) });
      notify(`已导入 ${result.inserted} 个新来源`); await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function add() {
    try {
      const payload = kind === "wechat" ? { ...form, type: "微信公众号", url: accountMode === "url" ? accountIdentifier.trim() : `wechat://${accountMode}/${encodeURIComponent(accountIdentifier.trim())}` } : form;
      await api(form.id ? `/api/sources/${form.id}` : "/api/sources", { method: form.id ? "PUT" : "POST", body: JSON.stringify(payload) });
      setForm(blankSource); setAccountIdentifier(""); notify(form.id ? "信息源修改已保存" : kind === "wechat" ? "公众号账号已导入" : "来源已添加"); await refresh();
    }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function edit(source: Source) {
    const isWechat = source.type === "微信公众号";
    setKind(isWechat ? "wechat" : "website");
    setForm({ id: source.id, name: source.name, url: source.url, coverage: source.coverage, type: source.type, enabled: source.enabled });
    if (isWechat) {
      const matched = source.url.match(/^wechat:\/\/(ghid)\/(.+)$/i);
      setAccountMode(matched ? "ghid" : "url");
      setAccountIdentifier(matched ? decodeURIComponent(matched[2]) : source.url);
    }
  }
  async function importAccounts() {
    const rows = accountBatch.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, identifier = ""] = line.split(/\s*[|,，\t]\s*/, 2);
      const url = /^https?:\/\/mp\.weixin\.qq\.com\//i.test(identifier) ? identifier : `wechat://ghid/${encodeURIComponent(identifier)}`;
      return { name, identifier, url };
    });
    if (!rows.length) return onError("请至少粘贴一行公众号账号");
    try {
      let inserted = 0;
      for (const row of rows) {
        await api("/api/sources", { method: "POST", body: JSON.stringify({ name: row.name, type: "微信公众号", url: row.url, coverage: "公众号历史文章", enabled: true }) });
        inserted++;
      }
      setAccountBatch(""); await refresh(); notify(`已导入 ${inserted} 个公众号账号`);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function remove(source: Source) {
    if (!window.confirm(`确定删除信息源“${source.name}”吗？\n\n历史任务与已采集网页不会被删除。`)) return;
    try { await api(`/api/sources/${source.id}`, { method: "DELETE" }); if (form.id === source.id) setForm(blankSource); notify("信息源已删除"); await refresh(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return (
    <div className="stack">
      <div className="period-mode" role="tablist" aria-label="来源类型"><button className={kind === "website" ? "active" : ""} onClick={() => { setKind("website"); setForm(blankSource); }}>网站来源（{sources.filter((source) => source.type !== "微信公众号").length}）</button><button className={kind === "wechat" ? "active" : ""} onClick={() => { setKind("wechat"); setForm({ ...blankSource, type: "微信公众号" }); }}>微信公众号（{sources.filter((source) => source.type === "微信公众号").length}）</button></div>
    <div className="two-col settings-cols">
      <section className="panel">
        <PanelHeader title={kind === "wechat" ? "公众号账号库" : "网站来源库"} subtitle={kind === "wechat" ? "这些账号可在新建微信监测时多选" : "用于多来源网页监测"} />
        <div className="settings-list">{sources.filter((source) => kind === "wechat" ? source.type === "微信公众号" : source.type !== "微信公众号").map((source) => <div key={source.id}><div className="settings-row"><span className="source-logo">{kind === "wechat" ? "微" : source.name.slice(0,1)}</span><div><strong>{source.name}</strong><p>{source.url.replace(/^wechat:\/\/ghid\//, "")}</p>{source.coverage && <small>{source.coverage}</small>}</div><StatusPill status={source.enabled ? "approved" : "rejected"} /><div className="row-actions"><button className="ghost small" disabled={Boolean(checking[source.id])} onClick={() => void check(source)}>{checking[source.id] ? "体检中…" : "体检"}</button><button className="ghost small" onClick={() => edit(source)}>编辑</button><button className="danger-ghost small" onClick={() => void remove(source)}>删除</button></div></div>{checks[source.id] && <pre className="test-result">{JSON.stringify(checks[source.id], null, 2)}</pre>}</div>)}</div>
      </section>
      <section className="stack">
        {kind === "website" ? <div className="panel form-card">
          <h2>批量导入</h2><p>支持当前“信息源名称、信息源类型、覆盖范围、网址、提出者”格式，也支持 CSV。</p>
          <label className="upload-box"><input type="file" accept=".xlsx,.csv" onChange={(e) => void upload(e.target.files?.[0])} /><span>⇧</span><div><strong>选择 XLSX 或 CSV</strong><p>系统会裁剪异常空白行、补全网址协议并跳过重复来源</p></div></label>
        </div> : <div className="panel form-card"><h2>批量导入公众号</h2><p>每行填写“显示名称 | 账号标识”。账号标识使用该账号任意一篇文章链接，或 gh_ 开头的公众号原始 ID。</p><label><span>公众号列表</span><textarea value={accountBatch} onChange={(event) => setAccountBatch(event.target.value)} placeholder={"海外电力观察 | https://mp.weixin.qq.com/s/...\n储能前沿 | gh_xxxxxxxxxxxx"} /></label><button className="ghost full" onClick={() => void importAccounts()}>导入这些账号</button></div>}
        <div className="panel form-card">
          <div className="form-card-head"><div><h2>{form.id ? "修改信息源" : kind === "wechat" ? "导入单个公众号" : "手工添加"}</h2><p>{form.id ? "修改会用于后续监测，历史任务保持原样。" : kind === "wechat" ? "建议用任意文章链接精确定位同名账号。" : "补充单个监测站点。"}</p></div>{form.id && <button className="ghost small" onClick={() => { setForm(blankSource); setAccountIdentifier(""); }}>取消编辑</button>}</div>
          <label><span>{kind === "wechat" ? "公众号显示名称" : "来源名称"}</span><input value={form.name} onChange={(e) => setForm({...form,name:e.target.value})} placeholder={kind === "wechat" ? "例如：海外电力观察" : "例如：中国能建"} /></label>
          {kind === "wechat" ? <><label><span>账号定位方式</span><select value={accountMode} onChange={(event) => setAccountMode(event.target.value as "url" | "ghid")}><option value="url">任意文章链接（推荐）</option><option value="ghid">公众号原始 ID（ghid）</option></select></label><label><span>账号标识</span><input value={accountIdentifier} onChange={(event) => setAccountIdentifier(event.target.value)} placeholder={accountMode === "url" ? "https://mp.weixin.qq.com/s/..." : "gh_xxxxxxxxxxxx"} /></label></> : <label><span>网址</span><input value={form.url} onChange={(e) => setForm({...form,url:e.target.value})} placeholder="https://…" /></label>}
          <label><span>覆盖范围</span><textarea value={form.coverage} onChange={(e) => setForm({...form,coverage:e.target.value})} placeholder="说明这个来源适合监测的内容" /></label>
          <label className="source-enabled"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({...form,enabled:e.target.checked})} /><span>用于后续监测</span></label>
          <button className="primary full" onClick={() => void add()}>{form.id ? "保存修改" : kind === "wechat" ? "导入公众号账号" : "保存来源"}</button>
        </div>
      </section>
    </div>
    </div>
  );
}

function connectionErrorMessage(message: string) {
  if (/405|not allowed/i.test(message)) return "服务地址或请求方式不匹配。请确认 Base URL 后重新检测。";
  if (/API Key|key或附加码|10002|unauthorized|401/i.test(message)) return "访问密钥、Token 或附加码未通过验证，请检查后重新保存。";
  if (/余额不足|20001/i.test(message)) return "接口账户余额不足，需要充值后才能继续使用。";
  if (/timeout|timed out|超时/i.test(message)) return "服务响应超时。请检查网络，稍后重新检测。";
  if (/fetch failed|network|connect|ENOTFOUND|ECONN/i.test(message)) return "暂时无法连接远端服务，请检查网络、代理或服务地址。";
  return "连接没有通过。可以检查配置后重新检测，技术详情已折叠保留。";
}

function connectionStage(kind: "dajiala" | "search" | "browser", elapsed: number) {
  if (elapsed < 2) return kind === "dajiala" ? "正在安全读取本地密钥" : "正在准备连接参数";
  if (elapsed < 5) return kind === "dajiala" ? "正在连接大家啦余额服务" : kind === "browser" ? "正在联系渲染服务" : "正在发送测试搜索";
  return "远端响应较慢，仍在等待，请不要关闭页面";
}

function ModelsView({ providers, refresh, notify, onError }: { providers: Provider[]; refresh: () => Promise<void>; notify: (message: string) => void; onError: (message: string) => void }) {
  const emptyForm = { name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com", apiKey: "", headers: {} as Record<string, string>, config: {} as Json };
  const [form, setForm] = useState<{ id?: string; name: string; kind: string; baseUrl: string; apiKey: string; headers: Record<string, string>; config: Json }>({...emptyForm});
  const [selected, setSelected] = useState("");
  const [models, setModels] = useState<{ id: string; name: string; capabilities?: Json }[]>([]);
  const [keyword, setKeyword] = useState("");
  const [test, setTest] = useState<ModelDiagnostic | null>(null);
  const [history, setHistory] = useState<{ id: string; ok: boolean; createdAt: string }[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedProvider = providers.find((provider) => provider.id === selected);

  function resetForm() {
    setForm({...emptyForm}); setSelected(""); setModels([]); setHistory([]); setTest(null); setCatalogError("");
  }
  async function selectProvider(provider: Provider) {
    setSelected(provider.id); setModels([]); setTest(null); setCatalogError("");
    setForm({
      id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl,
      apiKey: "", headers: provider.headers ?? {}, config: provider.config ?? {},
    });
    try {
      setHistory(await api<{ id: string; ok: boolean; createdAt: string }[]>(`/api/providers/${provider.id}/diagnostics`));
    } catch (cause) {
      setCatalogError(`无法读取检测记录：${providerErrorMessage(cause)}`);
    }
  }
  async function save() {
    setSaving(true);
    try {
      const item = await api<Provider>("/api/providers", { method: "POST", body: JSON.stringify(form) });
      setForm({
        id: item.id, name: item.name, kind: item.kind, baseUrl: item.baseUrl, apiKey: "",
        headers: item.headers ?? form.headers, config: item.config ?? form.config,
      });
      setSelected(item.id);
      await refresh();
      notify(form.id ? "模型供应商修改已保存" : "模型供应商已保存，可刷新模型目录验证连接");
    }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  async function pull(id = selected) {
    if (!id) return;
    setLoading(true); setTest(null); setCatalogError("");
    try {
      const available = await api<{ id: string; name: string; capabilities?: Json }[]>(`/api/providers/${id}/models`, { method: "POST", body: JSON.stringify({ force: true }), localRetry: 3 });
      setModels(available);
      setHistory(await api<{ id: string; ok: boolean; createdAt: string }[]>(`/api/providers/${id}/diagnostics`));
      notify(`模型目录已刷新，共 ${available.length} 个模型`);
    }
    catch (cause) { setCatalogError(providerErrorMessage(cause)); }
    finally { setLoading(false); }
  }
  async function testModel(modelId: string) {
    setCatalogError("");
    try {
      setTest(await api<ModelDiagnostic>(`/api/providers/${selected}/test`, { method: "POST", body: JSON.stringify({ modelId }) }));
      setHistory(await api<{ id: string; ok: boolean; createdAt: string }[]>(`/api/providers/${selected}/diagnostics`));
    }
    catch (cause) { setCatalogError(providerErrorMessage(cause)); }
  }
  async function removeProvider() {
    if (!selectedProvider || !window.confirm(`确定删除模型供应商“${selectedProvider.name}”吗？\n\n已保存的 API Key 和检测历史也会一并删除。`)) return;
    try {
      await api(`/api/providers/${selectedProvider.id}`, { method: "DELETE" });
      resetForm(); await refresh(); notify("模型供应商已删除");
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function clearSecret() {
    if (!selectedProvider || !window.confirm(`确定清除“${selectedProvider.name}”已保存的 API Key 吗？`)) return;
    try {
      await api(`/api/providers/${selectedProvider.id}/secret`, { method: "DELETE" });
      setForm((current) => ({ ...current, apiKey: "" }));
      await refresh(); notify("已清除保存的 API Key");
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const filtered = models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(keyword.toLowerCase()));
  return (
    <div className="settings-grid">
      <section className="panel form-card">
        <div className="form-card-head"><div><h2>{form.id ? "查看与修改供应商" : "新增模型供应商"}</h2><p>API Key 使用 Windows 当前用户凭据加密；编辑时留空表示保留原密钥，如需删除请使用“清除密钥”。</p></div>{form.id && <button className="ghost small" onClick={resetForm}>＋ 新增</button>}</div>
        <label><span>显示名称</span><input value={form.name} onChange={(e) => setForm({...form,name:e.target.value})} /></label>
        <label><span>类型</span><select value={form.kind} onChange={(e) => setForm({...form,kind:e.target.value})}><option value="openai">OpenAI（官方）</option><option value="openai-compatible">OpenAI 兼容 / 第三方</option><option value="azure-openai">Azure OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option></select></label>
        <label><span>Base URL</span><input value={form.baseUrl} onChange={(e) => setForm({...form,baseUrl:e.target.value})} /></label>
        <label><span>API Key</span><input type="password" autoComplete="new-password" name="dpm-provider-api-key" value={form.apiKey} onChange={(e) => setForm({...form,apiKey:e.target.value})} placeholder={form.id && selectedProvider?.hasSecret ? "留空则保留当前密钥" : "仅在本机加密保存"} /></label>
        {form.id && <div className="provider-detail"><span>{selectedProvider?.hasSecret ? "✓ 密钥已保存" : "! 尚未配置密钥"}</span><code>{form.id}</code></div>}
        {form.id && selectedProvider?.hasSecret && <button className="ghost full" onClick={() => void clearSecret()}>清除已保存的 API Key</button>}
        <button className="primary full" disabled={saving || !form.name.trim() || !form.baseUrl.trim()} onClick={() => void save()}>{saving ? "正在保存…" : form.id ? "保存修改" : "保存供应商"}</button>
        {form.id && <button className="danger-ghost full" onClick={() => void removeProvider()}>删除这个供应商</button>}
      </section>
      <section className="panel model-browser">
        <div className="panel-head"><div><h2>模型目录</h2><p>{selectedProvider ? `正在查看 ${selectedProvider.name}；刷新时才会访问远端服务` : "选择供应商后查看配置并刷新模型"}</p></div><div className="model-toolbar"><button className="ghost small" disabled={!selected || loading} onClick={() => void pull()}>{loading ? "正在刷新…" : "↻ 刷新模型"}</button></div></div>
        <div className="provider-tabs">{providers.map((provider) => <button className={selected === provider.id ? "active" : ""} key={provider.id} onClick={() => void selectProvider(provider)}>{provider.name}<small>{provider.hasSecret ? "已配置 · 点击查看" : "缺少密钥 · 点击查看"}</small></button>)}{providers.length === 0 && <Empty text="还没有模型供应商，请先在左侧添加。" />}</div>
        {catalogError && <div className="catalog-error"><div><strong>模型目录刷新失败</strong><p>{catalogError}</p></div><button className="ghost small" onClick={() => void pull()}>重试</button></div>}
        <input className="search-input" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="⌕ 按模型 ID 或关键字筛选" />
        <div className="model-list">{filtered.map((model) => <div className="model-row" key={model.id}><div><strong>{model.name || model.id}</strong><p>{model.id}</p></div><div className="capabilities"><span>JSON</span><span>Tools</span></div><button className="ghost small" onClick={() => void testModel(model.id)}>可用性检测</button></div>)}{!filtered.length && <Empty text={selected ? loading ? "正在读取远端模型目录…" : "点击“刷新模型”读取目录；供应商配置可在左侧查看和修改。" : "先选择一个已配置的供应商。"} />}</div>
        {test && <div className={`diagnostic ${test.status}`}>
          <div className="diagnostic-hero"><div className="health-gauge"><span>{test.status === "healthy" ? "✓" : test.status === "degraded" ? "!" : "×"}</span></div><div><small>{test.modelId || "模型检测"} · {Number(test.latencyMs ?? 0)} ms</small><h3>{test.headline}</h3><p>{test.recommendedAction}</p></div></div>
          <div className="diagnostic-history"><span>最近检测</span>{history.slice(0, 20).reverse().map((item) => <i key={item.id} className={item.ok ? "ok" : "bad"} title={`${new Date(item.createdAt).toLocaleString("zh-CN")} · ${item.ok ? "通过" : "失败"}`} />)}</div>
          <div className="diagnostic-checks">{Object.entries(test.checks ?? {}).map(([id, check]) => <article className={check.ok ? "ok" : "bad"} key={id}><span>{check.ok ? "✓" : "×"}</span><div><strong>{check.label}</strong><small>{check.latencyMs != null ? `${check.latencyMs} ms` : ""}</small><p>{check.message}</p>{check.fix && <em>如何修改：{check.fix}</em>}</div></article>)}</div>
        </div>}
      </section>
    </div>
  );
}

function SearchView({ providers, refresh, notify, onError }: { providers: SearchProvider[]; refresh: () => Promise<void>; notify: (message: string) => void; onError: (message: string) => void }) {
  const [form, setForm] = useState({ name: "Tavily", kind: "tavily", endpoint: "https://api.tavily.com/search", method: "POST", apiKey: "", verifycode: "" });
  const [tests, setTests] = useState<Record<string, ConnectionTestState>>({});
  const [testClock, setTestClock] = useState(0);
  useEffect(() => {
    if (!Object.values(tests).some((item) => item.status === "running")) return;
    const timer = window.setInterval(() => setTestClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [tests]);
  function chooseKind(kind: string) {
    if (kind === "dajiala") setForm({ ...form, kind, name: "大家啦微信内容", endpoint: "https://www.dajiala.com", method: "POST" });
    else if (kind === "tavily") setForm({ ...form, kind, name: "Tavily", endpoint: "https://api.tavily.com/search", method: "POST", verifycode: "" });
    else setForm({ ...form, kind, name: "通用 REST 搜索", endpoint: "", method: "POST", verifycode: "" });
  }
  async function save() {
    try { await api("/api/search-providers", { method: "POST", body: JSON.stringify(form) }); notify(form.kind === "dajiala" ? "微信内容 API 已加密保存" : "搜索供应商已保存"); setForm({ ...form, apiKey: "", verifycode: "" }); await refresh(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function test(id: string) {
    // Browser event timestamp drives the user-visible elapsed-time indicator.
    // eslint-disable-next-line react-hooks/purity
    const startedAt = Date.now();
    setTestClock(startedAt);
    setTests((current) => ({ ...current, [id]: { status: "running", startedAt } }));
    try {
      const result = await api<Json>(`/api/search-providers/${id}/test`, { method: "POST", body: JSON.stringify({ query: "2026 海外 光伏 储能 EPC 项目" }) });
      setTests((current) => ({ ...current, [id]: { status: "success", startedAt, finishedAt: Date.now(), result } }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setTests((current) => ({ ...current, [id]: { status: "failed", startedAt, finishedAt: Date.now(), error: message } }));
    }
  }
  return (
    <div className="two-col settings-cols">
      <section className="panel form-card">
        <h2>新增搜索与微信 API</h2><p>通用网页搜索用于官网监测；大家啦微信内容 API 用于已导入公众号账号的历史文章与全文获取。</p>
        <label><span>显示名称</span><input value={form.name} onChange={(e) => setForm({...form,name:e.target.value})} /></label>
        <label><span>类型</span><select value={form.kind} onChange={(e) => chooseKind(e.target.value)}><option value="tavily">Tavily</option><option value="generic-rest">通用 REST</option><option value="dajiala">大家啦微信内容</option></select></label>
        <label><span>{form.kind === "dajiala" ? "服务 Base URL" : "请求地址"}</span><input value={form.endpoint} onChange={(e) => setForm({...form,endpoint:e.target.value})} /></label>
        <label><span>API Key</span><input type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => setForm({...form,apiKey:e.target.value})} placeholder="仅在本机加密保存" /></label>
        {form.kind === "dajiala" && <><label><span>附加码 verifycode（可选）</span><input type="password" autoComplete="new-password" value={form.verifycode} onChange={(e) => setForm({...form,verifycode:e.target.value})} placeholder="账号未启用附加码时留空" /></label><div className="info-card"><span>¥</span><div><strong>保存后可检测余额</strong><p>检测使用免费余额接口；运行任务时会记录每次响应的本次花费和剩余余额，API Key 与附加码不会写入任务日志。</p></div></div></>}
        <button className="primary full" disabled={!form.name.trim() || !form.endpoint.trim() || !form.apiKey.trim()} onClick={() => void save()}>{form.kind === "dajiala" ? "加密保存微信 API" : "保存搜索能力"}</button>
      </section>
      <section className="panel">
        <PanelHeader title="已配置的搜索能力" subtitle="检测延迟、额度和结果映射" />
        <div className="settings-list">{providers.map((provider) => {
          const state = tests[provider.id];
          const elapsed = state ? Math.max(0, Math.floor(((state.finishedAt ?? testClock) - state.startedAt) / 1000)) : 0;
          const result = state?.result ?? {};
          const resultCount = Array.isArray(result.results) ? result.results.length : 0;
          return <div className="connection-entry" key={provider.id}><div className="settings-row"><span className="source-logo">{provider.kind === "dajiala" ? "微" : "S"}</span><div><strong>{provider.name}</strong><p>{provider.kind === "dajiala" ? "微信公众号历史与全文服务" : "网页搜索服务"} · {provider.hasSecret ? "密钥已保存" : "缺少密钥"}{provider.hasVerifycode ? " · 附加码已保存" : ""}</p></div><button className="ghost small" disabled={state?.status === "running"} onClick={() => void test(provider.id)}>{state?.status === "running" ? `检测中 ${elapsed}s` : state ? "重新检测" : provider.kind === "dajiala" ? "检测余额" : "测试搜索"}</button></div>
            {state?.status === "running" && <div className="connection-test-progress"><span /><div><strong>{connectionStage(provider.kind === "dajiala" ? "dajiala" : "search", elapsed)}</strong><p>已等待 {elapsed} 秒 · 检测期间不会产生文章抓取费用</p><i><b style={{ width: `${Math.min(92, 18 + elapsed * 11)}%` }} /></i></div></div>}
            {state?.status === "success" && <div className="connection-test-card success"><div className="connection-test-head"><span>✓</span><div><strong>{provider.kind === "dajiala" ? "连接正常，余额读取成功" : "连接正常，测试搜索成功"}</strong><p>检测耗时 {elapsed < 1 ? "不到 1 秒" : `${elapsed} 秒`}</p></div></div>{provider.kind === "dajiala" ? <div className="connection-metrics"><div><small>当前可用余额</small><strong>¥{Number(result.remainMoney ?? 0).toFixed(3)}</strong></div><div><small>昨日余额</small><strong>¥{Number(result.yesterdayMoney ?? 0).toFixed(3)}</strong></div><div><small>服务返回时间</small><strong>{String(result.requestTime ?? "刚刚")}</strong></div></div> : <div className="connection-metrics"><div><small>测试结果</small><strong>{resultCount} 条</strong></div><div><small>连接状态</small><strong>可以使用</strong></div></div>}</div>}
            {state?.status === "failed" && <div className="connection-test-card failed"><div className="connection-test-head"><span>!</span><div><strong>连接检测未通过</strong><p>{connectionErrorMessage(state.error ?? "")}</p></div></div><div className="connection-actions"><button className="ghost small" onClick={() => void test(provider.id)}>重新检测</button><details><summary>查看技术详情</summary><pre>{state.error}</pre></details></div></div>}
          </div>;
        })}{!providers.length && <Empty text="还没有搜索 API。" />}</div>
      </section>
    </div>
  );
}

function BrowserView({ notify, onError }: { notify: (message: string) => void; onError: (message: string) => void }) {
  const blankForm = { enabled: false, mode: "cloud", endpoint: "", region: "euwest", country: "", token: "", order: "local-first", connectTimeoutMs: 8000, clearToken: false };
  const [form, setForm] = useState(blankForm);
  const [current, setCurrent] = useState<BrowserRendering | null>(null);
  const [probe, setProbe] = useState<BrowserProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const [testStartedAt, setTestStartedAt] = useState(0);
  const [testFinishedAt, setTestFinishedAt] = useState(0);
  const [testClock, setTestClock] = useState(0);
  const [testError, setTestError] = useState("");
  useEffect(() => {
    if (!testing) return;
    const timer = window.setInterval(() => setTestClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [testing]);

  function composeEndpoint(values = form) {
    if (values.mode === "cloud") {
      const base = `wss://${values.region}.cloud.lightpanda.io/ws`;
      const params = new URLSearchParams();
      if (values.country.trim()) { params.set("proxy", "datacenter"); params.set("country", values.country.trim().toLowerCase()); }
      const query = params.toString();
      return query ? `${base}?${query}` : base;
    }
    return values.endpoint.trim();
  }

  async function load() {
    try {
      const config = await api<BrowserRendering>("/api/browser-rendering");
      setCurrent(config);
      const endpoint = config.endpoint ?? "";
      const cloud = /cloud\.lightpanda\.io/i.test(endpoint);
      let region = "euwest"; let country = "";
      try {
        const parsed = new URL(endpoint.replace(/^ws/i, "http"));
        const hostRegion = parsed.hostname.split(".")[0];
        if (/^(euwest|uswest)$/i.test(hostRegion)) region = hostRegion.toLowerCase();
        country = parsed.searchParams.get("country") ?? "";
      } catch { /* 端点为空或不可解析时保留默认 */ }
      setForm((previous) => ({
        ...previous, enabled: config.enabled, mode: cloud ? "cloud" : "local",
        endpoint: cloud ? "" : endpoint, region, country,
        order: config.backendOrder[0] === "lightpanda" ? "lightpanda-first" : "local-first",
        connectTimeoutMs: config.connectTimeoutMs || 8000, token: "", clearToken: false,
      }));
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      await api("/api/browser-rendering", {
        method: "POST",
        body: JSON.stringify({
          enabled: form.enabled, endpoint: composeEndpoint(),
          backendOrder: form.order === "lightpanda-first" ? ["lightpanda", "local"] : ["local", "lightpanda"],
          connectTimeoutMs: Number(form.connectTimeoutMs) || 8000,
          ...(form.token.trim() ? { token: form.token.trim() } : {}),
          ...(form.clearToken ? { clearToken: true } : {}),
        }),
      });
      notify("浏览器渲染配置已保存"); setProbe(null); await load();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function test() {
    // Browser event timestamp drives the user-visible elapsed-time indicator.
    // eslint-disable-next-line react-hooks/purity
    const startedAt = Date.now();
    setTesting(true); setProbe(null); setTestError(""); setTestStartedAt(startedAt); setTestFinishedAt(0); setTestClock(startedAt);
    try {
      const result = await api<BrowserProbe>("/api/browser-rendering/test", {
        method: "POST",
        body: JSON.stringify({ endpoint: composeEndpoint(), ...(form.token.trim() ? { token: form.token.trim() } : {}) }),
      });
      setProbe(result);
      if (result.ok) notify("Lightpanda 连接测试通过");
    } catch (cause) { setTestError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTestFinishedAt(Date.now()); setTesting(false); }
  }

  const sourceLabel = current?.source === "db" ? "设置页保存" : current?.source === "env" ? "环境变量" : "未配置";
  const testElapsed = testStartedAt ? Math.max(0, Math.floor(((testing ? testClock : testFinishedAt) - testStartedAt) / 1000)) : 0;
  return (
    <div className="two-col settings-cols">
      <section className="panel form-card">
        <h2>Lightpanda 渲染后端</h2>
        <p>MCP 或 Firecrawl 失效、本机 Chrome/Edge 被拦截时，用 Lightpanda 无头浏览器完整加载 JS 页面。Beta 阶段，复杂站点可能渲染不全，默认排在本机浏览器之后。</p>
        <label><span>启用 Lightpanda</span><select value={form.enabled ? "yes" : "no"} onChange={(e) => setForm({ ...form, enabled: e.target.value === "yes" })}><option value="no">停用（只用本机 Chrome/Edge）</option><option value="yes">启用（接入渲染兜底链）</option></select></label>
        <label><span>部署方式</span><select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="cloud">Lightpanda Cloud（托管，数据经第三方）</option><option value="local">本机 / 自托管（WSL2 · Docker）</option></select></label>
        {form.mode === "cloud" ? <>
          <label><span>区域</span><select value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}><option value="euwest">西欧 euwest</option><option value="uswest">美西 uswest</option></select></label>
          <label><span>代理国家代码（可选，如 de / us）</span><input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="留空使用共享数据中心 IP" /></label>
          <label><span>Cloud Token（留空保留已保存密钥）</span><input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder={current?.hasToken ? "已保存，留空保持不变" : "lightpanda.io 控制台获取"} /></label>
          {current?.hasToken && <label><span>清除已保存 Token</span><select value={form.clearToken ? "yes" : "no"} onChange={(e) => setForm({ ...form, clearToken: e.target.value === "yes" })}><option value="no">保留</option><option value="yes">保存时清除</option></select></label>}
        </> : <>
          <label><span>CDP 端点</span><input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="ws://127.0.0.1:9222" /></label>
          <label><span>访问 Token（可选，留空保留）</span><input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} /></label>
        </>}
        <label><span>渲染后端顺序</span><select value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value })}><option value="local-first">本机 Chrome/Edge 优先（兼容性更好）</option><option value="lightpanda-first">Lightpanda 优先（更轻更快）</option></select></label>
        <label><span>连接超时（毫秒）</span><input type="number" value={form.connectTimeoutMs} onChange={(e) => setForm({ ...form, connectTimeoutMs: Number(e.target.value) })} /></label>
        <button className="primary full" onClick={() => void save()}>保存渲染配置</button>
      </section>
      <section className="panel">
        <PanelHeader title="当前状态" subtitle="配置来源与连通性检测" />
        <div className="settings-list">
          <div className="settings-row"><span className="source-logo">▣</span><div><strong>{current?.enabled ? "已启用" : current ? "未启用" : "读取中…"}</strong><p>{current?.endpoint || "未配置端点"}</p></div></div>
          <div className="settings-row"><span className="source-logo">⇄</span><div><strong>兜底顺序</strong><p>{current ? current.backendOrder.map((item) => item === "local" ? "本机浏览器" : "Lightpanda").join(" → ") : "…"}</p></div></div>
          <div className="settings-row"><span className="source-logo">⚿</span><div><strong>Token</strong><p>{current?.hasToken ? "已加密保存（DPAPI）" : "未保存"} · 配置来源：{sourceLabel}</p></div></div>
        </div>
        <button className="ghost small" disabled={testing} onClick={() => void test()}>{testing ? `正在测试 ${testElapsed}s` : probe || testError ? "重新测试连接" : "测试连接"}</button>
        {testing && <div className="connection-test-progress browser-progress"><span /><div><strong>{connectionStage("browser", testElapsed)}</strong><p>已等待 {testElapsed} 秒 · 正在验证端点、Token 与浏览器会话</p><i><b style={{ width: `${Math.min(92, 18 + testElapsed * 10)}%` }} /></i></div></div>}
        {probe && <div className={probe.ok ? "connection-test-card success browser-result" : "connection-test-card failed browser-result"}><div className="connection-test-head"><span>{probe.ok ? "✓" : "!"}</span><div><strong>{probe.ok ? "渲染服务连接正常" : "渲染服务未能建立连接"}</strong><p>{probe.ok ? "后续网页监测可以使用 Lightpanda 作为渲染兜底。" : connectionErrorMessage(probe.error || probe.diagnosis || "")}</p></div></div>{probe.ok && <div className="connection-metrics"><div><small>连接耗时</small><strong>{probe.latencyMs < 1000 ? `${probe.latencyMs} 毫秒` : `${(probe.latencyMs / 1000).toFixed(1)} 秒`}</strong></div><div><small>服务版本</small><strong>{probe.version || "兼容"}</strong></div><div><small>检测端点</small><strong>{probe.endpoint ? "配置有效" : "默认端点"}</strong></div></div>}{!probe.ok && <div className="connection-actions"><button className="ghost small" onClick={() => void test()}>重新检测</button><details><summary>查看技术详情</summary><pre>{probe.error || probe.diagnosis}</pre></details></div>}</div>}
        {testError && <div className="connection-test-card failed browser-result"><div className="connection-test-head"><span>!</span><div><strong>连接检测未通过</strong><p>{connectionErrorMessage(testError)}</p></div></div><div className="connection-actions"><button className="ghost small" onClick={() => void test()}>重新检测</button><details><summary>查看技术详情</summary><pre>{testError}</pre></details></div></div>}
      </section>
    </div>
  );
}

function McpView({ servers, refresh, notify, onError }: { servers: McpServer[]; refresh: () => Promise<void>; notify: (message: string) => void; onError: (message: string) => void }) {
  const blankForm = { id: "", name: "", transport: "streamable-http", url: "", command: "", args: "[]", env: "{}" };
  const [form, setForm] = useState(blankForm);
  const [configJson, setConfigJson] = useState(JSON.stringify({
    mcpServers: { "firecrawl-mcp": { command: "npx", args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: "" } } },
  }, null, 2));
  const [catalog, setCatalog] = useState<Record<string, McpTestResult>>({});
  const [testing, setTesting] = useState<Record<string, number>>({});
  const [testClock, setTestClock] = useState(Date.now());
  const [own, setOwn] = useState<{ endpoint: string; token: string } | null>(null);
  useEffect(() => { void api<{endpoint:string;token:string}>("/api/mcp-token").then(setOwn).catch(() => undefined); }, []);
  useEffect(() => {
    if (!Object.keys(testing).length) return;
    const timer = window.setInterval(() => setTestClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [testing]);
  async function save() {
    try {
      const args = JSON.parse(form.args || "[]");
      const env = JSON.parse(form.env || "{}");
      if (!Array.isArray(args) || !env || typeof env !== "object" || Array.isArray(env)) throw new Error("参数必须是 JSON 数组，环境变量必须是 JSON 对象");
      await api("/api/mcp-servers", { method: "POST", body: JSON.stringify({ ...form, args, env, envKeys: Object.keys(env) }) });
      notify(form.id ? "MCP 配置已更新" : "MCP 服务器已保存"); setForm(blankForm); await refresh();
    }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function importConfig() {
    try {
      const parsed = JSON.parse(configJson);
      await api("/api/mcp-servers/import", { method: "POST", body: JSON.stringify(parsed) });
      notify("mcpServers 配置已导入；密钥已加密保存"); await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function edit(server: McpServer) {
    setForm({
      id: server.id, name: server.name, transport: server.transport, url: server.url,
      command: server.command, args: JSON.stringify(server.args ?? [], null, 2),
      env: JSON.stringify(Object.fromEntries((server.envKeys ?? []).map((key) => [key, ""])), null, 2),
    });
  }
  async function remove(server: McpServer) {
    if (!window.confirm(`确认删除 MCP“${server.name}”吗？`)) return;
    try {
      await api(`/api/mcp-servers/${server.id}`, { method: "DELETE" });
      setCatalog((current) => { const next = { ...current }; delete next[server.id]; return next; });
      if (form.id === server.id) setForm(blankForm);
      notify("MCP 配置和对应密钥已删除"); await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function test(id: string) {
    const startedAt = Date.now();
    setTesting((current) => ({ ...current, [id]: startedAt }));
    setCatalog((current) => { const next = { ...current }; delete next[id]; return next; });
    try {
      const signal = AbortSignal.timeout(75_000);
      const result = await api<McpTestResult>(`/api/mcp-servers/${id}/catalog`, { method: "POST", body: "{}", signal });
      setCatalog((current) => ({ ...current, [id]: result }));
      if (result.ok) notify("MCP 检测通过，工具目录已读取");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setCatalog((current) => ({ ...current, [id]: { ok: false, status: "failed", latencyMs: Date.now() - startedAt,
        error: message, diagnosis: /timeout|aborted/i.test(message) ? "检测等待超过 75 秒。请检查依赖下载、网络、代理或 MCP 进程日志后重试。" : "无法连接本地检测服务，请确认 API 服务仍在运行。" } }));
    } finally {
      setTesting((current) => { const next = { ...current }; delete next[id]; return next; });
    }
  }
  return (
    <div className="stack">
      <section className="own-mcp panel">
        <div><p className="eyebrow">本应用 MCP 服务端</p><h2>{own?.endpoint ?? "正在读取…"}</h2><p>Skill 可通过此地址启动监测、读取结果、执行深度扩散并导出快照。</p></div>
        <div className="token-box"><span>Bearer Token</span><code>{own?.token ?? "••••••••"}</code><button className="ghost small" onClick={() => own && navigator.clipboard.writeText(own.token)}>复制</button></div>
      </section>
      <div className="two-col settings-cols">
        <section className="panel form-card">
          <div className="form-card-head"><div><h2>{form.id ? "编辑外部 MCP" : "连接外部 MCP"}</h2><p>支持手动配置，也支持标准 mcpServers JSON。</p></div>{form.id && <button className="ghost small" onClick={() => setForm(blankForm)}>取消编辑</button>}</div>
          <label><span>名称</span><input value={form.name} onChange={(e) => setForm({...form,name:e.target.value})} /></label>
          <label><span>传输方式</span><select value={form.transport} onChange={(e) => setForm({...form,transport:e.target.value})}><option value="streamable-http">Streamable HTTP</option><option value="stdio">stdio</option><option value="sse">SSE（兼容）</option></select></label>
          {form.transport === "stdio" ? <><label><span>命令</span><input value={form.command} onChange={(e) => setForm({...form,command:e.target.value})} /></label><label><span>参数（JSON 数组）</span><textarea value={form.args} onChange={(e) => setForm({...form,args:e.target.value})} /></label><label><span>环境变量（JSON 对象；编辑时留空值可保留原密钥）</span><textarea value={form.env} onChange={(e) => setForm({...form,env:e.target.value})} /></label></> : <label><span>MCP URL</span><input value={form.url} onChange={(e) => setForm({...form,url:e.target.value})} placeholder="http://127.0.0.1:…/mcp" /></label>}
          <button className="primary full" onClick={() => void save()}>{form.id ? "保存修改" : "保存连接"}</button>
          <div className="mcp-json-import">
            <div><strong>导入 mcpServers JSON</strong><small>env 密钥只写入本机加密保险库，不会再次显示。</small></div>
            <textarea value={configJson} onChange={(e) => setConfigJson(e.target.value)} spellCheck={false} />
            <button className="ghost full" onClick={() => void importConfig()}>解析并导入配置</button>
          </div>
        </section>
        <section className="panel">
          <PanelHeader title="外部 MCP 目录" subtitle="查看 Tools、Resources 与 Prompts" />
          <div className="settings-list">{servers.map((server) => {
            const startedAt = testing[server.id];
            const elapsed = startedAt ? Math.max(0, Math.floor((testClock - startedAt) / 1000)) : 0;
            const result = catalog[server.id];
            return <div className="mcp-server-entry" key={server.id}><div className="settings-row"><span className="source-logo">M</span><div><strong>{server.name}</strong><p>{server.transport} · {server.url || `${server.command} ${(server.args ?? []).join(" ")}`}</p>{Boolean(server.envKeys?.length) && <small>已安全保存：{server.envKeys?.join("、")}</small>}</div><div className="row-actions"><button className="ghost small" onClick={() => edit(server)}>编辑</button><button className="ghost small" disabled={Boolean(startedAt)} onClick={() => void test(server.id)}>{startedAt ? `检测中 ${elapsed}s` : "检测"}</button><button className="danger-ghost small" disabled={Boolean(startedAt)} onClick={() => void remove(server)}>删除</button></div></div>
              {startedAt && <div className="mcp-test-progress"><span /><div><strong>{mcpTestStage(elapsed)}</strong><p>已等待 {elapsed} 秒；首次运行 npx 配置时，应用可能正在下载 MCP 包。</p></div></div>}
              {result && <div className={result.ok ? "mcp-test-result success" : "mcp-test-result failed"}><div><span>{result.ok ? "✓" : "!"}</span><div><strong>{result.ok ? "MCP 连接与目录检测通过" : "MCP 检测失败"}</strong><p>耗时 {Math.round(result.latencyMs / 100) / 10} 秒</p></div>{!result.ok && <button className="ghost small" onClick={() => void test(server.id)}>重新检测</button>}</div>{result.ok ? <><div className="mcp-catalog-counts"><span>Tools <b>{result.catalog?.tools?.length ?? 0}</b></span><span>Resources <b>{result.catalog?.resources?.length ?? 0}</b></span><span>Prompts <b>{result.catalog?.prompts?.length ?? 0}</b></span>{result.catalog?.runtime && <small>{result.catalog.runtime}</small>}</div>{Boolean(result.catalog?.warnings?.length) && <p className="mcp-compatibility">兼容提示：{result.catalog?.warnings?.join("；")}</p>}</> : <><p className="mcp-diagnosis">{result.diagnosis}</p><details><summary>查看完整错误</summary><pre>{result.error}</pre></details></>}</div>}
            </div>;
          })}{!servers.length && <Empty text="尚未连接外部 MCP。" />}</div>
        </section>
      </div>
    </div>
  );
}

function SkillView({ scans, activeScanId, notify, onError }: {
  scans: Scan[]; activeScanId: string; notify: (message: string) => void; onError: (message: string) => void;
}) {
  const [profile, setProfile] = useState<SkillProfile | null>(null);
  const [tab, setTab] = useState<"loaded" | "iterations">("loaded");
  const [scanId, setScanId] = useState(activeScanId);
  const [busy, setBusy] = useState("");
  const completedScans = scans.filter((scan) => ["completed", "failed", "stopped"].includes(scan.status));
  const load = useCallback(async () => {
    try { setProfile(await api<SkillProfile>("/api/skills/scan-overseas-energy-projects")); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }, [onError]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { if (activeScanId) setScanId(activeScanId); }, [activeScanId]);
  async function propose() {
    if (!scanId) return onError("请先选择一个已运行的监测任务");
    setBusy("propose");
    try {
      const iteration = await api<SkillIteration>("/api/skills/scan-overseas-energy-projects/propose", { method: "POST", body: JSON.stringify({ scanId }) });
      await load(); setTab("iterations");
      notify(iteration.proposal.modelUsed ? "大模型已根据任务证据生成 Skill 候选迭代" : "已根据任务证据生成本地规则候选；模型不可用时未阻塞分析");
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  }
  async function review(iteration: SkillIteration, decision: "apply" | "reject") {
    if (decision === "apply" && !window.confirm(`确定应用 Skill v${iteration.version} 候选吗？\n\n策略文件和已学习最佳实践将更新；后续任务会读取新版本。`)) return;
    setBusy(iteration.id);
    try {
      await api(`/api/skill-iterations/${iteration.id}/${decision}`, { method: "POST", body: "{}" });
      await load(); notify(decision === "apply" ? "候选已应用并沉淀为 Skill 最佳实践" : "候选已拒绝并保留审计记录");
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  }
  const policy = profile?.policy ?? {};
  return (
    <div className="stack skill-workspace">
      <section className="panel skill-hero">
        <div><p className="eyebrow">内置能力 / 可审计迭代</p><h2>{profile?.name ?? "正在加载检索 Skill…"}</h2><p>{profile?.description}</p></div>
        <div className="skill-loaded"><span className="pulse" /><div><strong>{profile ? `已加载 · Skill v${profile.version}` : "加载中"}</strong><small>每次变更均需人工应用，可随任务证据回溯</small></div></div>
      </section>
      <div className="skill-tabs" role="tablist">
        <button className={tab === "loaded" ? "active" : ""} onClick={() => setTab("loaded")}>已加载 Skill</button>
        <button className={tab === "iterations" ? "active" : ""} onClick={() => setTab("iterations")}>迭代候选与历史 {profile?.iterations.length ? <em>{profile.iterations.length}</em> : null}</button>
      </div>
      {tab === "loaded" && <div className="two-col settings-cols">
        <section className="panel">
          <PanelHeader title="当前检索策略" subtitle="任务执行时读取这些参数；应用候选后无需改代码即可生效" />
          <div className="policy-grid">{Object.entries(policy).filter(([key]) => key !== "iteration").map(([key, value]) => <div key={key}><span>{skillPolicyLabel(key)}</span><code>{formatSkillValue(value)}</code></div>)}</div>
          {Boolean(policy.iteration) && <details className="skill-document"><summary>查看迭代安全边界</summary><pre>{JSON.stringify(policy.iteration, null, 2)}</pre></details>}
          <details className="skill-document"><summary>查看完整 SKILL.md</summary><pre>{profile?.content}</pre></details>
        </section>
        <section className="panel">
          <PanelHeader title="已沉淀的最佳实践" subtitle="仅收录人工应用过的候选，后续模型和监测任务都会读取" />
          <pre className="learned-practices">{profile?.learnedPractices || "尚无已应用的迭代。完成一次监测后，可从右侧选项卡生成候选。"}</pre>
        </section>
      </div>}
      {tab === "iterations" && <div className="stack">
        <section className="panel skill-generator">
          <div><h2>从任务反馈生成候选</h2><p>读取监测漏斗、失败分类、来源分布和模型的结构化原因说明。系统不会保存或展示模型私有思维链。</p></div>
          <label><span>证据任务</span><select value={scanId} onChange={(event) => setScanId(event.target.value)}><option value="">选择任务</option>{completedScans.map((scan) => <option value={scan.id} key={scan.id}>{scan.id.slice(0, 8)} · {statusLabel(scan.status)} · {new Date(scan.createdAt).toLocaleString("zh-CN")}</option>)}</select></label>
          <button className="primary" disabled={!scanId || busy === "propose"} onClick={() => void propose()}>{busy === "propose" ? "正在分析…" : "生成 Skill 迭代候选"}</button>
        </section>
        <section className="skill-iteration-list">
          {profile?.iterations.map((iteration) => <article className={`panel skill-iteration ${iteration.status}`} key={iteration.id}>
            <div className="skill-iteration-head"><div><span className={`status-pill ${iteration.status === "applied" ? "approved" : iteration.status === "rejected" ? "rejected" : "review"}`}>{iteration.status === "applied" ? "已应用" : iteration.status === "rejected" ? "已拒绝" : "待确认"}</span><h3>候选 v{iteration.version}</h3><p>任务 {iteration.scanId.slice(0, 8)} · {new Date(iteration.createdAt).toLocaleString("zh-CN")} · {iteration.proposal.modelUsed ? "大模型分析" : "本地规则分析"}</p></div>{iteration.status === "proposed" && <div><button className="danger-ghost small" disabled={busy === iteration.id} onClick={() => void review(iteration, "reject")}>拒绝</button><button className="primary small" disabled={busy === iteration.id} onClick={() => void review(iteration, "apply")}>应用到 Skill</button></div>}</div>
            <p className="skill-summary">{iteration.proposal.summary}</p>
            <details className="skill-evidence"><summary>查看本次诊断证据</summary><pre>{JSON.stringify(iteration.evidence, null, 2)}</pre></details>
            {iteration.proposal.changes.length > 0 ? <div className="skill-change-list">{iteration.proposal.changes.map((change) => <div key={change.path}><div><strong>{skillPolicyLabel(change.path)}</strong><code>{formatSkillValue(policy[change.path])} → {formatSkillJson(change.proposedValueJson)}</code></div><dl><dt>依据</dt><dd>{change.reason}</dd><dt>预期</dt><dd>{change.expectedEffect}</dd><dt>回滚条件</dt><dd>{change.rollbackCondition}</dd></dl></div>)}</div> : <p className="muted">本轮证据不足以安全修改数值策略，仅建议沉淀以下经验。</p>}
            {iteration.proposal.learnedPractices.length > 0 && <div className="skill-practices"><strong>拟沉淀最佳实践</strong>{iteration.proposal.learnedPractices.map((practice) => <p key={practice}>• {practice}</p>)}</div>}
          </article>)}
          {profile && profile.iterations.length === 0 && <section className="panel"><Empty text="还没有 Skill 迭代记录。先选择一个已完成任务生成候选。" /></section>}
        </section>
      </div>}
    </div>
  );
}

function ExportsView({ activeScan, results, fields, notify, onError }: { activeScan?: Scan; results: Result[]; fields: Field[]; notify: (message: string) => void; onError: (message: string) => void }) {
  const [includeFlagged, setIncludeFlagged] = useState(false);
  const [exported, setExported] = useState<{ location: string; files: string[]; verified: boolean } | null>(null);
  const [targetDirectory, setTargetDirectory] = useState<ExportTarget | null>(null);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const wechatRequest = activeScan?.request?.wechat && typeof activeScan.request.wechat === "object" ? activeScan.request.wechat as Json : undefined;
  const fullTextMode = activeScan?.request?.acquisitionMode === "wechat" && wechatRequest?.outputMode === "fulltext";
  const fullTextCount = Number(activeScan?.progress.fullTextSucceeded ?? 0);
  const exportableCount = fullTextMode ? fullTextCount : results.length;
  const unresolved = results.filter((result) => !["approved","auto_approved"].includes(result.status)).length;
  async function chooseDirectory() {
    if (choosingDirectory) return;
    setChoosingDirectory(true);
    try {
      let nativeCause: unknown;
      try {
        const selected = await api<{ cancelled: boolean; token?: string; path?: string; name?: string }>("/api/export-directories/pick", { method: "POST", body: "{}" });
        if (selected.cancelled) return;
        if (!selected.token || !selected.path || !selected.name) throw new Error("服务端未返回有效的文件夹授权");
        setTargetDirectory({ mode: "native", token: selected.token, path: selected.path, name: selected.name });
        return;
      } catch (cause) {
        nativeCause = cause;
      }
      const browserWindow = window as unknown as { showDirectoryPicker?: (options?: { mode: "readwrite" }) => Promise<LocalDirectoryHandle> };
      const picker = browserWindow.showDirectoryPicker?.bind(window);
      if (!picker) throw nativeCause;
      const handle = await picker({ mode: "readwrite" });
      if (handle.requestPermission && await handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("没有获得目标文件夹的写入权限");
      setTargetDirectory({ mode: "browser", handle, path: handle.name, name: handle.name });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally { setChoosingDirectory(false); }
  }
  async function copyToTarget(downloads: Record<string, ExportDownload>) {
    if (!targetDirectory || targetDirectory.mode !== "browser") return [];
    const handle = targetDirectory.handle;
    if (handle.requestPermission && await handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("目标文件夹写入权限已失效，请重新选择");
    const verified: string[] = [];
    for (const descriptor of Object.values(downloads)) {
      const response = await fetch(`${API}${descriptor.url}`);
      if (!response.ok) throw new Error(`无法下载导出文件：${descriptor.name}`);
      const blob = await response.blob();
      const fileHandle = await handle.getFileHandle(descriptor.name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      const saved = await fileHandle.getFile();
      if (saved.size !== blob.size) throw new Error(`文件写入校验失败：${descriptor.name}`);
      verified.push(descriptor.name);
    }
    return verified;
  }
  async function create() {
    if (!activeScan) return;
    try {
      const snapshot = await api<{ id: string }>("/api/snapshots", { method: "POST", body: JSON.stringify({ scanId: activeScan.id, resultIds: fullTextMode ? [] : results.map((result) => result.id), fieldIds: fullTextMode ? [] : fields.map((field) => field.id), includeFlagged }) });
      const output = await api<{ id: string; outputDir: string; files: Record<string,string>; downloads: Record<string,ExportDownload>; delivery: "direct" | "staging"; verification: Record<string,{ path: string; exists: boolean; size: number }> }>(`/api/snapshots/${snapshot.id}/export`, { method: "POST", body: JSON.stringify({ directoryToken: targetDirectory?.mode === "native" ? targetDirectory.token : "" }) });
      if (targetDirectory?.mode === "native") {
        const checks = Object.values(output.verification);
        if (output.delivery !== "direct" || checks.length !== 4 || checks.some((item) => !item.exists || item.size <= 0)) throw new Error("服务端未能在目标文件夹完成四个文件的落盘校验");
        const files = checks.map((item) => item.path);
        setExported({ location: output.outputDir, files, verified: true });
        notify(`四个文件已直接写入并校验：${output.outputDir}`);
      } else if (targetDirectory?.mode === "browser") {
        try {
          const files = await copyToTarget(output.downloads);
          await api(`/api/exports/${output.id}/staging`, { method: "DELETE" });
          setExported({ location: `所选文件夹：${targetDirectory.path}`, files, verified: true });
          notify(`已校验 ${files.length} 个文件，并保存到“${targetDirectory.name}”`);
        } catch (cause) {
          setExported({ location: `浏览器写入失败；文件已保留在：${output.outputDir}`, files: Object.values(output.files), verified: false });
          throw new Error(`无法写入所选文件夹：${cause instanceof Error ? cause.message : String(cause)}。文件已保留在应用默认目录，重新选择文件夹后可再次导出。`);
        }
      } else {
        setExported({ location: output.outputDir, files: Object.values(output.files), verified: true });
        notify("四种交付文件已生成到应用默认目录");
      }
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return (
    <div className="two-col settings-cols">
      <section className="panel export-summary">
        <p className="eyebrow">确认快照</p><h2>{activeScan ? `任务 ${activeScan.id.slice(0,8)}` : "尚未选择任务"}</h2>
        <div className="export-metrics">{fullTextMode ? <><div><strong>{fullTextCount}</strong><span>全文文章</span></div><div><strong>4</strong><span>固定字段</span></div><div><strong>0</strong><span>待审核</span></div></> : <><div><strong>{results.length}</strong><span>全部结果</span></div><div><strong>{results.length-unresolved}</strong><span>已确认</span></div><div><strong>{unresolved}</strong><span>待处理</span></div></>}</div>
        <div className={choosingDirectory ? "export-target choosing" : "export-target"}><div><strong>导出目标文件夹</strong><p aria-live="polite">{choosingDirectory ? "正在等待系统文件夹窗口，请在弹出的窗口中完成选择…" : targetDirectory ? targetDirectory.path : "未选择，将使用应用默认 outputs 目录"}</p></div><button className="ghost small" disabled={choosingDirectory} onClick={() => void chooseDirectory()}>{choosingDirectory ? "等待选择…" : targetDirectory ? "重新选择" : "选择文件夹"}</button></div>
        {!fullTextMode && unresolved > 0 && <label className="include-flagged"><input type="checkbox" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} /><div><strong>将存疑记录一并导出</strong><p>这些记录会保留状态、评分和冲突说明。</p></div></label>}
        <button className="primary full export-button" disabled={choosingDirectory || !activeScan || !exportableCount || (!fullTextMode && unresolved > 0 && !includeFlagged)} onClick={() => void create()}>确认快照并一键导出</button>
      </section>
      <section className="panel">
        <PanelHeader title="交付内容" subtitle="同一个快照生成四种一致的文件" />
        <div className="deliverables">
          <Deliverable icon="X" title="Excel 工作簿" note={fullTextMode ? "公众号账号、发布日期、文章标题、正文" : "选定字段 + 最后一列原始链接"} />
          <Deliverable icon="M" title="Markdown 报告" note={fullTextMode ? "按文章整理的可阅读全文" : "摘要、项目表、冲突与失败说明"} />
          <Deliverable icon="J" title="JSON 数据" note={fullTextMode ? "仅包含四个指定字段" : "完整字段、证据、评分和审核历史"} />
          <Deliverable icon="Z" title={fullTextMode ? "文章正文包" : "网页全文证据包"} note={fullTextMode ? "每篇文章一个文本文件" : "原始 HTML/PDF、清洗正文与哈希"} />
        </div>
        {exported && <div className={exported.verified ? "export-result" : "export-result failed"}><strong>{exported.verified ? "导出完成并校验通过" : "未写入所选目标文件夹"}</strong><p>{exported.location}</p>{exported.files.map((value) => <div key={value}><span>文件</span><code>{value}</code></div>)}</div>}
      </section>
    </div>
  );
}

function PanelHeader({ title, subtitle, action, onAction }: { title: string; subtitle?: string; action?: string; onAction?: () => void }) {
  return <div className="panel-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action && <button className="text-link" onClick={onAction}>{action} →</button>}</div>;
}
function Empty({ text }: { text: string }) { return <div className="empty"><span>⌁</span><p>{text}</p></div>; }
function StatusDot({ status }: { status: string }) { return <span className={`status-dot ${status}`} />; }
function StatusPill({ status }: { status: string }) { return <span className={`status-pill ${status}`}>{statusLabel(status)}</span>; }
function HealthRow({ label, value, ok }: { label: string; value: string; ok: boolean }) { return <div className="health-row"><span className={ok ? "ok" : "warn"}>{ok ? "✓" : "•"}</span><div><strong>{label}</strong><p>{value}</p></div></div>; }
function ProgressRing({ value }: { value: number }) { return <div className="progress-ring" style={{ background: `conic-gradient(#1b766d ${value}%, #e1ebe8 0)` }}><span>{value}%</span></div>; }
function CheckCard({ checked, title, meta, onChange }: { checked: boolean; title: string; meta: string; onChange: () => void }) { return <label className={checked ? "check-card checked" : "check-card"}><input type="checkbox" checked={checked} onChange={onChange} /><span>{checked ? "✓" : ""}</span><div><strong>{title}</strong><small>{meta}</small></div></label>; }
function CheckLine({ checked, label, meta, onChange }: { checked: boolean; label: string; meta: string; onChange: () => void }) { return <label className="check-line"><input type="checkbox" checked={checked} onChange={onChange} /><span>{checked ? "✓" : ""}</span><div><strong>{label}</strong><p>{meta}</p></div></label>; }
function BudgetInput({ label, value, min = 1, step = 1, onChange }: { label: string; value: number; min?: number; step?: number; onChange: (value: number) => void }) {
  const integer = Number.isInteger(step);
  return <label><span>{label}</span><input type="number" min={min} step={step} value={value}
    onInput={(event) => {
      if (!integer) return;
      const input = event.currentTarget;
      const normalized = input.value.replace(/^0+(?=\d)/, "");
      if (normalized !== input.value) input.value = normalized;
    }}
    onChange={(event) => {
      const next = Number(event.currentTarget.value);
      if (Number.isFinite(next)) onChange(integer ? Math.max(min, Math.trunc(next)) : Math.max(min, next));
    }}
    onBlur={(event) => { event.currentTarget.value = String(integer ? Math.max(min, Math.trunc(Number(event.currentTarget.value) || min)) : Math.max(min, Number(event.currentTarget.value) || min)); }} />
  </label>;
}
function Deliverable({ icon, title, note }: { icon: string; title: string; note: string }) { return <div className="deliverable"><span>{icon}</span><div><strong>{title}</strong><p>{note}</p></div><i>✓</i></div>; }
function EvidenceText({ text, values }: { text: string; values: string[] }) {
  const tokens = [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 2))].sort((a, b) => b.length - a.length);
  if (!tokens.length) return <>{text}</>;
  const expression = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  return <>{text.split(expression).map((part, index) => tokens.some((token) => token.toLowerCase() === part.toLowerCase()) ? <mark key={`${part}-${index}`}>{part}</mark> : part)}</>;
}
function evidenceValues(result: Result, fieldId: string) {
  const direct = String(result.fields[fieldId] ?? "");
  if (fieldId !== "project_name" || !result.generatedFields?.includes("project_name")) return [direct];
  return ["epc", "chinese_client", "developer", "owner", "country", "address", "pv_capacity_mw", "storage_capacity_mwh", "project_type"]
    .map((id) => String(result.fields[id] ?? ""));
}
function bilingualOriginal(result: Result, fieldId: string) {
  const original = String(result.originalFields?.[fieldId] ?? "").trim();
  const translated = String(result.fields[fieldId] ?? "").trim();
  return Boolean(original && original.toLocaleLowerCase() !== translated.toLocaleLowerCase());
}
function isForeignResult(result: Result) { return Boolean(result.sourceLanguage && !/^zh(?:-|$)/i.test(result.sourceLanguage)); }
function hasDisplayValue(value: unknown) { return value !== "" && value !== null && value !== undefined; }
function failureReasonLabel(code: string) {
  const labels: Record<string, string> = {
    DISCOVERY_ERROR: "站点枚举失败", ROBOTS_DENIED: "robots.txt 禁止", HTTP_401: "需要登录", HTTP_403: "访问被拒绝",
    HTTP_404: "页面不存在", HTTP_429: "访问频率受限", TIMEOUT: "请求超时", NETWORK: "网络或 DNS 异常",
    PROXY_OR_DNS: "代理或 Fake-IP 路由异常", ACCESS_DENIED: "访问被拒绝", BOT_CHALLENGE: "机器人验证页面",
    RATE_LIMITED: "远端站点限流", FETCH_ERROR: "网页抓取异常", MODEL_EXTRACTION_ERROR: "模型抽取失败", MCP_CALL_ERROR: "MCP 调用失败",
    SOURCE_MISSING: "选定信息源已删除", SOURCE_NO_CONTENT: "网站未取得可用正文", SOURCE_SCAN_ERROR: "单站扫描异常",
  };
  return labels[code] ?? code;
}
function skillPolicyLabel(key: string) {
  const labels: Record<string, string> = {
    version: "策略文件版本", mcp_page_share: "MCP 页面份额上限",
    max_source_page_share: "单一来源页面份额", blocked_status_codes: "阻断状态码", retrieval_order: "检索回退顺序",
    safe_auto_adjustments: "允许自动优化", review_required: "必须人工确认",
  };
  return labels[key] ?? key;
}
function mcpTestStage(elapsed: number) {
  if (elapsed < 2) return "正在启动 MCP 运行进程";
  if (elapsed < 8) return "正在完成协议初始化";
  if (elapsed < 25) return "正在读取 Tools、Resources 与 Prompts";
  return "仍在等待依赖下载或远端服务响应";
}
function formatSkillValue(value: unknown) {
  if (value == null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}
function formatSkillJson(value: string) {
  try { return formatSkillValue(JSON.parse(value)); } catch { return value; }
}
function failureLogMatches(log: ScanLog, code: string) {
  const text = `${log.stage} ${log.event} ${log.message}`;
  if (code === "DISCOVERY_ERROR") return log.stage === "discovery" && ["warn", "error"].includes(log.level);
  if (code === "SEARCH_FALLBACK_ERROR") return log.event === "search_fallback_failed";
  if (code === "MODEL_EXTRACTION_ERROR") return log.stage === "model" && log.level === "error";
  if (code === "MCP_CALL_ERROR") return log.stage === "mcp" && log.level === "error";
  if (code === "SOURCE_MISSING") return log.event === "source_missing";
  if (code === "SOURCE_NO_CONTENT") return log.event === "source_no_content";
  if (code === "SOURCE_SCAN_ERROR") return log.event === "source_scan_failed";
  const patterns: Record<string, RegExp> = {
    TIMEOUT: /TIMEOUT|timeout|超时/i, NETWORK: /NETWORK|fetch failed|socket|网络|DNS/i,
    PROXY_OR_DNS: /PROXY_OR_DNS|Fake-IP|代理|DNS/i, ACCESS_DENIED: /ACCESS_DENIED|access denied|访问被拒绝/i,
    BOT_CHALLENGE: /BOT_CHALLENGE|captcha|verify.*human|机器人|验证码/i, RATE_LIMITED: /RATE_LIMITED|HTTP 429|限流/i,
    ROBOTS_DENIED: /ROBOTS_DENIED|robots\.txt/i, FETCH_ERROR: /FETCH_ERROR/i,
  };
  return patterns[code]?.test(text) ?? text.includes(code);
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function toggle(values: string[], value: string) { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function wizardNote(step: number) { return ["定义输出结构","限定发布日期","选择扫描站点","组合模型与工具","控制费用与规模"][step-1]; }
function capacityLabel(fields: Record<string, unknown>) {
  const parts = [];
  if (fields.pv_capacity_mw) parts.push(`${fields.pv_capacity_mw} MW 光伏`);
  if (fields.storage_capacity_mwh) parts.push(`${fields.storage_capacity_mwh} MWh 储能`);
  return parts.join(" / ") || "容量待核验";
}
