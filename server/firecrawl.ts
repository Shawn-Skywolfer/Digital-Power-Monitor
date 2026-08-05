import { documentFromExternalContent } from "./crawler";
import type { CrawledDocument, JsonObject } from "./types";

const FIRECRAWL_API = process.env.DPM_FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";

async function firecrawlRequest(apiKey: string, path: string, body: JsonObject) {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${FIRECRAWL_API}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      let data: JsonObject = {};
      try { data = JSON.parse(text) as JsonObject; } catch { data = { error: text.slice(0, 800) }; }
      if (response.ok && data.success !== false) return data;
      const message = String((data.error as JsonObject | undefined)?.message ?? data.error ?? data.message ?? `HTTP ${response.status}`);
      lastError = `Firecrawl HTTP ${response.status}：${message}`;
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(lastError);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!/timeout|aborted|fetch failed|HTTP (?:408|425|429|5\d\d)/i.test(lastError) || attempt === 3) throw new Error(lastError);
    }
    await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)));
  }
  throw new Error(lastError || "Firecrawl 请求失败");
}

export function firecrawlKeyFromProfiles(profiles: Array<{ name?: string; env?: Record<string, string> }>) {
  for (const profile of profiles) {
    const key = profile.env?.FIRECRAWL_API_KEY;
    if (key && /firecrawl/i.test(String(profile.name ?? ""))) return key;
  }
  return "";
}

export async function mapWithFirecrawl(apiKey: string, url: string, limit: number, search?: string) {
  const result = await firecrawlRequest(apiKey, "/v2/map", {
    url, limit: Math.max(1, Math.min(limit, 100)), ...(search ? { search } : {}),
    sitemap: "include", includeSubdomains: false, ignoreQueryParameters: true,
  });
  const links = (result.links ?? (result.data as JsonObject | undefined)?.links ?? []) as unknown[];
  return [...new Set(links.map((item) => typeof item === "string" ? item : String((item as JsonObject)?.url ?? "")).filter(Boolean))];
}

export async function scrapeWithFirecrawl(apiKey: string, url: string, sourceId: string): Promise<CrawledDocument> {
  const result = await firecrawlRequest(apiKey, "/v2/scrape", {
    url, formats: ["markdown", "html"], onlyMainContent: true, waitFor: 1_000,
    maxAge: 3_600_000, proxy: "auto",
  });
  const data = (result.data ?? result) as JsonObject;
  const metadata = (data.metadata ?? {}) as JsonObject;
  return documentFromExternalContent({
    url: String(metadata.sourceURL ?? metadata.url ?? url), sourceId,
    markdown: String(data.markdown ?? ""), html: String(data.html ?? ""),
    title: String(metadata.title ?? ""),
    publishedAt: String(metadata.publishedTime ?? metadata.datePublished ?? metadata.date ?? "") || null,
    statusCode: Number(metadata.statusCode ?? 200), provider: "Firecrawl",
  });
}
