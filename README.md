# Bob — Your Personal AI Assistant

Bob is an AI assistant that lives on your computer. He can fetch information, manage files, send emails, list things on eBay, control your smart home, and much more. You chat with him through a web dashboard in your browser, and optionally through Telegram on your phone.

**You don't need to be a programmer to use Bob.** Just follow the steps below.

### Why Bob?

Open-source AI agents like OpenClaw have gained massive popularity (166k+ GitHub stars), but they come with serious security risks — malicious marketplace skills, remote code execution vulnerabilities, and credential leaks. Anyone can publish a skill, and your agent blindly trusts it.

Bob takes a different approach:

- **No open skill marketplace** — all 170+ tools are vetted first-party code, not community-submitted plugins
- **Credential protection** — file access blocks `.env`, `.ssh/`, and credential files; API keys never leave your machine
- **Owner-only access** — only your Telegram ID can talk to Bob; dashboard requires an API token
- **Sandboxed A2A** — when other agents connect, they get restricted tools, separate context, rate limits, and cost tracking
- **Your data stays local** — conversations, contacts, expenses, and notes live in `memory/` on your machine, never uploaded anywhere

All the power of an autonomous agent, without the security nightmares.

---

## What You'll Need

Before starting, you need two things installed on your computer:

### 1. Node.js (version 22 or newer)

Node.js is the engine that runs Bob.

> **How to open a terminal:**
> - **Windows**: Press `Win + R`, type `cmd`, press Enter
> - **Mac**: Press `Cmd + Space`, type `Terminal`, press Enter

<details>
<summary><strong>Windows setup</strong></summary>

1. Go to [nodejs.org](https://nodejs.org/) and click the big green button
2. Run the installer (accept all defaults)
3. Open a **new** Command Prompt and check it worked:
   ```
   node --version
   ```
   You should see `v22` or higher.
4. Install pnpm:
   ```
   npm install -g pnpm
   ```

</details>

<details>
<summary><strong>Mac setup</strong></summary>

**Option A — Direct download (easiest):**
1. Go to [nodejs.org](https://nodejs.org/) and click the big green button
2. Run the installer
3. Open Terminal and check it worked:
   ```
   node --version
   ```
4. Install pnpm:
   ```
   npm install -g pnpm
   ```

**Option B — Via Homebrew (if you have it):**
```
brew install node
npm install -g pnpm
```

If you don't have Homebrew and want it:
```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

</details>

Check both are installed:
```
node --version    # should show v22 or higher
pnpm --version    # should show a version number
```

That's it for prerequisites.

---

## Pick a Brain

Bob needs an AI "brain" to think with. You have three options:

| | Gemini | OpenAI | Anthropic |
|---|---|---|---|
| **Best for** | Free / trying it out | Cheap + capable | Best quality |
| **Cost** | Free tier available | ~$0.15 per million tokens | ~$3 per million tokens |
| **Get a key** | [aistudio.google.com](https://aistudio.google.com/apikey) | [platform.openai.com](https://platform.openai.com/api-keys) | [console.anthropic.com](https://console.anthropic.com/) |

**Our recommendation:** Start with **Gemini** — it's free and works great for most tasks. You can always switch later.

### How to get a Gemini API key (free)

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **"Create API key"**
4. Copy the key (starts with `AIza...`) — you'll paste it during setup

<details>
<summary>How to get an OpenAI key instead</summary>

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create an account and add a payment method (pay-as-you-go, very cheap)
3. Click **"Create new secret key"**
4. Copy the key (starts with `sk-...`)
</details>

<details>
<summary>How to get an Anthropic key instead</summary>

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account and add a payment method
3. Go to **API Keys** and click **"Create Key"**
4. Copy the key (starts with `sk-ant-...`)
</details>

---

## Setup

### Step 1: Download Bob

**Option A — If you have Git:**
```
git clone https://github.com/ronedmeades/BobBot.git
cd BobBot
```

**Option B — No Git? No problem:**
1. Go to [github.com/ronedmeades/BobBot](https://github.com/ronedmeades/BobBot)
2. Click the green **"Code"** button, then **"Download ZIP"**
3. Unzip it and open a terminal in the `BobBot` folder

### Step 2: Install dependencies

```
pnpm install
```

This downloads everything Bob needs. Takes about 30 seconds.

### Step 3: Run the setup wizard

```
pnpm setup
```

The wizard will:
- Ask you to pick a brain (Gemini / OpenAI / Anthropic)
- Ask for your API key
- Test that it works
- Ask your name
- Create the configuration file

### Step 4: Create a desktop shortcut (Windows)

```
pnpm shortcut
```

This creates a **Bob** icon on your desktop. Double-click it to start Bob and open the dashboard in your browser — one click, done.

You'll also be asked if you want Bob to **start automatically** when you log in to Windows. If you say yes, your browser bookmark to `http://localhost:3000` will always work.

> **Prefer the terminal?** You can skip the shortcut and just run `pnpm dev` instead.

### Step 5: Start Bob

**With the desktop shortcut:** Double-click the Bob icon.

**From the terminal:**
```
pnpm dev
```

You should see:
```
Starting Bob...
Dashboard: http://localhost:3000
Bob is online. Provider: gemini, Model: gemini-2.0-flash
Chat with Bob at http://localhost:3000
```

### Step 6: Say hello!

Open [http://localhost:3000](http://localhost:3000) in your browser (or it opens automatically with the shortcut). Type a message in the chat box and hit Send.

Try: *"Hey Bob, what can you do?"*

---

## Chatting From Your Phone (Telegram)

Want to message Bob when you're away from your computer? Just ask him in the dashboard:

> *"Help me set up Telegram"*

Bob will walk you through the whole process step by step.

---

## What Can Bob Do?

Bob has **170+ tools across 35 skill modules**, plus domain expertise from **11 knowledge plugins**. Here's what he can do out of the box:

**Basics:**
- **Fetch web pages and APIs** — research topics, check prices, read documentation
- **Read and write files** — on your computer, wherever you point him
- **Run shell commands** — install things, run scripts, automate tasks
- **Remember things** — persistent notes that survive restarts
- **Learns your world** — Bob builds a mental model of the people, terms, and projects in your life. Say "chase Dave about Elm Street" and Bob knows Dave is your electrician and Elm Street is the rewire job

**Productivity:**
- **Calendar & events** — schedule meetings, deadlines, recurring events with reminders
- **Google Calendar** — list/create/update/delete events in Google Calendar, view attendees, recurrence
- **Reminders** — "remind me in 2 hours", "tomorrow morning", snooze support
- **Contacts** — address book with search, tags, and relationships
- **Quick capture** — jot down ideas, links, todos, snippets — searchable later
- **Expense tracking** — log expenses, category breakdowns, CSV/JSON export
- **Invoices** — generate PDF invoices (pulls your info from the vault, client info from contacts)
- **Fill forms** — personal data vault with smart field matching
- **PDF forms** — parse and auto-fill PDF forms from your vault

**Research & Content:**
- **Summarize documents** — summarize files or URLs (brief, detailed, or bullet points)
- **Translate text** — translate between languages, detect language
- **Weather** — current conditions and forecasts for any location (free, no API key)
- **Social media posts** — generate platform-optimized content for LinkedIn, Facebook, Instagram, Twitter/X
- **Monitor websites** — watch for changes, track keywords on HN/Reddit

**Marketplace & eBay:**
- **Marketplace engine** — unified orders, messaging, and fulfillment across platforms
- **eBay, Etsy, Poshmark, Depop** — built-in adapters (more can be added as local skills)
- **Get orders** — view orders from any marketplace, filter by status
- **Ship orders** — mark as shipped with tracking (single or bulk)
- **Buyer messaging** — send/receive messages through marketplace platforms
- **Process images** — resize, crop, convert, watermark (needs `sharp`)
- **Analyze images** — describe photos, extract text, generate listings from poster photos
- **List on eBay** — create listings, upload photos, bulk price updates (needs eBay API keys)
- **Batch poster workflow** — scan a folder of posters, auto-generate eBay listings
- **Standing rules** — persistent monitoring (alert on unshipped orders, new orders, unread messages, daily sales summary, weekly insights digest)
- **Escalation engine** — multi-channel notification chains (Telegram → SMS → phone call) with auto-acknowledge

**Communication:**
- **Voice messages** — send Bob a voice note on Telegram, get text + voice reply back (Whisper STT + edge-tts TTS)
- **Phone calls** — Bob can call your phone and speak a message aloud (needs Twilio)
- **SMS** — send text messages to your phone (needs Twilio)
- **Send email** — via Gmail (needs Gmail API keys)
- **Import Google Contacts** — pull contacts from Google into Bob's address book

**Smart Home:**
- **Home Assistant** — control lights, switches, climate, scenes, automations (15 tools)
- **Device monitoring** — persistent watches with alerts (e.g. "tell me when the front door opens")
- **Real-time state** — WebSocket connection for instant state change awareness, REST API fallback

**System:**
- **Personality presets** — switch Bob's style: `default` (personable mate), `tars` (witty, sarcastic — 75% humor setting), `professional` (no jokes), `minimal` (bare facts). Just say *"set personality to tars"*
- **File organizer** — scan folders, organize by type or date, find duplicates
- **Browser automation** — navigate pages, click, type, screenshot (needs `playwright`)
- **Backups** — auto-backup to an external drive on a schedule
- **Background tasks** — hand Bob a task and he works on it autonomously
- **Environment manager** — safely set API keys and config vars through chat (allowlisted keys only)
- **MCP servers** — connect to Model Context Protocol servers for plug-and-play tool expansion
- **Knowledge plugins** — built-in domain expertise for data analytics, finance, sales, legal, marketing, product management, customer support, and more
- **Analytics** — search conversation history, tool usage stats, event log (SQLite-powered)

**Agent-to-Agent (A2A):**
- **Bob-to-Bob communication** — your Bob can discover and talk to other Bobs using the open A2A protocol
- **Trust tiers** — control who can access what (blocked / manual approval / trusted / budget-capped)
- **Security** — sandboxed execution, per-peer tokens, rate limits, cost tracking, audit log

Bob is extensible — new skills can be added as modules. Ask Bob what he can do and he'll tell you.

---

## Phone Calls & SMS (Twilio)

Want Bob to be able to call or text your real phone? You'll need a Twilio account.

### Step 1: Create a Twilio account

1. Go to [twilio.com](https://www.twilio.com/) and sign up (free trial gives you ~$15 credit)
2. Verify your email and phone number

### Step 2: Get a Twilio phone number

1. In the Twilio Console, go to **Phone Numbers** → **Buy a number**
2. Pick any number with Voice and SMS capabilities (~$1.15/month)
3. Note down the phone number (e.g. `+15551234567`)

### Step 3: Find your credentials

1. From the Twilio Console dashboard, copy your **Account SID** (starts with `AC`)
2. Copy your **Auth Token** (click "Show" to reveal it)

### Step 4: Add to your .env file

Open your `.env` file and add these lines:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=+15551234567
OWNER_PHONE_NUMBER=+15559876543
```

Replace `OWNER_PHONE_NUMBER` with your real phone number (the one you want Bob to call/text).

### Step 5: Verify your number (free trial only)

On the free trial, Twilio can only call/text **verified** numbers:

1. In the Twilio Console, go to **Phone Numbers** → **Verified Caller IDs**
2. Click **Add a new Caller ID** and verify your personal phone number

This restriction is removed once you upgrade your Twilio account.

### Step 6: Restart Bob and test

```
pnpm dev
```

Then in the dashboard, try:
- *"Call me and say hello"*
- *"Text me a quick test message"*

---

## Voice Messages (Telegram)

Bob can understand voice notes and reply with voice. You need an OpenAI API key for the speech-to-text part (text-to-speech is free).

### How it works

1. **You send a voice note** on Telegram
2. **Bob transcribes it** using OpenAI Whisper ($0.006/min — that's less than a penny per minute)
3. **Bob processes your request** just like a text message
4. **Bob replies with text AND voice** — the voice reply is free (uses Microsoft Edge TTS)

### Setup

Add to your `.env` file:

```
OPENAI_API_KEY=sk-xxxxx
```

> **Already using OpenAI as your LLM provider?** Bob reuses `LLM_API_KEY` automatically — no extra key needed.

Optionally customize Bob's voice:

```
BOB_VOICE=en-GB-RyanNeural
```

The default is a British male voice. See [Microsoft's voice list](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support) for alternatives.

---

## Smart Home (Home Assistant)

Bob can control your smart home devices through Home Assistant.

### Step 1: Generate a long-lived access token

1. In Home Assistant, go to your **Profile** (click your name, bottom-left)
2. Scroll down to **Long-Lived Access Tokens**
3. Click **Create Token**, give it a name (e.g. "Bob"), and copy it

### Step 2: Add to your .env file

```
HA_URL=http://192.168.1.100:8123
HA_TOKEN=your_long_lived_access_token_here
```

Replace the URL with your Home Assistant's address.

### Step 3: Restart Bob and test

```
pnpm dev
```

Then try:
- *"What devices do I have?"*
- *"Turn off the living room lights"*
- *"What's the temperature in the bedroom?"*
- *"Watch the front door and tell me when it opens"*

---

## Community

Join the Bob community to share tips, get help, and show off what your Bob can do:

- **Discord**: [Join the Bob community](https://discord.gg/de4FNzvZ)
- **GitHub Issues**: [Report bugs or request features](https://github.com/ronedmeades/BobBot/issues)
- **GitHub Discussions**: [Ask questions and share ideas](https://github.com/ronedmeades/BobBot/discussions)

---

## Troubleshooting

**"node is not recognized" or "node: command not found"**
Node.js isn't installed. Go to [nodejs.org](https://nodejs.org/) and install it, then restart your terminal.

**"pnpm is not recognized"**
Run `npm install -g pnpm` first, then restart your terminal.

**"No API key for provider"**
You need to run `pnpm setup` first, or manually create a `.env` file. See the setup steps above.

**"API key invalid" or "authentication error"**
Double-check that you copied the full API key with no extra spaces. Try generating a new one.

**Port 3000 already in use**
Something else is using that port. Either close it, or add `DASHBOARD_PORT=3001` to your `.env` file.

**Bob seems slow or unresponsive**
Some AI providers have rate limits, especially on free tiers. Wait a moment and try again.

---

## Tech Stack

- **No web framework** — the dashboard/API server is raw `http.createServer()` (Node built-in)
- **grammY** — Telegram bot framework
- **@anthropic-ai/sdk** — Claude API client (also supports OpenAI and Gemini via provider adapters)
- **@modelcontextprotocol/sdk** — MCP client for plug-and-play tool servers
- **better-sqlite3** — SQLite database (conversation history, analytics, event log)
- **TypeScript** (strict, ESM) with **tsx** for dev/watch mode
- **Vitest** for testing
- **pnpm** as package manager

Minimal dependencies by design — Node built-ins preferred over adding packages.

---

## For Developers

See [CLAUDE.md](./CLAUDE.md) for the full technical architecture, API docs, and how to add new skills.

---

## License

MIT
