/**
 * Voice skill — Telegram voice message transcription + TTS responses.
 *
 * STT: OpenAI Whisper API (accepts OGG directly from Telegram)
 * TTS: edge-tts (free Microsoft Edge TTS) → ffmpeg → OGG/Opus
 *
 * Both are lazy-loaded to avoid startup cost when voice isn't used.
 */

import { config } from "../config.js";

// ─── Lazy-loaded deps ───────────────────────────────────────────────

let edgeTts: typeof import("edge-tts") | null = null;

async function loadEdgeTts(): Promise<typeof import("edge-tts")> {
  if (!edgeTts) {
    edgeTts = await import("edge-tts");
  }
  return edgeTts;
}

// ─── OpenAI key resolution ──────────────────────────────────────────

export function getWhisperApiKey(): string | null {
  // Explicit key takes priority
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  // If using OpenAI as LLM provider, reuse that key
  if (config.llm.provider === "openai" && config.llm.apiKey) return config.llm.apiKey;
  return null;
}

export function isTranscriptionAvailable(): boolean {
  return getWhisperApiKey() !== null;
}

// ─── Speech-to-Text ─────────────────────────────────────────────────

/**
 * Transcribe an OGG/Opus voice buffer via OpenAI Whisper API.
 */
export async function transcribeVoice(oggBuffer: Buffer): Promise<string> {
  const apiKey = getWhisperApiKey();
  if (!apiKey) {
    throw new Error(
      "Voice transcription requires an OpenAI API key. Set OPENAI_API_KEY in .env."
    );
  }

  // Use the openai package (already in dependencies)
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const file = new File([new Uint8Array(oggBuffer)], "voice.ogg", { type: "audio/ogg" });
  const transcription = await client.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return transcription.text;
}

// ─── Text-to-Speech ─────────────────────────────────────────────────

const DEFAULT_VOICE = "en-GB-RyanNeural";

/**
 * Synthesize text to OGG/Opus audio buffer (Telegram-compatible).
 * edge-tts produces MP3, ffmpeg converts to OGG/Opus.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  // Truncate very long text for TTS (keep first ~2000 chars)
  const ttsText = text.length > 2000
    ? text.slice(0, 2000) + "... (message truncated for voice)"
    : text;

  const voice = process.env.BOB_VOICE || DEFAULT_VOICE;

  // Generate MP3 via edge-tts
  const { tts } = await loadEdgeTts();
  const mp3Buffer = await tts(ttsText, { voice });

  // Convert MP3 → OGG/Opus via ffmpeg
  return mp3ToOgg(mp3Buffer);
}

/**
 * Convert MP3 buffer to OGG/Opus buffer using ffmpeg.
 */
function mp3ToOgg(mp3Buffer: Buffer): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const ffmpegStatic = await import("ffmpeg-static");
    const ffmpegModule = await import("fluent-ffmpeg");
    const ffmpeg = ffmpegModule.default;
    const { Readable, PassThrough } = await import("node:stream");

    // Set ffmpeg binary path
    const ffmpegPath = (ffmpegStatic as unknown as { default: string }).default ?? ffmpegStatic;
    ffmpeg.setFfmpegPath(ffmpegPath as string);

    const input = Readable.from(mp3Buffer);
    const output = new PassThrough();
    const chunks: Buffer[] = [];

    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks)));
    output.on("error", reject);

    ffmpeg(input)
      .inputFormat("mp3")
      .audioCodec("libopus")
      .audioBitrate("64k")
      .audioChannels(1)
      .format("ogg")
      .on("error", reject)
      .pipe(output, { end: true });
  });
}
