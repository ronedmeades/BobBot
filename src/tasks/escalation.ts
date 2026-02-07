/**
 * Escalation Engine
 *
 * Manages ordered notification chains with time delays.
 * Trigger -> wait -> nudge -> wait -> escalate.
 *
 * Acknowledgement: any user interaction (message in Telegram or dashboard)
 * after the trigger cancels further escalation.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type {
  EscalationChain,
  EscalationStep,
  EscalationFile,
  NotifyChannel,
} from "./types.js";

// --- Channel availability ---

export function getAvailableChannels(): NotifyChannel[] {
  const channels: NotifyChannel[] = [];

  // Telegram: need bot token + owner user ID (numeric)
  if (config.telegram.botToken && Number(config.owner.userId)) {
    channels.push("telegram");
  }

  // SMS + Call: need Twilio env vars
  const hasTwilio = !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER &&
    process.env.OWNER_PHONE_NUMBER
  );
  if (hasTwilio) {
    channels.push("sms");
    channels.push("call");
  }

  return channels;
}

/**
 * Filter requested channels to only those that are available,
 * and deduplicate (never send the same channel twice in a chain).
 */
export function filterChannels(requested: NotifyChannel[]): NotifyChannel[] {
  const available = new Set(getAvailableChannels());
  const seen = new Set<NotifyChannel>();
  const result: NotifyChannel[] = [];

  for (const ch of requested) {
    if (available.has(ch) && !seen.has(ch)) {
      result.push(ch);
      seen.add(ch);
    }
  }

  return result;
}

const ESCALATION_FILE = resolve("memory", "escalations.json");

let chains: EscalationChain[] = [];

// --- Last user interaction tracking ---
// Updated by core.ts / telegram.ts whenever the user sends a message
let lastInteractionAt: Record<string, string> = {}; // userId -> ISO timestamp

export function recordUserInteraction(userId: string): void {
  lastInteractionAt[userId] = new Date().toISOString();
}

export function getLastInteraction(userId: string): string | undefined {
  return lastInteractionAt[userId];
}

// --- Persistence ---

async function save(): Promise<void> {
  const data: EscalationFile = { version: 1, chains };
  await mkdir(resolve("memory"), { recursive: true });
  await writeFile(ESCALATION_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export async function initEscalation(): Promise<void> {
  try {
    const raw = await readFile(ESCALATION_FILE, "utf-8");
    const data = JSON.parse(raw) as EscalationFile;
    chains = data.chains ?? [];
    console.log(`[escalation] Loaded ${chains.length} chains from disk`);
  } catch {
    chains = [];
  }
}

// --- Create ---

export interface CreateEscalationOpts {
  triggerType: string;
  triggerRef: string;
  description: string;
  notifyChannels: NotifyChannel[];
  escalateAfterMin: number; // minutes between each step
  userId: string;
  chatId: number;
  context?: Record<string, string>;
}

export async function createEscalation(opts: CreateEscalationOpts): Promise<EscalationChain | null> {
  // Filter to available channels only, no duplicates
  const channels = filterChannels(opts.notifyChannels);
  if (channels.length === 0) {
    console.log(`[escalation] No available channels for "${opts.description}" — skipping`);
    return null;
  }

  const steps: EscalationStep[] = channels.map((channel, i) => ({
    channel,
    delayMin: i * opts.escalateAfterMin,  // first fires at 0, second at N, third at 2N...
  }));

  const chain: EscalationChain = {
    id: randomUUID(),
    triggerType: opts.triggerType,
    triggerRef: opts.triggerRef,
    description: opts.description,
    steps,
    currentStep: 0,
    triggeredAt: new Date().toISOString(),
    status: "active",
    userId: opts.userId,
    chatId: opts.chatId,
    context: opts.context,
  };

  chains.push(chain);
  await save();

  console.log(
    `[escalation] Created chain ${chain.id.slice(0, 8)} — ` +
    `${steps.length} steps: ${steps.map((s) => `${s.channel}@${s.delayMin}m`).join(" -> ")}`
  );

  return chain;
}

// --- Acknowledge ---

export async function acknowledgeEscalation(chainId: string): Promise<void> {
  const chain = chains.find((c) => c.id === chainId);
  if (chain && chain.status === "active") {
    chain.acknowledgedAt = new Date().toISOString();
    chain.status = "acknowledged";
    await save();
    console.log(`[escalation] Chain ${chainId.slice(0, 8)} acknowledged`);
  }
}

/**
 * Auto-acknowledge any active chains for a user based on their last interaction.
 * Called during the escalation tick.
 */
function autoAcknowledge(userId: string): void {
  const lastMsg = lastInteractionAt[userId];
  if (!lastMsg) return;

  for (const chain of chains) {
    if (chain.status !== "active") continue;
    if (chain.userId !== userId) continue;
    // Only acknowledge if user interacted AFTER the trigger
    // AND after at least one notification was sent
    if (chain.currentStep > 0 && lastMsg > chain.triggeredAt) {
      chain.acknowledgedAt = lastMsg;
      chain.status = "acknowledged";
      console.log(`[escalation] Chain ${chain.id.slice(0, 8)} auto-acknowledged (user active)`);
    }
  }
}

// --- Cancel ---

export async function cancelEscalation(chainId: string): Promise<void> {
  const chain = chains.find((c) => c.id === chainId);
  if (chain && chain.status === "active") {
    chain.status = "cancelled";
    await save();
  }
}

export async function cancelByTrigger(triggerRef: string): Promise<void> {
  for (const chain of chains) {
    if (chain.triggerRef === triggerRef && chain.status === "active") {
      chain.status = "cancelled";
    }
  }
  await save();
}

// --- Query ---

export function getActiveChains(): EscalationChain[] {
  return chains.filter((c) => c.status === "active");
}

export function getChain(id: string): EscalationChain | undefined {
  return chains.find((c) => c.id === id);
}

// --- Notification dispatch ---

type TelegramNotifyFn = (chatId: number, message: string) => Promise<void>;
let telegramNotify: TelegramNotifyFn | null = null;

export function setEscalationNotifier(fn: TelegramNotifyFn): void {
  telegramNotify = fn;
}

async function sendStep(chain: EscalationChain, step: EscalationStep): Promise<void> {
  const desc = chain.description;
  const urgency = step.delayMin > 0 ? " (escalated)" : "";

  if (step.channel === "telegram") {
    if (!telegramNotify || !chain.chatId) {
      step.error = "Telegram notifier not available";
      return;
    }
    const findings = chain.context?.findings;
    const summary = findings && findings.length > 4000
      ? findings.slice(0, 4000) + "\n\n...(truncated)"
      : (findings || "");
    const msg = summary
      ? `${chain.triggerType === "task_failed" ? "Task failed" : "Task complete"}${urgency}: "${desc}"\n\n${summary}`
      : `${chain.triggerType === "task_failed" ? "Task failed" : "Task complete"}${urgency}: "${desc}"`;
    await telegramNotify(chain.chatId, msg);
  } else if (step.channel === "sms") {
    const { handleSendSms } = await import("../skills/phone.js");
    const shortDesc = desc.length > 100 ? desc.slice(0, 100) + "..." : desc;
    await handleSendSms({
      message: `Bob${urgency}: "${shortDesc}" — check dashboard for details`,
    });
  } else if (step.channel === "call") {
    const { handleCallOwner } = await import("../skills/phone.js");
    await handleCallOwner({
      message: `Hello, this is Bob${urgency}. ${desc.slice(0, 200)}. Please check the dashboard for full results.`,
    });
  }

  step.sentAt = new Date().toISOString();
  console.log(`[escalation] Sent ${step.channel}${urgency} for chain ${chain.id.slice(0, 8)}`);
}

// --- Tick (called by worker loop) ---

export async function escalationTick(): Promise<void> {
  const active = chains.filter((c) => c.status === "active");
  if (active.length === 0) return;

  const now = Date.now();
  let changed = false;

  for (const chain of active) {
    // Auto-acknowledge if user has interacted since trigger
    autoAcknowledge(chain.userId);
    if (chain.status !== "active") {
      changed = true;
      continue;
    }

    // Check if the next step is due
    if (chain.currentStep >= chain.steps.length) {
      chain.status = "completed";
      changed = true;
      console.log(`[escalation] Chain ${chain.id.slice(0, 8)} completed (all steps sent)`);
      continue;
    }

    const step = chain.steps[chain.currentStep];
    const triggerTime = new Date(chain.triggeredAt).getTime();
    const stepDueAt = triggerTime + step.delayMin * 60 * 1000;

    if (now >= stepDueAt) {
      try {
        await sendStep(chain, step);
      } catch (err) {
        step.error = err instanceof Error ? err.message : String(err);
        console.error(`[escalation] Failed to send ${step.channel}:`, step.error);
      }
      chain.currentStep++;
      changed = true;

      // If that was the last step, mark completed
      if (chain.currentStep >= chain.steps.length) {
        chain.status = "completed";
        console.log(`[escalation] Chain ${chain.id.slice(0, 8)} completed (all steps sent)`);
      }
    }
  }

  if (changed) await save();
}

// --- Cleanup ---

export async function cleanupOldChains(): Promise<number> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const before = chains.length;

  chains = chains.filter((c) => {
    if (c.status === "acknowledged" || c.status === "completed" || c.status === "cancelled") {
      return new Date(c.triggeredAt).getTime() > cutoff;
    }
    return true;
  });

  const removed = before - chains.length;
  if (removed > 0) await save();
  return removed;
}
