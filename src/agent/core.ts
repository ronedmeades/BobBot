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
} from "./tool-loader.js";
import { selectPluginKnowledgeForMessage } from "./plugin-loader.js";

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

export interface ResolvedProvider {
  provider: LLMProvider;
  llmConfig: LLMConfig;
  isSecondary: boolean;
}

/**
 * Resolve which provider to use based on cost mode and source.
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
  const primary: ResolvedProvider = { provider: primaryProvider, llmConfig: primaryConfig, isSecondary: false };

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
    return { provider: secondaryProvider, llmConfig: secondaryConfig, isSecondary: true };
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
- ${getPersonalityPrompt(profile?.preferences?.personality)}
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
Cost mode: ${profile?.preferences?.costMode ?? config.costMode.default}${config.secondaryLlm ? ` | secondary: ${config.secondaryLlm.model} (${config.secondaryLlm.provider})` : " | no secondary configured"}
Platform: You are running on ${process.platform === "win32" ? "Windows — use PowerShell or cmd syntax (findstr, dir, etc.), NOT Unix commands (grep, ls, cat). The project is ESM (\"type\": \"module\") so use import, not require." : process.platform === "darwin" ? "macOS." : "Linux."}

CRITICAL — Actions require tools:
- NEVER claim to have done something without actually calling a tool. Describing an action in text does NOT make it happen.
- After using a tool, report what ACTUALLY happened based on the tool's response.
- Credentials: use list_env_keys to check what's set, set_env_var to add/update. Do NOT invent new key names — only pre-defined keys are accepted.
- File safety: When modifying a file that already has content, ALWAYS read it first with read_file. Then either use append=true to add to the end, or rebuild the full content and write with overwrite=true. NEVER write partial content that would erase existing data. For growing documents (timesheets, logs, lists), append=true is usually correct.

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

Self-extending skills:
- If you can't accomplish a task with your current tools, tell the user and offer to create a new skill for it
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
- You can also use write_file to update the .env file for them if they give you the values.` : ""}
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

  if (!isWorker && !isA2A) {
    setIsBusy(true, "chat");
  }

  try {
    return await runAgentInner(userId, userMessage, source, options);
  } finally {
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
  options?: AgentOptions
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
    ? { provider: getProvider(config.llm), llmConfig: config.llm, isSecondary: false } // A2A/sandbox always use primary
    : resolveProvider(source, costMode, userMessage);
  let activeProvider = resolved.provider;
  let activeLlmConfig = resolved.llmConfig;

  if (!options?.systemPrompt && source !== "worker") {
    console.log(`[cost-mode] source=${source} model=${activeLlmConfig.model} (${resolved.isSecondary ? "secondary" : "primary"})`);
  }

  const isDirectChat = source === "telegram" || source === "dashboard";
  const baseSysPrompt = options?.systemPrompt ?? buildSystemPrompt(profile, notes, ownerContext);
  const pluginSection = isDirectChat && !options?.systemPrompt
    ? selectPluginKnowledgeForMessage(userMessage)
    : "";
  const systemPrompt = isDirectChat && !options?.systemPrompt
    ? baseSysPrompt + pluginSection + buildCategorySystemPromptSection()
    : baseSysPrompt;
  let activeToolDefs = options?.toolDefs
    ?? (isDirectChat ? selectToolsForMessage(userMessage, toolDefinitions) : toolDefinitions);
  const activeToolExecutor = options?.toolExecutor ?? executeTool;
  const maxToolRounds = options?.maxRounds ?? config.agent.maxToolRounds;
  const toolContext: ToolContext = { userId };

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
  let rounds = 0;

  // Agentic loop — keep going while the LLM wants to use tools
  while (rounds < maxToolRounds) {
    // Check if worker should yield to a direct chat message
    if (source === "worker" && isPreemptRequested()) {
      console.log("[agent] Worker preempted by direct chat — yielding");
      clearPreempt();
      events.emitEvent("agent:status", { userId, status: "done", detail: "Preempted" });
      return { text: "(Preempted by direct chat — will continue on next tick)", toolsUsed };
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
      });
    } catch (err) {
      // If secondary failed, fall back to primary and notify
      if (resolved.isSecondary) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`[cost-mode] Secondary failed (${reason}), falling back to primary`);
        const primaryConfig = config.llm;
        activeProvider = getProvider(primaryConfig);
        activeLlmConfig = primaryConfig;
        fallbackNotice = `\n\n---\n*Secondary model failed (${activeLlmConfig.provider}): ${reason}. Fell back to primary model for this task.*`;
        response = await activeProvider.chat({
          model: activeLlmConfig.model,
          maxTokens: 4096,
          system: systemPrompt,
          tools: activeToolDefs,
          messages,
        });
      } else {
        throw err;
      }
    }

    // Collect all text blocks from the response
    const textBlocks = response.content
      .filter((b): b is Extract<ResponseBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text);

    // Collect all tool use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Extract<ResponseBlock, { type: "tool_use" }> => b.type === "tool_use"
    );

    // If no tool calls, check for hallucinated actions before finishing
    if (response.stopReason === "end_turn" || toolUseBlocks.length === 0) {
      const finalText = (textBlocks.join("\n") || "(No response)") + fallbackNotice;

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
