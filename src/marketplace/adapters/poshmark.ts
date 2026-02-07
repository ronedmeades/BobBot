/**
 * Poshmark Marketplace Adapter — Stub
 *
 * Poshmark does not have a public API. This adapter serves as a template
 * and returns helpful guidance pointing users toward browser automation
 * or a custom local adapter.
 *
 * To build a real Poshmark adapter, create local/skills/poshmark-marketplace.ts
 * exporting a marketplaceAdapter: AdapterFactory that uses Bob's browser
 * automation tools (Playwright) to interact with poshmark.com.
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
  "Poshmark does not have a public API. To interact with Poshmark, you can:\n" +
  "1. Use Bob's browser automation tools (browse_url, click_element, type_into) to navigate poshmark.com\n" +
  "2. Create a local adapter in local/skills/poshmark-marketplace.ts that automates the Poshmark web UI\n" +
  "3. Check poshmark.com manually for now";

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
  notes: "STUB: Poshmark has no public API. Use browser automation or create a local adapter in local/skills/.",
  create: () => new PoshmarkStubAdapter(),
};
