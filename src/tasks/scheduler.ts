import { stat } from "node:fs/promises";
import { config } from "../config.js";
import { memory } from "../agent/memory.js";
import { handleBackupBob } from "../skills/backup.js";
import { events } from "../dashboard/events.js";
import { checkScheduledTasks, initScheduledTasks } from "../skills/scheduler.js";
import { checkAllWatches } from "../skills/web-monitor.js";
import { checkCalendarReminders } from "../skills/calendar.js";
import { checkReminders } from "../skills/reminders.js";
import { checkStandingRules, initStandingRules } from "../skills/standing-rules.js";
import { checkHomeAssistantMonitors } from "../skills/home-assistant.js";
import { getIsBusy } from "./busy-state.js";

/**
 * Simple scheduler for recurring tasks.
 * Currently handles auto-backup on a configurable interval.
 *
 * Config via .env:
 *   BACKUP_PATH        — where to back up (e.g. D:\BobBackups)
 *   BACKUP_INTERVAL_DAYS — how often to auto-backup (default: 3)
 */

type NotifyFn = (chatId: number, message: string) => Promise<void>;

let notifyOwner: NotifyFn | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

// Check every hour if anything is due
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Track last backup time in memory as a note
const LAST_BACKUP_NOTE = "system-last-backup";

export function setSchedulerNotifier(fn: NotifyFn): void {
  notifyOwner = fn;
}

async function getLastBackupTime(): Promise<Date | null> {
  const note = await memory.loadNote(LAST_BACKUP_NOTE);
  if (!note) return null;
  const parsed = new Date(note.trim());
  return isNaN(parsed.getTime()) ? null : parsed;
}

async function setLastBackupTime(date: Date): Promise<void> {
  await memory.saveNote(LAST_BACKUP_NOTE, date.toISOString());
}

function getBackupIntervalDays(): number {
  const envVal = process.env.BACKUP_INTERVAL_DAYS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3; // default
}

async function isDriveAvailable(backupPath: string): Promise<boolean> {
  try {
    const s = await stat(backupPath);
    return s.isDirectory();
  } catch {
    // Check if at least the drive root exists (Windows: D:\, Mac/Linux: /Volumes/xxx)
    const root = backupPath.match(/^[A-Z]:\\/i)?.[0] ?? backupPath.split("/").slice(0, 3).join("/");
    try {
      await stat(root);
      return true;
    } catch {
      return false;
    }
  }
}

async function getOwnerChatId(): Promise<number | null> {
  const profile = await memory.loadProfile(config.owner.userId);
  if (!profile || profile.chatId === 0) return null;
  return profile.chatId;
}

async function sendOwnerMessage(message: string): Promise<void> {
  const chatId = await getOwnerChatId();
  if (chatId && notifyOwner) {
    await notifyOwner(chatId, message);
  }
}

async function checkAndRunBackup(): Promise<void> {
  const backupPath = process.env.BACKUP_PATH;
  if (!backupPath) return; // No backup path configured, skip silently

  const intervalDays = getBackupIntervalDays();
  const lastBackup = await getLastBackupTime();
  const now = new Date();

  // Check if backup is due
  if (lastBackup) {
    const daysSinceBackup = (now.getTime() - lastBackup.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceBackup < intervalDays) {
      return; // Not due yet
    }
  }

  // Backup is due — check if drive is available
  const driveReady = await isDriveAvailable(backupPath);

  if (!driveReady) {
    console.log(`[scheduler] Backup is due but drive not available: ${backupPath}`);
    await sendOwnerMessage(
      `Hey, it's been ${intervalDays}+ days since my last backup and I can't find the backup drive (${backupPath}). ` +
      `Can you plug it in? I'll back up automatically once I detect it.`
    );
    return;
  }

  // Drive is available — run backup
  console.log(`[scheduler] Running auto-backup to ${backupPath}`);
  events.emitEvent("task:update", {
    taskId: "auto-backup",
    status: "running",
    description: "Auto-backup in progress",
  });

  try {
    const result = await handleBackupBob({
      backup_path: backupPath,
      include_env: true,
      label: "auto",
    });

    if (result.success) {
      await setLastBackupTime(now);
      console.log(`[scheduler] Auto-backup complete`);
      events.emitEvent("task:update", {
        taskId: "auto-backup",
        status: "completed",
        description: "Auto-backup complete",
      });
      await sendOwnerMessage(`Auto-backup complete. ${result.output.split("\n")[1] ?? ""}`);
    } else {
      console.error(`[scheduler] Auto-backup failed: ${result.output}`);
      await sendOwnerMessage(`Tried to auto-backup but something went wrong: ${result.output.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Auto-backup error: ${msg}`);
    await sendOwnerMessage(`Auto-backup hit an error: ${msg}`);
  }
}

/**
 * Run all hourly checks: backup, scheduled tasks, web monitors.
 */
async function runAllChecks(): Promise<void> {
  // Skip if agent is busy with direct chat or background task
  if (getIsBusy()) {
    console.log("[scheduler] Skipping checks — agent is busy");
    return;
  }

  await checkAndRunBackup();

  // Run user-defined scheduled tasks
  try {
    await checkScheduledTasks();
  } catch (err) {
    console.error("[scheduler] Scheduled tasks error:", err);
  }

  // Check web monitors for changes
  try {
    const changes = await checkAllWatches();
    if (changes.length > 0) {
      await sendOwnerMessage(
        `Web monitor alert!\n\n${changes.join("\n\n")}`
      );
    }
  } catch (err) {
    console.error("[scheduler] Web monitor error:", err);
  }

  // Check calendar reminders
  try {
    const reminders = await checkCalendarReminders();
    if (reminders.length > 0) {
      await sendOwnerMessage(
        `Calendar reminders:\n\n${reminders.join("\n\n")}`
      );
    }
  } catch (err) {
    console.error("[scheduler] Calendar reminder error:", err);
  }

  // Check quick reminders (snooze-based)
  try {
    const dueReminders = await checkReminders();
    if (dueReminders.length > 0) {
      await sendOwnerMessage(
        `Reminders:\n\n${dueReminders.join("\n\n")}`
      );
    }
  } catch (err) {
    console.error("[scheduler] Reminders error:", err);
  }

  // Check standing rules (marketplace monitoring)
  try {
    const alerts = await checkStandingRules();
    if (alerts.length > 0) {
      await sendOwnerMessage(
        `Marketplace alerts:\n\n${alerts.join("\n\n")}`
      );
    }
  } catch (err) {
    console.error("[scheduler] Standing rules error:", err);
  }

  // Check Home Assistant device monitors
  try {
    const haAlerts = await checkHomeAssistantMonitors();
    if (haAlerts.length > 0) {
      await sendOwnerMessage(
        `Home Assistant alerts:\n\n${haAlerts.join("\n\n")}`
      );
    }
  } catch (err) {
    console.error("[scheduler] HA monitors error:", err);
  }

  // A2A maintenance (rate limit reset, approval expiry, cleanup, presence pings)
  try {
    const { config: appConfig } = await import("../config.js");
    if (appConfig.a2a.enabled) {
      await checkA2AMaintenance();
    }
  } catch (err) {
    console.error("[scheduler] A2A maintenance error:", err);
  }
}

/**
 * Start the scheduler. Checks hourly if any scheduled tasks are due.
 */
export async function startScheduler(): Promise<void> {
  if (schedulerTimer) return; // Already running

  // Initialize scheduled tasks and standing rules from disk
  await initScheduledTasks();
  await initStandingRules();

  const backupPath = process.env.BACKUP_PATH;
  const intervalDays = getBackupIntervalDays();

  if (backupPath) {
    console.log(`Auto-backup: every ${intervalDays} days → ${backupPath}`);
  }

  // Run first check after 30 seconds (let everything else start up first)
  setTimeout(() => {
    runAllChecks().catch((err) => {
      console.error("[scheduler] Error:", err);
    });
  }, 30_000);

  // Then check every hour
  schedulerTimer = setInterval(() => {
    runAllChecks().catch((err) => {
      console.error("[scheduler] Error:", err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * A2A maintenance tasks: reset rate limits, expire approvals, clean old data, ping peers.
 */
async function checkA2AMaintenance(): Promise<void> {
  const { resetHourlyCounters, listPeers, updatePeerPresence } = await import("../a2a/registry.js");
  const { expireOldApprovals } = await import("../a2a/approvals.js");
  const { cleanupOldA2ATasks } = await import("../a2a/tasks.js");
  const { cleanupOldEntries } = await import("../a2a/audit.js");

  // Reset hourly rate limit counters
  await resetHourlyCounters();

  // Expire old approval requests
  const expired = await expireOldApprovals();
  if (expired > 0) {
    console.log(`[a2a] Expired ${expired} old approval requests`);
  }

  // Clean up old tasks (>7 days) and audit entries (>30 days)
  const removedTasks = await cleanupOldA2ATasks();
  const removedAudit = await cleanupOldEntries();
  if (removedTasks > 0 || removedAudit > 0) {
    console.log(`[a2a] Cleaned up ${removedTasks} old tasks, ${removedAudit} old audit entries`);
  }

  // Presence ping: check all active peers
  const peers = await listPeers();
  for (const peer of peers) {
    if (peer.status !== "active") continue;
    try {
      const resp = await fetch(`${peer.url}/a2a/ping`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        await updatePeerPresence(peer.id, "online");
      } else {
        await updatePeerPresence(peer.id, "offline");
      }
    } catch {
      await updatePeerPresence(peer.id, "offline");
    }
  }
}

export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
