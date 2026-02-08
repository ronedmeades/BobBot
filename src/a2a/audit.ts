/**
 * A2A Audit Log
 *
 * Logs all agent-to-agent interactions with cost tracking,
 * approval status, and peer identification.
 *
 * Rolling 500-entry window with 30-day cleanup.
 * Persistence in memory/a2a-audit.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEntry, A2AAuditFile } from "./types.js";

const AUDIT_PATH = resolve("memory", "a2a-audit.json");
const CURRENT_VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_AGE_DAYS = 30;

// Module-level state
let entries: AuditEntry[] = [];
let initialized = false;

// ─── Persistence ────────────────────────────────────────────────────

async function loadAudit(): Promise<void> {
  try {
    const raw = await readFile(AUDIT_PATH, "utf-8");
    const data = JSON.parse(raw) as A2AAuditFile;
    entries = data.entries ?? [];
  } catch {
    entries = [];
  }
  initialized = true;
}

async function saveAudit(): Promise<void> {
  await mkdir(resolve("memory"), { recursive: true });
  const data: A2AAuditFile = { version: CURRENT_VERSION, entries };
  await writeFile(AUDIT_PATH, JSON.stringify(data, null, 2));
}

async function ensureLoaded(): Promise<void> {
  if (!initialized) await loadAudit();
}

// ─── Public API ─────────────────────────────────────────────────────

export async function initAudit(): Promise<void> {
  await ensureLoaded();
  if (entries.length > 0) {
    console.log(`[a2a] Loaded ${entries.length} audit entries`);
  }
}

export async function logA2AEvent(
  entry: Omit<AuditEntry, "id" | "timestamp">
): Promise<AuditEntry> {
  await ensureLoaded();

  const full: AuditEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  entries.push(full);

  // Trim to max size
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }

  await saveAudit();
  return full;
}

export async function getAuditLog(opts?: {
  peerId?: string;
  direction?: "inbound" | "outbound";
  limit?: number;
}): Promise<AuditEntry[]> {
  await ensureLoaded();

  let filtered = entries;

  if (opts?.peerId) {
    filtered = filtered.filter((e) => e.peerId === opts.peerId);
  }
  if (opts?.direction) {
    filtered = filtered.filter((e) => e.direction === opts.direction);
  }

  // Return most recent first
  const sorted = [...filtered].reverse();
  const limit = opts?.limit ?? 20;
  return sorted.slice(0, limit);
}

export async function getAuditStats(peerId?: string): Promise<{
  totalInbound: number;
  totalOutbound: number;
  totalCostUsd: number;
  approvedCount: number;
  rejectedCount: number;
}> {
  await ensureLoaded();

  const filtered = peerId ? entries.filter((e) => e.peerId === peerId) : entries;

  return {
    totalInbound: filtered.filter((e) => e.direction === "inbound").length,
    totalOutbound: filtered.filter((e) => e.direction === "outbound").length,
    totalCostUsd: filtered.reduce((sum, e) => sum + e.estimatedCostUsd, 0),
    approvedCount: filtered.filter((e) => e.approved).length,
    rejectedCount: filtered.filter((e) => !e.approved).length,
  };
}

export async function cleanupOldEntries(): Promise<number> {
  await ensureLoaded();

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const before = entries.length;
  entries = entries.filter((e) => new Date(e.timestamp).getTime() > cutoff);

  const removed = before - entries.length;
  if (removed > 0) {
    await saveAudit();
  }
  return removed;
}
