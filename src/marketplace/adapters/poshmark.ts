/**
 * Poshmark Marketplace Adapter — Stub
 *
 * Poshmark does NOT have any public or private API as of February 2026.
 * Unlike Depop (which has a private partner API) or eBay/Etsy (which have
 * public APIs), Poshmark offers no programmatic access at all.
 *
 * Options for Poshmark sellers:
 *   1. Use Bob's browser automation (Playwright) to navigate poshmark.com
 *      and perform actions like listing, checking orders, messaging buyers.
 *      This works but is fragile — Poshmark can change their UI at any time.
 *   2. Use a third-party service like Vendoo, List Perfectly, or Crosslist
 *      that supports Poshmark cross-listing (they use browser automation too).
 *   3. Manage Poshmark manually and use Bob for other platforms.
 *
 * If Poshmark ever releases an API, create a local adapter in
 * local/skills/poshmark-marketplace.ts exporting a marketplaceAdapter.
 */

import type {
  MarketplaceAdapter,
  MarketplaceOrder,
  MarketplaceMessage,
  OrderFilter,
  MessageFilter,
  FulfillmentInput,
  SendMessageInput,
  ToolResult,
  AdapterFactory,
} from "../types.js";

const STUB_MSG =
  "Poshmark does NOT have any API (public or private) as of February 2026.\n\n" +
  "Unlike eBay/Etsy (public APIs) or Depop (private partner API), Poshmark offers " +
  "no programmatic access at all.\n\n" +
  "Options:\n" +
  "1. Use Bob's browser automation (browse_url, click_element, type_into) to navigate poshmark.com — " +
  "this works but is fragile since Poshmark can change their UI\n" +
  "2. Use a cross-listing service like Vendoo, List Perfectly, or Crosslist that supports Poshmark\n" +
  "3. Manage Poshmark manually and use Bob for eBay/Etsy/Depop\n\n" +
  "If Poshmark ever releases an API, a local adapter can be created in local/skills/poshmark-marketplace.ts";

class PoshmarkStubAdapter implements MarketplaceAdapter {
  readonly platform = "poshmark" as const;
  readonly displayName = "Poshmark";

  isConfigured(): boolean {
    return false;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: STUB_MSG };
  }

  async getOrders(_opts?: OrderFilter): Promise<MarketplaceOrder[]> {
    throw new Error(STUB_MSG);
  }

  async getOrder(_orderId: string): Promise<MarketplaceOrder | null> {
    throw new Error(STUB_MSG);
  }

  async markShipped(_input: FulfillmentInput): Promise<ToolResult> {
    return { success: false, output: STUB_MSG };
  }

  async getMessages(_opts?: MessageFilter): Promise<MarketplaceMessage[]> {
    throw new Error(STUB_MSG);
  }

  async sendMessage(_input: SendMessageInput): Promise<ToolResult> {
    return { success: false, output: STUB_MSG };
  }
}

export const poshmarkAdapterFactory: AdapterFactory = {
  platform: "poshmark",
  displayName: "Poshmark",
  requiredEnvVars: [],
  notes:
    "STUB: Poshmark has NO API (public or private) as of Feb 2026. " +
    "Options: browser automation via Bob's Playwright tools, cross-listing services (Vendoo, List Perfectly, Crosslist), " +
    "or manual management. If Poshmark ever releases an API, create a local adapter in local/skills/.",
  create: () => new PoshmarkStubAdapter(),
};
