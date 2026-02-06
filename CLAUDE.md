# CLAUDE.md - Bob: Autonomous AI Agent

## Project Overview

Bob is an autonomous AI personal agent built from scratch. The idea: instead of downloading
something like OpenClaw, we build our own agent that lives on our machine, talks to us via
Telegram (and eventually phone), accepts tasks, works on them autonomously in the background,
and texts back when done.

This is an experimental project — exploring how far we can extend Claude's capabilities
as a general-purpose agent that isn't limited to a single folder or codebase.

### Inspiration: OpenClaw

We researched OpenClaw (formerly Clawdbot) — an open-source autonomous AI agent with 166k+
GitHub stars. We liked the concept but noted its major security issues (malicious marketplace
skills, RCE vulnerabilities, credential leaks). Bob takes the same idea but builds it from
scratch, focused and security-conscious — no open skill marketplace, all capabilities are
vetted first-party tools.

### Design Principles

- **Autonomous**: Accept a task, work in the background, report when done
- **Proactive**: Text the user with progress, results, or if something goes wrong
- **Extensible**: New capabilities added as skill modules
- **Secure**: Sandboxed execution, no blind trust of external data
- **Personal**: All user data stays local, never committed to repos

---

## Quick Start

```bash
git clone <repo-url>
cd bob
pnpm install
cp .env.example .env    # Fill in your API keys and owner info
pnpm dev                # Starts bot + dashboard with hot reload
```

### Environment Variables (create .env from .env.example)

```
ANTHROPIC_API_KEY=sk-ant-xxxxx      # From console.anthropic.com
TELEGRAM_BOT_TOKEN=123456:ABC-DEF   # From @BotFather on Telegram
OWNER_USER_ID=your-telegram-user-id # Your Telegram user ID
OWNER_NAME=YourName                 # How Bob addresses you
OWNER_NOTES=Optional context        # Anything Bob should know about you
DASHBOARD_PORT=3000                 # Optional, defaults to 3000
```

To create your own Telegram bot:
1. Message @BotFather on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token to your `.env`
4. Find your user ID by messaging @userinfobot on Telegram

On startup, Bob logs:
```
Starting Bob...
Dashboard: http://localhost:3000
Bob is online. Model: claude-sonnet-4-5-20250929
Waiting for Telegram messages...
```

---

## Tech Stack

### Dependencies
- **@anthropic-ai/sdk** — Claude API client
- **grammy** — Telegram Bot framework
- **dotenv** — Environment variable loading

### Dev Dependencies
- **typescript** — Strict TypeScript
- **tsx** — TypeScript execution with watch mode
- **vitest** — Test runner
- **@types/node** — Node.js type definitions

### Optional Dependencies (installed when needed)
- **sharp** — Image processing (required for image skills)

### Runtime
- **Node.js**: v22+
- **pnpm**: v10+
- **Platform**: Cross-platform (Windows, macOS, Linux)

---

## Project Structure

```
bob/
├── CLAUDE.md              # This file
├── .gitignore             # Standard ignores (node_modules, .env, dist, memory/, etc.)
├── .env.example           # Template for required environment variables
├── .env                   # YOUR config — never committed (gitignored)
├── package.json           # Project config, scripts, dependencies
├── tsconfig.json          # TypeScript config (strict, ES2022, NodeNext)
├── memory/                # Runtime user data — never committed (gitignored)
│   ├── user-*.json        # Per-user conversation history
│   ├── profile-*.json     # User profiles (name, preferences, notes)
│   └── notes/             # Named notes saved by Bob
└── src/
    ├── index.ts           # Entry point — starts bot + dashboard, seeds owner profile
    ├── config.ts          # Loads .env, validates required keys
    ├── agent/
    │   ├── core.ts        # THE BRAIN — agentic loop (Claude API + tool dispatch + events)
    │   ├── memory.ts      # Per-user conversation history + notes (JSON/markdown files)
    │   ├── tools.ts       # Tool definitions (what Claude can choose to use)
    │   └── tool-executor.ts  # Tool dispatch — routes tool calls to skill handlers
    ├── bot/
    │   └── telegram.ts    # Telegram bot: message handling, /task, /status, lifecycle
    ├── dashboard/
    │   ├── events.ts      # Global event bus — typed EventEmitter + 50-event ring buffer
    │   ├── server.ts      # HTTP server (Node built-in) — API routes + SSE streaming
    │   └── public/
    │       └── index.html # Single-file dashboard UI (vanilla HTML/CSS/JS, dark theme)
    ├── skills/
    │   ├── image-processing.ts  # Resize, crop, convert, watermark, thumbnails (sharp)
    │   ├── ebay-listing.ts      # eBay API: create listings, upload images, search categories
    │   └── batch-lister.ts      # Orchestrator: batch process images → create eBay listings
    └── tasks/
        ├── types.ts       # Task state types (pending/running/completed/failed)
        └── runner.ts      # Background task execution + user notification + events
```

---

## Architecture

### Two Interaction Modes

1. **Direct chat (Telegram)** — User sends a message, Bob responds inline.
2. **Direct chat (Dashboard)** — Browser chat panel at `http://localhost:3000`.

Both share conversation history via the owner's user ID.

3. **Background task** — User sends `/task <description>` via Telegram, Bob immediately
   replies "On it", runs the work asynchronously, and texts back when done.

### Agent Loop (src/agent/core.ts)

```
1. Receive user message (from Telegram or dashboard)
2. Emit "message:in" event to event bus
3. Load conversation history from memory (last 20 messages for context)
4. Send to Claude API with system prompt + tool definitions
5. If Claude wants to use tools → emit "tool:call", execute, emit "tool:result", loop
6. Repeat until Claude gives a final text response (max 20 tool rounds)
7. Save assistant response to memory
8. Emit "message:out" event
9. Return response
```

### Available Tools (21 total)

**Core Tools:**
| Tool | What It Does |
|------|-------------|
| `fetch_url` | HTTP requests (GET/POST/PUT/DELETE) with custom headers/body |
| `read_file` | Read local files |
| `write_file` | Write files (creates directories automatically) |
| `list_directory` | List contents of a directory |
| `run_command` | Execute shell commands (with timeout) |
| `save_note` | Save a named note to persistent memory |
| `load_note` | Load a previously saved note |
| `list_notes` | List all saved notes |
| `update_user_profile` | Update user name, preferences, or notes |

**Image Processing Skills** (requires `sharp`):
| Tool | What It Does |
|------|-------------|
| `batch_resize_images` | Resize images to target dimensions (e.g. 1600px for eBay) |
| `convert_image_format` | Convert between PNG, JPG, WebP |
| `generate_thumbnails` | Create gallery thumbnail versions |
| `add_watermark` | Overlay text watermark on images |
| `auto_crop` | Trim whitespace/borders from images |

**eBay Listing Skills** (requires eBay API credentials):
| Tool | What It Does |
|------|-------------|
| `create_ebay_listing` | Create a fixed-price listing via Inventory API |
| `upload_ebay_image` | Upload images to eBay Picture Service |
| `search_ebay_category` | Find category IDs by keyword |
| `generate_listing_content` | Prep image for AI-powered listing generation |
| `get_ebay_listing_status` | Check listing status by SKU/ID |

**Batch Workflow:**
| Tool | What It Does |
|------|-------------|
| `batch_list_posters` | End-to-end: scan folder → resize → upload → list on eBay |
| `batch_list_status` | Check progress of a running batch job |

### Event Bus (src/dashboard/events.ts)

Typed EventEmitter singleton. All modules emit events, the SSE endpoint streams them
to the dashboard in real-time. Maintains a 50-event ring buffer for history on connect.

| Event | Data | Emitted by |
|-------|------|-----------|
| `tool:call` | tool, input, userId | core.ts |
| `tool:result` | tool, success, output | core.ts |
| `message:in` | userId, text, source | core.ts |
| `message:out` | userId, text | core.ts |
| `task:update` | taskId, status, description | runner.ts |
| `bot:status` | running | telegram.ts, index.ts |

### Dashboard API (src/dashboard/server.ts)

Node built-in `http.createServer()`. No frameworks. Port 3000 (configurable).

| Method | Path | What it does |
|--------|------|-------------|
| GET | `/` | Serve dashboard HTML |
| GET | `/api/status` | Bot status, uptime, model info |
| GET | `/api/tasks` | All tasks for the owner |
| GET | `/api/history` | Last 20 conversation entries |
| GET | `/api/events` | SSE stream — real-time events |
| POST | `/api/chat` | Send message to Bob, get response |
| POST | `/api/bot/start` | Start Telegram polling |
| POST | `/api/bot/stop` | Stop Telegram polling |

### Memory System (src/agent/memory.ts)

- Per-user conversation history in `memory/user-{id}.json`
- Keeps last 100 messages per user (auto-trimmed)
- Named notes as markdown files
- User profiles in `memory/profile-{id}.json`
- **All memory is local-only** — gitignored, never committed

---

## Development

```bash
pnpm install          # Install dependencies
pnpm dev              # Run in dev mode with hot reload (tsx watch)
pnpm build            # Compile TypeScript to dist/
pnpm start            # Run compiled output
pnpm test             # Run tests (vitest)
```

### Adding New Skills

1. Create a new file in `src/skills/`
2. Export tool definitions (Anthropic.Tool[]) and handler functions
3. Import and spread the definitions into `src/agent/tools.ts`
4. Import and wire handlers into `src/agent/tool-executor.ts`
5. Skills that need optional dependencies should lazy-load them

---

## Conventions

- Strict TypeScript, no `any` types (exception: lazy-loaded optional deps)
- ESM modules (`"type": "module"` in package.json)
- Tools are pure functions that return `{ success: boolean, output: string }`
- All external API calls go through the tool system (never inline)
- Agent decisions are logged to console for debugging
- All significant actions emit events to the event bus for dashboard visibility
- Tasks always produce a report, even on failure
- No new dependencies unless absolutely necessary — prefer Node built-ins
- **Personal data stays local** — .env, memory/, profiles are all gitignored

---

## Security

- No open skill/plugin marketplace — all skills are vetted first-party code
- Credentials stored in `.env` (gitignored, never committed)
- User memory and profiles stored locally in `memory/` (gitignored)
- Tool execution has timeouts and output size limits
- The agent is sandboxed to the tools it's given — no arbitrary code execution
  beyond the `run_command` tool (which has configurable timeout)
- Prompt injection awareness — external data is never blindly trusted

---

## Future Roadmap

### Phase 2: Medical API Explorer
- FHIR-aware tools for medical API conventions
- Resource type enumeration and download
- Cross-format normalization (FHIR R4 JSON as canonical)

### Phase 3: Enhanced Capabilities
- Playwright browser automation
- MCP (Model Context Protocol) client for plug-and-play tool servers
- BullMQ + Redis for persistent task queue
- SQLite for task history and structured memory

### Phase 4: Voice
- Telegram voice messages via Whisper transcription
- Twilio for phone calls
- Text-to-speech for responses

### Phase 5: Broader Agent Capabilities
- Email (Gmail API / SMTP)
- Calendar management
- Scheduled/cron tasks
- Web monitoring (watch URLs, APIs, prices)
- Smart home (Home Assistant)

---

## Notes

- This is an experimental project
- Security is a priority — no open marketplaces, no blind trust
- Start simple, add capabilities incrementally
- The architecture supports any task type — skills are modular
- The agent is not limited to this folder — it can access anything Node.js has permissions for
