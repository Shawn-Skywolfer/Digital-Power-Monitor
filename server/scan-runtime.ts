import { randomUUID } from "node:crypto";
import { db, jsonParse, now } from "./db";
import type { JsonObject, ScanLogRecord } from "./types";

const activeScans = new Set<string>();

export class ScanStoppedError extends Error {
  constructor() { super("监测任务已停止"); this.name = "ScanStoppedError"; }
}

export function markScanActive(scanId: string, active: boolean) {
  if (active) activeScans.add(scanId); else activeScans.delete(scanId);
}

export function isScanActive(scanId: string) {
  return activeScans.has(scanId);
}

export function logScan(
  scanId: string, level: ScanLogRecord["level"], stage: string, event: string,
  message: string, context: JsonObject = {},
) {
  const row = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM scan_logs WHERE scan_id=?")
    .get(scanId) as { next: number };
  db.prepare(`INSERT INTO scan_logs
    (id,scan_id,sequence,level,stage,event,message,context_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), scanId, Number(row.next), level, stage, event, message,
      JSON.stringify(context), now(),
    );
}

export function getScanLogs(scanId: string, after = 0, limit = 500): ScanLogRecord[] {
  return (db.prepare(`SELECT * FROM scan_logs WHERE scan_id=? AND sequence>?
    ORDER BY sequence LIMIT ?`).all(scanId, after, Math.min(2000, Math.max(1, limit))) as Record<string, unknown>[])
    .map((row) => ({
      id: String(row.id), scanId: String(row.scan_id), sequence: Number(row.sequence),
      level: row.level as ScanLogRecord["level"], stage: String(row.stage), event: String(row.event),
      message: String(row.message), context: jsonParse<JsonObject>(row.context_json, {}),
      createdAt: String(row.created_at),
    }));
}

export async function scanControlPoint(scanId: string) {
  let announced = false;
  while (true) {
    const row = db.prepare("SELECT status FROM scans WHERE id=?").get(scanId) as { status: string } | undefined;
    if (!row || ["stopping", "stopped"].includes(row.status)) throw new ScanStoppedError();
    if (row.status !== "paused") return;
    if (!announced) {
      logScan(scanId, "info", "control", "paused", "任务已暂停，当前进度和队列已保存");
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export function controlScan(scanId: string, action: "pause" | "resume" | "stop") {
  const row = db.prepare("SELECT status FROM scans WHERE id=?").get(scanId) as { status: string } | undefined;
  if (!row) throw new Error("监测任务不存在");
  const current = row.status;
  if (action === "pause") {
    if (!["queued", "running"].includes(current)) throw new Error(`当前状态 ${current} 不能暂停`);
    db.prepare("UPDATE scans SET status='paused',updated_at=? WHERE id=?").run(now(), scanId);
    logScan(scanId, "info", "control", "pause_requested", "收到暂停请求");
  } else if (action === "resume") {
    if (current !== "paused") throw new Error(`当前状态 ${current} 不能继续`);
    if (!isScanActive(scanId)) throw new Error("服务已重启，当前任务不能原地继续；请复制任务参数后重新启动");
    db.prepare("UPDATE scans SET status='running',updated_at=? WHERE id=?").run(now(), scanId);
    logScan(scanId, "info", "control", "resumed", "任务已继续执行");
  } else {
    if (["completed", "failed", "stopped"].includes(current)) throw new Error(`当前状态 ${current} 不能停止`);
    const status = isScanActive(scanId) ? "stopping" : "stopped";
    db.prepare("UPDATE scans SET status=?,updated_at=? WHERE id=?").run(status, now(), scanId);
    logScan(scanId, "warn", "control", "stop_requested", status === "stopped" ? "任务已停止" : "收到停止请求，当前操作结束后停止");
  }
  return db.prepare("SELECT status,updated_at FROM scans WHERE id=?").get(scanId);
}
