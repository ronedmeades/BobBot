/**
 * eBay Marketplace Adapter
 *
 * Orders via Fulfillment API, messages via Trading API (XML).
 * Reuses auth from src/skills/ebay-listing.ts.
 */

import {
  getEbayConfig,
  getAccessToken,
  getBaseUrl,
} from "../../skills/ebay-listing.js";
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
  ShippingAddress,
  OrderItem,
} from "../types.js";

// ---------------------------------------------------------------------------
// eBay API helpers
// ---------------------------------------------------------------------------

async function ebayGet(path: string, token: string, env: "sandbox" | "production"): Promise<unknown> {
  const baseUrl = getBaseUrl(env);
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay API error (${response.status}): ${text}`);
  }
  return response.json();
}

async function ebayPost(
  path: string,
  token: string,
  body: unknown,
  env: "sandbox" | "production",
): Promise<unknown> {
  const baseUrl = getBaseUrl(env);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay API error (${response.status}): ${text}`);
  }
  // Some endpoints return empty body on success
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// eBay response types (Fulfillment API)
// ---------------------------------------------------------------------------

interface EbayFulfillmentOrder {
  orderId: string;
  orderFulfillmentStatus: string;
  creationDate: string;
  buyer: { username: string };
  pricingSummary: {
    total: { value: string; currency: string };
    deliveryCost?: { value: string; currency: string };
  };
  lineItems: Array<{
    lineItemId: string;
    title: string;
    sku?: string;
    quantity: number;
    total: { value: string; currency: string };
    image?: { imageUrl: string };
  }>;
  fulfillmentStartInstructions?: Array<{
    shippingStep?: {
      shipTo?: {
        fullName?: string;
        contactAddress?: {
          addressLine1?: string;
          addressLine2?: string;
          city?: string;
          stateOrProvince?: string;
          postalCode?: string;
          countryCode?: string;
        };
      };
    };
  }>;
  fulfillmentHrefs?: string[];
  paidAt?: string;
}

interface EbayOrdersResponse {
  orders?: EbayFulfillmentOrder[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Normalize eBay data to common types
// ---------------------------------------------------------------------------

function mapOrderStatus(ebayStatus: string): OrderStatus {
  switch (ebayStatus) {
    case "NOT_STARTED":
    case "IN_PROGRESS":
      return "paid";
    case "FULFILLED":
      return "shipped";
    default:
      return "paid";
  }
}

function normalizeOrder(order: EbayFulfillmentOrder): MarketplaceOrder {
  const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const addr = shipTo?.contactAddress;

  const address: ShippingAddress | undefined = addr
    ? {
        name: shipTo?.fullName ?? "",
        street1: addr.addressLine1 ?? "",
        street2: addr.addressLine2,
        city: addr.city ?? "",
        state: addr.stateOrProvince ?? "",
        postalCode: addr.postalCode ?? "",
        country: addr.countryCode ?? "",
      }
    : undefined;

  const items: OrderItem[] = order.lineItems.map((li) => ({
    title: li.title,
    sku: li.sku,
    quantity: li.quantity,
    price: { amount: parseFloat(li.total.value), currency: li.total.currency },
    imageUrl: li.image?.imageUrl,
    platformItemId: li.lineItemId,
  }));

  return {
    id: order.orderId,
    platform: "ebay",
    status: mapOrderStatus(order.orderFulfillmentStatus),
    buyer: {
      username: order.buyer.username,
      address,
    },
    items,
    total: {
      amount: parseFloat(order.pricingSummary.total.value),
      currency: order.pricingSummary.total.currency,
    },
    createdAt: order.creationDate,
    paidAt: order.paidAt,
    raw: order as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Trading API XML helpers (for messages)
// ---------------------------------------------------------------------------

function buildTradingXml(callName: string, body: string, token: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  ${body}
</${callName}Request>`;
}

async function tradingApiCall(
  callName: string,
  body: string,
  token: string,
  env: "sandbox" | "production",
): Promise<string> {
  const baseUrl = getBaseUrl(env);
  const xml = buildTradingXml(callName, body, token);

  const response = await fetch(`${baseUrl}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
    },
    body: xml,
  });

  return response.text();
}

function extractXmlValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function extractXmlAll(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

class EbayMarketplaceAdapter implements MarketplaceAdapter {
  readonly platform = "ebay" as const;
  readonly displayName = "eBay";

  isConfigured(): boolean {
    try {
      getEbayConfig();
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = getEbayConfig();
      await getAccessToken(config);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getOrders(opts?: OrderFilter): Promise<MarketplaceOrder[]> {
    const config = getEbayConfig();
    const token = await getAccessToken(config);
    const limit = opts?.limit ?? 20;

    let filter = "";
    const filters: string[] = [];

    if (opts?.status === "paid") {
      filters.push("orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}");
    } else if (opts?.status === "shipped") {
      filters.push("orderfulfillmentstatus:{FULFILLED}");
    }

    if (opts?.daysBack) {
      const since = new Date(Date.now() - opts.daysBack * 24 * 60 * 60 * 1000).toISOString();
      filters.push(`creationdate:[${since}..${new Date().toISOString()}]`);
    }

    if (filters.length > 0) {
      filter = `&filter=${encodeURIComponent(filters.join(","))}`;
    }

    const data = (await ebayGet(
      `/sell/fulfillment/v1/order?limit=${limit}${filter}`,
      token,
      config.environment,
    )) as EbayOrdersResponse;

    return (data.orders ?? []).map(normalizeOrder);
  }

  async getOrder(orderId: string): Promise<MarketplaceOrder | null> {
    try {
      const config = getEbayConfig();
      const token = await getAccessToken(config);
      const data = (await ebayGet(
        `/sell/fulfillment/v1/order/${orderId}`,
        token,
        config.environment,
      )) as EbayFulfillmentOrder;
      return normalizeOrder(data);
    } catch {
      return null;
    }
  }

  async markShipped(input: FulfillmentInput): Promise<ToolResult> {
    try {
      const config = getEbayConfig();
      const token = await getAccessToken(config);

      // Get the order to find line item IDs
      const order = (await ebayGet(
        `/sell/fulfillment/v1/order/${input.orderId}`,
        token,
        config.environment,
      )) as EbayFulfillmentOrder;

      const lineItems = order.lineItems.map((li) => ({
        lineItemId: li.lineItemId,
        quantity: li.quantity,
      }));

      await ebayPost(
        `/sell/fulfillment/v1/order/${input.orderId}/shipping_fulfillment`,
        token,
        {
          lineItems,
          shippedDate: input.shippedDate ?? new Date().toISOString(),
          shippingCarrierCode: input.carrier,
          trackingNumber: input.trackingNumber,
        },
        config.environment,
      );

      return {
        success: true,
        output: `Order ${input.orderId} marked as shipped via ${input.carrier} (tracking: ${input.trackingNumber})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("scope")) {
        return {
          success: false,
          output: `eBay auth error. Your OAuth token may need the sell.fulfillment scope. Re-authorize your eBay app with fulfillment permissions.\n\nError: ${msg}`,
        };
      }
      return { success: false, output: `Failed to mark shipped: ${msg}` };
    }
  }

  async getMessages(opts?: MessageFilter): Promise<MarketplaceMessage[]> {
    try {
      const config = getEbayConfig();
      const token = await getAccessToken(config);
      const limit = opts?.limit ?? 20;

      const folderFilter = opts?.unreadOnly
        ? "<FolderID>0</FolderID>"
        : "";

      const xml = await tradingApiCall(
        "GetMyMessages",
        `<DetailLevel>ReturnMessages</DetailLevel>
         ${folderFilter}
         <Pagination>
           <EntriesPerPage>${limit}</EntriesPerPage>
           <PageNumber>1</PageNumber>
         </Pagination>`,
        token,
        config.environment,
      );

      // Parse messages from XML response
      const messageBlocks = extractXmlAll(xml, "Message");
      const messages: MarketplaceMessage[] = [];

      for (const block of messageBlocks) {
        const id = extractXmlValue(block, "MessageID");
        const sender = extractXmlValue(block, "Sender");
        const subject = extractXmlValue(block, "Subject");
        const body = extractXmlValue(block, "Text") || extractXmlValue(block, "Body");
        const timestamp = extractXmlValue(block, "ReceiveDate") || extractXmlValue(block, "CreationDate");
        const read = extractXmlValue(block, "Read") === "true";
        const itemId = extractXmlValue(block, "ItemID");

        if (id) {
          messages.push({
            id,
            platform: "ebay",
            itemId: itemId || undefined,
            direction: "incoming",
            sender: sender || "unknown",
            recipient: "me",
            subject: subject || undefined,
            body: body || "(no body)",
            timestamp: timestamp || new Date().toISOString(),
            read,
          });
        }
      }

      return messages;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to get eBay messages: ${msg}`);
    }
  }

  async sendMessage(input: SendMessageInput): Promise<ToolResult> {
    try {
      const config = getEbayConfig();
      const token = await getAccessToken(config);

      if (!input.itemId && !input.orderId) {
        return {
          success: false,
          output: "eBay requires an item_id or order_id to send a message. Provide one so the message is linked to the correct transaction.",
        };
      }

      const itemTag = input.itemId
        ? `<ItemID>${input.itemId}</ItemID>`
        : "";

      const xml = await tradingApiCall(
        "AddMemberMessageAAQToPartner",
        `<MemberMessage>
           ${itemTag}
           <Body>${escapeXml(input.body)}</Body>
           <RecipientID>${escapeXml(input.recipientUsername)}</RecipientID>
           <QuestionType>General</QuestionType>
           <Subject>${escapeXml(input.subject ?? "Message from seller")}</Subject>
         </MemberMessage>`,
        token,
        config.environment,
      );

      if (xml.includes("<Ack>Success</Ack>") || xml.includes("<Ack>Warning</Ack>")) {
        return {
          success: true,
          output: `Message sent to ${input.recipientUsername} on eBay.`,
        };
      }

      const errorMsg = extractXmlValue(xml, "ShortMessage") || extractXmlValue(xml, "LongMessage") || "Unknown error";
      return { success: false, output: `eBay message failed: ${errorMsg}` };
    } catch (err) {
      return { success: false, output: `Failed to send eBay message: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Factory export
// ---------------------------------------------------------------------------

export const ebayAdapterFactory: AdapterFactory = {
  platform: "ebay",
  displayName: "eBay",
  requiredEnvVars: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN"],
  create: () => new EbayMarketplaceAdapter(),
};
