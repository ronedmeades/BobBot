import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SRC_DIR, "..");
export const ENV_PATH = resolve(PROJECT_ROOT, ".env");

export function loadEnvFile(): void {
  migrateUnsafeEbayRefreshToken();
  dotenv.config({ path: ENV_PATH });
}

function migrateUnsafeEbayRefreshToken(): void {
  if (!existsSync(ENV_PATH)) return;

  const content = readFileSync(ENV_PATH, "utf-8");
  const lines = content.split(/\r?\n/);
  let changed = false;

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) return line;

    const key = line.slice(0, eqIdx).trim();
    if (key !== "EBAY_REFRESH_TOKEN") return line;

    const rawValue = line.slice(eqIdx + 1).trim();
    const isQuoted =
      (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"));

    if (isQuoted || !rawValue.includes("#")) return line;

    changed = true;
    return `${key}=${JSON.stringify(rawValue)}`;
  });

  if (changed) {
    writeFileSync(ENV_PATH, updatedLines.join("\n"), "utf-8");
  }
}

export function readRawEnvValue(key: string): string | null {
  if (!existsSync(ENV_PATH)) return null;

  const content = readFileSync(ENV_PATH, "utf-8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const currentKey = trimmed.slice(0, eqIdx).trim();
    if (currentKey !== key) continue;

    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    return value;
  }

  return null;
}

export function getEnvValue(key: string): string {
  const loaded = process.env[key] ?? "";
  const raw = readRawEnvValue(key) ?? "";

  if (!loaded) return raw;
  if (!raw || raw === loaded) return loaded;

  // dotenv treats unquoted '#' as a comment. Prefer the raw line if it clearly
  // extends the loaded value with a token suffix.
  if (raw.startsWith(loaded) && raw.length > loaded.length && raw.includes("#")) {
    return raw;
  }

  return loaded;
}
