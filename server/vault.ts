import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "./db";

const VAULT_PATH = path.join(DATA_DIR, "secrets.json");
type VaultData = Record<string, string>;

function readVault(): VaultData {
  try { return JSON.parse(fs.readFileSync(VAULT_PATH, "utf8")) as VaultData; } catch { return {}; }
}

function protect(value: string): string {
  if (process.platform !== "win32") return Buffer.from(value, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Security -ErrorAction Stop;",
    "$v=[Console]::In.ReadToEnd();",
    "$b=[Text.Encoding]::UTF8.GetBytes($v);",
    "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($p));",
  ].join("");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: value, encoding: "utf8", windowsHide: true,
  }).trim();
}

function unprotect(value: string): string {
  if (process.platform !== "win32") return Buffer.from(value, "base64").toString("utf8");
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Security -ErrorAction Stop;",
    "$v=[Console]::In.ReadToEnd();",
    "$b=[Convert]::FromBase64String($v);",
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p));",
  ].join("");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: value, encoding: "utf8", windowsHide: true,
  });
}

export const vault = {
  set(key: string, value: string) {
    const data = readVault();
    data[key] = protect(value);
    fs.writeFileSync(VAULT_PATH, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  },
  get(key: string): string {
    const item = readVault()[key];
    if (!item) return "";
    try { return unprotect(item); } catch { return ""; }
  },
  has(key: string): boolean {
    return Boolean(readVault()[key]);
  },
  remove(key: string) {
    const data = readVault();
    delete data[key];
    fs.writeFileSync(VAULT_PATH, JSON.stringify(data, null, 2), "utf8");
  },
};
