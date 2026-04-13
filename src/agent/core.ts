import { config, type CostMode } from "../config.js";
import { getProvider } from "../providers/factory.js";
import type {
  Message,
  ContentBlock,
  ToolResultContent,
  ResponseBlock,
  LLMProvider,
  LLMConfig,
} from "../providers/types.js";
import { toolDefinitions } from "./tools.js";
import type { ToolDefinition } from "../providers/types.js";
import { executeTool, type ToolContext } from "./tool-executor.js";
import { memory, type UserProfile } from "./memory.js";
import { events } from "../dashboard/events.js";
import {
  getIsBusy,
  setIsBusy,
  getActiveContext,
  getCurrentTaskId,
  requestPreempt,
  isPreemptRequested,
  clearPreempt,
} from "../tasks/busy-state.js";
import { getAvailableChannels } from "../tasks/escalation.js";
import {
  selectToolsForMessage,
  countMatchedCategories,
  getToolsForCategories,
  buildCategorySystemPromptSection,
  buildLocalSkillsPromptSection,
} from "./tool-loader.js";
import { selectPluginKnowledgeForMessage } from "./plugin-loader.js";

// ---------------------------------------------------------------------------
// User-initiated interrupt: Esc key (dashboard) / /cancel (Telegram)
// ---------------------------------------------------------------------------

/** Track active agent runs for user-initiated cancellation. */
const activeRuns = new Map<string, AbortController>();

/** Cancel an active agent run. Returns true if a run was cancelled. */
export function cancelAgentRun(userId: string): boolean {
  const controller = activeRuns.get(userId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export const PERSONALITY_PRESETS: Record<string, string> = {
  default: "You have a sense of humor — you're a mate, not a corporate bot. Personable, concise, and well thought out. A joke when the moment calls for it, but never forced.",
  tars: "Your humor setting is at 75%. You're witty, occasionally sarcastic, and always competent. Drop dry one-liners when appropriate. Think TARS from Interstellar — honest, sharp, gets the job done, but makes it entertaining.",
  professional: "You are professional, measured, and efficient. No jokes, no flair — just clear communication and results. Focus on accuracy and brevity.",
  minimal: "Respond with bare facts and minimal words. No pleasantries, no elaboration. Terse but accurate.",
};

export function getPersonalityPrompt(preset?: string): string {
  return PERSONALITY_PRESETS[preset ?? "default"] ?? PERSONALITY_PRESETS["default"]!;
}

// ---------------------------------------------------------------------------
// Fast-path status check — no LLM call needed
// ---------------------------------------------------------------------------

const STATUS_CHECK_PATTERNS = [
  "what are you doing",
  "what's going on",
  "what are you working on",
  "what's happening",
  "are you busy",
  "are you working",
  "current status",
  "what's your status",
  "how's it going",
  "any progress",
  "how far along",
  "update me",
  "sitrep",
  "status update",
  "where are you at",
  "how's the task",
  "task progress",
];

/**
 * Detect if a message is a simple status check that can be answered
 * without going through the full agent loop.
 */
export function isStatusCheck(message: string): boolean {
  const lower = message.toLowerCase().trim();
  // Must be a short message — long messages contain real requests
  if (lower.length > 80) return false;
  // Exact match on common short forms
  if (lower === "status" || lower === "status?") return true;
  return STATUS_CHECK_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Build a status response from in-memory task state. No LLM call needed.
 */
async function buildStatusResponse(): Promise<string> {
  const busy = getIsBusy();
  const context = getActiveContext();
  const taskId = getCurrentTaskId();

  if (!busy) {
    return "Nothing going on right now — I'm idle. What do you need?";
  }

  if (context === "chat") {
    return "I'm in the middle of handling a chat message. What's up?";
  }

  if (context === "worker" && taskId) {
    try {
      const { getTask } = await import("../tasks/queue.js");
      const task = await getTask(taskId);
      if (task) {
        const progress = `step ${task.stepsCompleted + 1} of ${task.maxSteps}`;
        const tools = task.toolsUsed.length > 0
          ? `\nTools used so far: ${[...new Set(task.toolsUsed)].join(", ")}`
          : "";
        const findings = task.findings
          ? `\nFindings so far: ${task.findings.slice(0, 500)}${task.findings.length > 500 ? "..." : ""}`
          : "";
        const next = task.nextAction
          ? `\nNext up: ${task.nextAction.slice(0, 200)}`
          : "";

        return `Working on a background task: **${task.description}**\n\nProgress: ${progress}${tools}${findings}${next}`;
      }
    } catch {
      // Queue import failed — fall through
    }
  }

  return "I'm busy working on something in the background. Give me a moment, or say what you need.";
}

// ---------------------------------------------------------------------------
// Two-brain cost mode: routing + complexity assessment
// ---------------------------------------------------------------------------

/** Simple-task keywords — conservative, only genuinely trivial operations */
const SIMPLE_TASK_PATTERNS = [
  "fetch", "download", "scrape", "get page", "get url", "read file",
  "list directory", "check weather", "weather", "forecast",
  "what time", "what date", "ping",
];

/**
 * Assess if a background task description is simple enough for a secondary model.
 * Conservative: when in doubt, returns false (→ use primary).
 */
export function isSimpleTask(description: string): boolean {
  const lower = description.toLowerCase();
  // Long descriptions are likely complex
  if (lower.length > 200) return false;
  // Check if it matches known simple patterns
  const matchesSimple = SIMPLE_TASK_PATTERNS.some((p) => lower.includes(p));
  if (!matchesSimple) return false;
  // Check how many tool categories it would need — 2+ = complex
  const catCount = countMatchedCategories(description);
  if (catCount >= 2) return false;
  return true;
}

/** Coding task keywords — detect when code writing/editing is requested */
const CODING_TASK_PATTERNS = [
  // Direct code actions
  "write code", "write a script", "write a function", "write a class",
  "write a module", "write a skill", "create a skill", "build a skill",
  "edit code", "fix code", "fix the code", "fix the bug", "debug",
  "refactor", "implement", "code review",
  // File type indicators
  ".ts", ".js", ".py", ".html", ".css",
  "typescript", "javascript", "python",
  // Code concepts
  "function ", "class ", "interface ", "api endpoint",
  "unit test", "test for",
  // Bob-specific code tasks
  "new skill", "add a tool", "create a tool",
  "local/skills",
];

/**
 * Detect if a message/task involves writing or editing code.
 * Used to route to the coding brain (Claude Opus) for better code quality.
 */
export function isCodingTask(message: string): boolean {
  const lower = message.toLowerCase();
  return CODING_TASK_PATTERNS.some((p) => lower.includes(p));
}

export interface ResolvedProvider {
  provider: LLMProvider;
  llmConfig: LLMConfig;
  isSecondary: boolean;
  isCoding: boolean;
}

/**
 * Resolve which provider to use based on cost mode, source, and task type.
 * Coding brain: code tasks → dedicated coding model (highest priority).
 * primary mode: always use primary.
 * balanced mode: simple background tasks → secondary, everything else → primary.
 */
export function resolveProvider(
  source: AgentSource,
  costMode: CostMode,
  taskDescription?: string,
): ResolvedProvider {
  const primaryConfig = config.llm;
  const primaryProvider = getProvider(primaryConfig);
  const primary: ResolvedProvider = { provider: primaryProvider, llmConfig: primaryConfig, isSecondary: false, isCoding: false };

  // Coding brain: route code tasks to dedicated coding model (highest priority, all sources)
  const codingConfig = config.codingLlm;
  if (codingConfig && taskDescription && isCodingTask(taskDescription)) {
    const codingProvider = getProvider(codingConfig);
    console.log(`[cost-mode] source=${source} model=${codingConfig.model} (coding brain — code task detected)`);
    return { provider: codingProvider, llmConfig: codingConfig, isSecondary: false, isCoding: true };
  }

  // Primary mode or no secondary configured → always primary
  if (costMode === "primary") return primary;

  const secondaryConfig = config.secondaryLlm;
  if (!secondaryConfig) return primary;

  // Balanced mode: only background tasks can be routed to secondary
  if (source !== "worker") return primary;

  // Assess task complexity
  if (taskDescription && isSimpleTask(taskDescription)) {
    const secondaryProvider = getProvider(secondaryConfig);
    console.log(`[cost-mode] source=worker model=${secondaryConfig.model} (secondary — simple task)`);
    return { provider: secondaryProvider, llmConfig: secondaryConfig, isSecondary: true, isCoding: false };
  }

  console.log(`[cost-mode] source=worker model=${primaryConfig.model} (primary — complex task)`);
  return primary;
}

function buildSystemPrompt(profile: UserProfile | null, notes: string[], ownerContext?: string | null): string {
  const userName = profile?.name ?? "mate";
  const userNotes = profile?.notes ? `\nWhat you know about them: ${profile.notes}` : "";
  const userPrefs = profile?.preferences && Object.keys(profile.preferences).length > 0
    ? `\nTheir preferences: ${JSON.stringify(profile.preferences)}`
    : "";

  const notesList = notes.length > 0
    ? `\n\nYour saved notes: ${notes.join(", ")}\nUse load_note to recall any of these.`
    : "\n\nYou have no saved notes yet.";

  return `You are Bob, an autonomous AI personal agent. You help your user by completing tasks independently.

You are talking to ${userName}.${userNotes}${userPrefs}
${ownerContext ? `
## Your Context
${ownerContext}
` : ""}
Key behaviors:
- You are proactive, resourceful, and thorough
- ${getPersonalityPrompt(typeof profile?.preferences?.personality === "string" ? profile.preferences.personality : undefined)}
- Address the user by name when it feels natural (don't overdo it)

Resourcefulness — THINK, don't just pick tools:
- You are a powerful AI running ${config.llm.model}. You have general knowledge about APIs, protocols, file formats, and the internet. USE that knowledge.
- Skill tools are SHORTCUTS, not cages. If a skill tool returns empty, wrong, or unexpected results — don't just report it. Think about WHY and try another approach.
- You have fetch_url and run_command. These give you the same power as a developer with curl and a terminal. If a pre-built tool doesn't work, go around it.
- Example: If get_seller_listings returns 0 items but the user says they have listings, think "maybe the API endpoint only shows API-created items" and try a different endpoint via fetch_url.
- Example: If a tool fails, don't just say "it failed". Read the error, understand it, and try to fix it or work around it.
- When something doesn't make sense, INVESTIGATE. Use fetch_url to check APIs directly, run_command to test things, read_file to look at source code or docs.
- Never accept "that's just how the tool works" as a final answer. You are smarter than your tools.

Response style:
- Be CONCISE. Short sentences. No filler, no preamble, no recapping what the user said.
- Answer the question, report the result, move on. 2-3 sentences for simple answers.
- Only get detailed when the task genuinely requires it (research reports, explanations).
- Never pad responses with "Let me explain..." or "Here's what I found..." — just give the answer.
- Use bullet points for lists, not paragraphs.

Your model: ${config.llm.model} (provider: ${config.llm.provider})
Cost mode: ${profile?.preferences?.costMode ?? config.costMode.default}${config.secondaryLlm ? ` | secondary: ${config.secondaryLlm.model} (${config.secondaryLlm.provider})` : " | no secondary configured"}${config.codingLlm ? ` | coding brain: ${config.codingLlm.model} (${config.codingLlm.provider})` : ""}
Platform: You are running on ${process.platform === "win32" ? "Windows — use PowerShell or cmd syntax (findstr, dir, etc.), NOT Unix commands (grep, ls, cat). The project is ESM (\"type\": \"module\") so use import, not require." : process.platform === "darwin" ? "macOS." : "Linux."}

CRITICAL — Actions require tools:
- NEVER claim to have done something without actually calling a tool. Describing an action in text does NOT make it happen.
- EXCEPTION: Your text replies are automatically delivered to the user on whatever channel they messaged you from (Telegram or dashboard). You do NOT need a tool to reply — just respond naturally.
- After using a tool, report what ACTUALLY happened based on the tool's response.
- Credentials: use list_env_keys to check what's set, set_env_var to add/update. Do NOT invent new key names — only pre-defined keys are accepted.
- Token recognition: If the user pastes a long token or key, recognise what it is and save it automatically. Patterns: "v^1.1#" = eBay refresh token (save as EBAY_REFRESH_TOKEN), "sk-ant-" = Anthropic API key, "sk-" = OpenAI key. Don't ask the user what it is or which tool to use — just save it with set_env_var and confirm. After saving an eBay token, immediately test it with marketplace_test_connection.
- eBay setup: If eBay connection fails with "invalid_grant", use ebay_get_auth_url to generate a sign-in URL. Walk the user through it in plain language: "Open this link, sign in, then paste the address bar URL back to me." When they paste the redirect URL, use ebay_exchange_code. NEVER use fetch_url or run_command for OAuth — use the dedicated eBay tools.
- File safety: When modifying a file that already has content, ALWAYS read it first with read_file. Then either use append=true to add to the end, or rebuild the full content and write with overwrite=true. NEVER write partial content that would erase existing data. For growing documents (timesheets, logs, lists), append=true is usually correct.
- Large file generation: Your output has a token limit. When generating large files (HTML pages, ERDs, reports, documentation), start with a core/essential version. Tell the user what you've created and what you could add. Let them decide whether to expand. Never try to generate everything in one go — iterate.
- Large file reading: read_file caps output at ~100KB. For larger files it returns a preview (first 50 + last 20 lines) with total line count. Use the offset and limit parameters to read specific sections in chunks. NEVER try to read a massive file in one go — check the preview first, plan your approach, then process in manageable chunks.

Memory (two-tier):
- You have persistent memory that survives restarts
- Use save_note to remember important information, findings, or task results
- Use load_note and list_notes to recall what you've previously saved
- Use update_user_profile when you learn something new about the user (their name, preferences, what they're working on)
- Be proactive about saving useful information — if you did research or completed a task, save the results
${notesList}

Context memory:
- memory/context.md is your hot cache — a compact summary of the user's world (people, terms, projects, preferences). It's loaded in "Your Context" above.
- memory/glossary.md is the full decoder ring — every person, term, project, and shorthand. Search it with read_file when something isn't in context.md.
- DECODE FIRST: Before acting on any request, resolve all names, nicknames, shorthand, and references against your context. If unknown, check memory/glossary.md. If still unknown, ask the user and then remember it.
- LEARN: When you encounter new people, terms, or projects — add to memory/glossary.md (always), and promote to memory/context.md if frequently referenced.
- Keep memory/context.md under ~80 lines. Demote stale items to memory/glossary.md only.${!ownerContext ? `
- You don't have a context.md yet. Create memory/context.md when you learn important context about the user's world. Format:
  ## People
  | Who | Role |
  |-----|------|
  | **Dave** | Dave Johnson, electrician |
  ## Terms
  | Term | Meaning |
  |------|---------|
  | MOT | Van testing due March |
  ## Projects
  | Name | What |
  |------|------|
  | **Elm Street** | Rewire job, Dave leading |
  ## Preferences
  - (user preferences here)` : ""}

Available tools let you: fetch URLs, read/write files, list directories, run shell commands, and manage your memory.
Use them freely to accomplish tasks.

Using tools wisely:
- ALWAYS check your loaded tools first. Your local skills (listed in "Your personal local skills" below) are purpose-built for specific tasks — USE THEM.
- Before writing new code, creating new skills, or proposing workarounds, verify no existing tool already does what's needed.
- If a tool returns an error, investigate the error and retry with corrected parameters. Don't abandon working tools.
- Only if NO existing tool fits, offer to create a new skill:
- To add a skill:
  1. First read an existing skill for reference (e.g. use read_file on src/skills/backup.ts)
  2. Write a TypeScript file to local/skills/<name>.ts using write_file
  3. The file must export two things:
     - toolDefinitions: an array of tool definitions with name, description, and input_schema
     - toolHandlers: an object mapping tool names to async handler functions
  4. Each handler signature: async (input: Record<string, unknown>) => Promise<{ success: boolean, output: string }>
  5. Call install_skill with the skill name to hot-load it (no restart needed)
  6. Then use your new tools immediately in the same conversation
- Skills persist across restarts — they load automatically from local/skills/ on startup
- If install_skill reports an error, read the error message, fix the file with write_file, and try install_skill again

Background tasks:
- You can work on tasks autonomously in the background using create_background_task
- When the user asks you to "research X", "investigate Y", "look into Z", or any multi-step job, offer to create a background task
- Background tasks run automatically when you're not in a direct conversation — the user doesn't need to stay in the chat
- Each task runs in steps. Between steps, your findings are saved so you can continue later
- Use list_background_tasks to check on progress when the user asks
- Use get_task_details to see full findings for a specific task
- Task results are saved as notes you can load with load_note
- If the user says something like "work on this when you're free" or "do this in the background", that's definitely a background task

Notifications & escalation:
- The dashboard ALWAYS shows task completion — no setup needed
- External notifications (telegram, sms, call) only fire when the user explicitly asks: "text me when done", "call me if I don't respond"
- Currently available notification channels: ${getAvailableChannels().join(", ") || "none (dashboard only)"}
- ONLY offer channels that are listed as available above — never suggest a channel that isn't configured
- notify_via sets the escalation ORDER: first channel fires immediately, if user doesn't respond, next fires after escalate_after_minutes
- User can set a default via update_user_profile preferences.notify_default (e.g. "telegram")
- If user says "always text me when tasks finish", save that as their notify_default preference
${!config.telegram.botToken ? `
Telegram setup:
- The user is chatting via the web dashboard. Telegram is not set up yet.
- If they ask about mobile access or setting up Telegram, walk them through it:
  1. Install Telegram on their phone (telegram.org)
  2. Open Telegram and message @BotFather
  3. Send /newbot and follow the prompts to create a bot
  4. Copy the bot token and add TELEGRAM_BOT_TOKEN=<token> to the .env file
  5. Message @userinfobot on Telegram to find their user ID
  6. Add OWNER_USER_ID=<id> to the .env file
  7. Restart Bob (Ctrl+C in the terminal, then pnpm dev)
- Use set_env_var for .env changes. Do not try to edit .env with write_file because credential files are blocked.` : ""}
${userName === "mate" || userName === "Owner" ? `
The user hasn't told you their name yet. Ask them early in the conversation so you can address them personally. Use update_user_profile to save it.` : ""}`;
}

export interface AgentResponse {
  text: string;
  toolsUsed: string[];
}

export type AgentSource = "telegram" | "dashboard" | "worker" | "a2a";

/** Optional overrides for sandboxed/restricted agent runs (e.g. A2A). */
export interface AgentOptions {
  systemPrompt?: string;
  toolDefs?: ToolDefinition[];
  maxRounds?: number;
  toolExecutor?: (
    name: string,
    input: Record<string, unknown>,
    context?: ToolContext
  ) => Promise<{ success: boolean; output: string }>;
}

/**
 * Run the agent loop: send a message, let the LLM use tools, repeat until done.
 */
export async function runAgent(
  userId: string,
  userMessage: string,
  source: AgentSource = "telegram",
  options?: AgentOptions
): Promise<AgentResponse> {
  const isWorker = source === "worker";
  const isA2A = source === "a2a";

  // Fast-path: status check — no LLM call, no preemption, read-only
  if (!isWorker && !isA2A && isStatusCheck(userMessage)) {
    const statusText = await buildStatusResponse();

    await memory.appendHistory(userId, {
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    }, source);
    await memory.appendHistory(userId, {
      role: "assistant",
      content: statusText,
      timestamp: new Date().toISOString(),
    }, source);

    const eventSource = source === "telegram" ? "telegram" : "dashboard";
    events.emitEvent("message:in", { userId, text: userMessage, source: eventSource });
    events.emitEvent("message:out", { userId, text: statusText });

    return { text: statusText, toolsUsed: [] };
  }

  // Fast-path: dismiss coding warning — save preference, no LLM call
  if (!isWorker && !isA2A && userMessage.toLowerCase().includes("dismiss coding warning")) {
    const dismissProfile = await memory.loadProfile(userId);
    if (dismissProfile) {
      dismissProfile.preferences.codingWarningDismissed = true;
      await memory.saveProfile(dismissProfile);
    }
    const dismissText = "Coding warning dismissed. You won't see it again. You can always set up a coding brain later via CODING_LLM_API_KEY.";

    await memory.appendHistory(userId, { role: "user", content: userMessage, timestamp: new Date().toISOString() }, source);
    await memory.appendHistory(userId, { role: "assistant", content: dismissText, timestamp: new Date().toISOString() }, source);

    const eventSource = source === "telegram" ? "telegram" : "dashboard";
    events.emitEvent("message:in", { userId, text: userMessage, source: eventSource });
    events.emitEvent("message:out", { userId, text: dismissText });

    return { text: dismissText, toolsUsed: [] };
  }

  // If a background task is running, preempt it so direct chat takes priority
  // A2A requests don't preempt — they wait or queue
  if (!isWorker && !isA2A && getIsBusy() && getActiveContext() === "worker") {
    console.log("[agent] Chat incoming — requesting worker preemption");
    requestPreempt();

    const maxWait = 30_000;
    const start = Date.now();
    while (getIsBusy() && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (getIsBusy()) {
      console.log("[agent] Worker didn't yield in time — proceeding anyway");
    }
  }

  const controller = new AbortController();
  activeRuns.set(userId, controller);

  if (!isWorker && !isA2A) {
    setIsBusy(true, "chat");
  }

  try {
    return await runAgentInner(userId, userMessage, source, options, controller.signal);
  } finally {
    activeRuns.delete(userId);
    if (!isWorker && !isA2A) {
      setIsBusy(false);
    }
  }
}

/**
 * Detect when the LLM claims to have taken an action without using the tool.
 * Returns the first match found, or null if the response is clean.
 */
export function detectUnusedActions(
  text: string,
  usedTools: string[]
): { claim: string; tool: string } | null {
  const lower = text.toLowerCase();
  const checks: Array<{ patterns: string[]; tool: string; claim: string }> = [
    {
      patterns: ["calling you", "dialing", "call initiated", "calling now", "ringing now", "placed a call", "making the call"],
      tool: "call_owner",
      claim: "making a phone call",
    },
    {
      patterns: ["sms sent", "texting you", "text sent", "sent you a text", "sending a text"],
      tool: "send_sms",
      claim: "sending an SMS",
    },
    {
      patterns: ["added to your calendar", "event created", "added the event", "scheduled the event", "added to calendar"],
      tool: "add_event",
      claim: "adding a calendar event",
    },
    {
      patterns: ["reminder set", "i'll remind you", "reminder created", "set a reminder", "reminder is set"],
      tool: "set_reminder",
      claim: "setting a reminder",
    },
    {
      patterns: ["email sent", "sent the email", "sending the email", "emailed"],
      tool: "send_email",
      claim: "sending an email",
    },
    {
      patterns: [
        "file updated", "updated the file", "file has been updated",
        "written to the file", "saved the file", "updated the timesheet",
        "updated the document", "appended to the file", "added to the file",
        "file saved", "document updated",
      ],
      tool: "write_file",
      claim: "writing/updating a file",
    },
  ];

  for (const check of checks) {
    if (usedTools.includes(check.tool)) continue; // Tool was actually used, all good
    for (const pattern of check.patterns) {
      if (lower.includes(pattern)) {
        return { claim: check.claim, tool: check.tool };
      }
    }
  }

  return null;
}

async function runAgentInner(
  userId: string,
  userMessage: string,
  source: AgentSource,
  options: AgentOptions | undefined,
  signal: AbortSignal
): Promise<AgentResponse> {
  const eventSource = source === "worker" || source === "a2a" ? "dashboard" : source;
  events.emitEvent("message:in", { userId, text: userMessage, source: eventSource });

  // Load user profile, notes, and owner context for dynamic prompt
  let profile = await memory.loadProfile(userId);
  const notes = await memory.listNotes();
  const ownerContext = await memory.loadOwnerContext();

  // Auto-create profile if it doesn't exist
  if (!profile) {
    profile = {
      userId,
      name: "mate",
      chatId: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      preferences: {},
      notes: "",
    };
    await memory.saveProfile(profile);
  } else {
    profile.lastSeen = new Date().toISOString();
    await memory.saveProfile(profile);
  }

  // Resolve cost mode and provider
  const costMode: CostMode = (profile?.preferences?.costMode as CostMode) ?? config.costMode.default;
  const resolved = options?.systemPrompt
    ? { provider: getProvider(config.llm), llmConfig: config.llm, isSecondary: false, isCoding: false } // A2A/sandbox always use primary
    : resolveProvider(source, costMode, userMessage);
  let activeProvider = resolved.provider;
  let activeLlmConfig = resolved.llmConfig;

  if (!options?.systemPrompt && source !== "worker") {
    const brainLabel = resolved.isCoding ? "coding brain" : resolved.isSecondary ? "secondary" : "primary";
    console.log(`[cost-mode] source=${source} model=${activeLlmConfig.model} (${brainLabel})`);
  }

  // Coding brain warning: show once when coding task detected but no coding brain configured
  let codingWarningNotice = "";
  const isCodingMessage = isCodingTask(userMessage);
  if (
    !options?.systemPrompt
    && isCodingMessage
    && !config.codingLlm
    && config.llm.provider !== "anthropic"
    && !profile?.preferences?.codingWarningDismissed
  ) {
    codingWarningNotice = `\n\n---\n*You're currently using ${config.llm.provider} (${config.llm.model}) which has known issues with code generation. Recommend setting up a coding brain (CODING_LLM_API_KEY) to route code tasks to Claude Opus. Say "dismiss coding warning" to hide this.*`;
  }

  const isDirectChat = source === "telegram" || source === "dashboard";
  const baseSysPrompt = options?.systemPrompt ?? buildSystemPrompt(profile, notes, ownerContext);
  const pluginSection = isDirectChat && !options?.systemPrompt
    ? selectPluginKnowledgeForMessage(userMessage)
    : "";
  const systemPrompt = isDirectChat && !options?.systemPrompt
    ? baseSysPrompt + pluginSection + buildCategorySystemPromptSection() + buildLocalSkillsPromptSection()
    : baseSysPrompt;
  let activeToolDefs = options?.toolDefs
    ?? (isDirectChat ? selectToolsForMessage(userMessage, toolDefinitions) : toolDefinitions);
  const activeToolExecutor = options?.toolExecutor ?? executeTool;
  const maxToolRounds = options?.maxRounds ?? config.agent.maxToolRounds;
  const toolContext: ToolContext = { userId, signal };

  // Load conversation history for context
  const history = await memory.loadHistory(userId);

  // Build messages from history + new message
  const messages: Message[] = [
    ...history.slice(-20).map(
      (entry): Message => ({
        role: entry.role,
        content: entry.content,
      })
    ),
    { role: "user", content: userMessage },
  ];

  // Save the user message to memory
  await memory.appendHistory(userId, {
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
  }, source);

  if (isDirectChat && !options?.toolDefs) {
    console.log(`[tool-loader] ${activeToolDefs.length} tools selected (of ${toolDefinitions.length} total)`);
  }

  const toolsUsed: string[] = [];
  const toolCallSummaries: Array<{ tool: string; success: boolean; snippet: string }> = [];
  let rounds = 0;

  // Circuit breaker: detect repeated identical tool errors (stuck detection)
  let lastErrorKey: string | null = null;
  let consecutiveErrorCount = 0;
  const CIRCUIT_BREAKER_LIMIT = 2;

  // Build a pause message with context about what was done
  function buildPauseMessage(): string {
    if (toolCallSummaries.length === 0) {
      return `(Paused) I hadn't started any tool calls yet.\n\nWhat's up? Say "continue" to resume, or tell me what you'd like instead.`;
    }
    const summaryLines = toolCallSummaries.map((s) => {
      const icon = s.success ? "OK" : "FAIL";
      return `  - ${s.tool}: [${icon}] ${s.snippet}`;
    });
    return `(Paused after ${rounds} step${rounds !== 1 ? "s" : ""})\n\n` +
      `**Working on:** "${userMessage.slice(0, 150)}${userMessage.length > 150 ? "..." : ""}"\n\n` +
      `**Tools called (${toolCallSummaries.length}):**\n${summaryLines.join("\n")}\n\n` +
      `Say "continue" to pick up where I left off, or tell me what you'd like instead.`;
  }

  // Handle pause: save to history + emit events + return
  async function handlePause(): Promise<AgentResponse> {
    const pauseMsg = buildPauseMessage();
    console.log(`[agent] Run paused by user (${source}), ${rounds} rounds, ${toolsUsed.length} tools`);

    await memory.appendHistory(userId, {
      role: "assistant",
      content: pauseMsg,
      timestamp: new Date().toISOString(),
    }, source);

    events.emitEvent("agent:status", { userId, status: "done", detail: "Paused" });
    events.emitEvent("message:out", { userId, text: pauseMsg });

    return { text: pauseMsg, toolsUsed };
  }

  // Agentic loop — keep going while the LLM wants to use tools
  while (rounds < maxToolRounds) {
    // Check if worker should yield to a direct chat message
    if (source === "worker" && isPreemptRequested()) {
      console.log("[agent] Worker preempted by direct chat — yielding");
      clearPreempt();
      events.emitEvent("agent:status", { userId, status: "done", detail: "Preempted" });
      return { text: "(Preempted by direct chat — will continue on next tick)", toolsUsed };
    }

    // Check for user-initiated pause (Esc key, /cancel command)
    if (signal.aborted) {
      return handlePause();
    }

    rounds++;

    events.emitEvent("agent:status", {
      userId,
      status: "thinking",
      detail: rounds === 1 ? "Thinking..." : `Working... (step ${rounds})`,
    });

    let response;
    let fallbackNotice = "";
    try {
      response = await activeProvider.chat({
        model: activeLlmConfig.model,
        maxTokens: 4096,
        system: systemPrompt,
        tools: activeToolDefs,
        messages,
        signal,
      });
    } catch (err) {
      // AbortError = user pressed Esc / /cancel — treat as pause
      // DOMException("AbortError") from fetch, or SDK-specific abort errors
      const isAbort = signal.aborted || (err instanceof DOMException && err.name === "AbortError")
        || (err instanceof Error && err.name === "AbortError");
      if (isAbort) {
        return handlePause();
      }
      // If secondary or coding brain failed, fall back to primary and notify
      if (resolved.isSecondary || resolved.isCoding) {
        const label = resolved.isCoding ? "Coding brain" : "Secondary model";
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`[cost-mode] ${label} failed (${reason}), falling back to primary`);
        const primaryConfig = config.llm;
        activeProvider = getProvider(primaryConfig);
        activeLlmConfig = primaryConfig;
        fallbackNotice = `\n\n---\n*${label} failed (${reason}). Fell back to primary model for this task.*`;
        response = await activeProvider.chat({
          model: activeLlmConfig.model,
          maxTokens: 4096,
          system: systemPrompt,
          tools: activeToolDefs,
          messages,
          signal,
        });
      } else {
        throw err;
      }
    }

    // Check for pause after LLM response returns (signal may have been set during the API call)
    if (signal.aborted) {
      return handlePause();
    }

    // Collect all text blocks from the response
    const textBlocks = response.content
      .filter((b): b is Extract<ResponseBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text);

    // Collect all tool use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Extract<ResponseBlock, { type: "tool_use" }> => b.type === "tool_use"
    );

    // Detect truncated tool calls — LLM hit maxTokens mid-generation
    if (response.stopReason === "max_tokens" && toolUseBlocks.length > 0) {
      console.log(`[agent] Response truncated (max_tokens) with ${toolUseBlocks.length} tool calls — likely oversized output`);

      // Don't execute the broken tool calls — tell the LLM what happened
      messages.push({ role: "assistant", content: response.content as ContentBlock[] });

      // Send back dummy tool results so the API sees valid tool_result for each tool_use
      const truncationResults: ToolResultContent[] = toolUseBlocks.map(block => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: "SKIPPED — your previous response was truncated (hit output token limit). The content you tried to generate was too large for a single response.",
        is_error: true,
      }));
      messages.push({ role: "user", content: truncationResults });

      // Inject guidance for the LLM to self-correct
      messages.push({
        role: "user",
        content:
          "Your response was cut off because the content you tried to generate exceeded the output token limit. " +
          "Do NOT retry with the same large content. Instead:\n" +
          "1. Generate a simplified/core version first\n" +
          "2. Tell the user what you've created and what additional sections you could add separately\n" +
          "3. Let the user decide whether to expand\n" +
          "Think iteratively — ship the core, offer additions.",
      });
      continue; // Re-enter the loop with self-correction guidance
    }

    // If no tool calls, check for hallucinated actions before finishing
    if (response.stopReason === "end_turn" || toolUseBlocks.length === 0) {
      let finalText = (textBlocks.join("\n") || "(No response)") + fallbackNotice + codingWarningNotice;

      // Detect text truncation — append indicator so user can ask to continue
      if (response.stopReason === "max_tokens") {
        console.log("[agent] Text response truncated (max_tokens) — appending continuation indicator");
        finalText += '\n\n...\n\n*Long response, type "continue" to continue.*';
      }

      // Guard: detect when Bob claims to have done something without using the tool
      const missed = detectUnusedActions(finalText, toolsUsed);
      if (missed && rounds < maxToolRounds) {
        console.log(`[agent] Hallucination guard: Bob claimed "${missed.claim}" without using ${missed.tool}`);
        messages.push({ role: "assistant", content: response.content as ContentBlock[] });
        messages.push({
          role: "user",
          content: `You said "${missed.claim}" but you did NOT actually use the ${missed.tool} tool. ` +
            `Describing an action does NOT make it happen. You MUST call the ${missed.tool} tool now to actually do it.`,
        });
        continue; // Re-enter the agent loop
      }

      await memory.appendHistory(userId, {
        role: "assistant",
        content: finalText,
        timestamp: new Date().toISOString(),
      }, source);

      events.emitEvent("agent:status", { userId, status: "done" });
      events.emitEvent("message:out", { userId, text: finalText });

      return { text: finalText, toolsUsed };
    }

    // Add assistant message with tool calls to conversation
    messages.push({ role: "assistant", content: response.content as ContentBlock[] });

    // Execute each tool call and collect results
    const toolNames = toolUseBlocks.map((b) => b.name).join(", ");
    events.emitEvent("agent:status", {
      userId,
      status: "tool_use",
      detail: `Using ${toolNames}...`,
    });

    const toolResults: ToolResultContent[] = await Promise.all(
      toolUseBlocks.map(async (toolUse) => {
        // Check for pause before each tool execution
        if (signal.aborted) {
          toolsUsed.push(toolUse.name);
          toolCallSummaries.push({ tool: toolUse.name, success: false, snippet: "(skipped — paused)" });
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: "Skipped — user paused the run.",
            is_error: true,
          };
        }

        toolsUsed.push(toolUse.name);
        console.log(`  [tool] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);

        events.emitEvent("tool:call", { tool: toolUse.name, input: toolUse.input, userId });

        const startMs = Date.now();
        const result = await activeToolExecutor(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          toolContext
        );
        const durationMs = Date.now() - startMs;

        // Track for pause message
        toolCallSummaries.push({
          tool: toolUse.name,
          success: result.success,
          snippet: result.output.slice(0, 120),
        });

        events.emitEvent("tool:result", {
          tool: toolUse.name,
          success: result.success,
          output: result.output.slice(0, 500),
        });

        // Record tool call to SQLite (if available)
        try {
          const { insertToolCall } = await import("../db/queries.js");
          insertToolCall({
            toolName: toolUse.name,
            input: toolUse.input,
            output: result.output,
            success: result.success,
            durationMs,
            userId,
          });
        } catch {
          // SQLite not available
        }

        return {
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: result.output,
          is_error: !result.success,
        };
      })
    );

    // Check for pause after tool execution
    if (signal.aborted) {
      return handlePause();
    }

    // Circuit breaker: detect repeated identical tool errors
    const failedResults = toolResults.filter(r => r.is_error);
    if (failedResults.length > 0) {
      const failedBlock = toolUseBlocks.find(b => b.id === failedResults[0].tool_use_id);
      const errorKey = `${failedBlock?.name}:${failedResults[0].content.slice(0, 100)}`;

      if (errorKey === lastErrorKey) {
        consecutiveErrorCount++;
      } else {
        lastErrorKey = errorKey;
        consecutiveErrorCount = 1;
      }

      if (consecutiveErrorCount >= CIRCUIT_BREAKER_LIMIT) {
        const toolName = failedBlock?.name ?? "unknown";
        const errorPreview = failedResults[0].content.slice(0, 200);

        console.log(`[agent] Circuit breaker: ${toolName} failed ${CIRCUIT_BREAKER_LIMIT}x with same error`);

        const breakerMsg = `I'm stuck — \`${toolName}\` failed twice with the same error:\n\n> ${errorPreview}\n\nThis needs a different approach or a fix on your end. What would you like me to try?`;

        await memory.appendHistory(userId, {
          role: "assistant",
          content: breakerMsg,
          timestamp: new Date().toISOString(),
        }, source);

        events.emitEvent("agent:status", { userId, status: "done", detail: "Circuit breaker" });
        events.emitEvent("message:out", { userId, text: breakerMsg });

        return { text: breakerMsg, toolsUsed };
      }
    } else {
      // A round with no failures — reset the tracker
      lastErrorKey = null;
      consecutiveErrorCount = 0;
    }

    // Add tool results to conversation
    messages.push({ role: "user", content: toolResults });

    // Expand active tools if load_tools was called
    const loadToolsCalls = toolUseBlocks.filter((b) => b.name === "load_tools");
    if (loadToolsCalls.length > 0) {
      const existingNames = new Set(activeToolDefs.map((d) => d.name));
      for (const call of loadToolsCalls) {
        const cats = ((call.input as Record<string, unknown>).categories as string[]) ?? [];
        const newDefs = getToolsForCategories(cats, toolDefinitions);
        for (const def of newDefs) {
          if (!existingNames.has(def.name)) {
            activeToolDefs.push(def);
            existingNames.add(def.name);
          }
        }
        console.log(`[tool-loader] Expanded: +${cats.join(", ")} → ${activeToolDefs.length} tools`);
      }
    }
  }

  // If we hit the max rounds, return what we have
  const fallback = "I've been working on this for a while and hit my tool limit. Here's what I have so far — let me know if you want me to continue.";

  await memory.appendHistory(userId, {
    role: "assistant",
    content: fallback,
    timestamp: new Date().toISOString(),
  }, source);

  events.emitEvent("agent:status", { userId, status: "done" });
  events.emitEvent("message:out", { userId, text: fallback });

  return { text: fallback, toolsUsed };
}
