import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeGroupContext,
  estimateSessionTokens,
  findLatestSessionId,
  formatSessionEstimate,
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

describe('formatSessionEstimate', () => {
  it('formats a never-compacted session', () => {
    const text = formatSessionEstimate({
      sessionId: 'abc12345xyz',
      bytes: 320000,
      estimatedTokens: 80000,
      totalBytes: 320000,
      hasCompactBoundary: false,
      preCompactTokens: null,
      exists: true,
      sessionFile: '/some/path/abc.jsonl',
    });
    expect(text).toContain('80,000');
    expect(text.toLowerCase()).toContain('no compaction yet');
  });

  it('formats a compacted session with effective vs transcript distinction', () => {
    const text = formatSessionEstimate({
      sessionId: '8e2ebaa4-6e1c',
      bytes: 7432,
      estimatedTokens: 1858,
      totalBytes: 389364,
      hasCompactBoundary: true,
      preCompactTokens: 60506,
      exists: true,
      sessionFile: '/some/path/8e2ebaa4.jsonl',
    });
    expect(text).toContain('1,858');
    expect(text.toLowerCase()).toContain('effective tokens');
    expect(text).toContain('60,506');
    expect(text).toContain('8e2ebaa4');
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
    });
    expect(text.toLowerCase()).toContain('no active session');
  });
});
