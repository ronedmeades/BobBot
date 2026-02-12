/**
 * Plugin knowledge loader — selects domain expertise for system prompt injection.
 *
 * Mirrors tool-loader.ts: keyword matching against user messages, but for
 * knowledge (markdown) rather than tools (JSON schemas).
 *
 * Plugins follow Anthropic's knowledge-work-plugin format:
 *   .claude-plugin/plugin.json  — manifest
 *   skills/SKILL.md         — domain expertise with YAML frontmatter
 *   skills/references/*.md  — deep reference materials
 *   commands/*.md           — workflow templates (not used by Bob)
 *   .mcp.json               — MCP server configs (consumed by Bob's MCP client)
 *
 * ## Tiered Loading (context budget management)
 *
 * The difference between injecting 2KB of guidance and 50KB of reference
 * material is the difference between Bob staying sharp and hallucinating.
 * These tiers are explicit, enforced boundaries — not suggestions.
 *
 * TIER 1 — Always present in system prompt (~200-300 bytes)
 *   Compact list of available plugin domains + load_knowledge hint.
 *   Appears at end of system prompt section.
 *
 * TIER 2 — Auto-injected on keyword match (~200-800 bytes total)
 *   Short skill descriptions (1-2 sentences) for matched skills.
 *   Appears between base prompt and tool categories.
 *   NEVER includes full SKILL.md body or references.
 *
 * TIER 3 — On-demand via load_knowledge tool (2-25KB per skill)
 *   Full SKILL.md body returned as tool result.
 *   Only when LLM explicitly calls load_knowledge.
 *
 * TIER 4 — Deep references via load_knowledge + include_references (10-50KB)
 *   SKILL.md + all references/*.md returned as tool result.
 *   Only when LLM explicitly requests with include_references: true.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
import type { ToolDefinition } from "../providers/types.js";

// ─── Tier boundary constants ──────────────────────────────────────────
// These are hard limits, not guidelines. Functions enforce them.

/** Max bytes for a single Tier 2 skill description injected into system prompt */
const TIER_2_MAX_DESCRIPTION_BYTES = 500;

/** Max total bytes for all Tier 2 content combined in one system prompt */
const TIER_2_MAX_TOTAL_BYTES = 1500;

/** Max skills to match per message (prevents keyword flooding) */
const TIER_2_MAX_MATCHED_SKILLS = 5;

// ─── Types ────────────────────────────────────────────────────────────

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: { name: string };
}

interface PluginSkill {
  /** Skill name from frontmatter (e.g. "sql-queries") */
  name: string;
  /** Short description from frontmatter — used for Tier 2 injection */
  description: string;
  /** Keywords for message matching */
  keywords: string[];
  /** Parent plugin name */
  pluginName: string;
  /** Absolute path to SKILL.md */
  skillPath: string;
  /** Absolute paths to references/*.md files */
  referencePaths: string[];
}

interface LoadedPlugin {
  name: string;
  description: string;
  version: string;
  rootPath: string;
  skills: PluginSkill[];
}

// ─── Registry (populated by initPlugins) ──────────────────────────────

const plugins: Map<string, LoadedPlugin> = new Map();
const allSkills: PluginSkill[] = [];

// ─── Keyword overrides ────────────────────────────────────────────────
// Supplement auto-extracted keywords for skills where the description
// doesn't contain obvious trigger phrases users would type.

const KEYWORD_OVERRIDES: Record<string, string[]> = {
  // Data plugin skills
  "sql-queries": [
    "sql", "query", "database", "warehouse", "snowflake", "bigquery",
    "postgres", "redshift", "databricks", "cte", "window function",
    "join", "subquery", "index",
  ],
  "data-exploration": [
    "profile data", "dataset", "schema", "null", "cardinality",
    "data quality", "column distribution",
  ],
  "data-visualization": [
    "chart", "graph", "plot", "visualization", "matplotlib",
    "plotly", "seaborn", "bar chart", "line chart", "scatter",
    "histogram", "heatmap",
  ],
  "data-validation": [
    "validate data", "data check", "sanity check", "qa data",
    "data accuracy",
  ],
  "statistical-analysis": [
    "statistics", "hypothesis", "p-value", "regression", "correlation",
    "outlier", "standard deviation", "confidence interval", "t-test",
  ],
  "interactive-dashboard-builder": [
    "dashboard", "chart.js", "interactive chart", "html dashboard",
    "kpi", "filter",
  ],
  "data-context-extractor": [
    "data context", "tribal knowledge", "warehouse context",
    "metrics definition",
  ],
};

// ─── Stop words for keyword extraction ────────────────────────────────

const STOP_WORDS = new Set([
  // Articles, prepositions, conjunctions
  "a", "an", "the", "and", "or", "for", "to", "in", "of", "with",
  "is", "are", "use", "when", "that", "this", "from", "by", "on",
  "at", "as", "be", "it", "its", "your", "you", "etc", "all",
  "any", "can", "will", "about", "also", "each", "has", "have",
  "how", "may", "more", "most", "not", "only", "other", "our",
  "out", "over", "such", "than", "them", "then", "these", "they",
  "too", "very", "what", "which", "who", "would", "before", "after",
  // Verbs that appear in many skill descriptions and cause false matches
  "write", "read", "create", "build", "make", "find", "keep",
  "turn", "track", "plan", "draft", "check", "need", "help",
  "work", "using", "used", "based", "into", "across", "like",
  "want", "done", "gets", "take", "give", "look", "come", "goes",
  "stay", "down", "back", "just", "well", "good", "know", "take",
  // Generic nouns/adjectives common in descriptions
  "specific", "common", "existing", "current", "relevant",
  "detailed", "clear", "full", "quick", "best", "complex",
  "new", "first", "last", "next", "information", "questions",
  "company", "team", "tool", "tools", "using", "content",
]);

// ─── Frontmatter parser ───────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Handles both single-line descriptions and multi-line block scalars (>).
 * No YAML library needed — the format is simple and consistent.
 */
function parseFrontmatter(
  content: string
): { name: string; description: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const block = match[1];
  let name = "";
  let description = "";

  // Extract name (always single line)
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (nameMatch) name = nameMatch[1].trim();

  // Try single-line description first
  const descSingleMatch = block.match(/^description:\s*([^>\n].+)$/m);
  if (descSingleMatch) {
    description = descSingleMatch[1].trim();
  } else {
    // Multi-line block scalar: description: >\n  line1\n  line2...
    const descIdx = block.indexOf("description:");
    if (descIdx !== -1) {
      const afterDesc = block.slice(descIdx + "description:".length);
      const blockMatch = afterDesc.match(/^\s*>\s*\r?\n([\s\S]*?)$/);
      if (blockMatch) {
        description = blockMatch[1]
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" ");
      }
    }
  }

  return name ? { name, description } : null;
}

// ─── Keyword extraction ───────────────────────────────────────────────

/**
 * Extract keywords from a skill name + description.
 * Combines: name parts (split on hyphens) + description words + overrides.
 */
function extractKeywords(name: string, description: string): string[] {
  const keywords = new Set<string>();

  // From skill name: "sql-queries" → ["sql", "queries"]
  for (const part of name.split("-")) {
    if (part.length > 2) keywords.add(part.toLowerCase());
  }

  // From description: unique words >4 chars, stop words removed
  // Minimum 5 chars avoids noisy short words that match too broadly
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOP_WORDS.has(w));

  for (const word of words) {
    keywords.add(word);
  }

  // Manual overrides (multi-word phrases and domain terms)
  const overrides = KEYWORD_OVERRIDES[name];
  if (overrides) {
    for (const kw of overrides) {
      keywords.add(kw.toLowerCase());
    }
  }

  return Array.from(keywords);
}

// ─── Plugin scanning ──────────────────────────────────────────────────

/**
 * Scan a plugin directory and load its manifest + skills.
 */
function loadPlugin(pluginDir: string): LoadedPlugin | null {
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const manifestRaw = readFileSync(manifestPath, "utf-8");
    const manifest: PluginManifest = JSON.parse(manifestRaw);

    const skillsDir = join(pluginDir, "skills");
    const skills: PluginSkill[] = [];

    if (existsSync(skillsDir)) {
      const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      for (const dir of skillDirs) {
        const skillMdPath = join(skillsDir, dir.name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;

        try {
          const content = readFileSync(skillMdPath, "utf-8");
          const frontmatter = parseFrontmatter(content);
          if (!frontmatter) {
            console.log(
              `[plugin-loader] Warning: Could not parse frontmatter in ${skillMdPath}`
            );
            continue;
          }

          // Catalog reference files (paths only — content loaded on demand)
          const refsDir = join(skillsDir, dir.name, "references");
          const referencePaths: string[] = [];
          if (existsSync(refsDir)) {
            const refFiles = readdirSync(refsDir)
              .filter((f) => f.endsWith(".md"));
            for (const f of refFiles) {
              referencePaths.push(join(refsDir, f));
            }
          }

          skills.push({
            name: frontmatter.name,
            description: frontmatter.description,
            keywords: extractKeywords(
              frontmatter.name,
              frontmatter.description
            ),
            pluginName: manifest.name,
            skillPath: skillMdPath,
            referencePaths,
          });
        } catch (err) {
          console.log(
            `[plugin-loader] Warning: Failed to read ${skillMdPath}: ${err}`
          );
        }
      }
    }

    return {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      rootPath: pluginDir,
      skills,
    };
  } catch (err) {
    console.log(
      `[plugin-loader] Warning: Failed to load plugin at ${pluginDir}: ${err}`
    );
    return null;
  }
}

// ─── Initialization ───────────────────────────────────────────────────

/**
 * Initialize the plugin registry by scanning the plugins directory.
 * Called once at startup from index.ts.
 * Safe to call if plugins directory doesn't exist — logs warning and returns.
 */
export async function initPlugins(): Promise<void> {
  const pluginsRoot = resolve(process.cwd(), "knowledge-work-plugins-main");

  if (!existsSync(pluginsRoot)) {
    console.log(
      "[plugin-loader] No plugins directory found — running without knowledge plugins"
    );
    return;
  }

  const dirs = readdirSync(pluginsRoot, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && !d.name.startsWith(".")
  );

  let totalSkills = 0;
  const loadedNames: string[] = [];

  for (const dir of dirs) {
    const plugin = loadPlugin(join(pluginsRoot, dir.name));
    if (plugin && plugin.skills.length > 0) {
      plugins.set(plugin.name, plugin);
      allSkills.push(...plugin.skills);
      totalSkills += plugin.skills.length;
      loadedNames.push(plugin.name);
    }
  }

  // Rebuild the LOAD_KNOWLEDGE_DEF description with actual skill names
  if (allSkills.length > 0) {
    const skillList = allSkills.map((s) => s.name).join(", ");
    LOAD_KNOWLEDGE_DEF.description =
      "Load detailed domain expertise and methodology guides to inform your reasoning. " +
      "This does NOT add new tools — it gives you reference material on topics like " +
      "SQL best practices, data visualization principles, or statistical methods. " +
      "Use when you need deeper guidance than the auto-loaded context provides. " +
      `Available skills: ${skillList}`;
  }

  if (loadedNames.length > 0) {
    console.log(
      `[plugin-loader] Loaded ${loadedNames.length} plugin(s) (${totalSkills} skills): ${loadedNames.join(", ")}`
    );
  } else {
    console.log("[plugin-loader] No valid plugins found in plugins directory");
  }
}

// ─── Tier 1+2: System prompt injection ────────────────────────────────

/**
 * TIER 1 + TIER 2: Select plugin knowledge for a user message.
 *
 * Returns a system prompt section containing:
 * - Tier 1: Always-present compact list of available domains (~200-300 bytes)
 * - Tier 2: Matched skill descriptions if keywords hit (~200-800 bytes)
 *
 * Combined output is capped at TIER_2_MAX_TOTAL_BYTES to protect context budget.
 * Returns empty string if no plugins are loaded.
 */
export function selectPluginKnowledgeForMessage(message: string): string {
  if (plugins.size === 0) return "";

  const lower = message.toLowerCase();

  // ── Tier 2: keyword matching ──
  const matched: Array<{ pluginName: string; skillName: string; description: string }> = [];

  for (const skill of allSkills) {
    if (matched.length >= TIER_2_MAX_MATCHED_SKILLS) break;

    const hit = skill.keywords.some((kw) => lower.includes(kw));
    if (hit) {
      // Enforce per-description size cap
      const desc =
        skill.description.length > TIER_2_MAX_DESCRIPTION_BYTES
          ? skill.description.slice(0, TIER_2_MAX_DESCRIPTION_BYTES) + "..."
          : skill.description;
      matched.push({
        pluginName: skill.pluginName,
        skillName: skill.name,
        description: desc,
      });
    }
  }

  if (matched.length > 0) {
    const matchedNames = matched.map((m) => `${m.skillName} (${m.pluginName})`);
    console.log(`[plugin-loader] Matched: ${matchedNames.join(", ")}`);
  }

  // ── Build prompt section ──
  let section = "\n\nKnowledge plugins:";

  // Tier 2 matched skills (if any)
  if (matched.length > 0) {
    section +=
      "\nThe following domain expertise is relevant to this message:";

    let totalBytes = 0;
    for (const m of matched) {
      const line = `\n- [${m.pluginName}/${m.skillName}] ${m.description}`;
      if (totalBytes + line.length > TIER_2_MAX_TOTAL_BYTES) break;
      section += line;
      totalBytes += line.length;
    }

    section +=
      "\nUse load_knowledge with the skill name for full methodology and reference material.";
  }

  // Tier 1 always-present listing (compact — names + skill counts only)
  const pluginNames = Array.from(plugins.values())
    .map((p) => `${p.name} (${p.skills.length})`)
    .join(", ");

  section += `\nKnowledge domains available (use list_knowledge for details): ${pluginNames}`;

  return section;
}

// ─── Tier 3+4: On-demand knowledge loading ────────────────────────────

/**
 * TIER 3 + TIER 4: Load full skill content for the load_knowledge tool.
 *
 * Tier 3 (default): Returns the full SKILL.md body (2-25KB).
 * Tier 4 (include_references: true): Also appends all references/*.md (10-50KB).
 *
 * Content is returned as a tool result string — it enters the conversation
 * context, NOT the system prompt. This is intentional: large content only
 * appears when the LLM explicitly requests it.
 */
export async function loadPluginContent(
  skillName: string,
  options?: { includeReferences?: boolean }
): Promise<{ success: boolean; output: string }> {
  const skill = allSkills.find((s) => s.name === skillName);
  if (!skill) {
    const available = allSkills.map((s) => s.name).join(", ");
    return {
      success: false,
      output: `Unknown skill "${skillName}". Available: ${available || "none (no plugins loaded)"}`,
    };
  }

  try {
    // Tier 3: full SKILL.md
    const skillContent = readFileSync(skill.skillPath, "utf-8");
    let output = `# Knowledge: ${skill.name} (${skill.pluginName} plugin)\n\n${skillContent}`;

    // Tier 4: append references if requested
    if (options?.includeReferences && skill.referencePaths.length > 0) {
      output += "\n\n---\n# Reference Materials\n";
      for (const refPath of skill.referencePaths) {
        try {
          const refContent = readFileSync(refPath, "utf-8");
          const fileName = refPath.split(/[/\\]/).pop() ?? "reference.md";
          output += `\n---\n## ${fileName}\n\n${refContent}`;
        } catch {
          output += `\n---\n## ${refPath} (failed to read)\n`;
        }
      }
    } else if (skill.referencePaths.length > 0) {
      output += `\n\n---\nThis skill has ${skill.referencePaths.length} reference file(s) available. `;
      output += "Call load_knowledge again with include_references: true for detailed reference material.";
    }

    return { success: true, output };
  } catch (err) {
    return {
      success: false,
      output: `Failed to read skill "${skillName}": ${err}`,
    };
  }
}

// ─── Plugin listing ───────────────────────────────────────────────────

/**
 * List all loaded plugins and their skills.
 * Used by the list_knowledge tool.
 */
export function listPlugins(): Array<{
  name: string;
  description: string;
  skills: string[];
}> {
  const result: Array<{ name: string; description: string; skills: string[] }> =
    [];
  for (const [, plugin] of plugins) {
    result.push({
      name: plugin.name,
      description: plugin.description,
      skills: plugin.skills.map((s) => s.name),
    });
  }
  return result;
}

// ─── Tool definitions ─────────────────────────────────────────────────

/**
 * load_knowledge meta-tool — Tier 3/4 on-demand knowledge loading.
 *
 * IMPORTANT: This loads domain KNOWLEDGE, not tool CAPABILITIES.
 * The LLM gets reference material to reason with, not new tools to call.
 * The description is rebuilt after initPlugins() with actual skill names.
 */
export const LOAD_KNOWLEDGE_DEF: ToolDefinition = {
  name: "load_knowledge",
  description:
    "Load detailed domain expertise and methodology guides to inform your reasoning. " +
    "This does NOT add new tools — it gives you reference material. " +
    "Use when you need deeper guidance than the auto-loaded context provides.",
  input_schema: {
    type: "object" as const,
    properties: {
      skill: {
        type: "string",
        description:
          "The knowledge area to load (e.g. 'sql-queries', 'data-exploration')",
      },
      include_references: {
        type: "boolean",
        description:
          "Also load detailed reference materials (larger output). Default: false.",
      },
    },
    required: ["skill"],
  },
};

/**
 * list_knowledge meta-tool — discover available knowledge plugins.
 */
export const LIST_KNOWLEDGE_DEF: ToolDefinition = {
  name: "list_knowledge",
  description:
    "List all installed knowledge plugins and their available skills with descriptions.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};
