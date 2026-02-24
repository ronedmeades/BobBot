/**
 * Bob setup wizard — interactive CLI that creates a .env file.
 * Run with: pnpm setup
 */

import { createInterface } from "node:readline";
import { writeFile, access } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function print(msg: string): void {
  console.log(msg);
}

const PROVIDERS: Record<string, { name: string; model: string; keyUrl: string; keyPrefix: string; testFn: (key: string) => Promise<boolean> }> = {
  "1": {
    name: "gemini",
    model: "gemini-2.0-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPrefix: "AIza",
    testFn: testGemini,
  },
  "2": {
    name: "openai",
    model: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    testFn: testOpenAI,
  },
  "3": {
    name: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    keyUrl: "https://console.anthropic.com",
    keyPrefix: "sk-ant-",
    testFn: testAnthropic,
  },
};

async function testGemini(apiKey: string): Promise<boolean> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent("Say 'hello' in one word.");
  return !!result.response.text();
}

async function testOpenAI(apiKey: string): Promise<boolean> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });
  const result = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 5,
    messages: [{ role: "user", content: "Say 'hello' in one word." }],
  });
  return !!result.choices[0]?.message.content;
}

async function testAnthropic(apiKey: string): Promise<boolean> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const result = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 5,
    messages: [{ role: "user", content: "Say 'hello' in one word." }],
  });
  return result.content.length > 0;
}

async function main(): Promise<void> {
  print("");
  print("=================================");
  print("   Welcome to Bob setup!");
  print("=================================");
  print("");

  // Check if .env already exists
  const envPath = resolve(process.cwd(), ".env");
  try {
    await access(envPath);
    const overwrite = await ask(".env file already exists. Overwrite it? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      print("\nSetup cancelled. Your existing .env was not changed.");
      rl.close();
      return;
    }
    print("");
  } catch {
    // .env doesn't exist — that's fine
  }

  // Step 1: Pick a brain
  print("Step 1: Pick a brain for Bob");
  print("");
  print("  1. Gemini     — Free tier available, great for trying Bob out");
  print("  2. OpenAI     — Cheap and capable (GPT-4o-mini)");
  print("  3. Anthropic  — Best quality (Claude Sonnet)");
  print("");

  let choice = "";
  while (!PROVIDERS[choice]) {
    choice = await ask("Enter 1, 2, or 3: ");
    if (!PROVIDERS[choice]) {
      print("  Please enter 1, 2, or 3.");
    }
  }

  const provider = PROVIDERS[choice];
  print("");

  // Step 2: API key
  print(`Step 2: Get your ${provider.name} API key`);
  print("");
  print(`  Go to: ${provider.keyUrl}`);
  print("  Sign up (or log in), create an API key, and paste it below.");
  print("");

  let apiKey = "";
  let connected = false;

  while (!connected) {
    apiKey = await ask("Paste your API key: ");

    if (!apiKey) {
      print("  API key can't be empty. Try again.");
      continue;
    }

    // Quick sanity check on key format
    if (provider.keyPrefix && !apiKey.startsWith(provider.keyPrefix)) {
      print(`  That doesn't look like a ${provider.name} key (expected it to start with "${provider.keyPrefix}").`);
      const proceed = await ask("  Try anyway? (y/N): ");
      if (proceed.toLowerCase() !== "y") continue;
    }

    // Test the connection
    process.stdout.write("\n  Testing connection... ");

    try {
      await provider.testFn(apiKey);
      print(`Connected to ${provider.model}!\n`);
      connected = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      print(`Failed.\n`);
      print(`  Error: ${msg.slice(0, 200)}`);
      print("  Check your API key and try again.\n");
    }
  }

  // Step 3: Owner name
  print("Step 3: What should Bob call you?");
  print("");
  const name = await ask("Your name (or press Enter for 'Owner'): ") || "Owner";
  print("");

  // Write .env
  const envContent = [
    "# Bob configuration — created by pnpm setup",
    `PRIMARY_LLM_PROVIDER=${provider.name}`,
    `PRIMARY_LLM_API_KEY=${apiKey}`,
    `PRIMARY_LLM_MODEL=${provider.model}`,
    "",
    `OWNER_NAME=${name}`,
    "",
    "# Telegram (optional — ask Bob to help you set this up later)",
    "# TELEGRAM_BOT_TOKEN=",
    "# OWNER_USER_ID=",
    "",
    "# Dashboard port (default: 3000)",
    "# DASHBOARD_PORT=3000",
    "",
  ].join("\n");

  await writeFile(envPath, envContent, "utf-8");

  // Step 4: Desktop shortcut (Windows only)
  if (process.platform === "win32") {
    print("Step 4: Desktop shortcut");
    print("");
    print("  Create a desktop icon so you can launch Bob with one click.");
    print("  You can also choose to start Bob automatically when Windows starts.");
    print("");
    const shortcut = await ask("Set up desktop shortcut now? (Y/n): ");
    if (shortcut === "" || shortcut.toLowerCase() === "y") {
      print("");
      try {
        execSync(
          'powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1',
          { stdio: "inherit", cwd: process.cwd() },
        );
      } catch {
        print("  Shortcut setup had an issue — you can try again later with: pnpm shortcut");
        print("");
      }
    } else {
      print("  Skipped. You can set this up later with: pnpm shortcut");
      print("");
    }
  }

  print("=================================");
  print("   Setup complete!");
  print("=================================");
  print("");
  print("To start Bob:");
  print("");
  if (process.platform === "win32") {
    print("  Double-click the Bob icon on your desktop");
    print("  Or run: pnpm dev");
  } else {
    print("  pnpm dev");
  }
  print("");
  print("Then open http://localhost:3000 and say hello!");
  print("");
  print("Want to chat from your phone? Ask Bob:");
  print('  "Help me set up Telegram"');
  print("");

  rl.close();
}

main().catch((err) => {
  console.error("\nSetup failed:", err instanceof Error ? err.message : err);
  rl.close();
  process.exit(1);
});
