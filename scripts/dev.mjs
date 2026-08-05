import { spawn } from "node:child_process";

const env = {
  ...process.env,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8765",
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
};
const shell = process.platform === "win32";
const api = spawn("pnpm", ["run", "dev:api"], { stdio: "inherit", shell, env });
const web = spawn("pnpm", ["run", "dev:web"], { stdio: "inherit", shell, env });

function stop(signal = "SIGTERM") {
  api.kill(signal);
  web.kill(signal);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
api.on("exit", (code) => {
  if (code) {
    web.kill();
    process.exit(code);
  }
});
web.on("exit", (code) => {
  api.kill();
  process.exit(code ?? 0);
});
