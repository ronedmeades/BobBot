import { readdir, stat, readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Tool Definitions ---

export const backupToolDefinitions: Anthropic.Tool[] = [
  {
    name: "backup_bob",
    description:
      "Back up Bob's personal data (memory, profiles, notes, conversation history, and .env config) to a specified location. Creates a timestamped backup folder. Use this to protect against data loss or before making big changes. The backup includes everything needed to restore Bob's personality and knowledge on a new machine.",
    input_schema: {
      type: "object" as const,
      properties: {
        backup_path: {
          type: "string",
          description: "Destination directory for the backup (e.g. an external drive path). Falls back to BACKUP_PATH env var if not specified.",
        },
        include_env: {
          type: "boolean",
          description: "Whether to include .env file with API keys (default: true)",
        },
        label: {
          type: "string",
          description: "Optional label for this backup (e.g. 'before-upgrade', 'weekly')",
        },
      },
      required: [],
    },
  },
  {
    name: "restore_bob",
    description:
      "Restore Bob's personal data from a previous backup. This will overwrite current memory, profiles, and notes with the backup version. Optionally restores .env config too. Use this to rebuild Bob on a new machine or recover from data loss.",
    input_schema: {
      type: "object" as const,
      properties: {
        backup_path: {
          type: "string",
          description: "Path to the backup folder to restore from (the timestamped folder inside the backup directory)",
        },
        restore_env: {
          type: "boolean",
          description: "Whether to restore .env file (default: false — to avoid overwriting existing credentials)",
        },
      },
      required: ["backup_path"],
    },
  },
  {
    name: "list_backups",
    description:
      "List all available Bob backups at the configured backup location. Shows timestamps, sizes, and labels.",
    input_schema: {
      type: "object" as const,
      properties: {
        backup_path: {
          type: "string",
          description: "Directory to search for backups. Falls back to BACKUP_PATH env var if not specified.",
        },
      },
      required: [],
    },
  },
];

// --- Helpers ---

function getBackupRoot(overridePath?: string): string {
  const backupPath = overridePath ?? process.env.BACKUP_PATH;
  if (!backupPath) {
    throw new Error(
      "No backup path specified. Either pass backup_path or set BACKUP_PATH in .env"
    );
  }
  return resolve(backupPath);
}

function getProjectRoot(): string {
  // Walk up from this file to find the project root (where package.json lives)
  return resolve(process.cwd());
}

function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

interface BackupManifest {
  version: number;
  timestamp: string;
  label: string;
  platform: string;
  nodeVersion: string;
  contents: string[];
  includesEnv: boolean;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function getDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        const s = await stat(fullPath);
        totalSize += s.size;
      } else if (entry.isDirectory()) {
        totalSize += await getDirSize(fullPath);
      }
    }
  } catch {
    // skip inaccessible dirs
  }
  return totalSize;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Tool Handlers ---

export async function handleBackupBob(input: Record<string, unknown>): Promise<ToolResult> {
  const backupRoot = getBackupRoot(input.backup_path as string | undefined);
  const includeEnv = (input.include_env as boolean) ?? true;
  const label = (input.label as string) ?? "";
  const projectRoot = getProjectRoot();

  const timestamp = getTimestamp();
  const folderName = label ? `bob-backup-${timestamp}-${label}` : `bob-backup-${timestamp}`;
  const backupDir = join(backupRoot, folderName);

  await mkdir(backupDir, { recursive: true });

  const contents: string[] = [];

  // 1. Back up memory/ directory
  const memoryDir = join(projectRoot, "memory");
  if (await dirExists(memoryDir)) {
    const memoryBackup = join(backupDir, "memory");
    await cp(memoryDir, memoryBackup, { recursive: true });
    contents.push("memory/");
  }

  // 2. Back up local/ directory (personal skills and config)
  const localDir = join(projectRoot, "local");
  if (await dirExists(localDir)) {
    const localBackup = join(backupDir, "local");
    await cp(localDir, localBackup, { recursive: true });
    contents.push("local/");
  }

  // 3. Back up .env (credentials + owner config)
  if (includeEnv) {
    const envFile = join(projectRoot, ".env");
    if (await fileExists(envFile)) {
      const envContent = await readFile(envFile, "utf-8");
      await writeFile(join(backupDir, ".env"), envContent, "utf-8");
      contents.push(".env");
    }
  }

  // 3. Write manifest
  const manifest: BackupManifest = {
    version: 1,
    timestamp: new Date().toISOString(),
    label,
    platform: process.platform,
    nodeVersion: process.version,
    contents,
    includesEnv: includeEnv,
  };
  await writeFile(
    join(backupDir, "backup-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
  contents.push("backup-manifest.json");

  // Calculate total size
  const totalSize = await getDirSize(backupDir);

  return {
    success: true,
    output: `Backup complete!\nLocation: ${backupDir}\nSize: ${formatBytes(totalSize)}\nContents: ${contents.join(", ")}\n${includeEnv ? "Includes .env (API keys + owner config)" : ".env not included"}\n${label ? `Label: ${label}` : ""}`,
  };
}

export async function handleRestoreBob(input: Record<string, unknown>): Promise<ToolResult> {
  const backupDir = resolve(input.backup_path as string);
  const restoreEnv = (input.restore_env as boolean) ?? false;
  const projectRoot = getProjectRoot();

  // Verify backup exists
  if (!(await dirExists(backupDir))) {
    return { success: false, output: `Backup not found: ${backupDir}` };
  }

  // Read manifest
  const manifestPath = join(backupDir, "backup-manifest.json");
  if (!(await fileExists(manifestPath))) {
    return {
      success: false,
      output: `No backup-manifest.json found in ${backupDir}. Is this a valid Bob backup?`,
    };
  }

  const manifest: BackupManifest = JSON.parse(
    await readFile(manifestPath, "utf-8")
  );

  const restored: string[] = [];

  // 1. Restore memory/
  const memoryBackup = join(backupDir, "memory");
  if (await dirExists(memoryBackup)) {
    const memoryDest = join(projectRoot, "memory");
    await mkdir(memoryDest, { recursive: true });
    await cp(memoryBackup, memoryDest, { recursive: true });
    restored.push("memory/ (conversation history, profiles, notes)");
  }

  // 2. Restore local/ (personal skills and config)
  const localBackup = join(backupDir, "local");
  if (await dirExists(localBackup)) {
    const localDest = join(projectRoot, "local");
    await mkdir(localDest, { recursive: true });
    await cp(localBackup, localDest, { recursive: true });
    restored.push("local/ (personal skills and config)");
  }

  // 3. Restore .env
  if (restoreEnv) {
    const envBackup = join(backupDir, ".env");
    if (await fileExists(envBackup)) {
      const envContent = await readFile(envBackup, "utf-8");
      await writeFile(join(projectRoot, ".env"), envContent, "utf-8");
      restored.push(".env (API keys + owner config)");
    }
  }

  return {
    success: true,
    output: `Restore complete!\nBackup from: ${manifest.timestamp}${manifest.label ? ` (${manifest.label})` : ""}\nOriginal platform: ${manifest.platform}\nRestored: ${restored.join(", ") || "nothing to restore"}\n\nRestart Bob to pick up the restored data: pnpm dev`,
  };
}

export async function handleListBackups(input: Record<string, unknown>): Promise<ToolResult> {
  const backupRoot = getBackupRoot(input.backup_path as string | undefined);

  if (!(await dirExists(backupRoot))) {
    return { success: false, output: `Backup directory not found: ${backupRoot}` };
  }

  const entries = await readdir(backupRoot, { withFileTypes: true });
  const backupDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("bob-backup-"))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first

  if (backupDirs.length === 0) {
    return { success: true, output: `No backups found in ${backupRoot}` };
  }

  const results: string[] = [];

  for (const dir of backupDirs) {
    const fullPath = join(backupRoot, dir);
    const manifestPath = join(fullPath, "backup-manifest.json");

    let info = dir;
    try {
      if (await fileExists(manifestPath)) {
        const manifest: BackupManifest = JSON.parse(
          await readFile(manifestPath, "utf-8")
        );
        const size = await getDirSize(fullPath);
        const label = manifest.label ? ` [${manifest.label}]` : "";
        const env = manifest.includesEnv ? " +env" : "";
        info = `${dir}${label} — ${formatBytes(size)}${env} (${manifest.platform})`;
      }
    } catch {
      // show dir name even if manifest can't be read
    }

    results.push(info);
  }

  return {
    success: true,
    output: `Backups in ${backupRoot} (${backupDirs.length} found):\n\n${results.join("\n")}`,
  };
}
