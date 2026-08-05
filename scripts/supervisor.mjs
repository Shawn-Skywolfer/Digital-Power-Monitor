import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2] === "start" ? "start" : "dev";
const projectRoot = path.resolve(import.meta.dirname, "..");
const logPath = path.join(projectRoot, "data", "service-supervisor.log");
const apiUrl = process.env.DPM_API_URL ?? "http://127.0.0.1:8765";
const env = {
  ...process.env,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? apiUrl,
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
};

let shuttingDown = false;
let apiProcess;
let webProcess;
let apiRestartTimer;
let webRestartTimer;
let healthTimer;
let consecutiveHealthFailures = 0;

function writeLog(level, message, context = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...context });
  process.stdout.write(`[supervisor] ${message}\n`);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch { /* Console output remains available if the log file is not writable. */ }
}

function spawnNode(args, label) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  writeLog("info", `${label} 已启动`, { pid: child.pid });
  child.on("error", (error) => writeLog("error", `${label} 启动失败`, { error: error.message }));
  return child;
}

function startApi() {
  if (shuttingDown || (apiProcess && apiProcess.exitCode === null)) return;
  apiProcess = spawnNode(["--import", "tsx", "server/index.ts"], "API");
  apiProcess.once("exit", (code, signal) => {
    writeLog(code === 0 ? "warn" : "error", "API 已退出，守护进程将自动重启", { code, signal });
    apiProcess = undefined;
    if (!shuttingDown) apiRestartTimer = setTimeout(startApi, 1_200);
  });
}

function startWeb() {
  if (shuttingDown || (webProcess && webProcess.exitCode === null)) return;
  const command = mode === "start" ? "start" : "dev";
  const args = ["node_modules/vinext/dist/cli.js", command];
  if (mode === "dev") args.push("--hostname", "127.0.0.1", "--port", "3000");
  webProcess = spawnNode(args, "Web");
  webProcess.once("exit", (code, signal) => {
    writeLog(code === 0 ? "warn" : "error", "Web 已退出，守护进程将自动重启", { code, signal });
    webProcess = undefined;
    if (!shuttingDown) webRestartTimer = setTimeout(startWeb, 1_500);
  });
}

async function checkApiHealth() {
  if (shuttingDown) return;
  try {
    const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (consecutiveHealthFailures > 0) writeLog("info", "API 健康检查已恢复");
    consecutiveHealthFailures = 0;
  } catch (error) {
    consecutiveHealthFailures++;
    writeLog("warn", "API 健康检查失败", {
      consecutiveFailures: consecutiveHealthFailures,
      error: error instanceof Error ? error.message : String(error),
    });
    if (consecutiveHealthFailures >= 3) {
      consecutiveHealthFailures = 0;
      if (apiProcess && apiProcess.exitCode === null) {
        writeLog("error", "API 连续三次无响应，正在强制重启", { pid: apiProcess.pid });
        apiProcess.kill("SIGTERM");
      } else {
        startApi();
      }
    }
  }
}

function stop(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(apiRestartTimer);
  clearTimeout(webRestartTimer);
  clearInterval(healthTimer);
  if (apiProcess?.exitCode === null) apiProcess.kill(signal);
  if (webProcess?.exitCode === null) webProcess.kill(signal);
  writeLog("info", "服务守护进程已停止", { signal });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("uncaughtException", (error) => writeLog("error", "守护进程未捕获异常", { error: error.message }));
process.on("unhandledRejection", (error) => writeLog("error", "守护进程 Promise 异常", { error: String(error) }));

startApi();
startWeb();
healthTimer = setInterval(() => void checkApiHealth(), 5_000);
void checkApiHealth();
