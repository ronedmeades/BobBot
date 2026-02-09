# Contributing to Bob

Thanks for wanting to help make Bob better! Here's how to get started.

## Quick Start

```bash
git clone https://github.com/ronedmeades/BobBot.git
cd BobBot
pnpm install
cp .env.example .env    # Add your API key
pnpm dev                # Start with hot reload
```

See [CLAUDE.md](./CLAUDE.md) for the full technical architecture.

## How to Contribute

### Report a Bug

1. Check [existing issues](https://github.com/ronedmeades/BobBot/issues) first
2. Open a new issue with:
   - What you expected vs what happened
   - Steps to reproduce
   - Your OS and Node.js version
   - Which LLM provider you're using

### Suggest a Feature

1. Post in `#feature-ideas` on [Discord](https://github.com/ronedmeades/BobBot) or open a GitHub Issue
2. Describe what Bob should do and why it's useful
3. We'll discuss the approach before you start coding

### Submit a Pull Request

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npx tsc --noEmit` — must pass with zero errors
4. Test manually with `pnpm dev`
5. Open a PR with a clear description of what and why

## Adding a New Skill

Bob's skill system is modular. Here's the pattern:

### 1. Create the skill file

Create `src/skills/your-skill.ts`:

```typescript
import type { ToolDefinition } from "../providers/types.js";

// Tool definitions — what the LLM sees
export const yourSkillToolDefinitions: ToolDefinition[] = [
  {
    name: "your_tool_name",
    description: "What this tool does — be specific, the LLM reads this",
    input_schema: {
      type: "object",
      properties: {
        param1: { type: "string", description: "What this param is for" },
      },
      required: ["param1"],
    },
  },
];

// Handler — what actually runs
export async function handleYourTool(
  input: Record<string, unknown>
): Promise<{ success: boolean; output: string }> {
  const param1 = input.param1 as string;

  try {
    // Do the thing
    return { success: true, output: "It worked!" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed: ${msg}` };
  }
}
```

### 2. Wire it up

**`src/agent/tools.ts`** — import and spread the definitions:
```typescript
import { yourSkillToolDefinitions } from "../skills/your-skill.js";

export const toolDefinitions: ToolDefinition[] = [
  // ... existing tools
  ...yourSkillToolDefinitions,
];
```

**`src/agent/tool-executor.ts`** — add a case to the switch:
```typescript
case "your_tool_name":
  return handleYourTool(input);
```

**`src/agent/tool-loader.ts`** — add a category (or add to an existing one):
```typescript
{
  name: "your_category",
  description: "What these tools do",
  keywords: ["keyword1", "keyword2"],
  toolNames: ["your_tool_name"],
},
```

### 3. Optional dependencies

If your skill needs an npm package that isn't always needed, lazy-load it:

```typescript
let myLib: typeof import("some-lib") | null = null;

async function loadMyLib() {
  if (!myLib) myLib = await import("some-lib");
  return myLib;
}
```

This keeps Bob's startup fast for users who don't need your skill.

## Code Style

- **TypeScript strict mode** — no `any` types (exception: lazy-loaded deps)
- **ESM modules** — `import`/`export`, not `require`
- **Tools return `{ success, output }`** — always, even on failure
- **No unnecessary dependencies** — prefer Node built-ins
- **Lazy-load optional deps** — don't slow down startup
- **Keep it simple** — no over-engineering, no premature abstractions

## Local-Only Skills

Want to build something personal that doesn't belong in the public repo? Put it in `local/skills/` — it's gitignored and auto-loaded at startup. Great for prototyping before submitting a PR.

## Questions?

- **Discord**: Join our community server
- **GitHub Issues**: [ronedmeades/BobBot/issues](https://github.com/ronedmeades/BobBot/issues)
