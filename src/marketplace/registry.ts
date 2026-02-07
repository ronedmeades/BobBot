/**
 * Marketplace Adapter Registry
 *
 * Manages built-in + local marketplace adapters.
 * Built-in: eBay, Etsy, Poshmark
 * Local: auto-discovered from local/skills/ (export marketplaceAdapter)
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AdapterFactory, MarketplaceAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const factories = new Map<string, AdapterFactory>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerAdapter(factory: AdapterFactory): void {
  factories.set(factory.platform, factory);
}

export function getAdapter(platform: string): MarketplaceAdapter | null {
  const factory = factories.get(platform);
  if (!factory) return null;
  return factory.create();
}

export function listAdapters(): Array<{
  platform: string;
  displayName: string;
  configured: boolean;
  requiredEnvVars: string[];
  notes?: string;
}> {
  return [...factories.values()].map((f) => ({
    platform: f.platform,
    displayName: f.displayName,
    configured: f.create().isConfigured(),
    requiredEnvVars: f.requiredEnvVars,
    notes: f.notes,
  }));
}

export function getConfiguredAdapters(): MarketplaceAdapter[] {
  return [...factories.values()]
    .map((f) => f.create())
    .filter((a) => a.isConfigured());
}

export function hasAdapter(platform: string): boolean {
  return factories.has(platform);
}

// ---------------------------------------------------------------------------
// Initialization — register built-in + discover local adapters
// ---------------------------------------------------------------------------

export async function initMarketplaceAdapters(): Promise<void> {
  // Register built-in adapters
  const { ebayAdapterFactory } = await import("./adapters/ebay.js");
  const { etsyAdapterFactory } = await import("./adapters/etsy.js");
  const { poshmarkAdapterFactory } = await import("./adapters/poshmark.js");

  registerAdapter(ebayAdapterFactory);
  registerAdapter(etsyAdapterFactory);
  registerAdapter(poshmarkAdapterFactory);

  // Discover local marketplace adapters
  await discoverLocalAdapters();

  const adapters = listAdapters();
  const configured = adapters.filter((a) => a.configured).map((a) => a.displayName);
  console.log(
    `[marketplace] ${adapters.length} platforms registered` +
    (configured.length > 0 ? ` (${configured.join(", ")} configured)` : " (none configured)")
  );
}

// ---------------------------------------------------------------------------
// Local adapter discovery
// ---------------------------------------------------------------------------

async function discoverLocalAdapters(): Promise<void> {
  const localDir = resolve("local/skills");

  let files: string[];
  try {
    files = await readdir(localDir);
  } catch {
    return; // No local skills directory
  }

  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
    if (file.startsWith("_")) continue;

    try {
      const modulePath = resolve(localDir, file);
      const mod = await import(`file://${modulePath.replace(/\\/g, "/")}?t=${Date.now()}`);

      if (mod.marketplaceAdapter && typeof mod.marketplaceAdapter === "object") {
        const factory = mod.marketplaceAdapter as AdapterFactory;
        if (factory.platform && typeof factory.create === "function") {
          registerAdapter(factory);
          console.log(`[marketplace] Loaded local adapter: ${factory.displayName} (${factory.platform})`);
        }
      }
    } catch {
      // Not a marketplace adapter — skip silently
    }
  }
}
