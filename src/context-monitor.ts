/**
 * Lightweight on-disk estimator for the active Claude Agent SDK session's
 * conversation history.
 *
 * Ollama doesn't surface input_tokens via the SDK (we see 0), so we can't
 * read true context usage from the model side. Instead we stat the
 * session's transcript jsonl file and approximate tokens ≈ bytes/4. Coarse
 * but plenty good for "are we approaching the danger zone?" warnings.
 *
 * Stats are cached briefly (5s default) so per-message polling doesn't
 * thrash the filesystem.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

export interface SessionEstimate {
  sessionId: string;
  /** Bytes of effective context — content after the most recent compact_boundary
   * (or the whole file if no boundary has happened yet). This is what the
   * agent actually re-reads on resume, not the total transcript size. */
  bytes: number;
  estimatedTokens: number;
  /** Total transcript bytes on disk (always grows; not a context metric). */
  totalBytes: number;
  /** True if this session has ever been compacted. */
  hasCompactBoundary: boolean;
  /** Pre-compact token count the SDK reported at the most recent boundary,
   * or null if no boundary has happened yet. */
  preCompactTokens: number | null;
  exists: boolean;
  sessionFile: string;
}

interface EstimateOptions {
  /** Override DATA_DIR (tests). */
  dataDir?: string;
  /** Cache TTL in milliseconds. Default 5000. Set to 0 to bypass cache. */
  ttlMs?: number;
}

interface CacheEntry {
  bytes: number;
  totalBytes: number;
  hasCompactBoundary: boolean;
  preCompactTokens: number | null;
  mtimeMs: number;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Parse the jsonl to find the most recent compact_boundary marker.
 * Returns the byte offset right after that marker, or null if absent.
 * Also returns the SDK-reported preTokens from that boundary's metadata.
 */
function scanForLastBoundary(file: string): {
  postBoundaryBytes: number;
  hasBoundary: boolean;
  preCompactTokens: number | null;
  totalBytes: number;
} {
  const buf = fs.readFileSync(file);
  const totalBytes = buf.length;
  let cursor = 0;
  let lastBoundaryEnd: number | null = null;
  let preCompactTokens: number | null = null;

  while (cursor < totalBytes) {
    const nl = buf.indexOf(0x0a, cursor); // '\n'
    const end = nl === -1 ? totalBytes : nl + 1;
    const line = buf.slice(cursor, end).toString('utf8').trim();
    if (line) {
      // Only parse lines that mention the boundary subtype to keep this cheap
      // on long jsonls. Fall back to JSON.parse if the hint is present.
      if (line.includes('compact_boundary')) {
        try {
          const obj = JSON.parse(line) as {
            subtype?: string;
            compact_metadata?: { preTokens?: number };
            compactMetadata?: { preTokens?: number };
          };
          if (obj.subtype === 'compact_boundary') {
            lastBoundaryEnd = end;
            preCompactTokens =
              obj.compact_metadata?.preTokens ??
              obj.compactMetadata?.preTokens ??
              null;
          }
        } catch {
          /* malformed line; skip */
        }
      }
    }
    if (nl === -1) break;
    cursor = end;
  }

  return {
    postBoundaryBytes:
      lastBoundaryEnd === null ? totalBytes : totalBytes - lastBoundaryEnd,
    hasBoundary: lastBoundaryEnd !== null,
    preCompactTokens,
    totalBytes,
  };
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function sessionFilePath(
  dataDir: string,
  groupFolder: string,
  sessionId: string,
): string | null {
  if (!SAFE_NAME.test(sessionId) || !SAFE_NAME.test(groupFolder)) return null;
  return path.join(
    dataDir,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

export function estimateSessionTokens(
  sessionId: string,
  groupFolder: string,
  opts: EstimateOptions = {},
): SessionEstimate {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const ttlMs = opts.ttlMs ?? 5000;
  const file = sessionFilePath(dataDir, groupFolder, sessionId);
  if (!file) {
    return {
      sessionId,
      bytes: 0,
      estimatedTokens: 0,
      totalBytes: 0,
      hasCompactBoundary: false,
      preCompactTokens: null,
      exists: false,
      sessionFile: '',
    };
  }

  const cacheKey = file;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  // Cache hit is conditional on mtime — if the file changed since we cached,
  // skip the cache regardless of ttl.
  let mtimeMs = 0;
  let exists = false;
  try {
    const stat = fs.statSync(file);
    mtimeMs = stat.mtimeMs;
    exists = true;
  } catch {
    // Missing file is normal for brand-new sessions
  }

  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    now - cached.at < ttlMs &&
    exists
  ) {
    return {
      sessionId,
      bytes: cached.bytes,
      estimatedTokens: Math.round(cached.bytes / 4),
      totalBytes: cached.totalBytes,
      hasCompactBoundary: cached.hasCompactBoundary,
      preCompactTokens: cached.preCompactTokens,
      exists: cached.bytes > 0 || cached.totalBytes > 0,
      sessionFile: file,
    };
  }

  if (!exists) {
    cache.set(cacheKey, {
      bytes: 0,
      totalBytes: 0,
      hasCompactBoundary: false,
      preCompactTokens: null,
      mtimeMs: 0,
      at: now,
    });
    return {
      sessionId,
      bytes: 0,
      estimatedTokens: 0,
      totalBytes: 0,
      hasCompactBoundary: false,
      preCompactTokens: null,
      exists: false,
      sessionFile: file,
    };
  }

  const scan = scanForLastBoundary(file);
  cache.set(cacheKey, {
    bytes: scan.postBoundaryBytes,
    totalBytes: scan.totalBytes,
    hasCompactBoundary: scan.hasBoundary,
    preCompactTokens: scan.preCompactTokens,
    mtimeMs,
    at: now,
  });

  return {
    sessionId,
    bytes: scan.postBoundaryBytes,
    estimatedTokens: Math.round(scan.postBoundaryBytes / 4),
    totalBytes: scan.totalBytes,
    hasCompactBoundary: scan.hasBoundary,
    preCompactTokens: scan.preCompactTokens,
    exists: true,
    sessionFile: file,
  };
}

export function formatSessionEstimate(e: SessionEstimate): string {
  if (!e.exists) {
    return `No active session on disk (id ${e.sessionId}). Context: 0 tokens.`;
  }
  const tokens = e.estimatedTokens.toLocaleString();
  const kbActive = (e.bytes / 1024).toFixed(1);
  const sessionShort = e.sessionId.slice(0, 8);
  if (e.hasCompactBoundary) {
    const totalKb = (e.totalBytes / 1024).toFixed(1);
    const pre = e.preCompactTokens
      ? e.preCompactTokens.toLocaleString()
      : 'unknown';
    return (
      `Session ${sessionShort}…: ~${tokens} effective tokens since last compaction ` +
      `(${kbActive} kB / ${totalKb} kB transcript on disk). ` +
      `Pre-compact: ${pre} tokens were summarized.`
    );
  }
  return `Session ${sessionShort}…: ~${tokens} tokens (${kbActive} kB on disk). No compaction yet.`;
}

/** Clear in-memory cache. Useful for tests; also called after /compact. */
export function clearContextMonitorCache(): void {
  cache.clear();
}
