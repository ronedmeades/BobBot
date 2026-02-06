import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { memory } from "../agent/memory.js";
import { handleBackupBob } from "../skills/backup.js";
import { events } from "../dashboard/events.js";

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
 * Start the scheduler. Checks hourly if any scheduled tasks are due.
 */
export function startScheduler(): void {
  if (schedulerTimer) return; // Already running

  const backupPath = process.env.BACKUP_PATH;
  const intervalDays = getBackupIntervalDays();

  if (backupPath) {
    console.log(`Auto-backup: every ${intervalDays} days → ${backupPath}`);
  }

  // Run first check after 30 seconds (let everything else start up first)
  setTimeout(() => {
    checkAndRunBackup().catch((err) => {
      console.error("[scheduler] Error:", err);
    });
  }, 30_000);

  // Then check every hour
  schedulerTimer = setInterval(() => {
    checkAndRunBackup().catch((err) => {
      console.error("[scheduler] Error:", err);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
