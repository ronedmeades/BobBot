import type Anthropic from "@anthropic-ai/sdk";

// eBay API integration for creating and managing listings.
// Requires eBay developer credentials in .env:
//   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN
//   EBAY_ENVIRONMENT=sandbox|production (default: sandbox)

interface ToolResult {
  success: boolean;
  output: string;
}

export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  environment: "sandbox" | "production";
  ruName?: string;
}

export function getEbayConfig(): EbayConfig {
  const clientId = process.env.EBAY_CLIENT_ID ?? "";
  const clientSecret = process.env.EBAY_CLIENT_SECRET ?? "";
  const refreshToken = process.env.EBAY_REFRESH_TOKEN ?? "";
  const environment = (process.env.EBAY_ENVIRONMENT ?? "sandbox") as "sandbox" | "production";

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "eBay credentials not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN in .env"
    );
  }

  const ruName = process.env.EBAY_RUNAME ?? "";

  return { clientId, clientSecret, refreshToken, environment, ruName };
}

export function getBaseUrl(env: "sandbox" | "production"): string {
  return env === "production"
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";
}

export async function getAccessToken(config: EbayConfig): Promise<string> {
  const baseUrl = getBaseUrl(config.environment);
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  const response = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay OAuth failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

// --- Tool Definitions ---

export const ebayToolDefinitions: Anthropic.Tool[] = [
  {
    name: "create_ebay_listing",
    description:
      "Create a fixed-price listing on eBay. Provide title, description, price, category, images, and item specifics. Uses the eBay Inventory API.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Listing title (max 80 characters)",
        },
        description: {
          type: "string",
          description: "HTML description of the item",
        },
        price: {
          type: "number",
          description: "Price in USD",
        },
        quantity: {
          type: "number",
          description: "Available quantity (default: 1)",
        },
        category_id: {
          type: "string",
          description: "eBay category ID (use search_ebay_category to find this)",
        },
        image_urls: {
          type: "array",
          items: { type: "string" },
          description: "Array of image URLs (already uploaded to eBay or publicly accessible)",
        },
        item_specifics: {
          type: "object",
          description: "Key-value pairs for item specifics (e.g. Artist, Size, Type)",
          additionalProperties: { type: "string" },
        },
        condition: {
          type: "string",
          enum: ["NEW", "LIKE_NEW", "VERY_GOOD", "GOOD", "ACCEPTABLE"],
          description: "Item condition (default: NEW)",
        },
      },
      required: ["title", "description", "price", "category_id", "image_urls"],
    },
  },
  {
    name: "upload_ebay_image",
    description:
      "Upload a local image to eBay's picture service. Returns the hosted URL to use in listings.",
    input_schema: {
      type: "object" as const,
      properties: {
        image_path: {
          type: "string",
          description: "Local path to the image file to upload",
        },
      },
      required: ["image_path"],
    },
  },
  {
    name: "search_ebay_category",
    description:
      "Search for the correct eBay category ID by keyword. Returns matching categories with IDs. Use this before creating a listing to find the right category.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search term (e.g. 'poster', 'vintage art print', 'movie poster')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "generate_listing_content",
    description:
      "Generate an eBay listing title, description, and item specifics from an image. Uses Claude's vision to analyze the poster and produce listing-ready content. Returns JSON with title, description, and suggested item specifics.",
    input_schema: {
      type: "object" as const,
      properties: {
        image_path: {
          type: "string",
          description: "Path to the poster image to analyze",
        },
        additional_info: {
          type: "string",
          description: "Optional extra context (e.g. 'this is a reproduction', 'size is 24x36')",
        },
        price: {
          type: "number",
          description: "Price to include in listing (optional, for description context)",
        },
      },
      required: ["image_path"],
    },
  },
  {
    name: "get_ebay_listing_status",
    description:
      "Check the status of an eBay listing by item ID or SKU. Returns listing details including views, watchers, and current status.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_id: {
          type: "string",
          description: "eBay item ID or SKU to look up",
        },
      },
      required: ["item_id"],
    },
  },
  {
    name: "get_seller_listings",
    description:
      "Fetch active listings from the eBay seller account. Returns titles, prices, SKUs, and offer IDs. Use to review current listings, learn listing style, or prepare for bulk updates.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max items to return (default: 25, max: 200)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default: 0)",
        },
      },
      required: [],
    },
  },
  {
    name: "update_ebay_listing",
    description:
      "Update an existing eBay listing's price, title, description, or item specifics. Requires SKU (for title/description) and/or offer ID (for price). Use get_seller_listings to find these IDs.",
    input_schema: {
      type: "object" as const,
      properties: {
        sku: {
          type: "string",
          description: "SKU of the inventory item (for title/description/image changes)",
        },
        offer_id: {
          type: "string",
          description: "Offer ID (for price changes)",
        },
        title: {
          type: "string",
          description: "New listing title (max 80 characters)",
        },
        description: {
          type: "string",
          description: "New HTML description",
        },
        price: {
          type: "number",
          description: "New price in USD",
        },
        image_urls: {
          type: "array",
          items: { type: "string" },
          description: "New image URLs (replaces existing)",
        },
        item_specifics: {
          type: "object",
          description: "Updated item specifics (merged with existing)",
          additionalProperties: { type: "string" },
        },
      },
      required: [],
    },
  },
  {
    name: "bulk_update_prices",
    description:
      "Adjust prices on all active eBay listings by percentage or fixed amount. Smart rounding: under $10 rounds to .99, $10-$50 to .95, over $50 to whole dollar. Has preview mode.",
    input_schema: {
      type: "object" as const,
      properties: {
        percentage: {
          type: "number",
          description: "Percentage to adjust by (e.g. 15 for +15%, -10 for -10%). Use this OR fixed_amount.",
        },
        fixed_amount: {
          type: "number",
          description: "Fixed dollar amount to add/subtract (e.g. 5 for +$5). Use this OR percentage.",
        },
        preview: {
          type: "boolean",
          description: "If true, show changes without applying (default: false)",
        },
        sku_filter: {
          type: "string",
          description: "Only update SKUs starting with this prefix (e.g. 'poster-')",
        },
      },
      required: [],
    },
  },
];

// --- Tool Handlers ---

export async function handleCreateEbayListing(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getEbayConfig();
  const token = await getAccessToken(config);
  const baseUrl = getBaseUrl(config.environment);

  const title = input.title as string;
  const description = input.description as string;
  const price = input.price as number;
  const quantity = (input.quantity as number) ?? 1;
  const categoryId = input.category_id as string;
  const imageUrls = input.image_urls as string[];
  const itemSpecifics = (input.item_specifics as Record<string, string>) ?? {};
  const condition = (input.condition as string) ?? "NEW";

  // Create inventory item using Inventory API
  const sku = `poster-${Date.now()}`;

  // Step 1: Create inventory item
  const inventoryResponse = await fetch(
    `${baseUrl}/sell/inventory/v1/inventory_item/${sku}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Language": "en-US",
      },
      body: JSON.stringify({
        availability: {
          shipToLocationAvailability: {
            quantity,
          },
        },
        condition,
        product: {
          title,
          description,
          imageUrls,
          aspects: Object.fromEntries(
            Object.entries(itemSpecifics).map(([k, v]) => [k, [v]])
          ),
        },
      }),
    }
  );

  if (!inventoryResponse.ok) {
    const text = await inventoryResponse.text();
    return { success: false, output: `Failed to create inventory item: ${text}` };
  }

  // Step 2: Create offer
  const offerResponse = await fetch(`${baseUrl}/sell/inventory/v1/offer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
    },
    body: JSON.stringify({
      sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      listingDescription: description,
      availableQuantity: quantity,
      categoryId,
      pricingSummary: {
        price: {
          value: price.toFixed(2),
          currency: "USD",
        },
      },
    }),
  });

  if (!offerResponse.ok) {
    const text = await offerResponse.text();
    return { success: false, output: `Failed to create offer: ${text}` };
  }

  const offerData = (await offerResponse.json()) as { offerId: string };

  // Step 3: Publish offer
  const publishResponse = await fetch(
    `${baseUrl}/sell/inventory/v1/offer/${offerData.offerId}/publish`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!publishResponse.ok) {
    const text = await publishResponse.text();
    return {
      success: false,
      output: `Inventory item and offer created (SKU: ${sku}), but publish failed: ${text}`,
    };
  }

  const publishData = (await publishResponse.json()) as { listingId: string };

  return {
    success: true,
    output: `Listing created!\nSKU: ${sku}\nListing ID: ${publishData.listingId}\nTitle: ${title}\nPrice: $${price.toFixed(2)}`,
  };
}

export async function handleUploadEbayImage(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getEbayConfig();
  const token = await getAccessToken(config);
  const baseUrl = getBaseUrl(config.environment);
  const imagePath = input.image_path as string;

  const { readFile } = await import("node:fs/promises");
  const { resolve, basename } = await import("node:path");
  const imageBuffer = await readFile(resolve(imagePath));
  const fileName = basename(imagePath);

  // eBay Picture Services via Trading API (XML)
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <PictureName>${fileName}</PictureName>
</UploadSiteHostedPicturesRequest>`;

  // Use multipart upload to eBay's picture service
  const boundary = `----BobUpload${Date.now()}`;
  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml\r\n\r\n${xmlBody}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`,
  ];

  const bodyStart = Buffer.from(bodyParts[0]);
  const bodyMiddle = Buffer.from(bodyParts[1]);
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fullBody = Buffer.concat([bodyStart, bodyMiddle, imageBuffer, bodyEnd]);

  const tradingUrl = config.environment === "production"
    ? "https://api.ebay.com/ws/api.dll"
    : "https://api.sandbox.ebay.com/ws/api.dll";

  const response = await fetch(tradingUrl, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
      "X-EBAY-API-IAF-TOKEN": token,
      "X-EBAY-API-SITEID": "0",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: fullBody,
  });

  const responseText = await response.text();

  // Extract URL from XML response
  const urlMatch = responseText.match(/<FullURL>(.*?)<\/FullURL>/);
  if (urlMatch) {
    return {
      success: true,
      output: `Image uploaded: ${urlMatch[1]}`,
    };
  }

  return {
    success: false,
    output: `Upload response (may contain error): ${responseText.slice(0, 500)}`,
  };
}

export async function handleSearchEbayCategory(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getEbayConfig();
  const token = await getAccessToken(config);
  const baseUrl = getBaseUrl(config.environment);
  const query = input.query as string;

  const response = await fetch(
    `${baseUrl}/commerce/taxonomy/v1/category_tree/0/get_categories_by_keyword?q=${encodeURIComponent(query)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    return { success: false, output: `Category search failed: ${text}` };
  }

  const data = (await response.json()) as {
    categorySuggestions?: Array<{
      category: { categoryId: string; categoryName: string };
      categoryTreeNodeAncestors?: Array<{ categoryName: string }>;
    }>;
  };

  if (!data.categorySuggestions || data.categorySuggestions.length === 0) {
    return { success: true, output: `No categories found for "${query}"` };
  }

  const results = data.categorySuggestions.slice(0, 10).map((s) => {
    const ancestors = s.categoryTreeNodeAncestors?.map((a) => a.categoryName).reverse().join(" > ") ?? "";
    const path = ancestors ? `${ancestors} > ${s.category.categoryName}` : s.category.categoryName;
    return `${s.category.categoryId}: ${path}`;
  });

  return {
    success: true,
    output: `Categories matching "${query}":\n${results.join("\n")}`,
  };
}

export async function handleGenerateListingContent(input: Record<string, unknown>): Promise<ToolResult> {
  // This tool calls Claude's vision API to analyze the poster image
  // and generate listing content. The actual Claude call happens in the agent core,
  // so this handler prepares the prompt and reads the image.
  const imagePath = input.image_path as string;
  const additionalInfo = (input.additional_info as string) ?? "";
  const price = input.price as number | undefined;

  const { readFile } = await import("node:fs/promises");
  const { resolve, extname } = await import("node:path");
  const imageBuffer = await readFile(resolve(imagePath));
  const base64 = imageBuffer.toString("base64");
  const ext = extname(imagePath).toLowerCase();
  const mediaType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

  // For now, return the image info so the agent can use it in a follow-up vision call.
  // In a future iteration, this could directly call the Anthropic API with vision.
  return {
    success: true,
    output: JSON.stringify({
      status: "image_loaded",
      image_base64: base64.slice(0, 100) + "...",
      media_type: mediaType,
      size_bytes: imageBuffer.length,
      additional_info: additionalInfo,
      price,
      hint: "Use this image data to analyze the poster and generate: title (max 80 chars), HTML description, and item specifics (Artist, Size, Type, Original/Reproduction, Subject, Style).",
    }),
  };
}

export async function handleGetEbayListingStatus(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getEbayConfig();
  const token = await getAccessToken(config);
  const baseUrl = getBaseUrl(config.environment);
  const itemId = input.item_id as string;

  // Try as offer/SKU first, then as listing ID
  const response = await fetch(
    `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(itemId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    return { success: false, output: `Failed to get listing status: ${text}` };
  }

  const data = await response.json();
  return {
    success: true,
    output: JSON.stringify(data, null, 2),
  };
}

// --- Get seller listings ---

export async function handleGetSellerListings(input: Record<string, unknown>): Promise<ToolResult> {
  const ebayConfig = getEbayConfig();
  const token = await getAccessToken(ebayConfig);
  const baseUrl = getBaseUrl(ebayConfig.environment);
  const limit = Math.min((input.limit as number) ?? 25, 200);
  const offset = (input.offset as number) ?? 0;

  const invResponse = await fetch(
    `${baseUrl}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`,
    {
      headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
    }
  );

  if (!invResponse.ok) {
    const text = await invResponse.text();
    return { success: false, output: `Failed to fetch inventory: ${text}` };
  }

  const invData = (await invResponse.json()) as {
    total: number;
    inventoryItems?: Array<{
      sku: string;
      product?: { title?: string; description?: string };
      availability?: { shipToLocationAvailability?: { quantity?: number } };
    }>;
  };

  if (!invData.inventoryItems || invData.inventoryItems.length === 0) {
    return { success: true, output: "No active inventory items found." };
  }

  const listings: Array<{
    sku: string;
    title: string;
    price: string;
    offerId: string;
    quantity: number;
  }> = [];

  for (const item of invData.inventoryItems) {
    try {
      const offerResponse = await fetch(
        `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(item.sku)}`,
        {
          headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
        }
      );

      if (offerResponse.ok) {
        const offerData = (await offerResponse.json()) as {
          offers?: Array<{
            offerId: string;
            pricingSummary?: { price?: { value?: string; currency?: string } };
            availableQuantity?: number;
          }>;
        };

        const offer = offerData.offers?.[0];
        listings.push({
          sku: item.sku,
          title: item.product?.title ?? "(no title)",
          price: offer?.pricingSummary?.price?.value ?? "?",
          offerId: offer?.offerId ?? "",
          quantity: offer?.availableQuantity ?? item.availability?.shipToLocationAvailability?.quantity ?? 0,
        });
      }
    } catch {
      listings.push({
        sku: item.sku,
        title: item.product?.title ?? "(no title)",
        price: "?",
        offerId: "",
        quantity: 0,
      });
    }
  }

  const formatted = listings
    .map(
      (l, i) =>
        `${i + 1}. [${l.sku}] ${l.title}\n   Price: $${l.price} | Qty: ${l.quantity} | Offer: ${l.offerId}`
    )
    .join("\n");

  return {
    success: true,
    output: `Active listings (${listings.length} of ${invData.total} total, offset ${offset}):\n\n${formatted}`,
  };
}

// --- Update existing listing ---

export async function handleUpdateEbayListing(input: Record<string, unknown>): Promise<ToolResult> {
  const ebayConfig = getEbayConfig();
  const token = await getAccessToken(ebayConfig);
  const baseUrl = getBaseUrl(ebayConfig.environment);
  const sku = input.sku as string | undefined;
  const offerId = input.offer_id as string | undefined;
  const title = input.title as string | undefined;
  const description = input.description as string | undefined;
  const price = input.price as number | undefined;
  const imageUrls = input.image_urls as string[] | undefined;
  const itemSpecifics = input.item_specifics as Record<string, string> | undefined;

  if (!sku && !offerId) {
    return { success: false, output: "Must provide at least one of: sku (for inventory updates) or offer_id (for price updates)" };
  }

  const updates: string[] = [];

  // Update inventory item (title, description, images, specifics)
  if (sku && (title || description || imageUrls || itemSpecifics)) {
    const getResponse = await fetch(
      `${baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
      }
    );

    if (!getResponse.ok) {
      const text = await getResponse.text();
      return { success: false, output: `Failed to fetch inventory item: ${text}` };
    }

    const currentItem = (await getResponse.json()) as Record<string, unknown>;
    const product = (currentItem.product ?? {}) as Record<string, unknown>;

    if (title) product.title = title;
    if (description) product.description = description;
    if (imageUrls) product.imageUrls = imageUrls;
    if (itemSpecifics) {
      const existingAspects = (product.aspects ?? {}) as Record<string, string[]>;
      for (const [k, v] of Object.entries(itemSpecifics)) {
        existingAspects[k] = [v];
      }
      product.aspects = existingAspects;
    }
    currentItem.product = product;

    const putResponse = await fetch(
      `${baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Language": "en-US",
        },
        body: JSON.stringify(currentItem),
      }
    );

    if (!putResponse.ok) {
      const text = await putResponse.text();
      return { success: false, output: `Failed to update inventory item: ${text}` };
    }

    const changed = [title && "title", description && "description", imageUrls && "images", itemSpecifics && "specifics"].filter(Boolean).join(", ");
    updates.push(`Inventory item ${sku} updated (${changed})`);
  }

  // Update offer (price)
  if (offerId && price !== undefined) {
    const getResponse = await fetch(
      `${baseUrl}/sell/inventory/v1/offer/${offerId}`,
      {
        headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
      }
    );

    if (!getResponse.ok) {
      const text = await getResponse.text();
      return { success: false, output: `Failed to fetch offer: ${text}` };
    }

    const currentOffer = (await getResponse.json()) as Record<string, unknown>;
    const pricingSummary = (currentOffer.pricingSummary ?? {}) as Record<string, unknown>;
    pricingSummary.price = { value: price.toFixed(2), currency: "USD" };
    currentOffer.pricingSummary = pricingSummary;

    const putResponse = await fetch(
      `${baseUrl}/sell/inventory/v1/offer/${offerId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Language": "en-US",
        },
        body: JSON.stringify(currentOffer),
      }
    );

    if (!putResponse.ok) {
      const text = await putResponse.text();
      return { success: false, output: `Failed to update offer: ${text}` };
    }

    updates.push(`Offer ${offerId} price updated to $${price.toFixed(2)}`);
  }

  if (updates.length === 0) {
    return { success: false, output: "No updates specified. Provide title, description, price, image_urls, or item_specifics." };
  }

  return { success: true, output: updates.join("\n") };
}

// --- Bulk price update with smart rounding ---

function smartRoundPrice(rawPrice: number): number {
  if (rawPrice <= 0) return 0.99;
  if (rawPrice < 10) {
    return Math.floor(rawPrice) + 0.99;
  } else if (rawPrice <= 50) {
    return Math.floor(rawPrice) + 0.95;
  } else {
    return Math.round(rawPrice);
  }
}

export async function handleBulkUpdatePrices(input: Record<string, unknown>): Promise<ToolResult> {
  const percentage = input.percentage as number | undefined;
  const fixedAmount = input.fixed_amount as number | undefined;
  const preview = (input.preview as boolean) ?? false;
  const skuFilter = input.sku_filter as string | undefined;

  if (percentage === undefined && fixedAmount === undefined) {
    return { success: false, output: "Must provide either percentage or fixed_amount." };
  }
  if (percentage !== undefined && fixedAmount !== undefined) {
    return { success: false, output: "Provide percentage OR fixed_amount, not both." };
  }

  const ebayConfig = getEbayConfig();
  const token = await getAccessToken(ebayConfig);
  const baseUrl = getBaseUrl(ebayConfig.environment);

  // Fetch all inventory items (paginate)
  const allItems: Array<{ sku: string; title: string }> = [];
  let offset = 0;
  const pageSize = 100;

  while (true) {
    const response = await fetch(
      `${baseUrl}/sell/inventory/v1/inventory_item?limit=${pageSize}&offset=${offset}`,
      {
        headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return { success: false, output: `Failed to fetch inventory: ${text}` };
    }

    const data = (await response.json()) as {
      total: number;
      inventoryItems?: Array<{ sku: string; product?: { title?: string } }>;
    };

    if (!data.inventoryItems || data.inventoryItems.length === 0) break;

    for (const item of data.inventoryItems) {
      if (skuFilter && !item.sku.startsWith(skuFilter)) continue;
      allItems.push({
        sku: item.sku,
        title: item.product?.title ?? "(no title)",
      });
    }

    if (offset + pageSize >= data.total) break;
    offset += pageSize;
  }

  if (allItems.length === 0) {
    return { success: true, output: "No matching inventory items found." };
  }

  // Get offers and compute new prices
  const changes: Array<{
    sku: string;
    title: string;
    offerId: string;
    oldPrice: number;
    newPrice: number;
  }> = [];

  for (const item of allItems) {
    try {
      const offerResponse = await fetch(
        `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(item.sku)}`,
        {
          headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
        }
      );

      if (!offerResponse.ok) continue;

      const offerData = (await offerResponse.json()) as {
        offers?: Array<{
          offerId: string;
          pricingSummary?: { price?: { value?: string } };
        }>;
      };

      const offer = offerData.offers?.[0];
      if (!offer?.offerId || !offer.pricingSummary?.price?.value) continue;

      const oldPrice = parseFloat(offer.pricingSummary.price.value);
      let rawNew: number;

      if (percentage !== undefined) {
        rawNew = oldPrice * (1 + percentage / 100);
      } else {
        rawNew = oldPrice + (fixedAmount ?? 0);
      }

      const newPrice = smartRoundPrice(rawNew);

      changes.push({
        sku: item.sku,
        title: item.title,
        offerId: offer.offerId,
        oldPrice,
        newPrice,
      });
    } catch {
      // skip items with errors
    }
  }

  if (changes.length === 0) {
    return { success: true, output: "No listings with valid offers found to update." };
  }

  const changeDesc =
    percentage !== undefined
      ? `${percentage > 0 ? "+" : ""}${percentage}%`
      : `${(fixedAmount ?? 0) > 0 ? "+" : ""}$${(fixedAmount ?? 0).toFixed(2)}`;

  const changeLines = changes
    .map(
      (c) =>
        `  ${c.title.slice(0, 50).padEnd(50)} $${c.oldPrice.toFixed(2)} -> $${c.newPrice.toFixed(2)}`
    )
    .join("\n");

  if (preview) {
    return {
      success: true,
      output: `PREVIEW — Price adjustment: ${changeDesc} (${changes.length} listings)\n\n${changeLines}\n\nRun again with preview=false to apply.`,
    };
  }

  // Apply changes
  let updated = 0;
  let errors = 0;

  for (const change of changes) {
    try {
      const getResponse = await fetch(
        `${baseUrl}/sell/inventory/v1/offer/${change.offerId}`,
        {
          headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
        }
      );

      if (!getResponse.ok) {
        errors++;
        continue;
      }

      const currentOffer = (await getResponse.json()) as Record<string, unknown>;
      const pricing = (currentOffer.pricingSummary ?? {}) as Record<string, unknown>;
      pricing.price = { value: change.newPrice.toFixed(2), currency: "USD" };
      currentOffer.pricingSummary = pricing;

      const putResponse = await fetch(
        `${baseUrl}/sell/inventory/v1/offer/${change.offerId}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Language": "en-US",
          },
          body: JSON.stringify(currentOffer),
        }
      );

      if (putResponse.ok) {
        updated++;
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
  }

  return {
    success: true,
    output: `Price update complete (${changeDesc}):\n  Updated: ${updated}\n  Errors: ${errors}\n\n${changeLines}`,
  };
}
