import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'PUBLIC_INBOX_TARGET_JID',
  'MODEL_CONTEXT_LIMITS',
  'DEFAULT_CONTEXT_LIMIT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const OLLAMA_PROXY_PORT = parseInt(
  process.env.OLLAMA_PROXY_PORT || '11500',
  10,
);
export const OLLAMA_REAL_HOST =
  process.env.OLLAMA_REAL_HOST || 'http://127.0.0.1:11434';
/**
 * Parse a `MODEL_CONTEXT_LIMITS` string into a model→max-tokens map.
 * Format: comma-separated `model=limit` pairs, e.g.
 *   "gemma4:26b=32768,claude-opus-4-8=200000"
 * Model names may contain colons, so we split each entry on the first `=`.
 * Malformed entries (no `=`, empty key, non-numeric limit) are skipped.
 */
export function parseModelContextLimits(
  raw: string | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const idx = entry.indexOf('=');
    if (idx === -1) continue;
    const key = entry.slice(0, idx).trim();
    const value = parseInt(entry.slice(idx + 1).trim(), 10);
    if (!key || Number.isNaN(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Per-model context-window sizes, used by /context to show % of limit. */
export const MODEL_CONTEXT_LIMITS = parseModelContextLimits(
  process.env.MODEL_CONTEXT_LIMITS || envConfig.MODEL_CONTEXT_LIMITS,
);

/** Fallback context-window size when a model isn't in MODEL_CONTEXT_LIMITS. */
export const DEFAULT_CONTEXT_LIMIT = parseInt(
  process.env.DEFAULT_CONTEXT_LIMIT || envConfig.DEFAULT_CONTEXT_LIMIT || '0',
  10,
);

export const CONTEXT_WARN_TOKENS = parseInt(
  process.env.CONTEXT_WARN_TOKENS || '80000',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

export const PUBLIC_INBOX_TARGET_JID =
  process.env.PUBLIC_INBOX_TARGET_JID ||
  envConfig.PUBLIC_INBOX_TARGET_JID ||
  '';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Daily status digest (pinned Telegram message). Disabled if no main
// Telegram group is registered; explicit STATUS_ENABLED=false also disables.
export const STATUS_ENABLED =
  (process.env.STATUS_ENABLED ?? 'true').toLowerCase() !== 'false';
export const STATUS_REFRESH_HOUR = parseInt(
  process.env.STATUS_REFRESH_HOUR ?? '8',
  10,
);
export const STATUS_REFRESH_MINUTE = parseInt(
  process.env.STATUS_REFRESH_MINUTE ?? '0',
  10,
);
