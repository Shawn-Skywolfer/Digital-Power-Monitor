#!/usr/bin/env node

const [scanId, apiOrigin = "http://127.0.0.1:8765"] = process.argv.slice(2);
if (!scanId) {
  process.stderr.write("用法：node analyze_scan.mjs <scan-id> [api-origin]\n");
  process.exitCode = 2;
} else {
  const response = await fetch(`${apiOrigin.replace(/\/$/, "")}/api/scans/${encodeURIComponent(scanId)}/diagnostics`);
  const text = await response.text();
  if (!response.ok) throw new Error(`诊断接口 HTTP ${response.status}：${text}`);
  const diagnostics = JSON.parse(text);
  process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
}
