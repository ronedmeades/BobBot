import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Lazy-load stealth dependencies
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chromiumMod: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fingerprintGen: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fingerprintInj: any = null;

async function loadStealthDeps(): Promise<void> {
  if (chromiumMod) return;

  try {
    // playwright-extra
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pwExtra = await (Function('return import("playwright-extra")')() as Promise<any>);
    chromiumMod = pwExtra.chromium;

    // stealth plugin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stealthMod = await (Function('return import("puppeteer-extra-plugin-stealth")')() as Promise<any>);
    const StealthPlugin = stealthMod.default ?? stealthMod;
    chromiumMod.use(StealthPlugin());

    // fingerprint suite
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fpGenMod = await (Function('return import("fingerprint-generator")')() as Promise<any>);
    const FingerprintGenerator = fpGenMod.FingerprintGenerator ?? fpGenMod.default;
    fingerprintGen = new FingerprintGenerator();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fpInjMod = await (Function('return import("fingerprint-injector")')() as Promise<any>);
    const FingerprintInjector = fpInjMod.FingerprintInjector ?? fpInjMod.default;
    fingerprintInj = new FingerprintInjector();
  } catch (err) {
    chromiumMod = null;
    fingerprintGen = null;
    fingerprintInj = null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Stealth browser dependencies not installed. Run:\n" +
      "pnpm add playwright-extra puppeteer-extra-plugin-stealth fingerprint-generator fingerprint-injector\n\n" +
      `Original error: ${msg}`
    );
  }
}

// ---------------------------------------------------------------------------
// Stealth browser state (separate from basic browser.ts)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stealthBrowser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stealthContext: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stealthPage: any = null;
let stealthIdleTimer: ReturnType<typeof setTimeout> | null = null;
const STEALTH_IDLE_MS = 5 * 60 * 1000; // 5 min

// Network interception buffer
interface InterceptedResponse {
  url: string;
  method: string;
  status: number;
  contentType: string;
  body: string;
  timestamp: number;
}

let interceptPatterns: string[] = [];
const interceptedData: InterceptedResponse[] = [];
const MAX_INTERCEPTED = 100;

// Track whether this is the first browse in the current session
let isFirstBrowse = true;

const SCREENSHOTS_DIR = resolve("memory/screenshots");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resetStealthIdleTimer(): void {
  if (stealthIdleTimer) clearTimeout(stealthIdleTimer);
  stealthIdleTimer = setTimeout(async () => {
    await closeStealthInstance();
  }, STEALTH_IDLE_MS);
}

function imageMarker(filePath: string, alt: string): string {
  return `![${alt}](/api/image?path=${encodeURIComponent(filePath)})`;
}

// ---------------------------------------------------------------------------
// Human-like behavior helpers
// ---------------------------------------------------------------------------

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, delay));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function humanScroll(pg: any, scrolls: number, direction: "down" | "up"): Promise<void> {
  for (let i = 0; i < scrolls; i++) {
    const distance = Math.floor(Math.random() * 400) + 200; // 200-600px
    await pg.mouse.wheel(0, direction === "down" ? distance : -distance);
    await randomDelay(500, 1500);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function humanMouseMove(pg: any): Promise<void> {
  const viewport = pg.viewportSize();
  if (!viewport) return;

  const moves = Math.floor(Math.random() * 3) + 2;
  for (let i = 0; i < moves; i++) {
    const x = Math.floor(Math.random() * viewport.width * 0.8) + viewport.width * 0.1;
    const y = Math.floor(Math.random() * viewport.height * 0.8) + viewport.height * 0.1;
    await pg.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
    await randomDelay(200, 800);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function humanLikeBrowse(pg: any, url: string): Promise<void> {
  // Pre-navigation delay (simulates tab switch / thinking)
  await randomDelay(500, 2000);

  await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });

  // Post-navigation: wait for dynamic content
  await randomDelay(1000, 3000);

  // Simulate reading: mouse moves + light scrolling
  await humanMouseMove(pg);
  await humanScroll(pg, 2, "down");
}

// ---------------------------------------------------------------------------
// Network interception
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachNetworkInterception(pg: any): void {
  pg.on("response", async (response: { url(): string; headers(): Record<string, string>; status(): number; text(): Promise<string>; request(): { method(): string } }) => {
    try {
      const url = response.url();
      const contentType = response.headers()["content-type"] ?? "";

      // Only capture if URL matches any active pattern
      const matches = interceptPatterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(url);
        } catch {
          return url.includes(pattern);
        }
      });

      if (!matches) return;

      // Only capture JSON/text responses
      if (!contentType.includes("json") && !contentType.includes("text")) return;

      const body = await response.text().catch(() => "[body unavailable]");

      if (interceptedData.length >= MAX_INTERCEPTED) {
        interceptedData.shift();
      }

      interceptedData.push({
        url,
        method: response.request().method(),
        status: response.status(),
        contentType,
        body: body.length > 50_000 ? body.slice(0, 50_000) + "\n...[truncated]" : body,
        timestamp: Date.now(),
      });
    } catch {
      // Silently ignore — page may have navigated away
    }
  });
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

async function ensureStealthBrowser(rotateFingerprint = true): Promise<void> {
  await loadStealthDeps();

  if (!stealthBrowser) {
    stealthBrowser = await chromiumMod.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    console.log("[stealth-browser] Chromium (stealth) launched");
  }

  if (!stealthContext || !stealthPage || stealthPage.isClosed() || rotateFingerprint) {
    // Close old context if it exists
    if (stealthContext) {
      try { await stealthContext.close(); } catch { /* already closed */ }
    }

    // Generate a realistic fingerprint
    const fingerprint = fingerprintGen.getFingerprint({
      devices: ["desktop"],
      operatingSystems: ["windows"],
      browsers: ["chrome"],
      locales: ["en-US"],
    });

    // Create context with fingerprint parameters
    stealthContext = await stealthBrowser.newContext({
      userAgent: fingerprint.fingerprint.navigator.userAgent,
      viewport: {
        width: fingerprint.fingerprint.screen.width,
        height: fingerprint.fingerprint.screen.height,
      },
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
    });

    // Inject deeper fingerprint overrides
    await fingerprintInj.attachFingerprintToPlaywright(stealthContext, fingerprint);

    stealthPage = await stealthContext.newPage();

    // Re-attach network interception if patterns are active
    if (interceptPatterns.length > 0) {
      attachNetworkInterception(stealthPage);
    }

    console.log("[stealth-browser] New context with fresh fingerprint");
  }

  resetStealthIdleTimer();
}

async function closeStealthInstance(): Promise<void> {
  if (stealthIdleTimer) {
    clearTimeout(stealthIdleTimer);
    stealthIdleTimer = null;
  }

  interceptPatterns = [];
  interceptedData.length = 0;

  if (stealthBrowser) {
    try { await stealthBrowser.close(); } catch { /* already closed */ }
    stealthBrowser = null;
    stealthContext = null;
    stealthPage = null;
    console.log("[stealth-browser] Chromium (stealth) closed");
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const stealthBrowserToolDefinitions: ToolDefinition[] = [
  {
    name: "stealth_browse",
    description:
      "Navigate to a URL using a stealth browser with anti-bot-detection measures. " +
      "Uses fingerprint rotation, automation signal masking, and human-like behavior (random delays, mouse movements, scrolling). " +
      "Use this for sites with Incapsula/Imperva, Cloudflare, DataDome, or other bot detection. " +
      "For normal sites, use browse_url instead (lighter weight).",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        wait_for: {
          type: "string",
          enum: ["load", "networkidle", "domcontentloaded"],
          description: "Wait strategy (default: domcontentloaded). Use networkidle for SPAs that load data after page load.",
        },
        human_delay: {
          type: "boolean",
          description: "Add human-like delays, mouse movements, and scrolling (default: true)",
        },
        rotate_fingerprint: {
          type: "boolean",
          description: "Create a new browser context with a fresh fingerprint (default: true on first call, false on subsequent calls in same session)",
        },
        screenshot: {
          type: "boolean",
          description: "Take a screenshot after loading (default: false)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "intercept_network",
    description:
      "Start capturing XHR/fetch API responses matching URL patterns. " +
      "Many SPAs (like Albertsons, Walmart, etc.) fetch product data from internal JSON APIs — " +
      "this captures those responses so you can extract structured data instead of scraping HTML. " +
      "Call this BEFORE navigating to the page. Patterns support regex or plain substring match. " +
      "Example patterns: 'api/v3/products', '/graphql', 'nutrition'",
    input_schema: {
      type: "object" as const,
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          description: "URL patterns to intercept (regex or substring). Example: ['api/v3', '/graphql', 'product']",
        },
        clear_existing: {
          type: "boolean",
          description: "Clear previously captured data and patterns (default: false)",
        },
      },
      required: ["patterns"],
    },
  },
  {
    name: "get_intercepted_data",
    description:
      "Retrieve captured API responses from network interception. " +
      "Returns JSON bodies from XHR/fetch calls matching the patterns set by intercept_network. " +
      "This is how you extract product data from SPAs — the JSON API responses contain structured data " +
      "(nutrition, pricing, etc.) that's much more reliable than scraping rendered HTML.",
    input_schema: {
      type: "object" as const,
      properties: {
        filter_url: {
          type: "string",
          description: "Optional: filter results to URLs containing this substring",
        },
        limit: {
          type: "number",
          description: "Max number of results to return (default: 20, max: 100)",
        },
        json_only: {
          type: "boolean",
          description: "Only return responses with JSON content-type (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "stealth_scroll",
    description:
      "Perform human-like scrolling on the current stealth browser page. " +
      "Triggers lazy-loading of content and appears natural to bot detection. " +
      "Includes random delays and mouse movements between scrolls.",
    input_schema: {
      type: "object" as const,
      properties: {
        scrolls: {
          type: "number",
          description: "Number of scroll actions (default: 3)",
        },
        direction: {
          type: "string",
          enum: ["down", "up"],
          description: "Scroll direction (default: down)",
        },
        screenshot_after: {
          type: "boolean",
          description: "Take a screenshot after scrolling (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "stealth_close",
    description:
      "Close the stealth browser instance and clear all intercepted data. " +
      "The browser will relaunch with a fresh fingerprint on next use.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleStealthBrowse(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const url = input.url as string;
  const waitFor = (input.wait_for as string) ?? "domcontentloaded";
  const humanDelay = (input.human_delay as boolean) ?? true;
  const rotateFingerprint = (input.rotate_fingerprint as boolean) ?? isFirstBrowse;
  const takeScreenshot = (input.screenshot as boolean) ?? false;

  try {
    await ensureStealthBrowser(rotateFingerprint);
    isFirstBrowse = false;

    if (humanDelay) {
      await humanLikeBrowse(stealthPage, url);
    } else {
      await stealthPage.goto(url, {
        waitUntil: waitFor === "networkidle"
          ? "networkidle"
          : waitFor === "load"
            ? "load"
            : "domcontentloaded",
        timeout: 45_000,
      });
    }

    const title = await stealthPage.title();
    const text = await stealthPage.innerText("body").catch(() => "(could not extract text)");
    const truncated = text.length > 10_000
      ? text.slice(0, 10_000) + "\n...[truncated]"
      : text;

    let output = `Page: ${title}\nURL: ${stealthPage.url()}\nStealth: active | Fingerprint: ${rotateFingerprint ? "rotated" : "reused"}\n\n${truncated}`;

    if (interceptPatterns.length > 0) {
      output += `\n\n[Network interception active: ${interceptedData.length} responses captured]`;
    }

    if (takeScreenshot) {
      await mkdir(SCREENSHOTS_DIR, { recursive: true });
      const screenshotPath = resolve(SCREENSHOTS_DIR, `stealth-${Date.now()}.png`);
      await stealthPage.screenshot({ path: screenshotPath });
      output += `\n\n${imageMarker(screenshotPath, title)}`;
    }

    return { success: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Stealth browse failed: ${msg}` };
  }
}

export async function handleInterceptNetwork(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const patterns = (input.patterns as string[]) ?? [];
  const clearExisting = (input.clear_existing as boolean) ?? false;

  if (patterns.length === 0) {
    return { success: false, output: "At least one URL pattern is required." };
  }

  if (clearExisting) {
    interceptPatterns = [];
    interceptedData.length = 0;
  }

  // Add new patterns (dedup)
  const existingSet = new Set(interceptPatterns);
  for (const p of patterns) {
    if (!existingSet.has(p)) {
      interceptPatterns.push(p);
    }
  }

  // If browser is already running, attach interception to current page
  if (stealthPage && !stealthPage.isClosed()) {
    attachNetworkInterception(stealthPage);
  }

  return {
    success: true,
    output: `Network interception active. Patterns: ${interceptPatterns.join(", ")}\nCapture will begin on next page load. ${interceptedData.length} responses already captured.`,
  };
}

export async function handleGetInterceptedData(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const filterUrl = input.filter_url as string | undefined;
  const limit = Math.min((input.limit as number) ?? 20, MAX_INTERCEPTED);
  const jsonOnly = (input.json_only as boolean) ?? true;

  if (interceptedData.length === 0) {
    return {
      success: true,
      output: interceptPatterns.length === 0
        ? "No interception patterns set. Use intercept_network first."
        : "No responses captured yet. Navigate to a page to trigger API calls.",
    };
  }

  let results = [...interceptedData];

  if (filterUrl) {
    results = results.filter((r) => r.url.includes(filterUrl));
  }

  if (jsonOnly) {
    results = results.filter((r) => r.contentType.includes("json"));
  }

  results = results.slice(-limit); // Most recent N

  const formatted = results.map((r, i) => {
    const bodyPreview = r.body.length > 5000
      ? r.body.slice(0, 5000) + "\n...[truncated, full body available]"
      : r.body;
    return `--- Response ${i + 1} ---\n${r.method} ${r.url}\nStatus: ${r.status} | Type: ${r.contentType}\n${bodyPreview}`;
  });

  return {
    success: true,
    output: `${results.length} intercepted response(s) (${interceptedData.length} total captured):\n\n${formatted.join("\n\n")}`,
  };
}

export async function handleStealthScroll(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const scrolls = (input.scrolls as number) ?? 3;
  const direction = (input.direction as string as "down" | "up") ?? "down";
  const screenshotAfter = (input.screenshot_after as boolean) ?? false;

  try {
    if (!stealthPage || stealthPage.isClosed()) {
      return { success: false, output: "No stealth browser session active. Use stealth_browse first." };
    }

    resetStealthIdleTimer();
    await humanMouseMove(stealthPage);
    await humanScroll(stealthPage, scrolls, direction);

    let output = `Scrolled ${direction} ${scrolls} times with human-like behavior.`;

    if (interceptPatterns.length > 0) {
      output += ` | ${interceptedData.length} API responses captured.`;
    }

    if (screenshotAfter) {
      await mkdir(SCREENSHOTS_DIR, { recursive: true });
      const screenshotPath = resolve(SCREENSHOTS_DIR, `stealth-scroll-${Date.now()}.png`);
      await stealthPage.screenshot({ path: screenshotPath });
      output += `\n\n${imageMarker(screenshotPath, "after scroll")}`;
    }

    return { success: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Stealth scroll failed: ${msg}` };
  }
}

export async function handleStealthClose(): Promise<ToolResult> {
  isFirstBrowse = true;
  await closeStealthInstance();
  return { success: true, output: "Stealth browser closed. Fingerprint and intercepted data cleared." };
}
