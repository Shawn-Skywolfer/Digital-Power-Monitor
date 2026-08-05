# Evidence and iteration rules

## Diagnose the funnel

Use these causes in order:

1. `DISCOVERY_FAILURES`: entry, sitemap, feed or archive enumeration failed.
2. `ACCESS_BLOCKED`: HTTP 401/403/429 or block-page text was detected.
3. `SOURCE_BUDGET_MONOPOLY`: one source consumed over half the page budget.
4. `DATE_FILTER_LOSS`: fetched pages exist, but few have a reliable date in range.
5. `CLASSIFICATION_STARVATION`: date-qualified pages exist, but assessments are missing.
6. `MODEL_NOT_INVOKED`: no saved assessment or model error exists; do not describe this as model rejection.
7. `MODEL_EXTRACTION_ERROR`: a provider call failed and the deterministic fallback was used.
8. `LOW_PROJECT_YIELD`: assessments completed but few concrete project events were found.

## Evidence required for a change

Record:

- scan ID and time range;
- affected source and representative URLs;
- before/after funnel counts;
- relevant failure codes and log events;
- saved model rationale or provider error, if any;
- exact strategy value changed and rollback condition.

## Route patterns

Adopt the architectural patterns documented by the official projects, without copying AGPL code into this application:

- Firecrawl: map/search/scrape separation, sitemap controls, search operators, browser actions, deduplication and retry handling — <https://github.com/firecrawl/firecrawl> and <https://docs.firecrawl.dev/api-reference/endpoint/map>.
- Crawlee: sessions bind cookies, headers and proxy identity; blocked status codes retire a bad session — <https://crawlee.dev/js/docs/guides/session-management>.
- Playwright: isolate sites with browser contexts and retain ordinary session state during a scan — <https://playwright.dev/docs/api/class-browsercontext>.

These patterns improve reliability; they do not authorize bypassing access controls.
