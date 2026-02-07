/**
 * Marketplace Abstraction Engine — Core Types
 *
 * Common interfaces for cross-platform marketplace operations:
 * orders, messaging, fulfillment.
 */

// ---------------------------------------------------------------------------
// Platform & status enums
// ---------------------------------------------------------------------------

/** Known built-in platforms + any string for local adapters */
export type MarketplacePlatform = "ebay" | "etsy" | "poshmark" | (string & {});

export type OrderStatus =
  | "pending"
  | "paid"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded"
  | "return_requested";

export type MessageDirection = "incoming" | "outgoing";

// ---------------------------------------------------------------------------
// Normalized data models
// ---------------------------------------------------------------------------

export interface ShippingAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface TrackingInfo {
  carrier: string;
  trackingNumber: string;
  url?: string;
}

export interface OrderItem {
  title: string;
  sku?: string;
  quantity: number;
  price: { amount: number; currency: string };
  imageUrl?: string;
  platformItemId?: string;
}

export interface MarketplaceOrder {
  id: string;
  platform: MarketplacePlatform;
  status: OrderStatus;
  buyer: {
    username: string;
    name?: string;
    email?: string;
    address?: ShippingAddress;
  };
  items: OrderItem[];
  total: { amount: number; currency: string };
  platformFees?: { amount: number; currency: string };
  createdAt: string;
  paidAt?: string;
  shippedAt?: string;
  deliveredAt?: string;
  tracking?: TrackingInfo;
  raw?: Record<string, unknown>;
}

export interface MarketplaceMessage {
  id: string;
  platform: MarketplacePlatform;
  orderId?: string;
  itemId?: string;
  direction: MessageDirection;
  sender: string;
  recipient: string;
  subject?: string;
  body: string;
  timestamp: string;
  read: boolean;
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

export interface OrderFilter {
  status?: OrderStatus;
  limit?: number;
  daysBack?: number;
}

export interface FulfillmentInput {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  shippedDate?: string;
}

export interface SendMessageInput {
  recipientUsername: string;
  body: string;
  orderId?: string;
  itemId?: string;
  subject?: string;
}

export interface MessageFilter {
  unreadOnly?: boolean;
  limit?: number;
  daysBack?: number;
}

// ---------------------------------------------------------------------------
// Tool result (matches Bob's standard)
// ---------------------------------------------------------------------------

export interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface MarketplaceAdapter {
  readonly platform: MarketplacePlatform;
  readonly displayName: string;

  /** Are the required env vars present? */
  isConfigured(): boolean;

  /** Test API connectivity */
  testConnection(): Promise<{ success: boolean; error?: string }>;

  /** Get orders with optional filters */
  getOrders(opts?: OrderFilter): Promise<MarketplaceOrder[]>;

  /** Get a single order by ID */
  getOrder(orderId: string): Promise<MarketplaceOrder | null>;

  /** Mark an order as shipped */
  markShipped(input: FulfillmentInput): Promise<ToolResult>;

  /** Get buyer/seller messages */
  getMessages(opts?: MessageFilter): Promise<MarketplaceMessage[]>;

  /** Send a message to a buyer */
  sendMessage(input: SendMessageInput): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Adapter factory — used by registry
// ---------------------------------------------------------------------------

export interface AdapterFactory {
  platform: MarketplacePlatform;
  displayName: string;
  requiredEnvVars: string[];
  create(): MarketplaceAdapter;
}
