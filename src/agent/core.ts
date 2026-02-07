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
  source: "telegram" | "dashboard" = "telegram"
): Promise<AgentResponse> {
  events.emitEvent("message:in", { userId, text: userMessage, source });

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
    rounds++;

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

    // If no tool calls, we're done
    if (response.stopReason === "end_turn" || toolUseBlocks.length === 0) {
      const finalText = textBlocks.join("\n") || "(No response)";

      await memory.appendHistory(userId, {
        role: "assistant",
        content: finalText,
        timestamp: new Date().toISOString(),
      });

      events.emitEvent("message:out", { userId, text: finalText });

      return { text: finalText, toolsUsed };
    }

    // Add assistant message with tool calls to conversation
    messages.push({ role: "assistant", content: response.content as ContentBlock[] });

    // Execute each tool call and collect results
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

  events.emitEvent("message:out", { userId, text: fallback });

  return { text: fallback, toolsUsed };
}
