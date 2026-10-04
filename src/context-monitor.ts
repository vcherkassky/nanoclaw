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

import {
  DATA_DIR,
  DEFAULT_CONTEXT_LIMIT,
  MODEL_CONTEXT_LIMITS,
} from './config.js';

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
  /** Exact context size the model reported on its most recent assistant turn
   * (input_tokens + cache_read + cache_creation), or null if the transcript
   * has no assistant usage yet. This is preferred over the bytes/4 estimate. */
  actualInputTokens: number | null;
  /** Model name from the most recent assistant turn, or null. */
  model: string | null;
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
  actualInputTokens: number | null;
  model: string | null;
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
  actualInputTokens: number | null;
  model: string | null;
} {
  const buf = fs.readFileSync(file);
  const totalBytes = buf.length;
  let cursor = 0;
  let lastBoundaryEnd: number | null = null;
  let preCompactTokens: number | null = null;
  let actualInputTokens: number | null = null;
  let model: string | null = null;

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
            // Any assistant usage seen so far is pre-compaction and no longer
            // reflects the current context. Discard it; a post-boundary
            // assistant turn (if any) will set it again below.
            actualInputTokens = null;
            model = null;
          }
        } catch {
          /* malformed line; skip */
        }
      }
      // Capture the most recent assistant turn's reported usage + model. The
      // model reports the exact context size per turn, which is far better than
      // the bytes/4 estimate. Hint on '"usage"' to avoid parsing every line.
      if (line.includes('"usage"')) {
        try {
          const obj = JSON.parse(line) as {
            type?: string;
            message?: {
              model?: string;
              usage?: {
                input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
          };
          const usage =
            obj.type === 'assistant' ? obj.message?.usage : undefined;
          if (usage && typeof usage.input_tokens === 'number') {
            actualInputTokens =
              usage.input_tokens +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0);
            model = obj.message?.model ?? model;
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
    actualInputTokens,
    model,
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

function sessionDirPath(dataDir: string, groupFolder: string): string | null {
  if (!SAFE_NAME.test(groupFolder)) return null;
  return path.join(
    dataDir,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
}

/**
 * Find the most recently modified session JSONL file for a group and return
 * its session ID (filename without `.jsonl`). Returns `null` if the directory
 * doesn't exist or has no `.jsonl` files.
 *
 * Used as a defensive reconciliation: the SDK communicates new session IDs via
 * streaming markers, which we miss if the container is SIGKILL'd. Scanning the
 * directory after each container run lets us recover the latest session ID
 * even when those markers never arrived.
 */
export function findLatestSessionId(
  groupFolder: string,
  opts: { dataDir?: string } = {},
): string | null {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const dir = sessionDirPath(dataDir, groupFolder);
  if (!dir) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let bestSessionId: string | null = null;
  let bestMtimeMs = -1;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    if (!SAFE_NAME.test(sessionId)) continue;
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      if (stat.mtimeMs > bestMtimeMs) {
        bestMtimeMs = stat.mtimeMs;
        bestSessionId = sessionId;
      }
    } catch {
      // ignore unreadable files
    }
  }
  return bestSessionId;
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
      actualInputTokens: null,
      model: null,
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
      actualInputTokens: cached.actualInputTokens,
      model: cached.model,
    };
  }

  if (!exists) {
    cache.set(cacheKey, {
      bytes: 0,
      totalBytes: 0,
      hasCompactBoundary: false,
      preCompactTokens: null,
      actualInputTokens: null,
      model: null,
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
      actualInputTokens: null,
      model: null,
    };
  }

  const scan = scanForLastBoundary(file);
  cache.set(cacheKey, {
    bytes: scan.postBoundaryBytes,
    totalBytes: scan.totalBytes,
    hasCompactBoundary: scan.hasBoundary,
    preCompactTokens: scan.preCompactTokens,
    actualInputTokens: scan.actualInputTokens,
    model: scan.model,
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
    actualInputTokens: scan.actualInputTokens,
    model: scan.model,
  };
}

export interface FormatOptions {
  /** model → context-window size, for showing % of limit. */
  limits?: Record<string, number>;
  /** Fallback window size when the model isn't in `limits`. */
  defaultLimit?: number;
}

export function formatSessionEstimate(
  e: SessionEstimate,
  opts: FormatOptions = {},
): string {
  if (!e.exists) {
    return `No active session on disk (id ${e.sessionId}). Context: 0 tokens.`;
  }
  const sessionShort = e.sessionId.slice(0, 8);

  // Preferred path: the model reported an exact context size for its last turn.
  if (e.actualInputTokens !== null) {
    const tokens = e.actualInputTokens.toLocaleString();
    const limit = (e.model && opts.limits?.[e.model]) || opts.defaultLimit || 0;
    const parts = [`Session ${sessionShort}…: ${tokens} tokens`];
    if (limit > 0) {
      const pct = Math.round((e.actualInputTokens / limit) * 100);
      parts[0] = `Session ${sessionShort}…: ${tokens} / ${limit.toLocaleString()} tokens (${pct}%)`;
    }
    if (e.model) parts.push(`· ${e.model}`);
    return parts.join(' ');
  }

  const tokens = e.estimatedTokens.toLocaleString();
  const kbActive = (e.bytes / 1024).toFixed(1);
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

/**
 * Resolve a group's effective context and format it for `/context`.
 *
 * Prefers the session id we track in memory, but falls back to the newest
 * session transcript on disk when nothing is tracked. The fallback matters for
 * groups that run with `noSession` (e.g. scheduled/monitor groups): their
 * in-memory entry is never populated, yet the SDK still writes a real
 * transcript to disk. Without the fallback `/context` would report a constant
 * "no active session" regardless of activity.
 */
export function describeGroupContext(
  groupFolder: string,
  trackedSessionId: string | undefined,
  opts: EstimateOptions & FormatOptions = {},
): string {
  const sessionId =
    trackedSessionId ?? findLatestSessionId(groupFolder, opts) ?? undefined;
  if (!sessionId) return 'No active session yet — context is empty.';
  const estimate = estimateSessionTokens(sessionId, groupFolder, opts);
  return formatSessionEstimate(estimate, {
    limits: opts.limits ?? MODEL_CONTEXT_LIMITS,
    defaultLimit: opts.defaultLimit ?? DEFAULT_CONTEXT_LIMIT,
  });
}

/**
 * Build a one-line compaction summary for after a `/compact` run: how many
 * tokens were summarized and the resulting size. Right after compaction there
 * is no post-boundary assistant turn yet, so the post size is the byte estimate
 * of the injected summary (prefixed `~`); it becomes exact on the next message.
 */
export function describeCompaction(
  groupFolder: string,
  trackedSessionId: string | undefined,
  opts: EstimateOptions = {},
): string {
  const sessionId =
    trackedSessionId ?? findLatestSessionId(groupFolder, opts) ?? undefined;
  // Never claim success without a compact_boundary on disk as evidence.
  if (!sessionId) return 'No compaction recorded — there is no session yet.';
  const e = estimateSessionTokens(sessionId, groupFolder, opts);
  if (!e.hasCompactBoundary) return 'No compaction recorded for this session.';
  const approx = e.actualInputTokens === null;
  const post = e.actualInputTokens ?? e.estimatedTokens;
  const postStr = `${approx ? '~' : ''}${post.toLocaleString()}`;
  let msg: string;
  if (e.preCompactTokens) {
    const pct = Math.max(0, Math.round((1 - post / e.preCompactTokens) * 100));
    msg = `🗜️ Compacted: ${e.preCompactTokens.toLocaleString()} → ${postStr} tokens (${pct}% smaller).`;
  } else {
    msg = `🗜️ Compacted: now ${postStr} tokens.`;
  }
  if (approx) msg += ' Exact size updates after your next message.';
  return msg;
}

/** Where a session transcript stood just before `/compact` was sent. */
export interface CompactionSnapshot {
  sessionId: string | null;
  /** Transcript size in bytes; anything after this offset is new. */
  offset: number;
}

export type CompactionOutcome =
  | { compacted: true; summary: string }
  | { compacted: false; reason: string | null };

const MAX_COMPACTION_REASON_CHARS = 300;

/**
 * Record the current end of the group's session transcript so that
 * `checkCompactionOutcome` can tell records written by this `/compact` run
 * apart from older ones (e.g. a boundary from a previous compaction).
 * Byte offsets avoid comparing container and host clocks.
 */
export function snapshotCompaction(
  groupFolder: string,
  trackedSessionId: string | undefined,
  opts: { dataDir?: string } = {},
): CompactionSnapshot {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const sessionId =
    trackedSessionId ?? findLatestSessionId(groupFolder, { dataDir });
  if (!sessionId) return { sessionId: null, offset: 0 };
  const file = sessionFilePath(dataDir, groupFolder, sessionId);
  let offset = 0;
  if (file) {
    try {
      offset = fs.statSync(file).size;
    } catch {
      // No transcript yet — everything that appears is new.
    }
  }
  return { sessionId, offset };
}

/** Turn Claude Code's local_command stderr into a short human reason. */
function cleanCompactionError(raw: string): string | null {
  let text = raw.replace(/\s+/g, ' ').trim();
  // "Error: Error during compaction: Error: API Error: …" → "API Error: …"
  let prev: string;
  do {
    prev = text;
    text = text.replace(/^(?:Error:\s*|Error during compaction:\s*)/i, '');
  } while (text !== prev);
  text = text.replace(/[.\s]+$/, '');
  if (!text) return null;
  if (text.length > MAX_COMPACTION_REASON_CHARS) {
    text = text.slice(0, MAX_COMPACTION_REASON_CHARS - 1).trimEnd() + '…';
  }
  return text;
}

/**
 * Decide whether a `/compact` run actually compacted the session: success
 * requires a NEW `compact_boundary` record after the snapshot. On failure,
 * return the reason Claude Code wrote to the transcript's local_command
 * stderr (e.g. the model overrunning its output-token limit), if any.
 */
export function checkCompactionOutcome(
  groupFolder: string,
  trackedSessionId: string | undefined,
  snapshot: CompactionSnapshot,
  opts: { dataDir?: string } = {},
): CompactionOutcome {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const sessionId =
    trackedSessionId ?? findLatestSessionId(groupFolder, { dataDir });
  if (!sessionId) return { compacted: false, reason: null };
  const file = sessionFilePath(dataDir, groupFolder, sessionId);
  if (!file) return { compacted: false, reason: null };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { compacted: false, reason: null };
  }
  // A different session id (or a file that shrank) means the transcript was
  // replaced during the run: everything in it is new.
  const start =
    sessionId === snapshot.sessionId && snapshot.offset <= buf.length
      ? snapshot.offset
      : 0;

  let sawBoundary = false;
  let reason: string | null = null;
  for (const line of buf.subarray(start).toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      !(
        trimmed.includes('compact_boundary') ||
        trimmed.includes('local-command-stderr')
      )
    ) {
      continue;
    }
    let obj: { subtype?: string; content?: unknown };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.subtype === 'compact_boundary') {
      sawBoundary = true;
    } else if (
      obj.subtype === 'local_command' &&
      typeof obj.content === 'string'
    ) {
      const m = obj.content.match(
        /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/,
      );
      const cleaned = m ? cleanCompactionError(m[1]) : null;
      if (cleaned) reason = cleaned;
    }
  }

  if (sawBoundary) {
    return {
      compacted: true,
      summary: describeCompaction(groupFolder, sessionId, {
        dataDir,
        ttlMs: 0,
      }),
    };
  }
  return { compacted: false, reason };
}

/**
 * The best available context size for a session: the model-reported prompt
 * size of the last assistant turn when present (exact), else the bytes/4
 * transcript estimate. The estimate badly overstates real context (thinking
 * blocks, base64 tool results and metadata all live in the jsonl), so callers
 * should label it as estimated.
 */
export function effectiveContextTokens(e: SessionEstimate): {
  tokens: number;
  exact: boolean;
} {
  return e.actualInputTokens !== null
    ? { tokens: e.actualInputTokens, exact: true }
    : { tokens: e.estimatedTokens, exact: false };
}

/**
 * Move every top-level session transcript (`<id>.jsonl`, plus its sibling
 * `<id>/` directory of subagent/tool-result files) into `cleared/` under the
 * same projects dir, as `cleared/<timestamp>-<id>.jsonl`. Used by `/clear`.
 *
 * All transcripts are archived, not just the tracked one, because
 * `findLatestSessionId` adopts whichever top-level jsonl is newest: leaving an
 * older session in place would let the reconcile fallback (or `/context`)
 * resurrect it. Nothing is deleted; files stay recoverable from `cleared/`.
 * Returns the archived session ids.
 */
export function archiveSessionFiles(
  groupFolder: string,
  opts: { dataDir?: string; now?: Date } = {},
): string[] {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const dir = sessionDirPath(dataDir, groupFolder);
  if (!dir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const clearedDir = path.join(dir, 'cleared');
  const archived: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    if (!SAFE_NAME.test(sessionId)) continue;
    fs.mkdirSync(clearedDir, { recursive: true });
    let base = `${stamp}-${sessionId}`;
    for (
      let n = 1;
      fs.existsSync(path.join(clearedDir, `${base}.jsonl`)) ||
      fs.existsSync(path.join(clearedDir, base));
      n++
    ) {
      base = `${stamp}-${sessionId}-${n}`;
    }
    fs.renameSync(
      path.join(dir, entry.name),
      path.join(clearedDir, `${base}.jsonl`),
    );
    const siblingDir = path.join(dir, sessionId);
    try {
      if (fs.statSync(siblingDir).isDirectory()) {
        fs.renameSync(siblingDir, path.join(clearedDir, base));
      }
    } catch {
      // No sibling directory for this session.
    }
    archived.push(sessionId);
  }
  cache.clear();
  return archived;
}

/** Clear in-memory cache. Useful for tests; also called after /compact. */
export function clearContextMonitorCache(): void {
  cache.clear();
}
