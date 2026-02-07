# Bob — Your Personal AI Assistant

Bob is an AI assistant that lives on your computer. He can fetch information, manage files, send emails, list things on eBay, and much more. You chat with him through a web dashboard in your browser, and optionally through Telegram on your phone.

**You don't need to be a programmer to use Bob.** Just follow the steps below.

---

## What You'll Need

Before starting, you need two things installed on your computer:

### 1. Node.js (version 22 or newer)

Node.js is the engine that runs Bob. Download and install it:

- **Windows / Mac**: Go to [nodejs.org](https://nodejs.org/) and click the big green button. Run the installer.
- **Check it worked**: Open a terminal and type `node --version`. You should see `v22` or higher.

> **How to open a terminal:**
> - **Windows**: Press `Win + R`, type `cmd`, press Enter
> - **Mac**: Press `Cmd + Space`, type `Terminal`, press Enter

### 2. pnpm (package manager)

After installing Node.js, open a terminal and run:

```
npm install -g pnpm
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

### Step 4: Start Bob

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

### Step 5: Say hello!

Open [http://localhost:3000](http://localhost:3000) in your browser. Type a message in the chat box and hit Send.

Try: *"Hey Bob, what can you do?"*

---

## Chatting From Your Phone (Telegram)

Want to message Bob when you're away from your computer? Just ask him in the dashboard:

> *"Help me set up Telegram"*

Bob will walk you through the whole process step by step.

---

## What Can Bob Do?

Out of the box, Bob can:

- **Fetch web pages and APIs** — research topics, check prices, read documentation
- **Read and write files** — on your computer, wherever you point him
- **Run shell commands** — install things, run scripts, automate tasks
- **Remember things** — persistent notes that survive restarts
- **Process images** — resize, crop, convert, watermark (needs the `sharp` package)
- **List on eBay** — create listings, upload photos (needs eBay API keys)
- **Send email** — via Gmail (needs Gmail API keys)
- **Monitor websites** — watch for changes, track keywords on HN/Reddit
- **Analyze images** — describe photos, extract text, generate eBay listings from poster photos
- **Fill forms** — personal data vault with smart field matching

Bob is extensible — new skills can be added as modules. Ask Bob what he can do and he'll tell you.

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

## For Developers

See [CLAUDE.md](./CLAUDE.md) for the full technical architecture, API docs, and how to add new skills.

---

## License

MIT
