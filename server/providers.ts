import { performance } from "node:perf_hooks";
import type { JsonObject, ModelProviderRecord, SearchProviderRecord, SearchResult } from "./types";
import { vault } from "./vault";

function joinUrl(base: string, suffix: string) {
  const normalizedBase = base.replace(/\/+$/, "");
  let normalizedSuffix = suffix.replace(/^\/+/, "");
  for (const version of ["v1", "v1beta"]) {
    if (normalizedBase.toLowerCase().endsWith(`/${version}`) && normalizedSuffix.toLowerCase().startsWith(`${version}/`)) {
      normalizedSuffix = normalizedSuffix.slice(version.length + 1);
      break;
    }
  }
  return `${normalizedBase}/${normalizedSuffix}`;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 30_000): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    let endpoint = url;
    try {
      const parsed = new URL(url);
      parsed.search = "";
      parsed.hash = "";
      endpoint = parsed.toString();
    } catch { /* Preserve the invalid URL so the user can correct it. */ }
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause && typeof error.cause === "object"
      ? error.cause as { code?: string; message?: string }
      : undefined;
    const timedOut = /timeout|aborted/i.test(`${error instanceof Error ? error.name : ""} ${message}`);
    const reason = timedOut
      ? "请求超时"
      : cause?.code
        ? `${cause.code}${cause.message ? `：${cause.message}` : ""}`
        : /^fetch failed$/i.test(message) ? "网络连接失败" : message;
    throw new Error(`无法连接远端服务 ${endpoint} · ${reason}。请检查网络、代理、DNS 和 Base URL。`);
  }
  const text = await response.text();
  let data: JsonObject = {};
  try { data = JSON.parse(text) as JsonObject; } catch { data = { raw: text.slice(0, 1000) }; }
  if (!response.ok) {
    const errorObject = data.error && typeof data.error === "object" ? data.error as JsonObject : {};
    const message = String(errorObject.message ?? data.message ?? data.error ?? (text || `HTTP ${response.status}`)).slice(0, 800);
    const code = String(errorObject.code ?? data.code ?? "");
    const type = String(errorObject.type ?? data.type ?? "");
    throw new Error([`HTTP ${response.status}`, message, code && `code=${code}`, type && `type=${type}`].filter(Boolean).join(" · "));
  }
  return data;
}

function remediation(message: string) {
  if (/HTTP (401|403)|api.?key|unauthor|forbidden/i.test(message)) return "检查 API Key、请求头和账号权限";
  if (/HTTP 404|not found|deployment/i.test(message)) return "检查 Base URL、API版本、部署名或模型ID";
  if (/HTTP 429|quota|rate.?limit|insufficient/i.test(message)) return "检查额度和限流，降低并发或更换有额度的密钥";
  if (/HTTP 400|schema|response_format|invalid_request/i.test(message)) return "该端点可能不支持严格JSON Schema；改用兼容模式或检查模型类型";
  if (/timeout|fetch failed|ENOTFOUND|ECONN/i.test(message)) return "检查网络、代理、DNS和 Base URL 是否可访问";
  return "展开技术详情，根据返回消息修改供应商配置";
}

function secretHeaders(provider: ModelProviderRecord) {
  const apiKey = vault.get(`provider:${provider.id}`);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...provider.headers };
  if (provider.kind === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = String(provider.config.anthropicVersion ?? "2023-06-01");
  } else if (provider.kind !== "gemini" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    if (provider.kind === "azure-openai") headers["api-key"] = apiKey;
  }
  return { apiKey, headers };
}

export async function listProviderModels(provider: ModelProviderRecord) {
  const { apiKey, headers } = secretHeaders(provider);
  let url = joinUrl(provider.baseUrl, "v1/models");
  if (provider.kind === "anthropic") url = joinUrl(provider.baseUrl, "v1/models");
  if (provider.kind === "gemini") url = `${joinUrl(provider.baseUrl, "v1beta/models")}?key=${encodeURIComponent(apiKey)}`;
  if (provider.kind === "azure-openai") {
    const configured = Array.isArray(provider.config.models) ? provider.config.models : [];
    return configured.map((id) => ({ id: String(id), name: String(id), capabilities: inferCapabilities(String(id)) }));
  }
  const data = await fetchJson(url, { headers }, Number(provider.config.timeoutMs ?? 30_000));
  const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return items.map((item) => {
    const obj = item as JsonObject;
    const id = String(obj.id ?? obj.name ?? "");
    return { id: id.replace(/^models\//, ""), name: String(obj.displayName ?? id), capabilities: inferCapabilities(id) };
  }).filter((item) => item.id);
}

function inferCapabilities(modelId: string) {
  const id = modelId.toLowerCase();
  return {
    structuredOutput: /gpt|claude|gemini|qwen|deepseek/.test(id),
    toolCalling: /gpt|claude|gemini|qwen|deepseek/.test(id),
    jsonMode: !/embedding|image|audio|tts|whisper/.test(id),
    streaming: !/embedding/.test(id),
    longContext: /gpt-5|claude|gemini|qwen/.test(id),
  };
}

export async function testProvider(provider: ModelProviderRecord, modelId: string) {
  const started = performance.now();
  const checks: Record<string, { ok: boolean; label: string; message: string; latencyMs?: number; fix?: string }> = {};
  let models: { id: string }[] = [];
  const catalogStarted = performance.now();
  try {
    models = await listProviderModels(provider);
    checks.models = { ok: true, label: "模型目录", message: `已读取 ${models.length} 个模型`, latencyMs: Math.round(performance.now() - catalogStarted) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.models = { ok: false, label: "模型目录", message, fix: remediation(message), latencyMs: Math.round(performance.now() - catalogStarted) };
  }
  const selected = modelId || models[0]?.id;
  if (!selected) return {
    ok: false, status: "failed", headline: "没有可检测的模型", modelId: "", checks,
    recommendedAction: checks.models?.fix ?? "先配置模型ID", latencyMs: Math.round(performance.now() - started),
  };
  const inferenceStarted = performance.now();
  try {
    const result = await callModel(provider, selected, "只返回一个 JSON 对象：{\"ok\":true}", {
      type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false,
    });
    checks.text = { ok: true, label: "文本推理", message: "最小文本请求成功", latencyMs: Math.round(performance.now() - inferenceStarted) };
    checks.structuredOutput = {
      label: "结构化输出",
      ok: Boolean((result as JsonObject).ok),
      message: (result as JsonObject).ok ? "结构化输出通过" : "返回内容未通过 JSON Schema 检测",
      fix: (result as JsonObject).ok ? undefined : "将结构化模式改为兼容JSON，或更换支持结构化输出的模型",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.text = { ok: false, label: "文本推理", message, fix: remediation(message), latencyMs: Math.round(performance.now() - inferenceStarted) };
    checks.structuredOutput = { ok: false, label: "结构化输出", message: "结构化输出不可用", fix: remediation(message) };
  }
  const inferenceOk = Boolean(checks.text?.ok);
  const structuredOk = Boolean(checks.structuredOutput?.ok);
  const status = inferenceOk && structuredOk ? "healthy" : inferenceOk ? "degraded" : "failed";
  return {
    ok: status === "healthy", status,
    headline: status === "healthy" ? "模型连接与结构化抽取均正常" : status === "degraded" ? "模型可调用，但结构化抽取需要调整" : "模型当前不可用",
    recommendedAction: status === "healthy" ? "可以用于监测任务" : checks.structuredOutput?.fix ?? checks.text?.fix ?? checks.models?.fix,
    modelId: selected,
    capabilities: { ...inferCapabilities(selected), structuredOutput: Boolean(checks.structuredOutput?.ok) },
    checks,
    latencyMs: Math.round(performance.now() - started),
  };
}

export async function callModel(
  provider: ModelProviderRecord,
  modelId: string,
  prompt: string,
  schema?: JsonObject,
): Promise<unknown> {
  let lastError = "";
  let candidatePrompt = compactModelPrompt(prompt, 48_000);
  let candidateSchema = schema;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await callModelOnce(provider, modelId, candidatePrompt, candidateSchema); }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const retryable = /timeout|aborted|fetch failed|HTTP (?:408|425|429|5\d\d)|empty|JSON/i.test(lastError);
      if (!retryable || attempt === 2) break;
      candidatePrompt = compactModelPrompt(candidatePrompt, 26_000);
      if (schema && /empty|JSON|response_format|schema/i.test(lastError)) {
        candidatePrompt = `${candidatePrompt}\n\n兼容模式：只返回一个 JSON 对象，不要 Markdown、解释或思维过程。对象必须满足：\n${JSON.stringify(schema)}`;
        candidateSchema = undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, 900 + Math.floor(Math.random() * 350)));
    }
  }
  throw new Error(`模型抽取在 2 次自适应尝试后失败：${lastError}`);
}

function compactModelPrompt(prompt: string, maximum: number) {
  if (prompt.length <= maximum) return prompt;
  const bodyMarker = prompt.lastIndexOf("正文：");
  if (bodyMarker > 0) {
    const instructions = prompt.slice(0, bodyMarker + 3);
    const available = Math.max(4_000, maximum - instructions.length - 180);
    return `${instructions}\n${prompt.slice(bodyMarker + 3, bodyMarker + 3 + available)}\n\n【正文因长度已截断；只依据以上内容抽取】`;
  }
  return `${prompt.slice(0, maximum - 80)}\n\n【输入因长度已压缩】`;
}

async function callModelOnce(
  provider: ModelProviderRecord,
  modelId: string,
  prompt: string,
  schema?: JsonObject,
): Promise<unknown> {
  const { apiKey, headers } = secretHeaders(provider);
  const timeout = Number(provider.config.timeoutMs ?? 60_000);
  const maxOutputTokens = Number(provider.config.maxOutputTokens ?? 4096);
  if (provider.kind === "anthropic") {
    const data = await fetchJson(joinUrl(provider.baseUrl, "v1/messages"), {
      method: "POST", headers,
      body: JSON.stringify({ model: modelId, max_tokens: maxOutputTokens, messages: [{ role: "user", content: schema ? `${prompt}\n\n必须只返回符合以下 JSON Schema 的 JSON：\n${JSON.stringify(schema)}` : prompt }] }),
    }, timeout);
    const block = Array.isArray(data.content) ? data.content[0] as JsonObject : {};
    return parseModelJsonText(String(block.text ?? ""));
  }
  if (provider.kind === "gemini") {
    const data = await fetchJson(`${joinUrl(provider.baseUrl, `v1beta/models/${modelId}:generateContent`)}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens },
      }),
    }, timeout);
    const candidates = data.candidates as JsonObject[] | undefined;
    const parts = (candidates?.[0]?.content as JsonObject | undefined)?.parts as JsonObject[] | undefined;
    return parseModelJsonText(String(parts?.[0]?.text ?? ""));
  }
  if (provider.kind === "openai") {
    const body: JsonObject = { model: modelId, input: prompt, max_output_tokens: maxOutputTokens };
    if (schema) body.text = { format: { type: "json_schema", name: "project_extract", strict: true, schema } };
    const data = await fetchJson(joinUrl(provider.baseUrl, "v1/responses"), {
      method: "POST", headers, body: JSON.stringify(body),
    }, timeout);
    return parseModelJsonText(extractOpenAIResponseText(data));
  }
  const endpoint = provider.kind === "azure-openai"
    ? `${joinUrl(provider.baseUrl, `openai/deployments/${modelId}/chat/completions`)}?api-version=${provider.config.apiVersion ?? "2024-10-21"}`
    : joinUrl(provider.baseUrl, "v1/chat/completions");
  const baseBody: JsonObject = { model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: maxOutputTokens };
  let data: JsonObject;
  try {
    data = await fetchJson(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ ...baseBody, response_format: schema ? { type: "json_schema", json_schema: { name: "project_extract", strict: true, schema } } : { type: "json_object" } }),
    }, timeout);
  } catch (error) {
    if (!schema) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!/HTTP 400|schema|response_format|invalid_request|unsupported/i.test(message)) throw error;
    data = await fetchJson(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ ...baseBody, messages: [{ role: "user", content: `${prompt}\n\n必须只返回符合以下 JSON Schema 的 JSON：\n${JSON.stringify(schema)}` }], response_format: { type: "json_object" } }),
    }, timeout);
  }
  const choices = data.choices as JsonObject[] | undefined;
  const message = choices?.[0]?.message as JsonObject | undefined;
  return parseModelJsonText(String(message?.content ?? ""));
}

function extractOpenAIResponseText(data: JsonObject) {
  if (typeof data.output_text === "string") return data.output_text;
  const output = data.output as JsonObject[] | undefined;
  for (const item of output ?? []) {
    const content = item.content as JsonObject[] | undefined;
    for (const part of content ?? []) if (typeof part.text === "string") return part.text;
  }
  return "";
}

export function parseModelJsonText(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const candidates = [cleaned];
  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(cleaned.slice(objectStart, objectEnd + 1));
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try { return JSON.parse(candidate); } catch { /* try the next bounded JSON candidate */ }
  }
  throw new Error(`模型返回空内容或无效 JSON：${cleaned.slice(0, 240) || "<empty>"}`);
}

function getByPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (Array.isArray(current)) return current[Number(key)];
    if (current && typeof current === "object") return (current as JsonObject)[key];
    return undefined;
  }, value);
}

export async function searchWeb(provider: SearchProviderRecord, query: string, maxResults = 10): Promise<SearchResult[]> {
  const apiKey = vault.get(`search:${provider.id}`);
  if (provider.kind === "tavily") {
    const data = await fetchJson(provider.endpoint || "https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json", ...provider.headers },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "advanced", include_raw_content: false }),
    }, Number(provider.config.timeoutMs ?? 30_000));
    return ((data.results ?? []) as JsonObject[]).map((item) => ({
      title: String(item.title ?? ""), url: String(item.url ?? ""),
      snippet: String(item.content ?? ""), publishedAt: item.published_date ? String(item.published_date) : undefined,
    })).filter((item) => item.url);
  }
  const queryParam = String(provider.config.queryParam ?? "q");
  const resultPath = String(provider.config.resultPath ?? "results");
  const method = provider.method ?? "GET";
  const headers: Record<string, string> = { "Content-Type": "application/json", ...provider.headers };
  if (apiKey) headers[String(provider.config.apiKeyHeader ?? "Authorization")] = String(provider.config.apiKeyPrefix ?? "Bearer ") + apiKey;
  const endpoint = new URL(provider.endpoint);
  let body: string | undefined;
  if (method === "GET") {
    endpoint.searchParams.set(queryParam, query);
    endpoint.searchParams.set(String(provider.config.limitParam ?? "limit"), String(maxResults));
    if (apiKey && provider.config.apiKeyQueryParam) endpoint.searchParams.set(String(provider.config.apiKeyQueryParam), apiKey);
  } else {
    body = JSON.stringify({ [queryParam]: query, [String(provider.config.limitParam ?? "limit")]: maxResults });
  }
  const data = await fetchJson(endpoint.toString(), { method, headers, body }, Number(provider.config.timeoutMs ?? 30_000));
  const items = getByPath(data, resultPath);
  if (!Array.isArray(items)) return [];
  const titlePath = String(provider.config.titlePath ?? "title");
  const urlPath = String(provider.config.urlPath ?? "url");
  const snippetPath = String(provider.config.snippetPath ?? "snippet");
  const datePath = String(provider.config.datePath ?? "published_at");
  return items.map((item) => ({
    title: String(getByPath(item, titlePath) ?? ""),
    url: String(getByPath(item, urlPath) ?? ""),
    snippet: String(getByPath(item, snippetPath) ?? ""),
    publishedAt: String(getByPath(item, datePath) ?? "") || undefined,
  })).filter((item) => item.url);
}
