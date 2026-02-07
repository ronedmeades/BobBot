import type { ToolDefinition } from "../providers/types.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Tool Definitions ---

export const phoneToolDefinitions: ToolDefinition[] = [
  {
    name: "call_owner",
    description:
      "Make an outbound phone call to the owner using Twilio. The message will be spoken aloud using text-to-speech. Use this when you need to urgently reach the owner or deliver important information by voice. Requires TWILIO_* and OWNER_PHONE_NUMBER env vars.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description:
            "The message to speak on the call. Keep it conversational — this will be read aloud by TTS. Max ~3500 characters; longer messages are truncated at a sentence boundary.",
        },
        voice: {
          type: "string",
          enum: ["man", "woman", "alice", "Polly.Amy", "Polly.Joanna", "Polly.Matthew"],
          description:
            "TTS voice to use (default: 'Polly.Amy'). 'alice' is high-quality English. Polly.* voices use Amazon Polly.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "send_sms",
    description:
      "Send an SMS text message to the owner using Twilio. Use this for non-urgent notifications, quick updates, or when Telegram isn't appropriate. Requires TWILIO_* and OWNER_PHONE_NUMBER env vars.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description:
            "The SMS message to send. Max 1600 characters (standard SMS limit for concatenated messages).",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "get_call_status",
    description:
      "Check the status of a previously placed phone call by its Call SID. Returns current status (queued, ringing, in-progress, completed, failed, busy, no-answer, canceled), duration, and timestamps.",
    input_schema: {
      type: "object" as const,
      properties: {
        call_sid: {
          type: "string",
          description:
            "The Twilio Call SID (starts with 'CA') returned from call_owner.",
        },
      },
      required: ["call_sid"],
    },
  },
];

// --- Twilio Config ---

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  twilioPhoneNumber: string;
  ownerPhoneNumber: string;
}

function getTwilioConfig(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
  const ownerPhoneNumber = process.env.OWNER_PHONE_NUMBER;

  const missing: string[] = [];
  if (!accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!twilioPhoneNumber) missing.push("TWILIO_PHONE_NUMBER");
  if (!ownerPhoneNumber) missing.push("OWNER_PHONE_NUMBER");

  if (missing.length > 0) {
    throw new Error(
      `Twilio is not configured. Missing env vars: ${missing.join(", ")}. ` +
        `Sign up at twilio.com, get a phone number (~$1.15/mo), and add these to your .env file.`
    );
  }

  return {
    accountSid: accountSid!,
    authToken: authToken!,
    twilioPhoneNumber: twilioPhoneNumber!,
    ownerPhoneNumber: ownerPhoneNumber!,
  };
}

// --- HTTP Helpers ---

function twilioAuthHeader(accountSid: string, authToken: string): string {
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  return `Basic ${credentials}`;
}

async function twilioPost(
  config: TwilioConfig,
  path: string,
  body: Record<string, string>
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}${path}`;

  const formBody = new URLSearchParams(body).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: twilioAuthHeader(config.accountSid, config.authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody,
  });

  const data = (await response.json()) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

async function twilioGet(
  config: TwilioConfig,
  path: string
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: twilioAuthHeader(config.accountSid, config.authToken),
    },
  });

  const data = (await response.json()) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

// --- TwiML Builder ---

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateAtSentence(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }

  // Find the last sentence boundary before maxLength
  const truncated = text.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf(". ");
  const lastExclaim = truncated.lastIndexOf("! ");
  const lastQuestion = truncated.lastIndexOf("? ");
  const boundary = Math.max(lastPeriod, lastExclaim, lastQuestion);

  if (boundary > maxLength * 0.5) {
    return { text: truncated.slice(0, boundary + 1), truncated: true };
  }

  // No good sentence boundary — just truncate at word boundary
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.5) {
    return { text: truncated.slice(0, lastSpace), truncated: true };
  }

  return { text: truncated, truncated: true };
}

function buildTwiml(message: string, voice: string): string {
  const MAX_MESSAGE_LENGTH = 3500;
  const { text, truncated } = truncateAtSentence(message, MAX_MESSAGE_LENGTH);

  const spokenText = truncated
    ? `${text} ... The rest of this message was too long for a phone call. Please check your Telegram messages for the full text.`
    : text;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${escapeXml(voice)}">${escapeXml(spokenText)}</Say>`,
    "</Response>",
  ].join("\n");
}

// --- Handlers ---

export async function handleCallOwner(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const message = input.message as string;
  if (!message) {
    return { success: false, output: "message is required" };
  }

  const voice = (input.voice as string) ?? "Polly.Amy";

  try {
    const config = getTwilioConfig();
    const twiml = buildTwiml(message, voice);

    const result = await twilioPost(config, "/Calls.json", {
      To: config.ownerPhoneNumber,
      From: config.twilioPhoneNumber,
      Twiml: twiml,
    });

    if (!result.ok) {
      const errorMsg = (result.data.message as string) ?? JSON.stringify(result.data);
      return {
        success: false,
        output: `Twilio API error (HTTP ${result.status}): ${errorMsg}`,
      };
    }

    const callSid = result.data.sid as string;
    const status = result.data.status as string;

    return {
      success: true,
      output: [
        `Call initiated successfully!`,
        `Call SID: ${callSid}`,
        `Status: ${status}`,
        `To: ${config.ownerPhoneNumber}`,
        `From: ${config.twilioPhoneNumber}`,
        `Voice: ${voice}`,
        `Message length: ${message.length} chars`,
        ``,
        `Use get_call_status with SID "${callSid}" to check progress.`,
      ].join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg };
  }
}

export async function handleSendSms(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const message = input.message as string;
  if (!message) {
    return { success: false, output: "message is required" };
  }

  if (message.length > 1600) {
    return {
      success: false,
      output: `Message is ${message.length} characters — SMS limit is 1600 characters. Please shorten the message.`,
    };
  }

  try {
    const config = getTwilioConfig();

    const result = await twilioPost(config, "/Messages.json", {
      To: config.ownerPhoneNumber,
      From: config.twilioPhoneNumber,
      Body: message,
    });

    if (!result.ok) {
      const errorMsg = (result.data.message as string) ?? JSON.stringify(result.data);
      return {
        success: false,
        output: `Twilio API error (HTTP ${result.status}): ${errorMsg}`,
      };
    }

    const messageSid = result.data.sid as string;
    const status = result.data.status as string;
    const numSegments = result.data.num_segments as string;

    return {
      success: true,
      output: [
        `SMS sent successfully!`,
        `Message SID: ${messageSid}`,
        `Status: ${status}`,
        `To: ${config.ownerPhoneNumber}`,
        `Segments: ${numSegments ?? "1"}`,
        `Length: ${message.length} chars`,
      ].join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg };
  }
}

export async function handleGetCallStatus(
  input: Record<string, unknown>
): Promise<ToolResult> {
  const callSid = input.call_sid as string;
  if (!callSid) {
    return { success: false, output: "call_sid is required" };
  }

  // Validate SID format to prevent path injection
  if (!/^CA[a-f0-9]{32}$/i.test(callSid)) {
    return {
      success: false,
      output: `Invalid Call SID format. Expected 'CA' followed by 32 hex characters, got: "${callSid}"`,
    };
  }

  try {
    const config = getTwilioConfig();

    const result = await twilioGet(
      config,
      `/Calls/${encodeURIComponent(callSid)}.json`
    );

    if (!result.ok) {
      const errorMsg = (result.data.message as string) ?? JSON.stringify(result.data);
      return {
        success: false,
        output: `Twilio API error (HTTP ${result.status}): ${errorMsg}`,
      };
    }

    const status = result.data.status as string;
    const duration = result.data.duration as string;
    const startTime = result.data.start_time as string;
    const endTime = result.data.end_time as string;
    const direction = result.data.direction as string;
    const price = result.data.price as string;
    const priceUnit = result.data.price_unit as string;

    const lines = [
      `Call Status: ${status}`,
      `SID: ${callSid}`,
      `Direction: ${direction ?? "outbound-api"}`,
    ];

    if (duration) lines.push(`Duration: ${duration} seconds`);
    if (startTime) lines.push(`Started: ${startTime}`);
    if (endTime) lines.push(`Ended: ${endTime}`);
    if (price) lines.push(`Cost: ${price} ${priceUnit ?? "USD"}`);

    return { success: true, output: lines.join("\n") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg };
  }
}
