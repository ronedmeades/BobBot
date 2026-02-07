/**
 * Marketplace Skill — Unified tools for cross-platform marketplace operations.
 *
 * Orders, messaging, fulfillment across eBay, Etsy, Poshmark, and local adapters.
 */

import type { ToolDefinition } from "../providers/types.js";
import {
  getAdapter,
  listAdapters,
  getConfiguredAdapters,
  hasAdapter,
} from "../marketplace/registry.js";
import type { MarketplaceOrder, MarketplaceMessage, ToolResult } from "../marketplace/types.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const marketplaceToolDefinitions: ToolDefinition[] = [
  {
    name: "marketplace_list_platforms",
    description:
      "List all registered marketplace platforms and whether they are configured. Shows which platforms Bob can interact with and what env vars are needed for unconfigured ones.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "marketplace_test_connection",
    description:
      "Test API connectivity for a specific marketplace platform. Use this to verify credentials are working.",
    input_schema: {
      type: "object" as const,
      properties: {
        platform: {
          type: "string",
          description: "Platform to test (e.g. 'ebay', 'etsy')",
        },
      },
      required: ["platform"],
    },
  },
  {
    name: "marketplace_get_orders",
    description:
      "Get recent orders from one or all configured marketplace platforms. Returns normalized order data with buyer info, items, totals, and status.",
    input_schema: {
      type: "object" as const,
      properties: {
        platform: {
          type: "string",
          description: "Specific platform (e.g. 'ebay', 'etsy'). Omit to get orders from all configured platforms.",
        },
        status: {
          type: "string",
          enum: ["pending", "paid", "shipped", "delivered", "cancelled", "refunded"],
          description: "Filter by order status (e.g. 'paid' for awaiting shipment)",
        },
        limit: {
          type: "number",
          description: "Max orders to return (default: 20)",
        },
        days_back: {
          type: "number",
          description: "Only return orders from the last N days",
        },
      },
      required: [],
    },
  },
  {
    name: "marketplace_get_order",
    description:
      "Get detailed information about a specific order including buyer address, items, tracking, and full status.",
    input_schema: {
      type: "object" as const,
      properties: {
        platform: {
          type: "string",
          description: "Platform the order is on (e.g. 'ebay', 'etsy')",
        },
        order_id: {
          type: "string",
          description: "The order/receipt ID",
        },
      },
      required: ["platform", "order_id"],
    },
  },
  {
    name: "marketplace_ship_order",
    description:
      "Mark an order as shipped with carrier and tracking number. Updates the marketplace so the buyer gets a shipping notification.",
    input_schema: {
      type: "object" as const,
      properties: {
        platform: {
          type: "string",
          description: "Platform (e.g. 'ebay', 'etsy')",
        },
        order_id: {
          type: "string",
          description: "The order ID to mark as shipped",
        },
        carrier: {
          type: "string",
          description: "Shipping carrier (e.g. 'USPS', 'UPS', 'FedEx', 'Royal Mail')",
        },
        tracking_number: {
          type: "string",
          description: "The tracking number",
        },
      },
      required: ["platform", "order_id", "carrier", "tracking_number"],
    },
  },
  {
    name: "marketplace_get_messages",
    description:
      "Get buyer messages from a marketplace platform. Returns message history with sender, subject, and body.",
    input_schema: {
      type: "object" as const,
      properties: {
        platform: {
          type: "string",
          description: "Platform to get messages from (e.g. 'ebay'). Omit for all platforms.",
        },
        unread_only: {
          type: "boolean",
          description: "Only return unread messages (default: false)",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "marketplace_send_message",
    description:
      "Send a message to a buyer through a marketplace's internal messaging system. The message is sent through the platform (e.g. eBay's member-to-member messaging), not via email.",
    input_schema: {
      type: "object" as const,
      properties: {
        platform: {
          type: "string",
          description: "Platform to send through (e.g. 'ebay')",
        },
        recipient: {
          type: "string",
          description: "Buyer's username on the platform",
        },
        body: {
          type: "string",
          description: "Message body text",
        },
        order_id: {
          type: "string",
          description: "Order ID to link the message to (optional but recommended)",
        },
        item_id: {
          type: "string",
          description: "Item/listing ID to link the message to (required for eBay if no order_id)",
        },
        subject: {
          type: "string",
          description: "Message subject (optional, some platforms ignore this)",
        },
      },
      required: ["platform", "recipient", "body"],
    },
  },
  {
    name: "marketplace_order_summary",
    description:
      "Quick dashboard summary: order counts by platform and status. Great for morning briefings or checking what needs attention.",
    input_schema: {
      type: "object" as const,
      properties: {
        days_back: {
          type: "number",
          description: "Look back this many days (default: 30)",
        },
      },
      required: [],
    },
  },
  {
    name: "marketplace_get_unshipped",
    description:
      "Get all orders awaiting shipment across all configured marketplaces. Shortcut for marketplace_get_orders with status='paid'.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max orders per platform (default: 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "marketplace_bulk_ship",
    description:
      "Mark multiple orders as shipped in one go. Provide an array of orders with their tracking info. Returns a summary of successes and failures.",
    input_schema: {
      type: "object" as const,
      properties: {
        orders: {
          type: "array",
          items: {
            type: "object",
            properties: {
              platform: { type: "string", description: "Platform (e.g. 'ebay')" },
              order_id: { type: "string", description: "Order ID" },
              carrier: { type: "string", description: "Carrier name" },
              tracking_number: { type: "string", description: "Tracking number" },
            },
            required: ["platform", "order_id", "carrier", "tracking_number"],
          },
          description: "Array of orders to mark as shipped",
        },
      },
      required: ["orders"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleMarketplaceListPlatforms(): Promise<ToolResult> {
  const platforms = listAdapters();

  if (platforms.length === 0) {
    return { success: true, output: "No marketplace platforms registered." };
  }

  const lines = platforms.map((p) => {
    const status = p.configured ? "configured" : "not configured";
    const envHint = !p.configured && p.requiredEnvVars.length > 0
      ? ` (needs: ${p.requiredEnvVars.join(", ")})`
      : "";
    return `- ${p.displayName} (${p.platform}): ${status}${envHint}`;
  });

  const configured = platforms.filter((p) => p.configured);

  return {
    success: true,
    output: `Marketplace Platforms (${platforms.length} registered, ${configured.length} configured):\n\n${lines.join("\n")}`,
  };
}

export async function handleMarketplaceTestConnection(input: Record<string, unknown>): Promise<ToolResult> {
  const platform = input.platform as string;
  if (!platform) return { success: false, output: "platform is required" };

  if (!hasAdapter(platform)) {
    return { success: false, output: `Unknown platform: "${platform}". Use marketplace_list_platforms to see available platforms.` };
  }

  const adapter = getAdapter(platform)!;
  if (!adapter.isConfigured()) {
    const factory = listAdapters().find((a) => a.platform === platform);
    const envHint = factory?.requiredEnvVars.length
      ? ` Set these env vars: ${factory.requiredEnvVars.join(", ")}`
      : "";
    return { success: false, output: `${adapter.displayName} is not configured.${envHint}` };
  }

  const result = await adapter.testConnection();
  if (result.success) {
    return { success: true, output: `${adapter.displayName} connection successful!` };
  }
  return { success: false, output: `${adapter.displayName} connection failed: ${result.error}` };
}

export async function handleMarketplaceGetOrders(input: Record<string, unknown>): Promise<ToolResult> {
  const platform = input.platform as string | undefined;
  const status = input.status as string | undefined;
  const limit = (input.limit as number) ?? 20;
  const daysBack = input.days_back as number | undefined;

  const opts = {
    status: status as MarketplaceOrder["status"] | undefined,
    limit,
    daysBack,
  };

  try {
    let orders: MarketplaceOrder[];

    if (platform) {
      const adapter = getAdapter(platform);
      if (!adapter) return { success: false, output: `Unknown platform: "${platform}"` };
      if (!adapter.isConfigured()) return { success: false, output: `${adapter.displayName} is not configured.` };
      orders = await adapter.getOrders(opts);
    } else {
      // All configured platforms
      const adapters = getConfiguredAdapters();
      if (adapters.length === 0) return { success: true, output: "No marketplace platforms configured." };
      const results = await Promise.allSettled(adapters.map((a) => a.getOrders(opts)));
      orders = results
        .filter((r): r is PromiseFulfilledResult<MarketplaceOrder[]> => r.status === "fulfilled")
        .flatMap((r) => r.value);
    }

    if (orders.length === 0) {
      return { success: true, output: `No orders found${status ? ` with status "${status}"` : ""}.` };
    }

    const lines = orders.map((o) => formatOrder(o, false));
    return { success: true, output: `Orders (${orders.length}):\n\n${lines.join("\n\n")}` };
  } catch (err) {
    return { success: false, output: `Failed to get orders: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMarketplaceGetOrder(input: Record<string, unknown>): Promise<ToolResult> {
  const platform = input.platform as string;
  const orderId = input.order_id as string;
  if (!platform || !orderId) return { success: false, output: "platform and order_id are required" };

  const adapter = getAdapter(platform);
  if (!adapter) return { success: false, output: `Unknown platform: "${platform}"` };
  if (!adapter.isConfigured()) return { success: false, output: `${adapter.displayName} is not configured.` };

  try {
    const order = await adapter.getOrder(orderId);
    if (!order) return { success: false, output: `Order ${orderId} not found on ${adapter.displayName}.` };
    return { success: true, output: formatOrder(order, true) };
  } catch (err) {
    return { success: false, output: `Failed to get order: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMarketplaceShipOrder(input: Record<string, unknown>): Promise<ToolResult> {
  const platform = input.platform as string;
  const orderId = input.order_id as string;
  const carrier = input.carrier as string;
  const trackingNumber = input.tracking_number as string;

  if (!platform || !orderId || !carrier || !trackingNumber) {
    return { success: false, output: "platform, order_id, carrier, and tracking_number are all required" };
  }

  const adapter = getAdapter(platform);
  if (!adapter) return { success: false, output: `Unknown platform: "${platform}"` };
  if (!adapter.isConfigured()) return { success: false, output: `${adapter.displayName} is not configured.` };

  return adapter.markShipped({ orderId, carrier, trackingNumber });
}

export async function handleMarketplaceGetMessages(input: Record<string, unknown>): Promise<ToolResult> {
  const platform = input.platform as string | undefined;
  const unreadOnly = (input.unread_only as boolean) ?? false;
  const limit = (input.limit as number) ?? 20;

  try {
    if (platform) {
      const adapter = getAdapter(platform);
      if (!adapter) return { success: false, output: `Unknown platform: "${platform}"` };
      if (!adapter.isConfigured()) return { success: false, output: `${adapter.displayName} is not configured.` };

      const messages = await adapter.getMessages({ unreadOnly, limit });
      if (messages.length === 0) return { success: true, output: `No messages on ${adapter.displayName}.` };

      const lines = messages.map(formatMessage);
      return { success: true, output: `${adapter.displayName} Messages (${messages.length}):\n\n${lines.join("\n\n")}` };
    }

    // All platforms
    const adapters = getConfiguredAdapters();
    if (adapters.length === 0) return { success: true, output: "No marketplace platforms configured." };

    const allMessages: string[] = [];
    for (const adapter of adapters) {
      try {
        const messages = await adapter.getMessages({ unreadOnly, limit });
        if (messages.length > 0) {
          allMessages.push(
            `**${adapter.displayName}** (${messages.length}):\n${messages.map(formatMessage).join("\n\n")}`
          );
        }
      } catch (err) {
        allMessages.push(`**${adapter.displayName}**: ${err instanceof Error ? err.message : "error"}`);
      }
    }

    return {
      success: true,
      output: allMessages.length > 0 ? allMessages.join("\n\n---\n\n") : "No messages across any platform.",
    };
  } catch (err) {
    return { success: false, output: `Failed to get messages: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMarketplaceSendMessage(input: Record<string, unknown>): Promise<ToolResult> {
  const platform = input.platform as string;
  const recipient = input.recipient as string;
  const body = input.body as string;
  const orderId = input.order_id as string | undefined;
  const itemId = input.item_id as string | undefined;
  const subject = input.subject as string | undefined;

  if (!platform || !recipient || !body) {
    return { success: false, output: "platform, recipient, and body are required" };
  }

  const adapter = getAdapter(platform);
  if (!adapter) return { success: false, output: `Unknown platform: "${platform}"` };
  if (!adapter.isConfigured()) return { success: false, output: `${adapter.displayName} is not configured.` };

  return adapter.sendMessage({
    recipientUsername: recipient,
    body,
    orderId,
    itemId,
    subject,
  });
}

export async function handleMarketplaceOrderSummary(input: Record<string, unknown>): Promise<ToolResult> {
  const daysBack = (input.days_back as number) ?? 30;
  const adapters = getConfiguredAdapters();

  if (adapters.length === 0) {
    return { success: true, output: "No marketplace platforms configured." };
  }

  const sections: string[] = [];

  for (const adapter of adapters) {
    try {
      const orders = await adapter.getOrders({ daysBack, limit: 100 });
      const statusCounts = new Map<string, number>();
      let totalRevenue = 0;
      let currency = "USD";

      for (const order of orders) {
        statusCounts.set(order.status, (statusCounts.get(order.status) ?? 0) + 1);
        totalRevenue += order.total.amount;
        currency = order.total.currency;
      }

      const statusLines = [...statusCounts.entries()]
        .map(([s, c]) => `  ${s}: ${c}`)
        .join("\n");

      sections.push(
        `**${adapter.displayName}** (${orders.length} orders, last ${daysBack} days)\n` +
        `  Revenue: ${currency} ${totalRevenue.toFixed(2)}\n` +
        statusLines
      );
    } catch (err) {
      sections.push(`**${adapter.displayName}**: Error - ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { success: true, output: `Order Summary:\n\n${sections.join("\n\n")}` };
}

export async function handleMarketplaceGetUnshipped(input: Record<string, unknown>): Promise<ToolResult> {
  const limit = (input.limit as number) ?? 50;
  const adapters = getConfiguredAdapters();

  if (adapters.length === 0) {
    return { success: true, output: "No marketplace platforms configured." };
  }

  const allOrders: MarketplaceOrder[] = [];
  const errors: string[] = [];

  for (const adapter of adapters) {
    try {
      const orders = await adapter.getOrders({ status: "paid", limit });
      allOrders.push(...orders);
    } catch (err) {
      errors.push(`${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (allOrders.length === 0 && errors.length === 0) {
    return { success: true, output: "No unshipped orders across any platform!" };
  }

  const lines = allOrders.map((o) => formatOrder(o, false));
  let output = `Unshipped Orders (${allOrders.length}):\n\n${lines.join("\n\n")}`;

  if (errors.length > 0) {
    output += `\n\nErrors:\n${errors.join("\n")}`;
  }

  return { success: true, output };
}

export async function handleMarketplaceBulkShip(input: Record<string, unknown>): Promise<ToolResult> {
  const orders = input.orders as Array<{
    platform: string;
    order_id: string;
    carrier: string;
    tracking_number: string;
  }>;

  if (!orders || !Array.isArray(orders) || orders.length === 0) {
    return { success: false, output: "orders array is required and must not be empty" };
  }

  const results: string[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const order of orders) {
    const adapter = getAdapter(order.platform);
    if (!adapter || !adapter.isConfigured()) {
      results.push(`[FAIL] ${order.platform} #${order.order_id}: Platform not available`);
      failed++;
      continue;
    }

    const result = await adapter.markShipped({
      orderId: order.order_id,
      carrier: order.carrier,
      trackingNumber: order.tracking_number,
    });

    if (result.success) {
      results.push(`[OK] ${order.platform} #${order.order_id}: ${order.carrier} ${order.tracking_number}`);
      succeeded++;
    } else {
      results.push(`[FAIL] ${order.platform} #${order.order_id}: ${result.output}`);
      failed++;
    }
  }

  return {
    success: failed === 0,
    output: `Bulk Ship Results: ${succeeded} succeeded, ${failed} failed\n\n${results.join("\n")}`,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatOrder(order: MarketplaceOrder, detailed: boolean): string {
  const platform = order.platform.charAt(0).toUpperCase() + order.platform.slice(1);
  const items = order.items.map((i) => `  - ${i.title} x${i.quantity} (${i.price.currency} ${i.price.amount.toFixed(2)})`).join("\n");
  const tracking = order.tracking
    ? `\n  Tracking: ${order.tracking.carrier} ${order.tracking.trackingNumber}`
    : "";

  let output = `[${platform}] Order #${order.id} - ${order.status.toUpperCase()}\n` +
    `  Buyer: ${order.buyer.username}${order.buyer.name ? ` (${order.buyer.name})` : ""}\n` +
    `  Total: ${order.total.currency} ${order.total.amount.toFixed(2)}\n` +
    `  Date: ${order.createdAt}${tracking}\n` +
    `  Items:\n${items}`;

  if (detailed && order.buyer.address) {
    const a = order.buyer.address;
    output += `\n  Ship to: ${a.name}, ${a.street1}${a.street2 ? ` ${a.street2}` : ""}, ${a.city}, ${a.state} ${a.postalCode}, ${a.country}`;
  }

  if (detailed && order.buyer.email) {
    output += `\n  Buyer email: ${order.buyer.email}`;
  }

  return output;
}

function formatMessage(msg: MarketplaceMessage): string {
  const dir = msg.direction === "incoming" ? "FROM" : "TO";
  const read = msg.read ? "" : " [UNREAD]";
  const subject = msg.subject ? `\n  Subject: ${msg.subject}` : "";
  return `[${dir}] ${msg.sender}${read} (${msg.timestamp})${subject}\n  ${msg.body.slice(0, 200)}${msg.body.length > 200 ? "..." : ""}`;
}
