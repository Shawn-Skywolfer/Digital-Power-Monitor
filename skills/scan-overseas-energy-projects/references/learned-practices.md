# Learned retrieval practices

Only user-approved iteration candidates are appended here. Every entry must retain its scan ID, evidence, expected effect and rollback condition.

## v2 · 2026-08-05 · Direct user-approved system iteration

- A source queue completes only after every selected source has been processed. The requested duration is an estimate and no longer truncates unvisited sources.
- When local connections time out, close unexpectedly, fail dynamic rendering, or return a block page, use the user-configured Firecrawl Map/Scrape service and pass its full text through the same date, evidence, and project validation pipeline.
- A connection timeout is not proof of anti-bot blocking. Classify access restrictions only from HTTP 403/429, challenge pages, or explicit block signatures.
- On transient model timeouts or network errors, compact the article body, back off, and retry once. Fall back from strict Schema to compatible JSON only for confirmed schema incompatibility.
