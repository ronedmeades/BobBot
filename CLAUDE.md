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
HA_URL=http://192.168.1.100:8123    # Home Assistant URL (optional)
HA_TOKEN=your_long_lived_token      # HA long-lived access token (optional)
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

## Standard Operating Procedure

Every change follows these six stages:

1. **Agree on the task** - Discuss intent. Claude enters plan mode for anything non-trivial.
2. **Approve the plan** - User reviews planned changes and approves before any code is written.
3. **Create a feature branch** - Branch from main (e.g. `feature/geometry-book-1`). Never work directly on main.
4. **Implement and commit** - Make changes and commit to the feature branch.
5. **Review and test** - User reviews with `git diff main`, builds, and tests.
6. **User merges** - Only the user decides when to merge to main.

Rules:
- Never push to remote without explicit instruction
- Never commit to main directly
- Never skip plan mode for non-trivial changes
- Never amend previous commits unless explicitly asked
- Always wait for user approval before writing code

Shortcuts:
- **"ship it public"** — Commit all staged changes to main and push to GitHub (combines commit, merge to main, and git push in one step)

---

## Tech Stack

### Dependencies
- **@anthropic-ai/sdk** — Claude API client
- **@modelcontextprotocol/sdk** — MCP client (stdio + SSE transports)
- **better-sqlite3** — SQLite database (conversation history, tool analytics, event log)
- **grammy** — Telegram Bot framework
- **dotenv** — Environment variable loading

### Dev Dependencies
- **typescript** — Strict TypeScript
- **tsx** — TypeScript execution with watch mode
- **vitest** — Test runner
- **@types/node** — Node.js type definitions

### Optional Dependencies (installed when needed)
- **sharp** — Image processing (required for image skills)
- **pdf-lib** — PDF form parsing, filling, and invoice generation
- **exceljs** — Excel/spreadsheet reading
- **playwright** — Browser automation (Chromium, lazy-launched)
- **edge-tts** — Text-to-speech via Microsoft Edge (free, no API key)
- **fluent-ffmpeg** + **ffmpeg-static** — Audio format conversion (MP3→OGG/Opus for Telegram)

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
├── medical-records-research-summary.txt  # Vitalos research — kept locally, gitignored
├── package.json           # Project config, scripts, dependencies
├── tsconfig.json          # TypeScript config (strict, ES2022, NodeNext)
├── vitest.config.ts       # Test runner config (ESM, node environment)
├── tests/                 # Test suite (160 tests across 9 files)
│   ├── config.test.ts             # Config defaults, validateConfig
│   ├── agent/
│   │   ├── core.test.ts           # Hallucination guard (detectUnusedActions)
│   │   ├── tool-loader.test.ts    # Category-based tool selection, keyword matching
│   │   └── plugin-loader.test.ts  # YAML frontmatter parsing, keyword extraction
│   ├── skills/
│   │   ├── reminders.test.ts      # Natural language time parsing, snooze, formatting
│   │   └── form-filler.test.ts    # Field normalization, fuzzy vault matching
│   ├── tasks/
│   │   ├── busy-state.test.ts     # State transitions, preemption lifecycle
│   │   └── escalation.test.ts     # Channel filtering, dedup, interaction tracking
│   └── a2a/
│       └── public-skills.test.ts  # Three-tier security boundaries (SAFE/DATA/BLOCKED)
├── knowledge-work-plugins-main/  # Anthropic knowledge-work plugins (Apache 2.0)
│   ├── data/              # SQL, visualization, dashboards, statistics (7 skills)
│   ├── finance/           # Journal entries, reconciliation, statements (6 skills)
│   ├── sales/             # Prospecting, pipeline, outreach (6 skills)
│   ├── legal/             # Contracts, NDAs, compliance (6 skills)
│   ├── marketing/         # Content, campaigns, brand voice (5 skills)
│   ├── product-management/  # PRDs, roadmaps, stakeholder comms (6 skills)
│   ├── customer-support/  # Tickets, KB articles, escalation (5 skills)
│   ├── enterprise-search/ # Cross-tool search, synthesis (3 skills)
│   ├── productivity/      # Task management, memory (2 skills)
│   ├── bio-research/      # Life sciences R&D (5 skills)
│   └── cowork-plugin-management/  # Plugin creation/customization (2 skills)
├── local/                 # Local-only skills and personal data (gitignored)
│   └── skills/            # Hot-loadable skill modules (auto-discovered at startup)
├── memory/                # Runtime user data — never committed (gitignored)
│   ├── context.md         # Owner context hot cache (two-tier memory, ~80 lines)
│   ├── glossary.md        # Full decoder ring — people, terms, projects, shorthand
│   ├── user-*.json        # Per-user conversation history
│   ├── profile-*.json     # User profiles (name, preferences, notes)
│   ├── notes/             # Named notes saved by Bob
│   ├── calendar.json      # Calendar events and reminders
│   ├── captures.json      # Quick capture entries
│   ├── contacts.json      # Contacts / address book
│   ├── expenses.json      # Expense tracking records
│   ├── inventory.json     # Indexed inventory data
│   ├── invoices.json      # Invoice metadata (PDFs in invoices/)
│   ├── invoices/          # Generated invoice PDFs
│   ├── reminders.json     # Quick reminders with snooze
│   ├── screenshots/       # Browser automation screenshots
│   ├── task-queue.json    # Background task queue (persistent)
│   ├── vault.json         # Personal data vault for form filling
│   ├── a2a-peers.json     # A2A peer registry (when A2A enabled)
│   ├── a2a-audit.json     # A2A interaction audit log
│   ├── a2a-tasks.json     # A2A protocol task state
│   ├── a2a-approvals.json # A2A pending approval requests
│   ├── mcp-servers.json   # MCP server configs (persistent, auto-connect on startup)
│   └── bob.db             # SQLite database (conversations, tool calls, events)
└── src/
    ├── index.ts           # Entry point — starts bot + dashboard + scheduler, seeds owner profile
    ├── config.ts          # Loads .env, validates required keys, multi-provider support
    ├── agent/
    │   ├── core.ts        # THE BRAIN — agentic loop (LLM API + tool dispatch + events)
    │   ├── memory.ts      # Per-user conversation history + notes + owner context (JSON/markdown files)
    │   ├── tools.ts       # Tool definitions (what the LLM can choose to use)
    │   ├── tool-executor.ts  # Tool dispatch — routes tool calls to skill handlers
    │   ├── tool-loader.ts    # Category-based tool selection (keyword matching)
    │   └── plugin-loader.ts  # Knowledge plugin loader (Anthropic format, tiered injection)
    ├── bot/
    │   └── telegram.ts    # Telegram bot: message handling, /task, /status, lifecycle
    ├── dashboard/
    │   ├── events.ts      # Global event bus — typed EventEmitter + 50-event ring buffer
    │   ├── server.ts      # HTTP server (Node built-in) — API routes + SSE + image serving
    │   └── public/
    │       └── index.html # Single-file dashboard UI (vanilla HTML/CSS/JS, dark theme, inline images)
    ├── providers/
    │   ├── types.ts       # Provider-agnostic LLM interfaces (ToolDefinition, ChatOptions, VisionOptions)
    │   ├── factory.ts     # Provider factory — creates cached provider instances
    │   ├── anthropic.ts   # Anthropic/Claude provider
    │   ├── openai.ts      # OpenAI provider
    │   └── gemini.ts      # Google Gemini provider
    ├── db/
    │   ├── database.ts    # SQLite singleton manager (lazy-load, WAL mode, init/close)
    │   ├── migrations.ts  # Versioned schema migrations via PRAGMA user_version
    │   ├── queries.ts     # Typed query wrappers (prepared statements, no ORM)
    │   └── import.ts      # One-time JSON→SQLite migration for existing history
    ├── mcp/
    │   ├── types.ts       # MCP type definitions (McpServerConfig, McpServerState, McpToolInfo)
    │   └── client.ts      # MCP client manager: connect/disconnect, tool discovery, auto-reconnect, execution
    ├── skills/
    │   ├── image-processing.ts  # Resize, crop, convert, watermark, thumbnails (sharp)
    │   ├── ebay-listing.ts      # eBay API: listings, images, categories, bulk price updates
    │   ├── batch-lister.ts      # Vision-powered batch poster→eBay listing workflow
    │   ├── backup.ts            # Backup/restore Bob to external drive
    │   ├── scheduler.ts         # Cron-like scheduled/recurring tasks
    │   ├── gmail.ts             # Gmail: check, read, send, search, summarize + Google Contacts import
    │   ├── web-monitor.ts       # URL change detection, keyword tracking (HN/Reddit)
    │   ├── vision.ts            # Claude image analysis, poster-to-listing
    │   ├── form-filler.ts       # Personal data vault with fuzzy field matching
    │   ├── task-manager.ts      # Background task CRUD (create/list/cancel/priority/pause)
    │   ├── inventory.ts         # Image display, CSV/spreadsheet reading, inventory index+search
    │   ├── pdf-forms.ts         # PDF form parsing and auto-filling from vault (pdf-lib)
    │   ├── calendar.ts          # Calendar events, reminders, recurring event advancement
    │   ├── social-media.ts      # Platform-optimized social post generation + hashtags
    │   ├── contacts.ts          # Address book with fuzzy search, tags, relationships
    │   ├── reminders.ts         # Quick reminders with natural language time parsing + snooze
    │   ├── expenses.ts          # Expense tracking, category breakdown, CSV/JSON export
    │   ├── invoices.ts          # PDF invoice generation (pdf-lib), pulls from vault + contacts
    │   ├── summarizer.ts        # LLM-powered document and URL summarization
    │   ├── file-organizer.ts    # Scan, organize by type/date, find duplicates
    │   ├── quick-capture.ts     # Tagged quick capture with fuzzy search
    │   ├── weather.ts           # Weather and forecasts via wttr.in (no API key)
    │   ├── translation.ts       # LLM-powered translation and language detection
    │   ├── browser.ts           # Playwright browser automation (Chromium, lazy-launched)
    │   ├── phone.ts             # Twilio phone calls & SMS (owner-only, no new deps)
    │   ├── google-calendar.ts   # Google Calendar API (OAuth2, same client as Gmail)
    │   ├── env-manager.ts       # Safely set/list .env vars (allowlisted keys only)
    │   ├── standing-rules.ts    # Persistent marketplace monitoring rules (hourly scheduler)
    │   ├── marketplace.ts       # Unified marketplace tools (orders, messages, fulfillment)
    │   ├── home-assistant.ts     # Home Assistant smart home (REST + WebSocket, 15 tools, device monitors)
    │   ├── voice.ts             # Voice: Whisper STT + edge-tts TTS (Telegram voice messages)
    │   ├── a2a-client.ts        # A2A client tools (discover, send, peers, trust, audit)
    │   ├── mcp-manager.ts       # MCP server management tools (add, remove, list, reconnect, toggle)
    │   ├── analytics.ts         # Search history, tool stats, event log (SQLite-powered)
    │   └── local-loader.ts      # Auto-discover and hot-load skills from local/skills/
    ├── a2a/
    │   ├── types.ts       # A2A protocol interfaces (PeerAgent, AgentCard, JSON-RPC, etc.)
    │   ├── registry.ts    # Peer registry + per-peer tokens + trust tiers + rate limits
    │   ├── audit.ts       # Rolling audit log (500 entries, 30-day cleanup)
    │   ├── approvals.ts   # Owner approval flow (task + handshake requests)
    │   ├── public-skills.ts # Three-tier security boundary (safe/data/blocked tools)
    │   ├── tasks.ts       # A2A protocol task state management
    │   ├── sandbox.ts     # Sandboxed execution for external requests
    │   └── server.ts      # HTTP handler (Agent Card, JSON-RPC, handshake, ping)
    ├── marketplace/
    │   ├── types.ts       # MarketplaceAdapter interface, Order, Message, etc.
    │   ├── registry.ts    # Adapter registry + local adapter discovery
    │   └── adapters/
    │       ├── ebay.ts    # eBay: Fulfillment API (orders) + Trading API (messages)
    │       ├── etsy.ts    # Etsy: Receipts API (orders), v3 REST
    │       ├── poshmark.ts # Poshmark: stub (no public API)
    │       └── depop.ts   # Depop: stub (no public API)
    └── tasks/
        ├── types.ts       # Task state types (pending/running/completed/failed)
        ├── runner.ts      # Background task execution + user notification + events
        ├── worker.ts      # Autonomous task worker loop (30s polling, step-based execution)
        ├── busy-state.ts  # Prevents concurrent agent loops
        ├── escalation.ts  # Multi-channel notification chains (Telegram → SMS → call) with auto-acknowledge
        └── scheduler.ts   # Hourly scheduler: auto-backup, scheduled tasks, web monitors, calendar reminders, standing rules
```

---

## Architecture

### Two Interaction Modes

1. **Direct chat (Telegram)** — User sends a message, Bob responds inline.
2. **Direct chat (Dashboard)** — Browser chat panel at `http://localhost:3000`.

Both share conversation history via the owner's user ID.

3. **Background task** — User sends `/task <description>` via Telegram, Bob immediately
   replies "On it", runs the work asynchronously, and texts back when done.

### System Prompt Guardrails (src/agent/core.ts)

Bob's `buildSystemPrompt()` injects several runtime guardrails:

- **Platform awareness** — Detects `process.platform` and tells Bob to use Windows commands (findstr, PowerShell) instead of Unix (grep, ls, cat). Also reminds that the project is ESM (`import`, not `require`).
- **Tool usage rules** — CRITICAL section forbidding hallucinated actions (must actually call tools, not just describe them). Covered: calls, SMS, calendar, reminders, emails.
- **No test file litter** — Bob must use `node -e "..."` or skill tools, not create temp scripts in the project root.
- **Credential guidance** — Bob cannot read `.env` directly. Must use `list_env_keys` to check and `set_env_var` to update.
- **Hallucination guard** — `detectUnusedActions()` catches claims without tool calls, re-enters agent loop with correction prompt.

### Agent Loop (src/agent/core.ts)

```
1. Receive user message (from Telegram or dashboard)
2. Emit "message:in" event to event bus
3. Load conversation history from memory (last 20 messages for context)
4. Load owner context (memory/context.md) + build system prompt + select plugin knowledge + select tools
5. Send to Claude API with system prompt + tool definitions
6. If Claude wants to use tools → emit "tool:call", execute, emit "tool:result", loop
7. Repeat until Claude gives a final text response (max 20 tool rounds)
8. Save assistant response to memory
9. Emit "message:out" event
10. Return response
```

### Available Tools (~156 built-in across 33 skill modules + dynamic MCP server tools + 53 knowledge skills)

**Core Tools (13):**
| Tool | What It Does |
|------|-------------|
| `fetch_url` | HTTP requests (GET/POST/PUT/DELETE) with custom headers/body |
| `read_file` | Read local files (with credential blocklist protection) |
| `write_file` | Write files (creates directories automatically, credential paths blocked — use `set_env_var`) |
| `list_directory` | List contents of a directory |
| `run_command` | Execute shell commands (with timeout) |
| `save_note` | Save a named note to persistent memory |
| `load_note` | Load a previously saved note |
| `list_notes` | List all saved notes |
| `update_user_profile` | Update user name, preferences, or notes |
| `set_personality` | Switch personality preset (default, tars, professional, minimal) |
| `install_skill` | Hot-install a new skill from local/skills/ (no restart needed) |
| `load_knowledge` | Load domain expertise from a knowledge plugin (SQL guides, accounting standards, etc.) |
| `list_knowledge` | List all installed knowledge plugins and their available skills |

**Image Processing (5)** — requires `sharp`:
| Tool | What It Does |
|------|-------------|
| `batch_resize_images` | Resize images to target dimensions (e.g. 1600px for eBay) |
| `convert_image_format` | Convert between PNG, JPG, WebP |
| `generate_thumbnails` | Create gallery thumbnail versions |
| `add_watermark` | Overlay text watermark on images |
| `auto_crop` | Trim whitespace/borders from images |

**eBay Listing (8)** — requires eBay API credentials (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, `EBAY_ENVIRONMENT`, optional `EBAY_RUNAME` for OAuth setup):
| Tool | What It Does |
|------|-------------|
| `create_ebay_listing` | Create a fixed-price listing via Inventory API |
| `upload_ebay_image` | Upload images to eBay Picture Service |
| `search_ebay_category` | Find category IDs by keyword |
| `generate_listing_content` | Prep image for AI-powered listing generation |
| `get_ebay_listing_status` | Check listing status by SKU/ID |
| `get_seller_listings` | List all active seller listings |
| `update_ebay_listing` | Update an existing listing (price, title, etc.) |
| `bulk_update_prices` | Batch price updates across multiple listings |

**Batch Poster Workflow (4):**
| Tool | What It Does |
|------|-------------|
| `batch_list_posters` | End-to-end: scan folder → vision analyze → create eBay listings |
| `batch_list_status` | Check progress of a running batch job |
| `review_batch_samples` | Review AI-generated listing samples before publishing |
| `approve_batch` | Approve and publish reviewed batch listings |

**Vision & Image Analysis (2):**
| Tool | What It Does |
|------|-------------|
| `analyze_image` | AI-powered image description, text extraction, object identification |
| `analyze_poster_for_listing` | Generate structured eBay listing content from a poster image |

**Backup & Restore (3):**
| Tool | What It Does |
|------|-------------|
| `backup_bob` | Back up Bob's memory, config, and code to external drive |
| `restore_bob` | Restore from a backup |
| `list_backups` | List available backup snapshots |

**Scheduled Tasks (4):**
| Tool | What It Does |
|------|-------------|
| `add_scheduled_task` | Create a recurring or one-shot scheduled task |
| `remove_scheduled_task` | Delete a scheduled task |
| `list_scheduled_tasks` | List all scheduled tasks |
| `run_scheduled_task` | Manually trigger a scheduled task |

**Gmail & Google Contacts (7)** — requires GMAIL_* env vars:
| Tool | What It Does |
|------|-------------|
| `check_email` | Check for new/unread emails |
| `read_email` | Read a specific email by ID |
| `send_email` | Send an email |
| `search_email` | Search emails by query |
| `get_email_summary` | Get a summary of recent emails |
| `import_google_contacts` | Import Google contacts into Bob's address book (dedup by email) |
| `list_google_contacts` | Preview Google contacts without importing |

**Web Monitoring (5):**
| Tool | What It Does |
|------|-------------|
| `watch_url` | Monitor a URL for content changes |
| `watch_keywords` | Track keywords on HN, Reddit, or custom sources |
| `list_watches` | List all active watches |
| `remove_watch` | Stop watching a URL/keyword |
| `check_watches_now` | Manually trigger all watch checks |

**Form Filling & Personal Data Vault (6):**
| Tool | What It Does |
|------|-------------|
| `save_personal_data` | Save personal info to the vault (name, address, SSN, etc.) |
| `load_personal_data` | Load data from the vault |
| `list_personal_data` | List all vault categories |
| `delete_personal_data` | Remove data from the vault |
| `fill_form_fields` | Auto-fill form fields using fuzzy matching against vault |
| `suggest_form_mapping` | Preview how vault data maps to form fields |

**Background Task Management (6):**
| Tool | What It Does |
|------|-------------|
| `create_background_task` | Create an autonomous background task |
| `list_background_tasks` | List all tasks and their status |
| `get_task_details` | Get detailed info on a specific task |
| `cancel_background_task` | Cancel a running/pending task |
| `update_task_priority` | Change task priority |
| `pause_resume_task` | Pause or resume a task |

**Inventory & Data (6):**
| Tool | What It Does |
|------|-------------|
| `show_image` | Display an image inline in chat (dashboard renders as thumbnail) |
| `read_csv` | Parse and display CSV file contents |
| `read_spreadsheet` | Read Excel/Numbers spreadsheets (exceljs) |
| `index_inventory` | Build searchable index from CSV, spreadsheet, or image folder |
| `search_inventory` | Fuzzy search the inventory index |
| `get_inventory_stats` | Summary stats on indexed inventory |

**PDF Forms (2)** — requires `pdf-lib`:
| Tool | What It Does |
|------|-------------|
| `parse_pdf_form` | Extract all fillable field names, types, and current values |
| `fill_pdf_form` | Auto-fill PDF from vault + explicit overrides, save filled copy |

**Calendar & Events (5):**
| Tool | What It Does |
|------|-------------|
| `add_event` | Create a calendar event (deadline, meeting, appointment) |
| `list_events` | List upcoming events with filtering |
| `update_event` | Modify an existing event |
| `remove_event` | Delete an event |
| `complete_event` | Mark done (recurring events advance to next occurrence) |

**Google Calendar (6)** — requires Google Calendar API credentials:
| Tool | What It Does |
|------|-------------|
| `list_google_calendars` | List all calendars in the user's Google account |
| `list_google_events` | List upcoming events with date range and search filters |
| `get_google_event` | Get full event details (attendees, recurrence, reminders) |
| `create_google_event` | Create event with attendees, location, recurrence, reminders |
| `update_google_event` | Modify an existing Google Calendar event |
| `delete_google_event` | Delete an event from Google Calendar |

**Social Media (2):**
| Tool | What It Does |
|------|-------------|
| `generate_social_post` | Generate platform-optimized posts (LinkedIn, Facebook, Instagram, Twitter/X) |
| `suggest_social_hashtags` | Generate relevant hashtags tailored to each platform |

**Contacts / Address Book (6):**
| Tool | What It Does |
|------|-------------|
| `add_contact` | Create a contact (name, email, phone, company, relationship, tags) |
| `search_contacts` | Fuzzy search by name, company, email, or tag |
| `get_contact` | Get full contact details by ID |
| `update_contact` | Modify contact fields |
| `delete_contact` | Remove a contact |
| `list_contacts` | List all or filtered contacts (by tag, relationship) |

**Reminders (4):**
| Tool | What It Does |
|------|-------------|
| `set_reminder` | Create a reminder with natural language time ("in 2 hours", "tomorrow morning") |
| `list_reminders` | List active reminders |
| `snooze_reminder` | Snooze a reminder for a duration (default: 1 hour) |
| `dismiss_reminder` | Dismiss/complete a reminder |

**Expense Tracking (5):**
| Tool | What It Does |
|------|-------------|
| `add_expense` | Log an expense (amount, category, vendor, receipt) |
| `list_expenses` | List expenses with date/category filters |
| `get_expense_summary` | Totals by category for a period (month/quarter/year) |
| `delete_expense` | Remove an expense |
| `export_expenses` | Export to CSV or JSON file |

**Invoices (3)** — requires `pdf-lib`:
| Tool | What It Does |
|------|-------------|
| `create_invoice` | Generate a PDF invoice (pulls sender from vault, client from contacts) |
| `list_invoices` | List previously generated invoices |
| `get_invoice` | Get invoice details by ID or number |

**Document Summarizer (2):**
| Tool | What It Does |
|------|-------------|
| `summarize_document` | Summarize a local file (brief/detailed/bullets style) |
| `summarize_url` | Fetch a URL and summarize its content |

**File Organizer (3):**
| Tool | What It Does |
|------|-------------|
| `scan_folder` | Scan and categorize files by type, date, size |
| `organize_files` | Move files into organized subfolders (by_type or by_date, dry_run by default) |
| `find_duplicates` | Find duplicate files by name and size |

**Quick Capture (4):**
| Tool | What It Does |
|------|-------------|
| `capture` | Quick capture text, links, ideas, todos, or snippets with tags |
| `list_captures` | List captures with type/tag filters |
| `search_captures` | Fuzzy search through all captures |
| `delete_capture` | Remove a capture |

**Weather (2)** — uses wttr.in, no API key:
| Tool | What It Does |
|------|-------------|
| `get_weather` | Current weather for any location |
| `get_forecast` | Multi-day forecast (1–3 days) |

**Translation (2):**
| Tool | What It Does |
|------|-------------|
| `translate_text` | Translate text between languages (LLM-powered) |
| `detect_language` | Identify the language of text |

**Browser Automation (6)** — requires `playwright`:
| Tool | What It Does |
|------|-------------|
| `browse_url` | Navigate to URL in Chromium, return page text + optional screenshot |
| `click_element` | Click an element by CSS selector |
| `type_into` | Type text into an input field |
| `extract_content` | Extract text, HTML, or attributes from elements |
| `take_screenshot` | Screenshot the current page (viewport or full page) |
| `close_browser` | Close the browser instance |

**Phone Calls & SMS (3)** — requires Twilio account:
| Tool | What It Does |
|------|-------------|
| `call_owner` | Outbound TTS phone call to owner via Twilio (configurable voice) |
| `send_sms` | Send SMS text message to owner |
| `get_call_status` | Check call progress/status by Call SID |

**Marketplace Engine (10)** — cross-platform (eBay, Etsy, Poshmark, Depop + local adapters):
| Tool | What It Does |
|------|-------------|
| `marketplace_list_platforms` | List registered platforms and config status |
| `marketplace_test_connection` | Test API connectivity for a platform |
| `marketplace_get_orders` | Get orders from one or all platforms (filter by status, date) |
| `marketplace_get_order` | Get detailed order info |
| `marketplace_ship_order` | Mark order shipped with carrier + tracking |
| `marketplace_get_messages` | Get buyer messages from one or all platforms |
| `marketplace_send_message` | Send message to buyer through marketplace |
| `marketplace_order_summary` | Dashboard: order counts by platform and status |
| `marketplace_get_unshipped` | Quick view of all orders awaiting shipment |
| `marketplace_bulk_ship` | Mark multiple orders as shipped at once |

**Environment Management (2):**
| Tool | What It Does |
|------|-------------|
| `set_env_var` | Safely add/update a single env var in .env (allowlisted keys only, hot-reloads into process.env) |
| `list_env_keys` | Show which env vars are set vs missing (never reveals values, includes per-category usage hints) |

**Standing Rules — Marketplace Monitoring (4):**
| Tool | What It Does |
|------|-------------|
| `create_standing_rule` | Create a persistent monitoring rule (unshipped orders, new orders, messages, daily summary, weekly insights) |
| `list_standing_rules` | List all rules with status, last triggered, trigger count |
| `update_standing_rule` | Modify params, enable/disable, change notification channels |
| `remove_standing_rule` | Delete a monitoring rule |

**Home Assistant — Smart Home (15)** — requires `HA_TOKEN`:
| Tool | What It Does |
|------|-------------|
| `ha_get_state` | Get state + attributes of a single entity |
| `ha_get_all_states` | List all entities grouped by domain, optional filter |
| `ha_call_service` | Call any HA service (light/turn_on, climate/set_temperature, etc.) |
| `ha_toggle` | Toggle an entity on/off |
| `ha_set_state` | Quick on/off for common entities |
| `ha_list_scenes` | List available scenes |
| `ha_activate_scene` | Activate a scene (movie mode, bedtime, etc.) |
| `ha_list_automations` | List automations with enabled/disabled status |
| `ha_toggle_automation` | Enable/disable an automation |
| `ha_get_history` | State change history for an entity over time |
| `ha_get_services` | List available services for a domain |
| `ha_system_info` | HA version, location, timezone, components |
| `ha_watch_device` | Create persistent monitor rule (alert on state condition) |
| `ha_list_watches` | List active device monitors |
| `ha_remove_watch` | Remove a device monitor |

**A2A Client — Agent-to-Agent Communication (8)** — requires `A2A_ENABLED=true`:
| Tool | What It Does |
|------|-------------|
| `discover_agent` | Fetch Agent Card from URL, initiate handshake or open connection |
| `send_to_agent` | Send message/task to a known peer via JSON-RPC |
| `list_peers` | List all peers with trust tier, presence, and activity |
| `get_peer_details` | Full peer details (skills, budget, rate limits, recent audit) |
| `set_peer_trust` | Change trust tier (blocked/manual/trusted/budget-capped) + budget/rate config |
| `remove_peer` | Remove peer from registry |
| `a2a_audit_log` | View A2A interaction history with cost tracking |
| `approve_a2a_request` | Approve/reject pending task or handshake requests |

**MCP Server Management (6):**
| Tool | What It Does |
|------|-------------|
| `mcp_add_server` | Connect to an MCP server (stdio subprocess or SSE HTTP). Tools become available as `{server}_{tool}` |
| `mcp_remove_server` | Disconnect and remove an MCP server |
| `mcp_list_servers` | List all configured servers with status and tool count |
| `mcp_list_tools` | List all tools from MCP servers (optionally filtered by server) |
| `mcp_reconnect` | Reconnect to one or all MCP servers |
| `mcp_toggle_server` | Enable/disable a server without removing its config |

**Dynamic MCP Tools** — any tools from connected MCP servers are available with `{server}_{tool}` prefix.

**Analytics & History (5)** — requires SQLite (better-sqlite3):
| Tool | What It Does |
|------|-------------|
| `search_history` | Search past conversations by keyword, date range |
| `get_tool_stats` | Tool usage statistics: most used, success rates, avg duration |
| `get_event_log` | Query persistent event log by type and time range |
| `search_tasks` | Search background task history by keyword, status, date range |
| `get_task_audit` | Full audit trail for a task: every step, prompt, response, tools, timing |

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
| `a2a:request` | peerId, peerName, method, approved | server.ts (a2a) |
| `a2a:response` | peerId, taskId, state, costUsd | server.ts (a2a) |
| `a2a:approval` | requestId, peerName, description, status, type | server.ts (a2a) |
| `a2a:peer` | peerId, peerName, action | server.ts (a2a) |
| `mcp:connect` | server, toolCount | client.ts (mcp) |
| `mcp:disconnect` | server, reason | client.ts (mcp) |
| `mcp:error` | server, error | client.ts (mcp) |
| `mcp:tools_changed` | server, toolCount | client.ts (mcp) |

### Dashboard API (src/dashboard/server.ts)

Node built-in `http.createServer()`. No frameworks. Port 3000 (configurable).

| Method | Path | What it does |
|--------|------|-------------|
| GET | `/` | Serve dashboard HTML |
| GET | `/api/status` | Bot status, uptime, model info |
| GET | `/api/tasks` | All tasks for the owner |
| GET | `/api/history` | Last 20 conversation entries |
| GET | `/api/events` | SSE stream — real-time events |
| GET | `/api/image` | Serve local images (auth via header or query param) |
| POST | `/api/chat` | Send message to Bob, get response |
| POST | `/api/bot/start` | Start Telegram polling |
| POST | `/api/bot/stop` | Stop Telegram polling |
| GET | `/.well-known/agent.json` | A2A Agent Card (public, no auth, 404 in private mode) |
| GET | `/a2a/ping` | A2A presence check (no auth) |
| POST | `/a2a/handshake` | A2A mutual discovery handshake (peer token auth) |
| POST | `/a2a` | A2A JSON-RPC dispatch (peer token auth) |
| GET | `/api/a2a/peers` | Dashboard: list A2A peers |
| GET | `/api/a2a/audit` | Dashboard: A2A audit log |
| GET | `/api/a2a/approvals` | Dashboard: pending approvals |
| POST | `/api/a2a/approvals/:id/approve` | Dashboard: approve a request |
| POST | `/api/a2a/approvals/:id/reject` | Dashboard: reject a request |

All `/api/*` endpoints require `BOB_API_TOKEN` authentication (header or query param).
A2A endpoints (`/.well-known/agent.json`, `/a2a/*`) use per-peer token auth (separate from dashboard).

### Memory System (src/agent/memory.ts)

- Per-user conversation history in `memory/user-{id}.json`
- Keeps last 100 messages per user (auto-trimmed)
- Named notes as markdown files
- User profiles in `memory/profile-{id}.json`
- **All memory is local-only** — gitignored, never committed

**Two-tier context memory (decode-first pattern):**
- `memory/context.md` — **hot cache** (~80 lines). Compact summary of the owner's world: people, terms, projects, preferences. Loaded into the system prompt on every message via `loadOwnerContext()`. Covers ~90% of daily decoding needs.
- `memory/glossary.md` — **full decoder ring**. Every person, term, project, and shorthand. Searched via `read_file` when something isn't in context.md. Can grow indefinitely.
- **Decode-first**: System prompt instructs Bob to resolve all names, nicknames, shorthand, and references against context before acting on any request. Unknown terms → check glossary → ask user → remember.
- **Auto-seeded on first boot**: `memory.initOwnerContext()` in `index.ts` creates empty `context.md` and `glossary.md` at startup if they don't exist. Only the owner's name (from `OWNER_NAME`) appears in the heading — no seed data, Bob learns everything organically from conversations.
- **Organic growth**: Bob populates context.md and glossary.md naturally as the owner mentions people, terms, and projects. Promotion to hot cache and demotion to glossary-only based on usage frequency.
- **Additive-only**: Sits alongside existing profile/notes/SQLite memory. `loadOwnerContext()` reads the hot cache, `initOwnerContext()` seeds on first run.
- Adapted from Anthropic's productivity plugin memory-management pattern, refit for personal agent use case.

### A2A (Agent-to-Agent) Protocol (src/a2a/)

Bob instances can discover, connect, and communicate with other A2A-compatible agents using
the open A2A protocol (Google/Linux Foundation standard). Disabled by default — set `A2A_ENABLED=true`.

**Architecture:**
- **Agent Card** at `/.well-known/agent.json` — public discovery endpoint
- **JSON-RPC 2.0** over HTTP at `/a2a` — authenticated message exchange
- **Handshake** at `/a2a/handshake` — mutual discovery with owner approval
- **Ping** at `/a2a/ping` — lightweight presence check

**Security model (defense-in-depth):**
- **Trust Tiers**: Blocked (reject all) → Manual (require owner approval, default) → Trusted (auto-approve) → Budget-capped (auto-approve up to $X)
- **Three-tier tool access**: SAFE tools (~20, any peer) / DATA tools (~15, Trusted only) / BLOCKED tools (~60+, never external)
- **Per-peer tokens**: Each peer gets a unique auth token — one compromised token doesn't affect others
- **Sandbox**: External requests run in isolated context — separate userId, restricted tools, custom system prompt, 5 tool rounds max, 60s timeout
- **Prompt injection defense**: External messages wrapped in delimiters, system prompt warns against treating as instructions
- **Anti-recursion**: Module-level flag prevents forwarding chains; A2A client tools are in BLOCKED_TOOLS set
- **Discovery modes**: Open (anyone connects) / Handshake (mutual approval, default) / Private (invisible)
- **Rate limits**: Per-peer hourly caps (default 10/hr), auto-reset by scheduler
- **Audit**: Every interaction logged with cost, peer, method, approval status (rolling 500 entries)
- **Owner controls**: Telegram `/approve`, `/reject`, `/trust` commands; dashboard UI; budget caps with cost tracking

**Telegram commands:**
- `/approve <id>` — approve a pending A2A request (task or handshake)
- `/reject <id>` — reject a pending request
- `/trust <id>` — approve AND set peer to Trusted tier (auto-approve all future requests)

### MCP (Model Context Protocol) Client (src/mcp/)

Bob can connect to any MCP-compatible tool server, making its tools available natively.
This is the primary extensibility mechanism — instead of writing new skills from scratch,
connect an existing MCP server and its tools appear automatically.

**Architecture:**
- **Client manager** (`src/mcp/client.ts`) — manages multiple server connections, tool discovery, execution dispatch
- **Skill** (`src/skills/mcp-manager.ts`) — 6 owner-facing tools for self-configuration via chat
- **Persistent config** in `memory/mcp-servers.json` — servers auto-connect on startup
- **Tool namespace** — each server's tools prefixed as `{serverName}_{toolName}` to prevent collisions
- **O(1) dispatch** — `Map<prefixedName, {server, originalName}>` for instant routing

**Transports:**
- **stdio** — runs MCP server as a subprocess (e.g. `npx @modelcontextprotocol/server-filesystem /path`)
- **SSE** — connects to remote MCP server over HTTP/Server-Sent Events

**Reliability:**
- Auto-reconnect with exponential backoff (2s → 4s → 8s → ... up to 60s, max 5 attempts)
- Listens for `ToolListChangedNotification` — live tool refresh when server updates
- Transport error/close handlers trigger reconnection automatically
- Graceful shutdown disconnects all servers on process exit

**Security:**
- MCP management tools (`mcp_add_server`, etc.) are in A2A `BLOCKED_TOOLS` — owner only
- Dynamic MCP tools are blocked from A2A peers (`isMcpTool()` check in `isPublicTool()`)
- MCP tools always included in category-based tool loading (user explicitly configured them)

**Integration:**
- Tools appear in `refreshTools()` alongside built-in and local tools
- Tool executor falls through to `executeMcpTool()` via `isMcpTool()` in the default case
- Dashboard receives `mcp:connect`, `mcp:disconnect`, `mcp:error`, `mcp:tools_changed` events

### SQLite Database (src/db/)

Bob uses SQLite for queryable, persistent structured storage alongside the existing JSON files.
Dual-write architecture: data goes to both JSON (for backward compat) and SQLite (for queries).
If `better-sqlite3` isn't installed, everything works in JSON-only mode.

**Architecture:**
- **Database** (`src/db/database.ts`) — singleton manager, lazy-loads better-sqlite3, WAL mode, `memory/bob.db`
- **Migrations** (`src/db/migrations.ts`) — versioned schema via `PRAGMA user_version`, auto-applied at startup
- **Queries** (`src/db/queries.ts`) — typed wrappers with prepared statements, no ORM
- **Import** (`src/db/import.ts`) — one-time migration of existing JSON conversation history
- **Skill** (`src/skills/analytics.ts`) — 5 tools: search_history, get_tool_stats, get_event_log, search_tasks, get_task_audit

**Tables (v1 — conversations, tool calls, events):**
- `conversations` — all user/assistant messages with userId, role, content, source, timestamp
- `tool_calls` — every tool execution with name, input/output, success, duration_ms, userId
- `events` — persistent event log (survives restarts, unlike the 50-entry ring buffer)
- `metadata` — key-value store for import flags and config

**Tables (v2 — task audit trail):**
- `tasks` — mirrors Task interface: id, status, priority, description, findings, result, tools_used, timestamps
- `task_steps` — per-step audit: step_number, prompt, response, tools_used, duration_ms

**Data flow:**
- Conversations: `memory.appendHistory()` writes to JSON (LLM context) + SQLite (long-term archive)
- Tool calls: `core.ts` agent loop records each tool execution with timing to SQLite
- Events: `events.emitEvent()` writes to ring buffer (SSE streaming) + SQLite (durability)
- Tasks: `queue.ts` syncs task state on every create/update/cancel/pause/resume
- Task steps: `worker.ts` records each step with prompt, response, tools, and timing
- Import: on first run, all `memory/user-*.json` files are imported into `conversations` table

**Graceful degradation:**
- All SQLite writes are wrapped in try/catch — failures don't break the agent
- `isDbAvailable()` check in every query function — returns empty results if DB not ready
- Deleting `bob.db` is safe — system continues in JSON-only mode, re-imports on next startup

### Knowledge Plugin System (src/agent/plugin-loader.ts)

Bob integrates Anthropic's knowledge-work plugins — markdown-based domain expertise that gets
injected into the LLM's context alongside tools. Plugins add **knowledge** (how to think about
a domain), not **capabilities** (what the LLM can do). Skills handle execution; plugins handle reasoning.

**Architecture:**
- **Plugin loader** (`src/agent/plugin-loader.ts`) — mirrors `tool-loader.ts` for knowledge instead of tools
- **Plugin format** — Anthropic's standard: `.claude-plugin/plugin.json` manifest, `skills/*/SKILL.md` with YAML frontmatter, `references/*.md` for deep material
- **Plugin source** — `knowledge-work-plugins-main/` directory (committed, Apache 2.0)
- **Initialization** — `initPlugins()` called at startup, scans all plugins, parses frontmatter, builds keyword index
- **No dependencies** — hand-rolled YAML frontmatter parser, uses only Node built-ins

**Tiered context injection (enforced boundaries):**

| Tier | When | What | Size | Where |
|------|------|------|------|-------|
| 1 | Always | Compact domain listing + `load_knowledge` hint | ~200 bytes | System prompt (end) |
| 2 | Keyword match | Matched skill descriptions (1-2 sentences) | ~200-800 bytes | System prompt (before tool categories) |
| 3 | `load_knowledge` call | Full SKILL.md body | 2-25KB | Tool result |
| 4 | `load_knowledge` + `include_references` | SKILL.md + references/*.md | 10-50KB | Tool result |

Tiers 1+2 are system prompt additions (lightweight, capped at 1.5KB). Tiers 3+4 are tool results
(only when LLM explicitly requests). This prevents context pressure from large reference materials.

**Installed plugins (11 plugins, 53 skills):**
- **data** (7 skills) — SQL queries, data exploration, visualization, dashboards, statistics, validation, context extraction
- **finance** (6) — journal entries, reconciliation, financial statements, variance analysis, close management, audit
- **sales** (6) — account research, call prep, daily briefing, outreach, competitive intel, asset creation
- **legal** (6) — contract review, NDA triage, compliance, canned responses, risk assessment, meeting briefing
- **marketing** (5) — content creation, campaign planning, brand voice, competitive analysis, performance analytics
- **product-management** (6) — feature specs, roadmap, stakeholder comms, user research, competitive analysis, metrics
- **customer-support** (5) — ticket triage, customer research, response drafting, escalation, knowledge management
- **enterprise-search** (3) — search strategy, source management, knowledge synthesis
- **productivity** (2) — task management, memory management
- **bio-research** (5) — single-cell RNA QC, scvi-tools, Nextflow, instrument data, scientific problem selection
- **cowork-plugin-management** (2) — plugin creation, plugin customization

**Keyword matching:**
- Keywords extracted from skill `name` (split on hyphens) + `description` (words >4 chars, stop words removed) + manual overrides
- Same `message.toLowerCase().includes(keyword)` pattern as tool-loader
- Max 5 skills matched per message to prevent flooding

**Meta-tools (always loaded, part of core tools):**
- `load_knowledge` — loads full skill content (Tier 3) or with references (Tier 4). Description explicitly states "This does NOT add new tools"
- `list_knowledge` — lists all plugins and their skills

---

## Development

```bash
pnpm install          # Install dependencies
pnpm dev              # Run in dev mode with hot reload (tsx watch)
pnpm build            # Compile TypeScript to dist/
pnpm start            # Run compiled output
pnpm test             # Run tests (vitest)
```

### Test Suite

167 tests across 9 files covering pure-logic core functions. Run with `pnpm test`.

| Area | File | Tests | What it covers |
|------|------|-------|----------------|
| Agent | `tests/agent/core.test.ts` | 27 | Hallucination guard + personality presets |
| Agent | `tests/agent/tool-loader.test.ts` | 24 | Category-based tool selection, keyword matching, meta-tools |
| Agent | `tests/agent/plugin-loader.test.ts` | 17 | YAML frontmatter parsing, keyword extraction, stop words |
| Skills | `tests/skills/reminders.test.ts` | 29 | Natural language time parsing, snooze duration, formatting |
| Skills | `tests/skills/form-filler.test.ts` | 24 | Field normalization, fuzzy vault matching (3-pass) |
| Tasks | `tests/tasks/busy-state.test.ts` | 12 | Busy state transitions, preemption lifecycle |
| Tasks | `tests/tasks/escalation.test.ts` | 9 | Channel filtering, dedup, interaction tracking |
| Config | `tests/config.test.ts` | 7 | Config defaults, A2A settings, validateConfig |
| A2A | `tests/a2a/public-skills.test.ts` | 18 | Three-tier security (SAFE/DATA/BLOCKED), trust tiers, MCP blocking |

Tests focus on exported pure functions — no network calls, no heavy mocking (except module-level mocks for tool-loader and A2A tests). Uses `vi.useFakeTimers()` for deterministic time tests.

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
- **API token authentication** — all dashboard/API endpoints require `BOB_API_TOKEN`
- **Telegram owner check** — only `OWNER_USER_ID` can interact with the bot
- **Credential blocklist** — `read_file` and `write_file` both block `.env`, `.ssh/`, `.gnupg/`, credentials files. Credentials must go through `set_env_var` (allowlisted keys only)
- Credentials stored in `.env` (gitignored, never committed)
- User memory and profiles stored locally in `memory/` (gitignored)
- Tool execution has timeouts and output size limits
- The agent is sandboxed to the tools it's given — no arbitrary code execution
  beyond the `run_command` tool (which has configurable timeout)
- Prompt injection awareness — external data is never blindly trusted

---

## Future Roadmap

### Community
- Discord server for Bob community

---

## Next Session

- [x] Smart Home — Home Assistant integration (15 tools, REST + WebSocket, device monitors)
- [x] Voice — Telegram voice messages (Whisper STT + edge-tts TTS)
- [x] Knowledge plugins — Anthropic knowledge-work-plugins integration (11 plugins, 53 skills, tiered injection)
- [x] Memory system — Two-tier context memory (context.md hot cache + glossary.md decoder ring, decode-first pattern)
- [ ] Discord server for Bob community

## Personality Presets

Bob has switchable personality presets inspired by TARS from Interstellar. Stored in `profile.preferences.personality`, injected into the system prompt via `getPersonalityPrompt()` in `src/agent/core.ts`.

| Preset | Style |
|--------|-------|
| `default` | Personable, concise, occasional wit — a mate, not a corporate bot |
| `tars` | Humor at 75%. Witty, sarcastic, competent. Dry one-liners. |
| `professional` | No jokes, no flair. Clear communication and results. |
| `minimal` | Bare facts, minimal words. Terse but accurate. |

Switch via the `set_personality` tool (always loaded as a core tool). Takes effect from the next message onward.

---

## Known Issues

### Tool Hallucination (mitigated)
With ~137 tools loaded on every message, the LLM sometimes "describes" taking an action (e.g. "Calling you now!") without actually invoking the tool. This is a known LLM behavior under high tool-count context pressure. **Mitigations in place:**
1. System prompt includes explicit `CRITICAL — Tool usage rules` section forbidding fake actions
2. `detectUnusedActions()` guard in `core.ts` catches claims about calls, SMS, calendar, reminders, and emails without corresponding tool usage, and re-enters the agent loop with a correction prompt
3. Category-based tool loading (implemented) reduces tools sent per message from ~145 to 12-40, significantly reducing context pressure
4. MCP tool servers further reduce need to load all built-in tools at once

### Worker Preemption
Background tasks used to block direct chat entirely. Fixed with preemption: when a chat message arrives, the worker yields at the next tool-round boundary (5-30s worst case). Implementation in `busy-state.ts` (preempt flag) and `core.ts` (check + wait-for-yield).

## Notes

- This is an experimental project
- Security is a priority — no open marketplaces, no blind trust
- Start simple, add capabilities incrementally
- The architecture supports any task type — skills are modular
- The agent is not limited to this folder — it can access anything Node.js has permissions for
