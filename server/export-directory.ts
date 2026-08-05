import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const grants = new Map<string, { directory: string; expiresAt: number }>();
const GRANT_TTL_MS = 30 * 60_000;

function purgeExpiredGrants() {
  const current = Date.now();
  for (const [token, grant] of grants) if (grant.expiresAt <= current) grants.delete(token);
}

export function grantExportDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error("所选导出目标不是文件夹");
  fs.accessSync(resolved, fs.constants.W_OK);
  purgeExpiredGrants();
  const token = randomUUID();
  grants.set(token, { directory: resolved, expiresAt: Date.now() + GRANT_TTL_MS });
  return { token, path: resolved, name: path.basename(resolved) || resolved };
}

export function resolveExportDirectory(token: string) {
  purgeExpiredGrants();
  const grant = grants.get(token);
  if (!grant) throw new Error("导出文件夹授权已失效，请重新选择文件夹");
  const stat = fs.statSync(grant.directory);
  if (!stat.isDirectory()) throw new Error("导出目标文件夹已不存在");
  fs.accessSync(grant.directory, fs.constants.W_OK);
  grant.expiresAt = Date.now() + GRANT_TTL_MS;
  return grant.directory;
}

export async function pickExportDirectory() {
  if (process.platform !== "win32") throw new Error("当前系统暂不支持原生文件夹选择器");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择 Digital Power Monitor 导出目标文件夹'",
    "$dialog.ShowNewFolderButton = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))",
    "}",
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    windowsHide: true,
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024,
  });
  const encoded = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  if (!encoded) return { cancelled: true as const };
  const directory = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (!directory) return { cancelled: true as const };
  return { cancelled: false as const, ...grantExportDirectory(directory) };
}
