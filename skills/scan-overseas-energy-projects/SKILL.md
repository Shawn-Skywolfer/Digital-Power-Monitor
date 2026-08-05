---
name: scan-overseas-energy-projects
description: Diagnose, execute, and iteratively improve overseas energy-project retrieval for Digital Power Monitor. Use when scanning a date range, investigating zero-result scans, Access Denied pages, site-enumeration failures, model extraction feedback, source-budget imbalance, or when comparing the application's configured crawler/search/MCP routes and proposing the next evidence-backed retrieval round.
---

# Overseas Energy Project Retrieval

Use the application's own API or MCP tools as the system of record. Do not duplicate its crawler, approve review items, or infer missing project facts.

## Run the workflow

1. Call `list_fields` and `list_sources` before a new scan. Preserve the user's selected time range, fields, sources, model, search providers, MCP services, and budgets.
2. Start the configured application scan with `start_scan`. When search or crawler MCP services are configured, include them as parallel evidence routes rather than replacements for official source pages.
3. Poll `get_scan_status` until the scan reaches a terminal state. Do not treat an unchanged running state as failure.
4. Call `get_scan_diagnostics`, then `get_articles` and `get_results`. If MCP is unavailable, run `node scripts/analyze_scan.mjs <scan-id> [api-origin]` from this skill directory.
5. Trace the funnel in order: selected sources → enumerated URLs → fetched正文 → date-qualified pages → assessed articles → model extractions → project mentions → merged projects.
6. Classify each problem using [retrieval policy](references/retrieval-policy.json) and [evidence rules](references/evidence-and-iteration.md). Cite scan IDs, counts, URLs, failure codes, and log events.
   Also read [learned practices](references/learned-practices.md) when it exists; these are user-approved lessons promoted from prior scan iterations.
7. Execute another scan only when a bounded change is supported by evidence. Compare the new funnel with the previous round.
8. Stop after three rounds, after the target is met, or when two consecutive rounds fail to improve date-qualified pages or valid projects.

## Select retrieval routes

Apply the lowest-cost compliant route first, and run independent configured routes in parallel when budget permits:

- Prefer official RSS/Atom, sitemap and dated archive links.
- Use normal static HTTP with caching, per-host throttling and bounded backoff.
- Use a persistent browser session for JavaScript-rendered public pages and sites that require ordinary session cookies.
- Use configured search providers for `site:` discovery when direct enumeration fails.
- Use configured crawl/search MCP services, including Firecrawl-compatible services, when available.
- Use official mirrors, press releases, tender portals, or regulator pages to corroborate blocked primary pages.

Never automate CAPTCHA solving, bypass login/paywall controls, ignore `robots.txt`, rotate identities to evade a ban, or claim a blocked page was successfully collected. Mark it with `ACCESS_DENIED`, `BOT_CHALLENGE`, `RATE_LIMITED`, or `ROBOTS_DENIED` and choose an authorized alternative.

## Diagnose model behavior

Read saved structured responses, confidence, concise `reasoning`, provider diagnostics and model errors. State explicitly when the model was never invoked. Never request, reconstruct, or expose private chain-of-thought; the application intentionally stores only auditable short rationales and structured outputs.

## Iterate safely

Auto-apply only low-risk changes allowed by the policy: fairer page allocation, lower per-host concurrency, longer backoff, candidate re-ranking, and fallback ordering. Record the evidence, old value, new value, expected effect and rollback condition.

Require user review before adding a paid service or proxy, increasing cost/time budgets, weakening date acceptance, changing `robots.txt` handling, or accessing authenticated content. Never change extraction fields merely to inflate project counts.

Treat a strategy as improved only if it raises at least one downstream metric without degrading evidence quality: unique valid URLs, successful正文, date-qualified articles, assessment coverage, valid project yield, or corroborating source count.
