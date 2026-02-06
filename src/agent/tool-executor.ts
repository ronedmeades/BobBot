import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exec } from "node:child_process";
import { memory } from "./memory.js";
import {
  handleBatchResize,
  handleConvertFormat,
  handleGenerateThumbnails,
  handleAddWatermark,
  handleAutoCrop,
} from "../skills/image-processing.js";
import {
  handleCreateEbayListing,
  handleUploadEbayImage,
  handleSearchEbayCategory,
  handleGenerateListingContent,
  handleGetEbayListingStatus,
} from "../skills/ebay-listing.js";
import {
  handleBatchListPosters,
  handleBatchListStatus,
} from "../skills/batch-lister.js";
import {
  handleBackupBob,
  handleRestoreBob,
  handleListBackups,
} from "../skills/backup.js";
import {
  handleAddScheduledTask,
  handleRemoveScheduledTask,
  handleListScheduledTasks,
  handleRunScheduledTask,
} from "../skills/scheduler.js";
import {
  handleCheckEmail,
  handleReadEmail,
  handleSendEmail,
  handleSearchEmail,
  handleGetEmailSummary,
} from "../skills/gmail.js";
import {
  handleWatchUrl,
  handleWatchKeywords,
  handleListWatches,
  handleRemoveWatch,
  handleCheckWatchesNow,
} from "../skills/web-monitor.js";
import {
  handleAnalyzeImage,
  handleAnalyzePosterForListing,
} from "../skills/vision.js";
import {
  handleSavePersonalData,
  handleLoadPersonalData,
  handleListPersonalData,
  handleDeletePersonalData,
  handleFillFormFields,
  handleSuggestFormMapping,
} from "../skills/form-filler.js";
import { executeLocalTool } from "../skills/local-loader.js";

interface ToolResult {
  success: boolean;
  output: string;
}

export interface ToolContext {
  userId: string;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context?: ToolContext
): Promise<ToolResult> {
  try {
    switch (name) {
      case "fetch_url":
        return await handleFetchUrl(input);
      case "read_file":
        return await handleReadFile(input);
      case "write_file":
        return await handleWriteFile(input);
      case "list_directory":
        return await handleListDirectory(input);
      case "run_command":
        return await handleRunCommand(input);
      case "save_note":
        return await handleSaveNote(input);
      case "load_note":
        return await handleLoadNote(input);
      case "list_notes":
        return await handleListNotes();
      case "update_user_profile":
        return await handleUpdateUserProfile(input, context);
      // Image processing skills
      case "batch_resize_images":
        return await handleBatchResize(input);
      case "convert_image_format":
        return await handleConvertFormat(input);
      case "generate_thumbnails":
        return await handleGenerateThumbnails(input);
      case "add_watermark":
        return await handleAddWatermark(input);
      case "auto_crop":
        return await handleAutoCrop(input);
      // eBay listing skills
      case "create_ebay_listing":
        return await handleCreateEbayListing(input);
      case "upload_ebay_image":
        return await handleUploadEbayImage(input);
      case "search_ebay_category":
        return await handleSearchEbayCategory(input);
      case "generate_listing_content":
        return await handleGenerateListingContent(input);
      case "get_ebay_listing_status":
        return await handleGetEbayListingStatus(input);
      // Batch workflow skills
      case "batch_list_posters":
        return await handleBatchListPosters(input);
      case "batch_list_status":
        return await handleBatchListStatus(input);
      // Backup & restore skills
      case "backup_bob":
        return await handleBackupBob(input);
      case "restore_bob":
        return await handleRestoreBob(input);
      case "list_backups":
        return await handleListBackups(input);
      // Scheduled tasks skills
      case "add_scheduled_task":
        return await handleAddScheduledTask(input);
      case "remove_scheduled_task":
        return await handleRemoveScheduledTask(input);
      case "list_scheduled_tasks":
        return await handleListScheduledTasks();
      case "run_scheduled_task":
        return await handleRunScheduledTask(input);
      // Gmail skills
      case "check_email":
        return await handleCheckEmail(input);
      case "read_email":
        return await handleReadEmail(input);
      case "send_email":
        return await handleSendEmail(input);
      case "search_email":
        return await handleSearchEmail(input);
      case "get_email_summary":
        return await handleGetEmailSummary(input);
      // Web monitoring skills
      case "watch_url":
        return await handleWatchUrl(input);
      case "watch_keywords":
        return await handleWatchKeywords(input);
      case "list_watches":
        return await handleListWatches();
      case "remove_watch":
        return await handleRemoveWatch(input);
      case "check_watches_now":
        return await handleCheckWatchesNow();
      // Vision/image analysis skills
      case "analyze_image":
        return await handleAnalyzeImage(input);
      case "analyze_poster_for_listing":
        return await handleAnalyzePosterForListing(input);
      // Form filling & personal data vault
      case "save_personal_data":
        return await handleSavePersonalData(input);
      case "load_personal_data":
        return await handleLoadPersonalData(input);
      case "list_personal_data":
        return await handleListPersonalData();
      case "delete_personal_data":
        return await handleDeletePersonalData(input);
      case "fill_form_fields":
        return await handleFillFormFields(input);
      case "suggest_form_mapping":
        return await handleSuggestFormMapping(input);
      default: {
        // Try local skills before giving up
        const localResult = await executeLocalTool(name, input, context);
        if (localResult) return localResult;
        return { success: false, output: `Unknown tool: ${name}` };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Error: ${message}` };
  }
}

async function handleFetchUrl(input: Record<string, unknown>): Promise<ToolResult> {
  const url = input.url as string;
  const method = (input.method as string) ?? "GET";
  const headers = (input.headers as Record<string, string>) ?? {};
  const body = input.body as string | undefined;

  const response = await fetch(url, {
    method,
    headers,
    body: body ?? undefined,
  });

  const text = await response.text();
  const truncated = text.length > 50000 ? text.slice(0, 50000) + "\n...[truncated]" : text;

  return {
    success: response.ok,
    output: `HTTP ${response.status} ${response.statusText}\n\n${truncated}`,
  };
}

async function handleReadFile(input: Record<string, unknown>): Promise<ToolResult> {
  const path = resolve(input.path as string);
  const content = await readFile(path, "utf-8");
  return { success: true, output: content };
}

async function handleWriteFile(input: Record<string, unknown>): Promise<ToolResult> {
  const path = resolve(input.path as string);
  const content = input.content as string;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");

  return { success: true, output: `Written to ${path}` };
}

async function handleListDirectory(input: Record<string, unknown>): Promise<ToolResult> {
  const path = resolve((input.path as string) ?? ".");
  const entries = await readdir(path);

  const details = await Promise.all(
    entries.map(async (entry) => {
      try {
        const s = await stat(resolve(path, entry));
        return `${s.isDirectory() ? "[dir] " : "      "}${entry}`;
      } catch {
        return `  [?]  ${entry}`;
      }
    })
  );

  return { success: true, output: details.join("\n") };
}

async function handleRunCommand(input: Record<string, unknown>): Promise<ToolResult> {
  const command = input.command as string;
  const timeoutMs = (input.timeout_ms as number) ?? 30000;

  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          success: false,
          output: `Exit code: ${err.code}\nstdout: ${stdout}\nstderr: ${stderr}`,
        });
      } else {
        resolve({
          success: true,
          output: stdout + (stderr ? `\nstderr: ${stderr}` : ""),
        });
      }
    });
  });
}

async function handleSaveNote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = input.name as string;
  const content = input.content as string;
  const path = await memory.saveNote(name, content);
  return { success: true, output: `Note saved: ${path}` };
}

async function handleLoadNote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = input.name as string;
  const content = await memory.loadNote(name);
  if (content === null) {
    return { success: false, output: `Note "${name}" not found` };
  }
  return { success: true, output: content };
}

async function handleListNotes(): Promise<ToolResult> {
  const notes = await memory.listNotes();
  if (notes.length === 0) {
    return { success: true, output: "No notes saved yet." };
  }
  return { success: true, output: notes.join("\n") };
}

async function handleUpdateUserProfile(
  input: Record<string, unknown>,
  context?: ToolContext
): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, output: "No user context available" };
  }

  const profile = await memory.loadProfile(context.userId);
  if (!profile) {
    return { success: false, output: "User profile not found" };
  }

  if (input.name !== undefined) {
    profile.name = input.name as string;
  }
  if (input.preferences !== undefined) {
    const prefs = input.preferences as Record<string, string>;
    Object.assign(profile.preferences, prefs);
  }
  if (input.notes !== undefined) {
    profile.notes = input.notes as string;
  }

  profile.lastSeen = new Date().toISOString();
  await memory.saveProfile(profile);

  return { success: true, output: `Profile updated for ${profile.name}` };
}
