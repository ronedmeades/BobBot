/**
 * Depop Marketplace Adapter — Stub
 *
 * Depop has a real Selling API (inventory, orders, offers) but it is
 * PRIVATE / PARTNER-ONLY. Public developers cannot access it without
 * approval from Depop's partnership team.
 *
 * How to get access:
 *   1. Email partnersupport@depop.com requesting Selling API access
 *   2. Explain your use case (e.g. "I sell posters on Depop and want
 *      to manage inventory and orders programmatically via my own tools")
 *   3. Depop will review and respond with next steps
 *   4. Once approved, you'll get API credentials and access to their
 *      sandbox environment for testing
 *
 * API docs (once approved): https://partnerapi.depop.com/api-docs/
 *
 * What the Depop Selling API supports:
 *   - Inventory management: create, update, delete listings
 *   - Order management: retrieve and manage orders, webhooks for real-time updates
 *   - Offers automation: send and respond to offers
 *   - Sandbox environment for testing
 *
 * Until approved, you can use Bob's browser automation tools (browse_url,
 * click_element, type_into) to interact with depop.com directly, or
 * create a local adapter in local/skills/depop-marketplace.ts.
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
  "Depop's Selling API is private/partner-only and requires approval.\n\n" +
  "To get access:\n" +
  "1. Email partnersupport@depop.com requesting Selling API access\n" +
  "2. Explain your use case (e.g. managing inventory and orders for your Depop shop)\n" +
  "3. Wait for Depop to review and approve your request\n" +
  "4. Once approved, you'll receive API credentials\n\n" +
  "API docs (once approved): https://partnerapi.depop.com/api-docs/\n\n" +
  "In the meantime, you can:\n" +
  "- Use Bob's browser automation (browse_url, click_element, type_into) to interact with depop.com\n" +
  "- Create a local adapter in local/skills/depop-marketplace.ts once you have API access";

class DepopStubAdapter implements MarketplaceAdapter {
  readonly platform = "depop" as const;
  readonly displayName = "Depop";

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

export const depopAdapterFactory: AdapterFactory = {
  platform: "depop",
  displayName: "Depop",
  requiredEnvVars: [],
  notes:
    "STUB: Depop has a real Selling API (inventory, orders, offers) but it is private/partner-only. " +
    "Email partnersupport@depop.com to request access. " +
    "Once approved, create a local adapter in local/skills/depop-marketplace.ts with your credentials.",
  create: () => new DepopStubAdapter(),
};
