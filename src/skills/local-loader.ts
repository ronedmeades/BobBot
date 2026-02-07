import { readdir, stat, mkdir } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "../providers/types.js";

/**
 * Local skills auto-loader.
 *
 * Scans `local/skills/` for .ts/.js files at startup and dynamically imports them.
 * Each local skill file should export:
 *   - toolDefinitions: ToolDefinition[]
 *   - toolHandlers: Record<string, (input: Record<string, unknown>, context?: any) => Promise<ToolResult>>
 *
 * This lets users add personal skills that are never committed to the public repo.
 */

interface ToolResult {
  success: boolean;
  output: string;
}

type ToolHandler = (
  input: Record<string, unknown>,
  context?: { userId: string }
) => Promise<ToolResult>;

interface LocalSkillModule {
  toolDefinitions?: ToolDefinition[];
  toolHandlers?: Record<string, ToolHandler>;
}

// Accumulated definitions and handlers from all local skills
const localDefinitions: ToolDefinition[] = [];
const localHandlers = new Map<string, ToolHandler>();
let loaded = false;

function getLocalSkillsDir(): string {
  return resolve(process.cwd(), "local", "skills");
}

/**
 * Load all local skill modules. Safe to call multiple times — only loads once.
 */
export async function loadLocalSkills(): Promise<void> {
  if (loaded) return;
  loaded = true;

  const skillsDir = getLocalSkillsDir();

  // Check if local/skills/ exists
  try {
    const s = await stat(skillsDir);
    if (!s.isDirectory()) return;
  } catch {
    // Directory doesn't exist — that's fine, no local skills
    return;
  }

  const entries = await readdir(skillsDir);
  const skillFiles = entries.filter(
    (f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.startsWith("_")
  );

  if (skillFiles.length === 0) return;

  console.log(`Loading ${skillFiles.length} local skill(s)...`);

  for (const file of skillFiles) {
    const filePath = join(skillsDir, file);
    const skillName = file.replace(extname(file), "");

    try {
      // Dynamic import using file:// URL (required for ESM on Windows)
      const fileUrl = pathToFileURL(filePath).href;
      const mod = (await import(fileUrl)) as LocalSkillModule;

      if (mod.toolDefinitions && Array.isArray(mod.toolDefinitions)) {
        localDefinitions.push(...mod.toolDefinitions);
      }

      if (mod.toolHandlers && typeof mod.toolHandlers === "object") {
        for (const [name, handler] of Object.entries(mod.toolHandlers)) {
          localHandlers.set(name, handler);
        }
      }

      const defCount = mod.toolDefinitions?.length ?? 0;
      const handlerCount = mod.toolHandlers ? Object.keys(mod.toolHandlers).length : 0;
      console.log(`  [local] ${skillName}: ${defCount} tools, ${handlerCount} handlers`);
    } catch (err) {
      console.error(`  [local] Failed to load ${skillName}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Local skills loaded: ${localDefinitions.length} tools total`);
}

/**
 * Get all tool definitions from local skills.
 * Call loadLocalSkills() first.
 */
export function getLocalToolDefinitions(): ToolDefinition[] {
  return localDefinitions;
}

/**
 * Try to execute a tool by name from local skills.
 * Returns null if the tool isn't a local skill.
 */
export async function executeLocalTool(
  name: string,
  input: Record<string, unknown>,
  context?: { userId: string }
): Promise<ToolResult | null> {
  const handler = localHandlers.get(name);
  if (!handler) return null;
  return handler(input, context);
}

/**
 * Hot-install a single skill file at runtime.
 * Dynamically imports the file, registers its tools and handlers,
 * and returns the names of newly available tools.
 */
export async function installLocalSkill(
  skillName: string
): Promise<{ success: boolean; toolNames: string[]; error?: string }> {
  const skillsDir = getLocalSkillsDir();

  // Ensure local/skills/ exists
  await mkdir(skillsDir, { recursive: true });

  // Try .ts first, then .js
  let filePath = join(skillsDir, `${skillName}.ts`);
  try {
    await stat(filePath);
  } catch {
    filePath = join(skillsDir, `${skillName}.js`);
    try {
      await stat(filePath);
    } catch {
      return { success: false, toolNames: [], error: `Skill file not found: local/skills/${skillName}.ts (or .js)` };
    }
  }

  try {
    // Cache-busting: append timestamp so Node.js re-imports the file
    const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;
    const mod = (await import(fileUrl)) as LocalSkillModule;

    if (!mod.toolDefinitions && !mod.toolHandlers) {
      return {
        success: false,
        toolNames: [],
        error: "Skill file must export toolDefinitions (array) and/or toolHandlers (object).",
      };
    }

    const newToolNames: string[] = [];

    if (mod.toolDefinitions && Array.isArray(mod.toolDefinitions)) {
      for (const def of mod.toolDefinitions) {
        // Remove old definition with same name (allows re-install to update)
        const existingIdx = localDefinitions.findIndex((d) => d.name === def.name);
        if (existingIdx !== -1) {
          localDefinitions.splice(existingIdx, 1);
        }
        localDefinitions.push(def);
        newToolNames.push(def.name);
      }
    }

    if (mod.toolHandlers && typeof mod.toolHandlers === "object") {
      for (const [name, handler] of Object.entries(mod.toolHandlers)) {
        localHandlers.set(name, handler);
      }
    }

    console.log(`  [install] ${skillName}: ${newToolNames.length} tools installed (${newToolNames.join(", ")})`);
    return { success: true, toolNames: newToolNames };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, toolNames: [], error: message };
  }
}
