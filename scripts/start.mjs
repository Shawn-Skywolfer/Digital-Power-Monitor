import { spawn } from "node:child_process";

const env = {
  ...process.env,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8765",
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
};
const shell = process.platform === "win32";
const api = spawn("pnpm", ["run", "start:api"], { stdio: "inherit", shell, env });
const web = spawn("pnpm", ["run", "start:web"], { stdio: "inherit", shell, env });
process.on("SIGINT", () => {
  api.kill("SIGINT");
  web.kill("SIGINT");
});
