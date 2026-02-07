/**
 * Etsy Marketplace Adapter
 *
 * Orders via Etsy v3 REST API (Receipts), fulfillment via tracking endpoint.
 * Messages: limited in Etsy v3 API, returns informative guidance.
 *
 * Requires: ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_REFRESH_TOKEN, ETSY_SHOP_ID
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
  OrderStatus,
  OrderItem,
  ShippingAddress,
} from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface EtsyConfig {
  apiKey: string;
  sharedSecret: string;
  refreshToken: string;
  shopId: string;
}

function getEtsyConfig(): EtsyConfig {
  const apiKey = process.env.ETSY_API_KEY ?? "";
  const sharedSecret = process.env.ETSY_SHARED_SECRET ?? "";
  const refreshToken = process.env.ETSY_REFRESH_TOKEN ?? "";
  const shopId = process.env.ETSY_SHOP_ID ?? "";

  if (!apiKey || !sharedSecret || !refreshToken || !shopId) {
    throw new Error(
      "Etsy credentials not configured. Set ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_REFRESH_TOKEN, and ETSY_SHOP_ID in .env"
    );
  }

  return { apiKey, sharedSecret, refreshToken, shopId };
}

// ---------------------------------------------------------------------------
// Auth — Etsy OAuth2 (body params, not Basic header)
// ---------------------------------------------------------------------------

async function getEtsyAccessToken(config: EtsyConfig): Promise<string> {
  const response = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.apiKey,
      refresh_token: config.refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Etsy OAuth failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { access_token: string; refresh_token?: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const ETSY_BASE = "https://openapi.etsy.com/v3";

async function etsyGet(path: string, token: string, apiKey: string): Promise<unknown> {
  const response = await fetch(`${ETSY_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": apiKey,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Etsy API error (${response.status}): ${text}`);
  }
  return response.json();
}

async function etsyPost(
  path: string,
  token: string,
  apiKey: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`${ETSY_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Etsy API error (${response.status}): ${text}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// Etsy response types
// ---------------------------------------------------------------------------

interface EtsyReceipt {
  receipt_id: number;
  buyer_user_id: number;
  buyer_email: string;
  name: string;
  status: string; // "paid", "completed", "open", "cancelled"
  transactions: Array<{
    transaction_id: number;
    title: string;
    quantity: number;
    price: { amount: number; divisor: number; currency_code: string };
    listing_id: number;
    sku?: string;
    image_listing_id?: number;
  }>;
  formatted_address: string;
  first_line?: string;
  second_line?: string;
  city?: string;
  state?: string;
  zip?: string;
  country_iso?: string;
  grandtotal: { amount: number; divisor: number; currency_code: string };
  create_timestamp: number;
  update_timestamp: number;
  is_shipped: boolean;
  shipments?: Array<{
    carrier_name: string;
    tracking_code: string;
  }>;
}

interface EtsyReceiptsResponse {
  count: number;
  results: EtsyReceipt[];
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function mapEtsyStatus(receipt: EtsyReceipt): OrderStatus {
  if (receipt.status === "cancelled") return "cancelled";
  if (receipt.is_shipped) return "shipped";
  if (receipt.status === "paid" || receipt.status === "open") return "paid";
  if (receipt.status === "completed") return "delivered";
  return "pending";
}

function normalizeEtsyOrder(receipt: EtsyReceipt): MarketplaceOrder {
  const address: ShippingAddress | undefined = receipt.first_line
    ? {
        name: receipt.name,
        street1: receipt.first_line,
        street2: receipt.second_line,
        city: receipt.city ?? "",
        state: receipt.state ?? "",
        postalCode: receipt.zip ?? "",
        country: receipt.country_iso ?? "",
      }
    : undefined;

  const items: OrderItem[] = receipt.transactions.map((t) => ({
    title: t.title,
    sku: t.sku,
    quantity: t.quantity,
    price: {
      amount: t.price.amount / t.price.divisor,
      currency: t.price.currency_code,
    },
    platformItemId: String(t.listing_id),
  }));

  const tracking = receipt.shipments?.[0];

  return {
    id: String(receipt.receipt_id),
    platform: "etsy",
    status: mapEtsyStatus(receipt),
    buyer: {
      username: String(receipt.buyer_user_id),
      name: receipt.name,
      email: receipt.buyer_email,
      address,
    },
    items,
    total: {
      amount: receipt.grandtotal.amount / receipt.grandtotal.divisor,
      currency: receipt.grandtotal.currency_code,
    },
    createdAt: new Date(receipt.create_timestamp * 1000).toISOString(),
    tracking: tracking
      ? { carrier: tracking.carrier_name, trackingNumber: tracking.tracking_code }
      : undefined,
    raw: receipt as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

class EtsyMarketplaceAdapter implements MarketplaceAdapter {
  readonly platform = "etsy" as const;
  readonly displayName = "Etsy";

  isConfigured(): boolean {
    try {
      getEtsyConfig();
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = getEtsyConfig();
      const token = await getEtsyAccessToken(config);
      // Ping the shop endpoint
      await etsyGet(`/application/shops/${config.shopId}`, token, config.apiKey);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getOrders(opts?: OrderFilter): Promise<MarketplaceOrder[]> {
    const config = getEtsyConfig();
    const token = await getEtsyAccessToken(config);
    const limit = opts?.limit ?? 25;

    let statusFilter = "";
    if (opts?.status === "paid") statusFilter = "&was_shipped=false&was_paid=true";
    else if (opts?.status === "shipped") statusFilter = "&was_shipped=true";

    const data = (await etsyGet(
      `/application/shops/${config.shopId}/receipts?limit=${limit}${statusFilter}&sort_on=created&sort_order=desc`,
      token,
      config.apiKey,
    )) as EtsyReceiptsResponse;

    let orders = data.results.map(normalizeEtsyOrder);

    // Filter by days back if specified
    if (opts?.daysBack) {
      const cutoff = Date.now() - opts.daysBack * 24 * 60 * 60 * 1000;
      orders = orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
    }

    return orders;
  }

  async getOrder(orderId: string): Promise<MarketplaceOrder | null> {
    try {
      const config = getEtsyConfig();
      const token = await getEtsyAccessToken(config);
      const data = (await etsyGet(
        `/application/shops/${config.shopId}/receipts/${orderId}`,
        token,
        config.apiKey,
      )) as EtsyReceipt;
      return normalizeEtsyOrder(data);
    } catch {
      return null;
    }
  }

  async markShipped(input: FulfillmentInput): Promise<ToolResult> {
    try {
      const config = getEtsyConfig();
      const token = await getEtsyAccessToken(config);

      await etsyPost(
        `/application/shops/${config.shopId}/receipts/${input.orderId}/tracking`,
        token,
        config.apiKey,
        {
          carrier_name: input.carrier,
          tracking_code: input.trackingNumber,
          send_bcc: false,
        },
      );

      return {
        success: true,
        output: `Etsy order ${input.orderId} marked as shipped via ${input.carrier} (tracking: ${input.trackingNumber})`,
      };
    } catch (err) {
      return {
        success: false,
        output: `Failed to mark Etsy order shipped: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async getMessages(_opts?: MessageFilter): Promise<MarketplaceMessage[]> {
    // Etsy v3 API does not expose a conversations/messages endpoint.
    // Buyer messages are delivered via email and visible in the Etsy seller dashboard.
    throw new Error(
      "Etsy v3 API does not support reading messages programmatically. " +
      "Buyer messages are sent to your email and visible at etsy.com/your/shops/me/conversations. " +
      "Consider using Bob's browser automation (browse_url) to check messages."
    );
  }

  async sendMessage(_input: SendMessageInput): Promise<ToolResult> {
    return {
      success: false,
      output:
        "Etsy v3 API does not support sending messages programmatically. " +
        "To message a buyer, use the Etsy seller dashboard at etsy.com or " +
        "Bob's browser automation (browse_url, type_into) to navigate and send messages.",
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const etsyAdapterFactory: AdapterFactory = {
  platform: "etsy",
  displayName: "Etsy",
  requiredEnvVars: ["ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_REFRESH_TOKEN", "ETSY_SHOP_ID"],
  notes: "Etsy v3 REST API. Orders and fulfillment supported. Messages not available via API (use Etsy dashboard).",
  create: () => new EtsyMarketplaceAdapter(),
};
