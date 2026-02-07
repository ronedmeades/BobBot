import { readdir, stat, rename, mkdir } from "node:fs/promises";
import { resolve, extname, basename, join } from "node:path";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// File type categories
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  // Images
  ".jpg": "Images", ".jpeg": "Images", ".png": "Images", ".gif": "Images",
  ".webp": "Images", ".bmp": "Images", ".svg": "Images", ".ico": "Images",
  ".tiff": "Images", ".tif": "Images",
  // Documents
  ".doc": "Documents", ".docx": "Documents", ".txt": "Documents",
  ".md": "Documents", ".rtf": "Documents", ".odt": "Documents",
  // Spreadsheets
  ".xls": "Spreadsheets", ".xlsx": "Spreadsheets", ".csv": "Spreadsheets",
  ".numbers": "Spreadsheets", ".ods": "Spreadsheets",
  // PDFs
  ".pdf": "PDFs",
  // Presentations
  ".ppt": "Presentations", ".pptx": "Presentations", ".key": "Presentations",
  // Archives
  ".zip": "Archives", ".tar": "Archives", ".gz": "Archives",
  ".rar": "Archives", ".7z": "Archives", ".bz2": "Archives",
  // Audio
  ".mp3": "Audio", ".wav": "Audio", ".flac": "Audio",
  ".aac": "Audio", ".ogg": "Audio", ".m4a": "Audio",
  // Video
  ".mp4": "Video", ".mkv": "Video", ".avi": "Video",
  ".mov": "Video", ".wmv": "Video", ".webm": "Video",
  // Code
  ".ts": "Code", ".js": "Code", ".py": "Code", ".java": "Code",
  ".c": "Code", ".cpp": "Code", ".h": "Code", ".go": "Code",
  ".rs": "Code", ".rb": "Code", ".php": "Code", ".sql": "Code",
  ".html": "Code", ".css": "Code", ".json": "Code", ".xml": "Code",
  ".yaml": "Code", ".yml": "Code",
};

function getFileCategory(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return TYPE_MAP[ext] ?? "Other";
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const fileOrganizerToolDefinitions: ToolDefinition[] = [
  {
    name: "scan_folder",
    description:
      "Scan a folder and report its contents organized by file type, with counts and sizes. " +
      "Useful for understanding what's in a messy directory before organizing.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the folder to scan" },
        recursive: {
          type: "boolean",
          description: "Scan subdirectories too (default: false)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "organize_files",
    description:
      "Organize files in a folder into subfolders by type (Images/, Documents/, PDFs/, etc.) " +
      "or by date (2026-01/, 2026-02/, etc.). Defaults to dry run — shows what would happen " +
      "without moving anything. Set dry_run=false to actually move files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the folder to organize" },
        strategy: {
          type: "string",
          enum: ["by_type", "by_date"],
          description: "Organization strategy: 'by_type' (Images/, Documents/, etc.) or 'by_date' (YYYY-MM/). Default: by_type.",
        },
        dry_run: {
          type: "boolean",
          description: "Preview only — don't actually move files (default: true)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "find_duplicates",
    description:
      "Find duplicate files in a folder by comparing filenames and sizes. " +
      "Reports groups of potential duplicates.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the folder to check" },
        recursive: {
          type: "boolean",
          description: "Check subdirectories too (default: false)",
        },
      },
      required: ["path"],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileInfo {
  name: string;
  path: string;
  size: number;
  modified: Date;
  category: string;
}

async function scanDir(dirPath: string, recursive: boolean): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  const entries = await readdir(dirPath);

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        if (recursive) {
          const subFiles = await scanDir(fullPath, true);
          files.push(...subFiles);
        }
      } else {
        files.push({
          name: entry,
          path: fullPath,
          size: s.size,
          modified: s.mtime,
          category: getFileCategory(entry),
        });
      }
    } catch {
      // Skip inaccessible files
    }
  }

  return files;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleScanFolder(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const dirPath = resolve(input.path as string);
  const recursive = (input.recursive as boolean) ?? false;

  let files: FileInfo[];
  try {
    files = await scanDir(dirPath, recursive);
  } catch {
    return { success: false, output: `Cannot read directory: ${dirPath}` };
  }

  if (files.length === 0) {
    return { success: true, output: `Folder is empty: ${dirPath}` };
  }

  // Group by category
  const byCategory: Record<string, { count: number; totalSize: number }> = {};
  let totalSize = 0;

  for (const f of files) {
    if (!byCategory[f.category]) {
      byCategory[f.category] = { count: 0, totalSize: 0 };
    }
    byCategory[f.category]!.count++;
    byCategory[f.category]!.totalSize += f.size;
    totalSize += f.size;
  }

  const lines = Object.entries(byCategory)
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([cat, info]) => `  ${cat.padEnd(16)} ${String(info.count).padStart(5)} files   ${formatSize(info.totalSize).padStart(10)}`);

  return {
    success: true,
    output:
      `Scan of ${dirPath}${recursive ? " (recursive)" : ""}:\n` +
      `${"─".repeat(50)}\n` +
      `${files.length} files, ${formatSize(totalSize)} total\n\n` +
      `By type:\n${lines.join("\n")}`,
  };
}

export async function handleOrganizeFiles(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const dirPath = resolve(input.path as string);
  const strategy = (input.strategy as string) ?? "by_type";
  const dryRun = (input.dry_run as boolean) ?? true;

  let files: FileInfo[];
  try {
    files = await scanDir(dirPath, false);
  } catch {
    return { success: false, output: `Cannot read directory: ${dirPath}` };
  }

  if (files.length === 0) {
    return { success: true, output: "No files to organize." };
  }

  const moves: { from: string; to: string; name: string }[] = [];

  for (const f of files) {
    let targetDir: string;

    if (strategy === "by_date") {
      const dateStr = f.modified.toISOString().slice(0, 7); // YYYY-MM
      targetDir = join(dirPath, dateStr);
    } else {
      targetDir = join(dirPath, f.category);
    }

    const targetPath = join(targetDir, f.name);
    if (targetPath !== f.path) {
      moves.push({ from: f.path, to: targetPath, name: f.name });
    }
  }

  if (moves.length === 0) {
    return { success: true, output: "All files are already organized." };
  }

  // Group moves for display
  const byDest: Record<string, string[]> = {};
  for (const m of moves) {
    const dest = basename(resolve(m.to, ".."));
    if (!byDest[dest]) byDest[dest] = [];
    byDest[dest]!.push(m.name);
  }

  const preview = Object.entries(byDest)
    .map(([dest, names]) => `  ${dest}/\n${names.map((n) => `    ${n}`).join("\n")}`)
    .join("\n\n");

  if (dryRun) {
    return {
      success: true,
      output:
        `DRY RUN — would move ${moves.length} files:\n\n${preview}\n\n` +
        `To actually move files, run again with dry_run: false.`,
    };
  }

  // Actually move files
  let moved = 0;
  let errors = 0;
  for (const m of moves) {
    try {
      await mkdir(resolve(m.to, ".."), { recursive: true });
      await rename(m.from, m.to);
      moved++;
    } catch {
      errors++;
    }
  }

  return {
    success: true,
    output:
      `Organized ${moved} files (${errors} errors):\n\n${preview}`,
  };
}

export async function handleFindDuplicates(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const dirPath = resolve(input.path as string);
  const recursive = (input.recursive as boolean) ?? false;

  let files: FileInfo[];
  try {
    files = await scanDir(dirPath, recursive);
  } catch {
    return { success: false, output: `Cannot read directory: ${dirPath}` };
  }

  // Group by name+size (simple duplicate detection)
  const groups: Record<string, FileInfo[]> = {};
  for (const f of files) {
    // Use lowercase name + size as key
    const key = `${f.name.toLowerCase()}:${f.size}`;
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(f);
  }

  const duplicates = Object.values(groups).filter((g) => g.length > 1);

  if (duplicates.length === 0) {
    return { success: true, output: `No duplicates found in ${dirPath}.` };
  }

  const lines = duplicates.map((group) => {
    const f = group[0]!;
    const paths = group.map((g) => `    ${g.path}`).join("\n");
    return `  "${f.name}" (${formatSize(f.size)}) — ${group.length} copies:\n${paths}`;
  });

  const totalWasted = duplicates.reduce(
    (sum, group) => sum + group[0]!.size * (group.length - 1),
    0
  );

  return {
    success: true,
    output:
      `Found ${duplicates.length} group(s) of duplicates (${formatSize(totalWasted)} could be freed):\n\n${lines.join("\n\n")}`,
  };
}
