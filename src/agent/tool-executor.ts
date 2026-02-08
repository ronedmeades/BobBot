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
  handleGetSellerListings,
  handleUpdateEbayListing,
  handleBulkUpdatePrices,
} from "../skills/ebay-listing.js";
import {
  handleBatchListPosters,
  handleBatchListStatus,
  handleReviewBatchSamples,
  handleApproveBatch,
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
  handleImportGoogleContacts,
  handleListGoogleContacts,
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
import {
  handleCreateBackgroundTask,
  handleListBackgroundTasks,
  handleGetTaskDetails,
  handleCancelBackgroundTask,
  handleUpdateTaskPriority,
  handlePauseResumeTask,
} from "../skills/task-manager.js";
import {
  handleShowImage,
  handleReadCsv,
  handleReadSpreadsheet,
  handleIndexInventory,
  handleSearchInventory,
  handleGetInventoryStats,
} from "../skills/inventory.js";
import {
  handleParsePdfForm,
  handleFillPdfForm,
} from "../skills/pdf-forms.js";
import {
  handleAddEvent,
  handleListEvents,
  handleUpdateEvent,
  handleRemoveEvent,
  handleCompleteEvent,
} from "../skills/calendar.js";
import {
  handleGenerateSocialPost,
  handleSuggestSocialHashtags,
} from "../skills/social-media.js";
import {
  handleTranslateText,
  handleDetectLanguage,
} from "../skills/translation.js";
import {
  handleGetWeather,
  handleGetForecast,
} from "../skills/weather.js";
import {
  handleAddContact,
  handleSearchContacts,
  handleGetContact,
  handleUpdateContact,
  handleDeleteContact,
  handleListContacts,
} from "../skills/contacts.js";
import {
  handleSetReminder,
  handleListReminders,
  handleSnoozeReminder,
  handleDismissReminder,
} from "../skills/reminders.js";
import {
  handleAddExpense,
  handleListExpenses,
  handleGetExpenseSummary,
  handleDeleteExpense,
  handleExportExpenses,
} from "../skills/expenses.js";
import {
  handleCreateInvoice,
  handleListInvoices,
  handleGetInvoice,
} from "../skills/invoices.js";
import {
  handleSummarizeDocument,
  handleSummarizeUrl,
} from "../skills/summarizer.js";
import {
  handleScanFolder,
  handleOrganizeFiles,
  handleFindDuplicates,
} from "../skills/file-organizer.js";
import {
  handleCapture,
  handleListCaptures,
  handleSearchCaptures,
  handleDeleteCapture,
} from "../skills/quick-capture.js";
import {
  handleBrowseUrl,
  handleClickElement,
  handleTypeInto,
  handleExtractContent,
  handleTakeScreenshot,
  handleCloseBrowser,
} from "../skills/browser.js";
import {
  handleCallOwner,
  handleSendSms,
  handleGetCallStatus,
} from "../skills/phone.js";
import {
  handleMarketplaceListPlatforms,
  handleMarketplaceTestConnection,
  handleMarketplaceGetOrders,
  handleMarketplaceGetOrder,
  handleMarketplaceShipOrder,
  handleMarketplaceGetMessages,
  handleMarketplaceSendMessage,
  handleMarketplaceOrderSummary,
  handleMarketplaceGetUnshipped,
  handleMarketplaceBulkShip,
} from "../skills/marketplace.js";
import {
  handleListGoogleCalendars,
  handleListGoogleEvents,
  handleGetGoogleEvent,
  handleCreateGoogleEvent,
  handleUpdateGoogleEvent,
  handleDeleteGoogleEvent,
} from "../skills/google-calendar.js";
import {
  handleSetEnvVar,
  handleListEnvKeys,
} from "../skills/env-manager.js";
import {
  handleCreateStandingRule,
  handleListStandingRules,
  handleUpdateStandingRule,
  handleRemoveStandingRule,
} from "../skills/standing-rules.js";
import {
  handleDiscoverAgent,
  handleSendToAgent,
  handleListPeers,
  handleGetPeerDetails,
  handleSetPeerTrust,
  handleRemovePeer,
  handleA2AAuditLog,
  handleApproveA2ARequest,
} from "../skills/a2a-client.js";
import { executeLocalTool, installLocalSkill } from "../skills/local-loader.js";
import { refreshTools } from "./tools.js";

interface ToolResult {
  success: boolean;
  output: string;
}

export interface ToolContext {
  userId: string;
}

/**
 * Sandboxed tool executor for A2A external requests.
 * Checks if the tool is allowed for the given trust tier before executing.
 */
export async function executeToolSandboxed(
  name: string,
  input: Record<string, unknown>,
  context?: ToolContext,
  trustTier: import("../a2a/types.js").TrustTier = "manual"
): Promise<ToolResult> {
  // Lazy import to avoid circular dependency at module load
  const { isPublicTool } = await import("../a2a/public-skills.js");
  if (!isPublicTool(name, trustTier)) {
    return {
      success: false,
      output: `Tool "${name}" is not available for external requests.`,
    };
  }
  return executeTool(name, input, context);
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
      case "install_skill":
        return await handleInstallSkill(input);
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
      case "get_seller_listings":
        return await handleGetSellerListings(input);
      case "update_ebay_listing":
        return await handleUpdateEbayListing(input);
      case "bulk_update_prices":
        return await handleBulkUpdatePrices(input);
      // Batch workflow skills
      case "batch_list_posters":
        return await handleBatchListPosters(input);
      case "batch_list_status":
        return await handleBatchListStatus(input);
      case "review_batch_samples":
        return await handleReviewBatchSamples(input);
      case "approve_batch":
        return await handleApproveBatch(input);
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
      // Google Contacts (via People API, same OAuth)
      case "import_google_contacts":
        return await handleImportGoogleContacts(input);
      case "list_google_contacts":
        return await handleListGoogleContacts(input);
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
      // Background task management
      case "create_background_task":
        return await handleCreateBackgroundTask(input, context);
      case "list_background_tasks":
        return await handleListBackgroundTasks();
      case "get_task_details":
        return await handleGetTaskDetails(input);
      case "cancel_background_task":
        return await handleCancelBackgroundTask(input);
      case "update_task_priority":
        return await handleUpdateTaskPriority(input);
      case "pause_resume_task":
        return await handlePauseResumeTask(input);
      // Inventory, image display & data reading
      case "show_image":
        return await handleShowImage(input);
      case "read_csv":
        return await handleReadCsv(input);
      case "read_spreadsheet":
        return await handleReadSpreadsheet(input);
      case "index_inventory":
        return await handleIndexInventory(input);
      case "search_inventory":
        return await handleSearchInventory(input);
      case "get_inventory_stats":
        return await handleGetInventoryStats();
      // PDF form skills
      case "parse_pdf_form":
        return await handleParsePdfForm(input);
      case "fill_pdf_form":
        return await handleFillPdfForm(input);
      // Calendar & events
      case "add_event":
        return await handleAddEvent(input);
      case "list_events":
        return await handleListEvents(input);
      case "update_event":
        return await handleUpdateEvent(input);
      case "remove_event":
        return await handleRemoveEvent(input);
      case "complete_event":
        return await handleCompleteEvent(input);
      // Social media post generation
      case "generate_social_post":
        return await handleGenerateSocialPost(input);
      case "suggest_social_hashtags":
        return await handleSuggestSocialHashtags(input);
      // Translation & language detection
      case "translate_text":
        return await handleTranslateText(input);
      case "detect_language":
        return await handleDetectLanguage(input);
      // Weather skills
      case "get_weather":
        return await handleGetWeather(input);
      case "get_forecast":
        return await handleGetForecast(input);
      // Contacts / address book
      case "add_contact":
        return await handleAddContact(input);
      case "search_contacts":
        return await handleSearchContacts(input);
      case "get_contact":
        return await handleGetContact(input);
      case "update_contact":
        return await handleUpdateContact(input);
      case "delete_contact":
        return await handleDeleteContact(input);
      case "list_contacts":
        return await handleListContacts(input);
      // Reminders
      case "set_reminder":
        return await handleSetReminder(input);
      case "list_reminders":
        return await handleListReminders(input);
      case "snooze_reminder":
        return await handleSnoozeReminder(input);
      case "dismiss_reminder":
        return await handleDismissReminder(input);
      // Expense tracking
      case "add_expense":
        return await handleAddExpense(input);
      case "list_expenses":
        return await handleListExpenses(input);
      case "get_expense_summary":
        return await handleGetExpenseSummary(input);
      case "delete_expense":
        return await handleDeleteExpense(input);
      case "export_expenses":
        return await handleExportExpenses(input);
      // Invoice generation
      case "create_invoice":
        return await handleCreateInvoice(input);
      case "list_invoices":
        return await handleListInvoices(input);
      case "get_invoice":
        return await handleGetInvoice(input);
      // Document summarizer
      case "summarize_document":
        return await handleSummarizeDocument(input);
      case "summarize_url":
        return await handleSummarizeUrl(input);
      // File organizer
      case "scan_folder":
        return await handleScanFolder(input);
      case "organize_files":
        return await handleOrganizeFiles(input);
      case "find_duplicates":
        return await handleFindDuplicates(input);
      // Quick capture
      case "capture":
        return await handleCapture(input);
      case "list_captures":
        return await handleListCaptures(input);
      case "search_captures":
        return await handleSearchCaptures(input);
      case "delete_capture":
        return await handleDeleteCapture(input);
      // Browser automation
      case "browse_url":
        return await handleBrowseUrl(input);
      case "click_element":
        return await handleClickElement(input);
      case "type_into":
        return await handleTypeInto(input);
      case "extract_content":
        return await handleExtractContent(input);
      case "take_screenshot":
        return await handleTakeScreenshot(input);
      case "close_browser":
        return await handleCloseBrowser();
      // Phone calls & SMS (Twilio)
      case "call_owner":
        return await handleCallOwner(input);
      case "send_sms":
        return await handleSendSms(input);
      case "get_call_status":
        return await handleGetCallStatus(input);
      // Marketplace engine
      case "marketplace_list_platforms":
        return await handleMarketplaceListPlatforms();
      case "marketplace_test_connection":
        return await handleMarketplaceTestConnection(input);
      case "marketplace_get_orders":
        return await handleMarketplaceGetOrders(input);
      case "marketplace_get_order":
        return await handleMarketplaceGetOrder(input);
      case "marketplace_ship_order":
        return await handleMarketplaceShipOrder(input);
      case "marketplace_get_messages":
        return await handleMarketplaceGetMessages(input);
      case "marketplace_send_message":
        return await handleMarketplaceSendMessage(input);
      case "marketplace_order_summary":
        return await handleMarketplaceOrderSummary(input);
      case "marketplace_get_unshipped":
        return await handleMarketplaceGetUnshipped(input);
      case "marketplace_bulk_ship":
        return await handleMarketplaceBulkShip(input);
      // Environment variable management
      case "set_env_var":
        return await handleSetEnvVar(input);
      case "list_env_keys":
        return await handleListEnvKeys(input);
      // Standing rules (marketplace monitoring)
      case "create_standing_rule":
        return await handleCreateStandingRule(input);
      case "list_standing_rules":
        return await handleListStandingRules();
      case "update_standing_rule":
        return await handleUpdateStandingRule(input);
      case "remove_standing_rule":
        return await handleRemoveStandingRule(input);
      // Google Calendar
      case "list_google_calendars":
        return await handleListGoogleCalendars();
      case "list_google_events":
        return await handleListGoogleEvents(input);
      case "get_google_event":
        return await handleGetGoogleEvent(input);
      case "create_google_event":
        return await handleCreateGoogleEvent(input);
      case "update_google_event":
        return await handleUpdateGoogleEvent(input);
      case "delete_google_event":
        return await handleDeleteGoogleEvent(input);
      // A2A client tools
      case "discover_agent":
        return await handleDiscoverAgent(input);
      case "send_to_agent":
        return await handleSendToAgent(input);
      case "list_peers":
        return await handleListPeers();
      case "get_peer_details":
        return await handleGetPeerDetails(input);
      case "set_peer_trust":
        return await handleSetPeerTrust(input);
      case "remove_peer":
        return await handleRemovePeer(input);
      case "a2a_audit_log":
        return await handleA2AAuditLog(input);
      case "approve_a2a_request":
        return await handleApproveA2ARequest(input);
      // Tool loading (actual expansion happens in core.ts)
      case "load_tools": {
        const categories = (input.categories as string[]) ?? [];
        const { getToolsForCategories: getCats, isValidCategory } = await import("./tool-loader.js");
        const { toolDefinitions: allDefs } = await import("./tools.js");
        const loaded = getCats(categories, allDefs);
        const unknowns = categories.filter((c) => !isValidCategory(c));
        let msg = `Loaded ${categories.length} category(s): ${categories.join(", ")}. ${loaded.length} tools now available.`;
        if (unknowns.length > 0) msg += ` Unknown categories (ignored): ${unknowns.join(", ")}`;
        return { success: true, output: msg };
      }
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

// Credential files that should never be read (defense against prompt injection exfiltration)
const BLOCKED_PATHS = [
  /[/\\]\.env$/i,
  /[/\\]\.env\..+$/i,
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.gnupg[/\\]/i,
  /[/\\]credentials\.json$/i,
  /[/\\]\.netrc$/i,
  /[/\\]\.npmrc$/i,
  /[/\\]\.pypirc$/i,
];

function isBlockedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return BLOCKED_PATHS.some((pattern) => pattern.test(normalized));
}

async function handleReadFile(input: Record<string, unknown>): Promise<ToolResult> {
  const path = resolve(input.path as string);
  if (isBlockedPath(path)) {
    return { success: false, output: "Access denied — this file contains credentials and cannot be read." };
  }
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

async function handleInstallSkill(input: Record<string, unknown>): Promise<ToolResult> {
  const skillName = input.skill_name as string;
  if (!skillName) {
    return { success: false, output: "skill_name is required" };
  }

  const result = await installLocalSkill(skillName);

  if (!result.success) {
    return { success: false, output: `Failed to install skill "${skillName}": ${result.error}` };
  }

  // Rebuild the global tool definitions so the next API call sees the new tools
  refreshTools();

  return {
    success: true,
    output: `Skill "${skillName}" installed successfully. New tools available: ${result.toolNames.join(", ")}`,
  };
}
