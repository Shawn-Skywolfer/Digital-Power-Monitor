import fs from "node:fs/promises";
import "../server/index.ts";

const API = "http://127.0.0.1:8765";

async function waitForApi() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${API}/health`);
      if (response.ok) return;
    } catch {
      // The listener may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API did not become ready");
}

async function postFile(path: string, endpoint: string) {
  const content = await fs.readFile(path);
  const response = await fetch(`${API}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: path.split(/[\\/]/).at(-1), base64: content.toString("base64") }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(payload));
  return payload;
}

try {
  await waitForApi();
  const health = await fetch(`${API}/health`).then((response) => response.json());
  const sources = await postFile("C:/Users/perfe/Downloads/信息来源.xlsx", "/api/sources/import");
  const reference = await postFile("C:/Users/perfe/Downloads/项目汇总列表-V1.xlsx", "/api/reference/import");
  if (reference.rows.length !== 69) throw new Error(`Expected 69 reference rows, received ${reference.rows.length}`);
  const sourceList = await fetch(`${API}/api/sources`).then((response) => response.json());
  console.log(JSON.stringify({
    health,
    importedSources: sources,
    effectiveSourceCount: sourceList.length,
    referenceRows: reference.rows.length,
    referenceHeaders: reference.headers,
  }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
