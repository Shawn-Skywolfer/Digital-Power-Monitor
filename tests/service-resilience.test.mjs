import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ships API supervision and visible client reconnection", async () => {
  const [supervisor, page, dev, start] = await Promise.all([
    readFile(new URL("../scripts/supervisor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(supervisor, /API 已退出，守护进程将自动重启/);
  assert.match(supervisor, /consecutiveHealthFailures >= 3/);
  assert.match(supervisor, /setInterval\(\(\) => void checkApiHealth\(\), 5_000\)/);
  assert.match(page, /serviceState/);
  assert.match(page, /服务自动恢复中/);
  assert.match(page, /localRetry: 3/);
  assert.match(dev, /supervisor\.mjs/);
  assert.match(start, /supervisor\.mjs/);
});
