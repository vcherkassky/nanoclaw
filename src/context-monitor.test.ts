import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveSessionFiles,
  checkCompactionOutcome,
  describeCompaction,
  describeGroupContext,
  effectiveContextTokens,
  estimateSessionTokens,
  findLatestSessionId,
  formatSessionEstimate,
  snapshotCompaction,
} from './context-monitor.js';

describe('estimateSessionTokens', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-monitor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSessionFile(folder: string, sessionId: string, body: string) {
    const dir = path.join(
      tmpDir,
      'data',
      'sessions',
      folder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, body);
    return filePath;
  }

  it('returns zero when session file is absent', () => {
    const result = estimateSessionTokens('no-such-id', 'g', {
      dataDir: path.join(tmpDir, 'data'),
    });
    expect(result.bytes).toBe(0);
    expect(result.estimatedTokens).toBe(0);
    expect(result.exists).toBe(false);
  });

  it('measures whole file when no compact_boundary present', () => {
    // 100 small lines, each non-boundary
    const body =
      Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ type: 'user', i, content: 'hello' }),
      ).join('\n') + '\n';
    const filePath = makeSessionFile('g', 'sess1', body);
    const size = fs.statSync(filePath).size;
    const result = estimateSessionTokens('sess1', 'g', {
      dataDir: path.join(tmpDir, 'data'),
    });
    expect(result.bytes).toBe(size);
    expect(result.totalBytes).toBe(size);
    expect(result.hasCompactBoundary).toBe(false);
    expect(result.preCompactTokens).toBeNull();
    expect(result.estimatedTokens).toBe(Math.round(size / 4));
  });

  it('measures only post-boundary bytes when compact_boundary is present', () => {
    const pre = Array.from({ length: 50 }, () =>
      JSON.stringify({ type: 'user', content: 'old turn '.repeat(20) }),
    ).join('\n');
    const boundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { preTokens: 12345, trigger: 'manual' },
    });
    const post = Array.from({ length: 3 }, () =>
      JSON.stringify({ type: 'user', content: 'new turn' }),
    ).join('\n');
    const body = pre + '\n' + boundary + '\n' + post + '\n';
    const filePath = makeSessionFile('g', 'sess1', body);

    const totalSize = fs.statSync(filePath).size;
    const expectedPost = post.length + 1; // trailing newline
    const result = estimateSessionTokens('sess1', 'g', {
      dataDir: path.join(tmpDir, 'data'),
    });
    expect(result.totalBytes).toBe(totalSize);
    expect(result.bytes).toBe(expectedPost);
    expect(result.bytes).toBeLessThan(result.totalBytes);
    expect(result.hasCompactBoundary).toBe(true);
    expect(result.preCompactTokens).toBe(12345);
    expect(result.estimatedTokens).toBe(Math.round(expectedPost / 4));
  });

  it('uses the LAST compact_boundary when multiple are present', () => {
    const lines = [
      JSON.stringify({ type: 'user', content: 'a' }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { preTokens: 100 },
      }),
      JSON.stringify({ type: 'user', content: 'b'.repeat(500) }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { preTokens: 999 },
      }),
      JSON.stringify({ type: 'user', content: 'after-second' }),
    ];
    const body = lines.join('\n') + '\n';
    makeSessionFile('g', 'sess1', body);
    const result = estimateSessionTokens('sess1', 'g', {
      dataDir: path.join(tmpDir, 'data'),
    });
    expect(result.preCompactTokens).toBe(999);
    // Only the final "after-second" line should remain
    expect(result.bytes).toBe(lines[4].length + 1);
  });

  it('caches results, refreshing when mtime changes', () => {
    const filePath = makeSessionFile('g', 'sess2', 'x'.repeat(400));
    const first = estimateSessionTokens('sess2', 'g', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 60000,
    });

    // Within TTL AND no file change — cache hit
    const cached = estimateSessionTokens('sess2', 'g', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 60000,
    });
    expect(cached.bytes).toBe(first.bytes);

    // Mutate file — cache must invalidate even within TTL (mtime check)
    fs.appendFileSync(filePath, 'y'.repeat(400));
    // Ensure mtime moves forward on filesystems with low precision
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(filePath, future, future);

    const fresh = estimateSessionTokens('sess2', 'g', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 60000,
    });
    expect(fresh.bytes).toBe(800);
  });

  it('extracts actual input tokens (incl. cache) and model from the last assistant turn', () => {
    const lines = [
      JSON.stringify({ type: 'user', content: 'hi' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'gemma4:26b',
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'gemma4:26b',
          usage: {
            input_tokens: 2500,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 100,
            output_tokens: 80,
          },
        },
      }),
    ];
    makeSessionFile('g', 'sess1', lines.join('\n') + '\n');
    const r = estimateSessionTokens('sess1', 'g', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    // LAST assistant turn: 2500 + 400 + 100 = 3000
    expect(r.actualInputTokens).toBe(3000);
    expect(r.model).toBe('gemma4:26b');
  });

  it('discards pre-compaction usage when a compact_boundary follows the last assistant turn', () => {
    // Mirrors a just-ran /compact: an assistant turn, then a boundary, then
    // only the injected summary (user entries) — no new assistant turn yet.
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'gemma4:26b', usage: { input_tokens: 30000 } },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { preTokens: 30000 },
      }),
      JSON.stringify({ type: 'user', content: 'summary line' }),
    ];
    makeSessionFile('g', 'sess1', lines.join('\n') + '\n');
    const r = estimateSessionTokens('sess1', 'g', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    // The 30k usage is pre-compaction → stale → fall back to byte estimate.
    expect(r.actualInputTokens).toBeNull();
    expect(r.hasCompactBoundary).toBe(true);
  });

  it('uses post-compaction assistant usage when a turn follows the boundary', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'gemma4:26b', usage: { input_tokens: 30000 } },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { preTokens: 30000 },
      }),
      JSON.stringify({ type: 'user', content: 'summary' }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'gemma4:26b', usage: { input_tokens: 4200 } },
      }),
    ];
    makeSessionFile('g', 'sess1', lines.join('\n') + '\n');
    const r = estimateSessionTokens('sess1', 'g', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(r.actualInputTokens).toBe(4200);
  });

  it('reports null actual tokens when no assistant usage is present', () => {
    makeSessionFile(
      'g',
      'sess1',
      JSON.stringify({ type: 'user', content: 'x' }) + '\n',
    );
    const r = estimateSessionTokens('sess1', 'g', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(r.actualInputTokens).toBeNull();
    expect(r.model).toBeNull();
  });

  it('rejects path traversal in session id or folder', () => {
    const a = estimateSessionTokens('../escape', 'g', {
      dataDir: path.join(tmpDir, 'data'),
    });
    expect(a.exists).toBe(false);
    expect(a.bytes).toBe(0);
    const b = estimateSessionTokens('s', '../escape', {
      dataDir: path.join(tmpDir, 'data'),
    });
    expect(b.exists).toBe(false);
  });
});

describe('findLatestSessionId', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-monitor-latest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(
    folder: string,
    sessionId: string,
    mtimeMs: number,
    body = 'x',
  ): void {
    const dir = path.join(
      tmpDir,
      'data',
      'sessions',
      folder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, body);
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }

  it('returns null when the session directory does not exist', () => {
    expect(
      findLatestSessionId('does-not-exist', {
        dataDir: path.join(tmpDir, 'data'),
      }),
    ).toBeNull();
  });

  it('returns null when the directory has no jsonl files', () => {
    fs.mkdirSync(
      path.join(
        tmpDir,
        'data',
        'sessions',
        'g',
        '.claude',
        'projects',
        '-workspace-group',
      ),
      { recursive: true },
    );
    expect(
      findLatestSessionId('g', { dataDir: path.join(tmpDir, 'data') }),
    ).toBeNull();
  });

  it('returns the session id of the most recently modified jsonl', () => {
    writeSession('g', 'older', 1_700_000_000_000);
    writeSession('g', 'newer', 1_700_000_100_000);
    expect(
      findLatestSessionId('g', { dataDir: path.join(tmpDir, 'data') }),
    ).toBe('newer');
  });

  it('ignores non-jsonl files', () => {
    writeSession('g', 'only-real', 1_700_000_000_000);
    const dir = path.join(
      tmpDir,
      'data',
      'sessions',
      'g',
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    fs.utimesSync(path.join(dir, 'note.txt'), 9_999_999, 9_999_999);
    expect(
      findLatestSessionId('g', { dataDir: path.join(tmpDir, 'data') }),
    ).toBe('only-real');
  });

  it('rejects unsafe groupFolder', () => {
    expect(
      findLatestSessionId('../escape', {
        dataDir: path.join(tmpDir, 'data'),
      }),
    ).toBeNull();
  });
});

describe('describeGroupContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-monitor-describe-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(
    folder: string,
    sessionId: string,
    body: string,
    mtimeMs?: number,
  ): void {
    const dir = path.join(
      tmpDir,
      'data',
      'sessions',
      folder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, body);
    if (mtimeMs) fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }

  it('falls back to the newest on-disk session when none is tracked', () => {
    // Reproduces the noSession-group bug: the in-memory map has no entry,
    // but a real transcript exists on disk and should be reported.
    writeSession('g', 'on-disk-sess', 'z'.repeat(800));
    const text = describeGroupContext('g', undefined, {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(text.toLowerCase()).not.toContain('no active session yet');
    expect(text).toContain('on-disk-'); // short id of the on-disk session
    expect(text).toContain('200'); // 800 bytes / 4 = 200 tokens
  });

  it('uses the tracked session id when one is provided', () => {
    writeSession('g', 'tracked-sess', 'a'.repeat(400));
    writeSession('g', 'other-sess', 'b'.repeat(4000), Date.now() + 5000);
    const text = describeGroupContext('g', 'tracked-sess', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(text).toContain('tracked-'); // tracked id, not the newer "other-sess"
    expect(text).toContain('100'); // 400 bytes / 4 = 100 tokens
  });

  it('reports empty when nothing is tracked and no files exist on disk', () => {
    const text = describeGroupContext('g', undefined, {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(text.toLowerCase()).toContain('no active session yet');
  });
});

describe('describeCompaction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-monitor-compact-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(folder: string, sessionId: string, body: string) {
    const dir = path.join(
      tmpDir,
      'data',
      'sessions',
      folder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);
  }

  it('reports pre→post tokens and a reduction percent', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'm', usage: { input_tokens: 30000 } },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { preTokens: 30000 },
      }),
      JSON.stringify({ type: 'user', content: 'short summary' }),
    ];
    writeSession('g', 'sess1', lines.join('\n') + '\n');
    const text = describeCompaction('g', 'sess1', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(text.toLowerCase()).toContain('compacted');
    expect(text).toContain('30,000');
    expect(text).toMatch(/\d+% smaller/);
  });

  it('never claims success when no compaction boundary is present', () => {
    writeSession(
      'g',
      'sess1',
      JSON.stringify({ type: 'user', content: 'x' }) + '\n',
    );
    const text = describeCompaction('g', 'sess1', {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(text.toLowerCase()).not.toContain('compaction complete');
    expect(text.toLowerCase()).toContain('no compaction');
  });

  it('never claims success when there is no session at all', () => {
    const text = describeCompaction('g', undefined, {
      dataDir: path.join(tmpDir, 'data'),
      ttlMs: 0,
    });
    expect(text.toLowerCase()).not.toContain('compaction complete');
  });
});

// The shape Claude Code writes when /compact fails (captured from a real
// telegram_main session where the local model overran the output limit).
const COMPACT_FAILURE_LINE = JSON.stringify({
  parentUuid: '58dd55fa',
  isSidechain: false,
  type: 'system',
  subtype: 'local_command',
  content:
    "<local-command-stderr>Error: Error during compaction: Error: API Error: Claude's response exceeded the 20000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.</local-command-stderr>",
  level: 'info',
  timestamp: '2026-10-04T12:52:32.441Z',
  uuid: '0e001258',
  sessionId: 'sess1',
});

const COMPACT_COMMAND_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content:
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
  },
});

describe('compaction outcome', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-monitor-outcome-'));
    dataDir = path.join(tmpDir, 'data');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function sessionFile(sessionId: string): string {
    const dir = path.join(
      dataDir,
      'sessions',
      'g',
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${sessionId}.jsonl`);
  }

  function append(sessionId: string, lines: string[]): void {
    fs.appendFileSync(sessionFile(sessionId), lines.join('\n') + '\n');
  }

  const priorBoundary = JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { preTokens: 12000 },
  });
  const usage = (n: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { model: 'm', usage: { input_tokens: n } },
    });

  it('reports success with stats when a NEW compact_boundary appears', () => {
    append('sess1', [usage(30000)]);
    const snap = snapshotCompaction('g', 'sess1', { dataDir });
    append('sess1', [
      COMPACT_COMMAND_LINE,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { preTokens: 30000 },
      }),
      JSON.stringify({ type: 'user', content: 'summary' }),
    ]);

    const outcome = checkCompactionOutcome('g', 'sess1', snap, { dataDir });

    expect(outcome.compacted).toBe(true);
    if (!outcome.compacted) throw new Error('unreachable');
    expect(outcome.summary).toContain('30,000');
    expect(outcome.summary.toLowerCase()).toContain('compacted');
  });

  it('reports failure with the stderr reason when no new boundary appears', () => {
    // An OLD boundary from an earlier, successful compaction must not count.
    append('sess1', [usage(5000), priorBoundary, usage(40000)]);
    const snap = snapshotCompaction('g', 'sess1', { dataDir });
    append('sess1', [COMPACT_COMMAND_LINE, COMPACT_FAILURE_LINE]);

    const outcome = checkCompactionOutcome('g', 'sess1', snap, { dataDir });

    expect(outcome.compacted).toBe(false);
    if (outcome.compacted) throw new Error('unreachable');
    expect(outcome.reason).toContain(
      "API Error: Claude's response exceeded the 20000 output token maximum",
    );
    expect(outcome.reason).not.toContain('<local-command-stderr>');
    expect(outcome.reason).not.toMatch(/^Error:/);
    expect(outcome.reason).not.toMatch(/\.$/);
  });

  it('reports failure without a reason when nothing new was written', () => {
    append('sess1', [usage(40000)]);
    const snap = snapshotCompaction('g', 'sess1', { dataDir });

    const outcome = checkCompactionOutcome('g', 'sess1', snap, { dataDir });

    expect(outcome).toEqual({ compacted: false, reason: null });
  });

  it('ignores stderr written before the snapshot', () => {
    append('sess1', [COMPACT_COMMAND_LINE, COMPACT_FAILURE_LINE]);
    const snap = snapshotCompaction('g', 'sess1', { dataDir });

    const outcome = checkCompactionOutcome('g', 'sess1', snap, { dataDir });

    expect(outcome).toEqual({ compacted: false, reason: null });
  });

  it('truncates very long failure reasons', () => {
    append('sess1', [usage(40000)]);
    const snap = snapshotCompaction('g', 'sess1', { dataDir });
    append('sess1', [
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        content: `<local-command-stderr>Error: Error during compaction: ${'x'.repeat(2000)}</local-command-stderr>`,
      }),
    ]);

    const outcome = checkCompactionOutcome('g', 'sess1', snap, { dataDir });

    if (outcome.compacted) throw new Error('expected failure');
    expect(outcome.reason!.length).toBeLessThanOrEqual(301);
    expect(outcome.reason).toMatch(/…$/);
  });

  it('scans the whole file when the session id changed during the run', () => {
    append('old', [usage(30000)]);
    const snap = snapshotCompaction('g', 'old', { dataDir });
    append('new', [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { preTokens: 30000 },
      }),
    ]);

    const outcome = checkCompactionOutcome('g', 'new', snap, { dataDir });

    expect(outcome.compacted).toBe(true);
  });

  it('handles a group with no session at all', () => {
    const snap = snapshotCompaction('g', undefined, { dataDir });
    const outcome = checkCompactionOutcome('g', undefined, snap, { dataDir });
    expect(outcome).toEqual({ compacted: false, reason: null });
  });
});

describe('archiveSessionFiles', () => {
  let tmpDir: string;
  let dataDir: string;
  let projDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-monitor-archive-'));
    dataDir = path.join(tmpDir, 'data');
    projDir = path.join(
      dataDir,
      'sessions',
      'g',
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('moves every top-level session jsonl (and sibling dir) into cleared/', () => {
    fs.writeFileSync(path.join(projDir, 'current.jsonl'), 'current');
    fs.writeFileSync(path.join(projDir, 'older.jsonl'), 'older');
    fs.mkdirSync(path.join(projDir, 'current', 'subagents'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projDir, 'current', 'subagents', 'a.jsonl'),
      'a',
    );
    // Not a session transcript: must be left alone.
    fs.writeFileSync(path.join(projDir, 'x.jsonl.bak.1'), 'bak');

    const archived = archiveSessionFiles('g', {
      dataDir,
      now: new Date('2026-10-04T12:00:00.000Z'),
    });

    expect(archived.sort()).toEqual(['current', 'older']);
    const top = fs.readdirSync(projDir).sort();
    expect(top).toEqual(['cleared', 'x.jsonl.bak.1']);
    const cleared = fs.readdirSync(path.join(projDir, 'cleared')).sort();
    expect(cleared).toEqual([
      '2026-10-04T12-00-00-000Z-current',
      '2026-10-04T12-00-00-000Z-current.jsonl',
      '2026-10-04T12-00-00-000Z-older.jsonl',
    ]);
    // Content preserved (recoverable, never deleted).
    expect(
      fs.readFileSync(
        path.join(projDir, 'cleared', '2026-10-04T12-00-00-000Z-current.jsonl'),
        'utf8',
      ),
    ).toBe('current');
    expect(
      fs.existsSync(
        path.join(
          projDir,
          'cleared',
          '2026-10-04T12-00-00-000Z-current',
          'subagents',
          'a.jsonl',
        ),
      ),
    ).toBe(true);
  });

  it('makes archived sessions invisible to findLatestSessionId and /context', () => {
    fs.writeFileSync(path.join(projDir, 'current.jsonl'), 'x'.repeat(800));

    archiveSessionFiles('g', { dataDir });

    expect(findLatestSessionId('g', { dataDir })).toBeNull();
    expect(
      describeGroupContext('g', undefined, { dataDir, ttlMs: 0 }).toLowerCase(),
    ).toContain('no active session yet');
  });

  it('does not overwrite an earlier archive with the same name', () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    fs.writeFileSync(path.join(projDir, 's.jsonl'), 'first');
    archiveSessionFiles('g', { dataDir, now });
    fs.writeFileSync(path.join(projDir, 's.jsonl'), 'second');
    archiveSessionFiles('g', { dataDir, now });

    const cleared = fs.readdirSync(path.join(projDir, 'cleared'));
    expect(cleared).toHaveLength(2);
    const contents = cleared
      .map((f) => fs.readFileSync(path.join(projDir, 'cleared', f), 'utf8'))
      .sort();
    expect(contents).toEqual(['first', 'second']);
  });

  it('returns [] when the session directory does not exist', () => {
    expect(archiveSessionFiles('missing', { dataDir })).toEqual([]);
  });

  it('rejects unsafe group folders', () => {
    expect(archiveSessionFiles('../escape', { dataDir })).toEqual([]);
  });
});

describe('effectiveContextTokens', () => {
  const base = {
    sessionId: 's',
    bytes: 884000,
    estimatedTokens: 221000,
    totalBytes: 884000,
    hasCompactBoundary: false,
    preCompactTokens: null,
    exists: true,
    sessionFile: '/p',
    model: 'gemma4:26b',
  };

  it('prefers the model-reported size when available', () => {
    expect(
      effectiveContextTokens({ ...base, actualInputTokens: 50912 }),
    ).toEqual({ tokens: 50912, exact: true });
  });

  it('falls back to the byte estimate when no usage was reported', () => {
    expect(
      effectiveContextTokens({ ...base, actualInputTokens: null }),
    ).toEqual({ tokens: 221000, exact: false });
  });
});

describe('formatSessionEstimate', () => {
  it('formats actual usage with percent of the configured model limit', () => {
    const text = formatSessionEstimate(
      {
        sessionId: '8e2ebaa4-6e1c',
        bytes: 0,
        estimatedTokens: 0,
        totalBytes: 0,
        hasCompactBoundary: false,
        preCompactTokens: null,
        exists: true,
        sessionFile: '/some/path/8e2ebaa4.jsonl',
        actualInputTokens: 30066,
        model: 'gemma4:26b',
      },
      { limits: { 'gemma4:26b': 32768 } },
    );
    expect(text).toContain('30,066');
    expect(text).toContain('32,768');
    expect(text).toContain('92%');
    expect(text).toContain('gemma4:26b');
  });

  it('formats actual usage without percent when the model limit is unknown', () => {
    const text = formatSessionEstimate(
      {
        sessionId: 'abc12345',
        bytes: 0,
        estimatedTokens: 0,
        totalBytes: 0,
        hasCompactBoundary: false,
        preCompactTokens: null,
        exists: true,
        sessionFile: '/p',
        actualInputTokens: 5000,
        model: 'mystery-model',
      },
      { limits: {} },
    );
    expect(text).toContain('5,000');
    expect(text).not.toContain('%');
  });

  it('falls back to the byte estimate when no actual usage is available', () => {
    const text = formatSessionEstimate({
      sessionId: 'abc12345xyz',
      bytes: 320000,
      estimatedTokens: 80000,
      totalBytes: 320000,
      hasCompactBoundary: false,
      preCompactTokens: null,
      exists: true,
      sessionFile: '/some/path/abc.jsonl',
      actualInputTokens: null,
      model: null,
    });
    expect(text).toContain('80,000');
    expect(text.toLowerCase()).toContain('no compaction yet');
  });

  it('says "no active session" when absent', () => {
    const text = formatSessionEstimate({
      sessionId: 'abc',
      bytes: 0,
      estimatedTokens: 0,
      totalBytes: 0,
      hasCompactBoundary: false,
      preCompactTokens: null,
      exists: false,
      sessionFile: '/some/path.jsonl',
      actualInputTokens: null,
      model: null,
    });
    expect(text.toLowerCase()).toContain('no active session');
  });
});
