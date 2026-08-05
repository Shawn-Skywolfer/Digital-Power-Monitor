import { spawn } from "node:child_process";
import path from "node:path";

const command = process.argv[2] ?? "dev";
const bin = path.resolve("node_modules", ".bin", process.platform === "win32" ? "vinext.CMD" : "vinext");
const child = spawn(bin, [command], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8765",
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
