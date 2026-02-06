import type Anthropic from "@anthropic-ai/sdk";

// Gmail API integration.
// Requires Google OAuth2 credentials in .env:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN

interface ToolResult {
  success: boolean;
  output: string;
}

interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function getGmailConfig(): GmailConfig {
  const clientId = process.env.GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? "";
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN ?? "";

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail credentials not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in .env"
    );
  }

  return { clientId, clientSecret, refreshToken };
}

async function getAccessToken(config: GmailConfig): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail OAuth failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailGet(path: string, token: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail API error (${response.status}): ${text}`);
  }
  return response.json();
}

async function gmailPost(path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail API error (${response.status}): ${text}`);
  }
  return response.json();
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType: string;
  body?: { data?: string; size: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  snippet: string;
  payload: {
    headers: GmailHeader[];
    mimeType: string;
    body?: { data?: string; size: number };
    parts?: GmailPart[];
  };
  internalDate: string;
}

function getHeader(headers: GmailHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractBody(message: GmailMessage): string {
  // Try to find text/plain part
  const findPart = (parts: GmailPart[] | undefined, mime: string): string | null => {
    if (!parts) return null;
    for (const part of parts) {
      if (part.mimeType === mime && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts) {
        const found = findPart(part.parts, mime);
        if (found) return found;
      }
    }
    return null;
  };

  // Direct body
  if (message.payload.body?.data) {
    return decodeBase64Url(message.payload.body.data);
  }

  // Prefer plain text
  const plain = findPart(message.payload.parts, "text/plain");
  if (plain) return plain;

  // Fall back to HTML
  const html = findPart(message.payload.parts, "text/html");
  if (html) return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  return "(no body)";
}

// --- Tool Definitions ---

export const gmailToolDefinitions: Anthropic.Tool[] = [
  {
    name: "check_email",
    description:
      "Check for new or unread emails. Returns a list of recent messages with sender, subject, and snippet.",
    input_schema: {
      type: "object" as const,
      properties: {
        max_results: {
          type: "number",
          description: "Maximum number of emails to return (default: 10)",
        },
        query: {
          type: "string",
          description: "Gmail search query (default: 'is:unread'). Examples: 'from:boss@company.com', 'is:unread label:important'",
        },
      },
      required: [],
    },
  },
  {
    name: "read_email",
    description:
      "Read the full content of a specific email by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        email_id: {
          type: "string",
          description: "The Gmail message ID",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email from the configured Gmail account.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC email address (optional)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "search_email",
    description:
      "Search emails using Gmail query syntax. Returns matching messages with sender, subject, and snippet.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (e.g. 'from:someone subject:invoice after:2026/01/01')",
        },
        max_results: {
          type: "number",
          description: "Maximum results (default: 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_email_summary",
    description:
      "Get a summary of recent email activity — unread count, important senders, subjects needing attention. Designed for morning briefings.",
    input_schema: {
      type: "object" as const,
      properties: {
        hours: {
          type: "number",
          description: "Look back this many hours (default: 24)",
        },
      },
      required: [],
    },
  },
];

// --- Tool Handlers ---

export async function handleCheckEmail(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getGmailConfig();
  const token = await getAccessToken(config);
  const maxResults = (input.max_results as number) ?? 10;
  const query = (input.query as string) ?? "is:unread";

  const data = (await gmailGet(
    `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    token
  )) as { messages?: Array<{ id: string }> };

  if (!data.messages || data.messages.length === 0) {
    return { success: true, output: `No emails found for query: "${query}"` };
  }

  const results: string[] = [];
  for (const msg of data.messages.slice(0, maxResults)) {
    const full = (await gmailGet(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token)) as GmailMessage;
    const from = getHeader(full.payload.headers, "From");
    const subject = getHeader(full.payload.headers, "Subject");
    const date = getHeader(full.payload.headers, "Date");
    results.push(`[${msg.id}] ${date}\n  From: ${from}\n  Subject: ${subject}\n  ${full.snippet}`);
  }

  return {
    success: true,
    output: `Found ${data.messages.length} email(s) matching "${query}":\n\n${results.join("\n\n")}`,
  };
}

export async function handleReadEmail(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getGmailConfig();
  const token = await getAccessToken(config);
  const emailId = input.email_id as string;

  const message = (await gmailGet(`/messages/${emailId}?format=full`, token)) as GmailMessage;

  const from = getHeader(message.payload.headers, "From");
  const to = getHeader(message.payload.headers, "To");
  const subject = getHeader(message.payload.headers, "Subject");
  const date = getHeader(message.payload.headers, "Date");
  const body = extractBody(message);

  return {
    success: true,
    output: `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`,
  };
}

export async function handleSendEmail(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getGmailConfig();
  const token = await getAccessToken(config);

  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const cc = input.cc as string | undefined;

  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);

  const raw = Buffer.from(
    headers.join("\r\n") + "\r\n\r\n" + body
  ).toString("base64url");

  await gmailPost("/messages/send", token, { raw });

  return {
    success: true,
    output: `Email sent to ${to}: "${subject}"${cc ? ` (cc: ${cc})` : ""}`,
  };
}

export async function handleSearchEmail(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getGmailConfig();
  const token = await getAccessToken(config);
  const query = input.query as string;
  const maxResults = (input.max_results as number) ?? 20;

  const data = (await gmailGet(
    `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    token
  )) as { messages?: Array<{ id: string }>; resultSizeEstimate?: number };

  if (!data.messages || data.messages.length === 0) {
    return { success: true, output: `No emails found for: "${query}"` };
  }

  const results: string[] = [];
  for (const msg of data.messages.slice(0, maxResults)) {
    const full = (await gmailGet(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token)) as GmailMessage;
    const from = getHeader(full.payload.headers, "From");
    const subject = getHeader(full.payload.headers, "Subject");
    results.push(`[${msg.id}] From: ${from} | ${subject}`);
  }

  return {
    success: true,
    output: `${data.resultSizeEstimate ?? data.messages.length} result(s) for "${query}":\n\n${results.join("\n")}`,
  };
}

export async function handleGetEmailSummary(input: Record<string, unknown>): Promise<ToolResult> {
  const config = getGmailConfig();
  const token = await getAccessToken(config);
  const hours = (input.hours as number) ?? 24;

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const afterDate = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, "0")}/${String(since.getDate()).padStart(2, "0")}`;

  // Get unread count
  const unreadData = (await gmailGet(`/messages?q=is:unread&maxResults=100`, token)) as {
    messages?: Array<{ id: string }>;
    resultSizeEstimate?: number;
  };
  const unreadCount = unreadData.resultSizeEstimate ?? unreadData.messages?.length ?? 0;

  // Get recent messages
  const recentData = (await gmailGet(
    `/messages?q=after:${afterDate}&maxResults=50`,
    token
  )) as { messages?: Array<{ id: string }> };

  const senderCounts = new Map<string, number>();
  const subjects: string[] = [];

  if (recentData.messages) {
    for (const msg of recentData.messages.slice(0, 30)) {
      try {
        const full = (await gmailGet(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token)) as GmailMessage;
        const from = getHeader(full.payload.headers, "From");
        const subject = getHeader(full.payload.headers, "Subject");
        const sender = from.replace(/<.*>/, "").trim();
        senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1);
        if (subjects.length < 10) subjects.push(`- ${subject} (from ${sender})`);
      } catch {
        // skip individual failures
      }
    }
  }

  const topSenders = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sender, count]) => `- ${sender}: ${count} email(s)`)
    .join("\n");

  const totalRecent = recentData.messages?.length ?? 0;

  return {
    success: true,
    output: `Email Summary (last ${hours} hours):\n\nUnread: ${unreadCount}\nNew messages: ${totalRecent}\n\nTop senders:\n${topSenders || "- none"}\n\nRecent subjects:\n${subjects.join("\n") || "- none"}`,
  };
}
