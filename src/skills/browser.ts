import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Lazy-load playwright
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwrightMod: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPlaywright(): Promise<any> {
  if (!playwrightMod) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await (Function('return import("playwright")')() as Promise<any>);
      playwrightMod = mod.default ?? mod;
    } catch {
      throw new Error(
        "playwright is not installed. Run: pnpm add playwright && npx playwright install chromium"
      );
    }
  }
  return playwrightMod;
}

// ---------------------------------------------------------------------------
// Browser singleton with idle timeout
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let page: any = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    await closeBrowserInstance();
  }, IDLE_TIMEOUT_MS);
}

async function ensureBrowser(): Promise<void> {
  const pw = await getPlaywright();
  if (!browser) {
    browser = await pw.chromium.launch({ headless: false });
    console.log("[browser] Chromium launched");
  }
  if (!page || page.isClosed()) {
    const context = await browser.newContext();
    page = await context.newPage();
  }
  resetIdleTimer();
}

async function closeBrowserInstance(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Already closed
    }
    browser = null;
    page = null;
    console.log("[browser] Chromium closed");
  }
}

const SCREENSHOTS_DIR = resolve("memory/screenshots");

async function saveScreenshot(path?: string): Promise<string> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  const filePath = path
    ? resolve(path)
    : resolve(SCREENSHOTS_DIR, `screenshot-${Date.now()}.png`);
  await mkdir(dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath });
  return filePath;
}

function imageMarker(filePath: string, alt: string): string {
  return `![${alt}](/api/image?path=${encodeURIComponent(filePath)})`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const browserToolDefinitions: ToolDefinition[] = [
  {
    name: "browse_url",
    description:
      "Navigate to a URL in a browser and return the page text content. " +
      "Optionally takes a screenshot. Uses a real Chromium browser so it works with " +
      "JavaScript-rendered pages, SPAs, and sites that block simple HTTP requests.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        wait_for: {
          type: "string",
          enum: ["load", "networkidle"],
          description: "Wait strategy: 'load' (default) or 'networkidle' (wait for all network requests to finish)",
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
    name: "click_element",
    description:
      "Click an element on the current page by CSS selector. " +
      "Optionally takes a screenshot after clicking.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element to click (e.g. 'button.submit', '#login-btn', 'a[href=\"/about\"]')",
        },
        screenshot: {
          type: "boolean",
          description: "Take a screenshot after clicking (default: false)",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "type_into",
    description:
      "Type text into an input field on the current page. " +
      "Clears the field first, then types the new text.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the input field",
        },
        text: {
          type: "string",
          description: "Text to type into the field",
        },
        screenshot: {
          type: "boolean",
          description: "Take a screenshot after typing (default: false)",
        },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "extract_content",
    description:
      "Extract text, HTML, or an attribute from elements on the current page. " +
      "If no selector is provided, extracts the full page text.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for elements to extract from. If omitted, extracts full page text.",
        },
        attribute: {
          type: "string",
          description: "Extract a specific attribute (e.g. 'href', 'src', 'value') instead of text content.",
        },
      },
      required: [],
    },
  },
  {
    name: "take_screenshot",
    description: "Take a screenshot of the current browser page.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Where to save the screenshot. Default: memory/screenshots/screenshot-{timestamp}.png",
        },
        full_page: {
          type: "boolean",
          description: "Capture the full scrollable page (default: false — viewport only)",
        },
      },
      required: [],
    },
  },
  {
    name: "close_browser",
    description: "Close the browser instance. It will relaunch automatically on next use.",
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

export async function handleBrowseUrl(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const url = input.url as string;
  const waitFor = (input.wait_for as string) ?? "load";
  const takeScreenshot = (input.screenshot as boolean) ?? false;

  try {
    await ensureBrowser();

    await page.goto(url, {
      waitUntil: waitFor === "networkidle" ? "networkidle" : "load",
      timeout: 30_000,
    });

    const title = await page.title();
    const text = await page.innerText("body").catch(() => "(could not extract text)");
    const truncated = text.length > 10_000
      ? text.slice(0, 10_000) + "\n...[truncated]"
      : text;

    let output = `Page: ${title}\nURL: ${page.url()}\n\n${truncated}`;

    if (takeScreenshot) {
      const screenshotPath = await saveScreenshot();
      output += `\n\n${imageMarker(screenshotPath, title)}`;
    }

    return { success: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Browse failed: ${msg}` };
  }
}

export async function handleClickElement(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const selector = input.selector as string;
  const takeScreenshot = (input.screenshot as boolean) ?? false;

  try {
    await ensureBrowser();
    await page.click(selector, { timeout: 10_000 });

    // Wait a moment for any navigation or rendering
    await page.waitForTimeout(500);

    let output = `Clicked: ${selector}\nCurrent URL: ${page.url()}`;

    if (takeScreenshot) {
      const screenshotPath = await saveScreenshot();
      output += `\n\n${imageMarker(screenshotPath, "after click")}`;
    }

    return { success: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Click failed on "${selector}": ${msg}` };
  }
}

export async function handleTypeInto(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const selector = input.selector as string;
  const text = input.text as string;
  const takeScreenshot = (input.screenshot as boolean) ?? false;

  try {
    await ensureBrowser();
    await page.fill(selector, text, { timeout: 10_000 });

    let output = `Typed into ${selector}: "${text.length > 50 ? text.slice(0, 50) + "..." : text}"`;

    if (takeScreenshot) {
      const screenshotPath = await saveScreenshot();
      output += `\n\n${imageMarker(screenshotPath, "after typing")}`;
    }

    return { success: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Type failed on "${selector}": ${msg}` };
  }
}

export async function handleExtractContent(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const selector = input.selector as string | undefined;
  const attribute = input.attribute as string | undefined;

  try {
    await ensureBrowser();

    if (!selector) {
      const text = await page.innerText("body").catch(() => "(could not extract text)");
      const truncated = text.length > 10_000
        ? text.slice(0, 10_000) + "\n...[truncated]"
        : text;
      return { success: true, output: truncated };
    }

    const elements = await page.$$(selector);
    if (elements.length === 0) {
      return { success: false, output: `No elements found for selector: ${selector}` };
    }

    const results: string[] = [];
    for (const el of elements.slice(0, 50)) {
      if (attribute) {
        const val = await el.getAttribute(attribute);
        if (val) results.push(val);
      } else {
        const text = await el.innerText();
        if (text.trim()) results.push(text.trim());
      }
    }

    if (results.length === 0) {
      return { success: true, output: `Found ${elements.length} element(s) but no content extracted.` };
    }

    return {
      success: true,
      output: `${results.length} result(s) from "${selector}":\n\n${results.join("\n")}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Extract failed: ${msg}` };
  }
}

export async function handleTakeScreenshot(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const customPath = input.path as string | undefined;
  const fullPage = (input.full_page as boolean) ?? false;

  try {
    await ensureBrowser();

    const filePath = customPath ? resolve(customPath) : resolve(SCREENSHOTS_DIR, `screenshot-${Date.now()}.png`);
    await mkdir(dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage });

    return {
      success: true,
      output: `Screenshot saved: ${filePath}\n\n${imageMarker(filePath, "screenshot")}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Screenshot failed: ${msg}` };
  }
}

export async function handleCloseBrowser(): Promise<ToolResult> {
  await closeBrowserInstance();
  return { success: true, output: "Browser closed." };
}
