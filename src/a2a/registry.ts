/**
 * A2A Peer Registry
 *
 * Manages known peer agents — discovery, trust tiers, per-peer tokens,
 * rate limiting, budget tracking, and presence.
 *
 * Follows the load-once persistence pattern (see standing-rules.ts).
 * Data stored in memory/a2a-peers.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PeerAgent,
  PeerSkill,
  TrustTier,
  PresenceStatus,
  A2APeersFile,
  AgentCard,
} from "./types.js";

const PEERS_PATH = resolve("memory", "a2a-peers.json");
const CURRENT_VERSION = 1;

// Module-level state (load-once pattern)
let peers: PeerAgent[] = [];
let initialized = false;

// ─── Persistence ────────────────────────────────────────────────────

async function loadPeers(): Promise<void> {
  try {
    const raw = await readFile(PEERS_PATH, "utf-8");
    const data = JSON.parse(raw) as A2APeersFile;
    peers = data.peers ?? [];
    // Reset hourly counters on load (fresh start)
    for (const peer of peers) {
      peer.requestsThisHour = 0;
      peer.lastHourReset = new Date().toISOString();
    }
  } catch {
    peers = [];
  }
  initialized = true;
}

async function savePeers(): Promise<void> {
  await mkdir(resolve("memory"), { recursive: true });
  const data: A2APeersFile = { version: CURRENT_VERSION, peers };
  await writeFile(PEERS_PATH, JSON.stringify(data, null, 2));
}

async function ensureLoaded(): Promise<void> {
  if (!initialized) await loadPeers();
}

// ─── Public API ─────────────────────────────────────────────────────

export async function initPeerRegistry(): Promise<void> {
  await ensureLoaded();
  if (peers.length > 0) {
    const active = peers.filter((p) => p.status === "active").length;
    console.log(`[a2a] Loaded ${peers.length} peers (${active} active)`);
  }
}

export async function registerPeer(
  card: AgentCard,
  url: string,
  options?: { trustTier?: TrustTier; ourTokenForThem?: string }
): Promise<PeerAgent> {
  await ensureLoaded();

  // Check if already registered at this URL
  const existing = peers.find((p) => p.url === url);
  if (existing) {
    // Update from fresh Agent Card
    existing.agentId = card.id;
    existing.name = card.name;
    existing.description = card.description;
    existing.skills = (card.skills ?? []).map(skillFromCard);
    existing.lastSeen = new Date().toISOString();
    await savePeers();
    return existing;
  }

  const now = new Date().toISOString();
  const peer: PeerAgent = {
    id: randomUUID(),
    agentId: card.id,
    name: card.name,
    url: url.replace(/\/+$/, ""), // Trim trailing slashes
    description: card.description ?? "",
    skills: (card.skills ?? []).map(skillFromCard),
    trustTier: options?.trustTier ?? "manual",
    status: "active",
    presence: "unknown",
    peerToken: randomUUID(),     // Token they use to auth with us
    ourTokenForThem: options?.ourTokenForThem ?? "", // Token we use with them
    budgetUsed: 0,
    rateLimitPerHour: 10,
    requestsThisHour: 0,
    lastHourReset: now,
    firstSeen: now,
    lastSeen: now,
    totalRequests: 0,
    totalCostUsd: 0,
    notes: "",
  };

  peers.push(peer);
  await savePeers();
  console.log(`[a2a] Registered peer "${peer.name}" (${peer.id}) at ${peer.url}`);
  return peer;
}

export async function getPeer(id: string): Promise<PeerAgent | null> {
  await ensureLoaded();
  return peers.find((p) => p.id === id) ?? null;
}

export async function getPeerByToken(token: string): Promise<PeerAgent | null> {
  await ensureLoaded();
  if (!token) return null;
  return peers.find((p) => p.peerToken === token) ?? null;
}

export async function getPeerByUrl(url: string): Promise<PeerAgent | null> {
  await ensureLoaded();
  const normalized = url.replace(/\/+$/, "");
  return peers.find((p) => p.url === normalized) ?? null;
}

export async function getPeerByAgentId(agentId: string): Promise<PeerAgent | null> {
  await ensureLoaded();
  return peers.find((p) => p.agentId === agentId) ?? null;
}

export async function listPeers(): Promise<PeerAgent[]> {
  await ensureLoaded();
  return [...peers];
}

export async function updatePeer(
  id: string,
  updates: Partial<Omit<PeerAgent, "id" | "peerToken">>
): Promise<PeerAgent | null> {
  await ensureLoaded();
  const peer = peers.find((p) => p.id === id);
  if (!peer) return null;
  Object.assign(peer, updates);
  await savePeers();
  return peer;
}

export async function removePeer(id: string): Promise<boolean> {
  await ensureLoaded();
  const idx = peers.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const removed = peers.splice(idx, 1)[0];
  await savePeers();
  console.log(`[a2a] Removed peer "${removed.name}" (${removed.id})`);
  return true;
}

// ─── Trust Management ───────────────────────────────────────────────

export async function setTrustTier(
  id: string,
  tier: TrustTier,
  budgetCap?: number
): Promise<PeerAgent | null> {
  await ensureLoaded();
  const peer = peers.find((p) => p.id === id);
  if (!peer) return null;

  peer.trustTier = tier;
  if (tier === "budget-capped" && budgetCap !== undefined) {
    peer.budgetCap = budgetCap;
  }
  if (tier === "blocked") {
    peer.status = "blocked";
  } else if (peer.status === "blocked") {
    peer.status = "active";
  }

  await savePeers();
  console.log(`[a2a] Set trust tier for "${peer.name}" to ${tier}${budgetCap ? ` ($${budgetCap} cap)` : ""}`);
  return peer;
}

export function checkBudget(peer: PeerAgent): { allowed: boolean; remaining: number } {
  if (peer.trustTier !== "budget-capped" || !peer.budgetCap) {
    return { allowed: true, remaining: Infinity };
  }
  const remaining = peer.budgetCap - peer.budgetUsed;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

export async function recordCost(peerId: string, costUsd: number): Promise<void> {
  await ensureLoaded();
  const peer = peers.find((p) => p.id === peerId);
  if (!peer) return;
  peer.budgetUsed += costUsd;
  peer.totalCostUsd += costUsd;
  await savePeers();
}

// ─── Rate Limiting ──────────────────────────────────────────────────

export function checkRateLimit(peer: PeerAgent): boolean {
  const now = Date.now();
  const resetTime = new Date(peer.lastHourReset).getTime();

  // Auto-reset if more than 1 hour has passed
  if (now - resetTime > 3_600_000) {
    peer.requestsThisHour = 0;
    peer.lastHourReset = new Date().toISOString();
  }

  return peer.requestsThisHour < peer.rateLimitPerHour;
}

export async function recordRequest(peer: PeerAgent): Promise<void> {
  peer.requestsThisHour++;
  peer.totalRequests++;
  peer.lastRequestAt = new Date().toISOString();
  peer.lastSeen = new Date().toISOString();
  await savePeers();
}

export function resetHourlyCounters(): void {
  const now = new Date().toISOString();
  for (const peer of peers) {
    peer.requestsThisHour = 0;
    peer.lastHourReset = now;
  }
  // Don't await save here — called from scheduler, will save on next mutation
}

// ─── Presence ───────────────────────────────────────────────────────

export async function updatePeerPresence(
  id: string,
  presence: PresenceStatus
): Promise<void> {
  await ensureLoaded();
  const peer = peers.find((p) => p.id === id);
  if (!peer) return;
  peer.presence = presence;
  if (presence === "online") {
    peer.lastSeen = new Date().toISOString();
  }
  // Don't save on every presence update — too noisy. Save on next mutation.
}

export async function getPeerPresence(id: string): Promise<PresenceStatus> {
  await ensureLoaded();
  const peer = peers.find((p) => p.id === id);
  return peer?.presence ?? "unknown";
}

// ─── Helpers ────────────────────────────────────────────────────────

function skillFromCard(s: { id: string; name: string; description?: string }): PeerSkill {
  return { id: s.id, name: s.name, description: s.description ?? "" };
}
