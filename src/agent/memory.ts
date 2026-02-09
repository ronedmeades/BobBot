import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const MEMORY_DIR = resolve("memory");

export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface UserProfile {
  userId: string;
  name: string;
  chatId: number;
  firstSeen: string;
  lastSeen: string;
  preferences: Record<string, string>;
  notes: string;
}

/**
 * Persistent memory for the agent.
 * Stores per-user conversation history and general notes as markdown files.
 */
export const memory = {
  async init(): Promise<void> {
    await mkdir(MEMORY_DIR, { recursive: true });
  },

  /** Load conversation history for a specific user */
  async loadHistory(userId: string): Promise<ConversationEntry[]> {
    const path = join(MEMORY_DIR, `user-${userId}.json`);
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as ConversationEntry[];
    } catch {
      return [];
    }
  },

  /** Append a message to a user's conversation history */
  async appendHistory(userId: string, entry: ConversationEntry, source?: string): Promise<void> {
    const history = await this.loadHistory(userId);
    history.push(entry);

    // Keep last 100 messages to avoid unbounded growth
    const trimmed = history.slice(-100);
    const path = join(MEMORY_DIR, `user-${userId}.json`);
    await writeFile(path, JSON.stringify(trimmed, null, 2), "utf-8");

    // Dual-write to SQLite (if available)
    try {
      const { insertConversation } = await import("../db/queries.js");
      insertConversation({
        userId,
        role: entry.role,
        content: entry.content,
        source,
      });
    } catch {
      // SQLite not available — JSON-only mode
    }
  },

  /** Save a named note (e.g., task results, API findings) */
  async saveNote(name: string, content: string): Promise<string> {
    const path = join(MEMORY_DIR, `${name}.md`);
    await writeFile(path, content, "utf-8");
    return path;
  },

  /** Read a named note */
  async loadNote(name: string): Promise<string | null> {
    const path = join(MEMORY_DIR, `${name}.md`);
    try {
      return await readFile(path, "utf-8");
    } catch {
      return null;
    }
  },

  /** List all notes */
  async listNotes(): Promise<string[]> {
    try {
      const files = await readdir(MEMORY_DIR);
      return files.filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  },

  /** Load a user profile */
  async loadProfile(userId: string): Promise<UserProfile | null> {
    const path = join(MEMORY_DIR, `profile-${userId}.json`);
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  },

  /** Save a user profile */
  async saveProfile(profile: UserProfile): Promise<void> {
    const path = join(MEMORY_DIR, `profile-${profile.userId}.json`);
    await writeFile(path, JSON.stringify(profile, null, 2), "utf-8");
  },
};
