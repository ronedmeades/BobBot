import { config } from "../config.js";
import { getProvider } from "../providers/factory.js";
import type {
  Message,
  ContentBlock,
  ToolResultContent,
  ResponseBlock,
} from "../providers/types.js";
import { toolDefinitions } from "./tools.js";
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

function buildSystemPrompt(profile: UserProfile | null, notes: string[]): string {
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

Key behaviors:
- You are proactive, resourceful, and thorough
- When given a task, you figure out how to do it using your tools
- You explore APIs, read documentation, download data, and produce results
- You give concise progress updates but save the detail for the final report
- If you hit a wall, say so clearly and explain what you need
- You have a sense of humor — you're a mate, not a corporate bot
- Address the user by name when it feels natural (don't overdo it)

CRITICAL — Tool usage rules:
- You MUST use your tools to take actions. NEVER claim to have done something without actually calling the tool.
- If the user asks you to make a phone call → you MUST call the call_owner tool. Do NOT just say "Calling you now".
- If the user asks you to add a calendar event → you MUST call add_event. Do NOT just say "Added to your calendar".
- If the user asks you to set a reminder → you MUST call set_reminder. Do NOT just say "Reminder set".
- This applies to ALL actions: writing files, sending emails, creating tasks, etc.
- The ONLY way to take an action is by using a tool. Describing an action in text does NOT make it happen.
- After using a tool, report what ACTUALLY happened based on the tool's response — not what you assumed would happen.

Memory:
- You have persistent memory that survives restarts
- Use save_note to remember important information, findings, or task results
- Use load_note and list_notes to recall what you've previously saved
- Use update_user_profile when you learn something new about the user (their name, preferences, what they're working on)
- Be proactive about saving useful information — if you did research or completed a task, save the results
${notesList}

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

const provider = getProvider(config.llm);

export interface AgentResponse {
  text: string;
  toolsUsed: string[];
}

/**
 * Run the agent loop: send a message, let the LLM use tools, repeat until done.
 */
export async function runAgent(
  userId: string,
  userMessage: string,
  source: "telegram" | "dashboard" | "worker" = "telegram"
): Promise<AgentResponse> {
  const isWorker = source === "worker";

  // If a background task is running, preempt it so direct chat takes priority
  if (!isWorker && getIsBusy() && getActiveContext() === "worker") {
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

  if (!isWorker) {
    setIsBusy(true, "chat");
  }

  try {
    return await runAgentInner(userId, userMessage, source);
  } finally {
    if (!isWorker) {
      setIsBusy(false);
    }
  }
}

/**
 * Detect when the LLM claims to have taken an action without using the tool.
 * Returns the first match found, or null if the response is clean.
 */
function detectUnusedActions(
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
  source: "telegram" | "dashboard" | "worker"
): Promise<AgentResponse> {
  events.emitEvent("message:in", { userId, text: userMessage, source: source === "worker" ? "dashboard" : source });

  // Load user profile and notes for dynamic prompt
  let profile = await memory.loadProfile(userId);
  const notes = await memory.listNotes();

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

  const systemPrompt = buildSystemPrompt(profile, notes);
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
  });

  const toolsUsed: string[] = [];
  let rounds = 0;

  // Agentic loop — keep going while the LLM wants to use tools
  while (rounds < config.agent.maxToolRounds) {
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

    const response = await provider.chat({
      model: config.llm.model,
      maxTokens: 4096,
      system: systemPrompt,
      tools: toolDefinitions,
      messages,
    });

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
      const finalText = textBlocks.join("\n") || "(No response)";

      // Guard: detect when Bob claims to have done something without using the tool
      const missed = detectUnusedActions(finalText, toolsUsed);
      if (missed && rounds < config.agent.maxToolRounds) {
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
      });

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

        const result = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          toolContext
        );

        events.emitEvent("tool:result", {
          tool: toolUse.name,
          success: result.success,
          output: result.output.slice(0, 500),
        });

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
  }

  // If we hit the max rounds, return what we have
  const fallback = "I've been working on this for a while and hit my tool limit. Here's what I have so far — let me know if you want me to continue.";

  await memory.appendHistory(userId, {
    role: "assistant",
    content: fallback,
    timestamp: new Date().toISOString(),
  });

  events.emitEvent("agent:status", { userId, status: "done" });
  events.emitEvent("message:out", { userId, text: fallback });

  return { text: fallback, toolsUsed };
}
