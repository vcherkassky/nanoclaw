import { describe, expect, it } from 'vitest';

import {
  messageCursor,
  parseMessageCursor,
  sanitizeStoredCursor,
} from './message-cursor.js';

describe('message cursors', () => {
  const TS = '2026-10-04T12:00:00.000Z';

  it('encodes timestamp and seq, and parses them back', () => {
    const c = messageCursor({ timestamp: TS, seq: 42 });
    expect(c).toBe(`${TS}|42`);
    expect(parseMessageCursor(c)).toEqual({ timestamp: TS, seq: 42 });
  });

  it('falls back to the bare timestamp when a message has no seq', () => {
    expect(messageCursor({ timestamp: TS })).toBe(TS);
  });

  it('parses legacy timestamp-only cursors (and empty) with seq null', () => {
    expect(parseMessageCursor(TS)).toEqual({ timestamp: TS, seq: null });
    expect(parseMessageCursor('')).toEqual({ timestamp: '', seq: null });
  });

  it('downgrades a stored cursor whose seq is beyond the DB to a legacy cursor', () => {
    // e.g. the DB was restored from an older backup: rowids went backwards.
    expect(sanitizeStoredCursor(`${TS}|500`, 100)).toBe(TS);
    expect(sanitizeStoredCursor(`${TS}|100`, 100)).toBe(`${TS}|100`);
    expect(sanitizeStoredCursor(TS, 0)).toBe(TS);
    expect(sanitizeStoredCursor('', 0)).toBe('');
  });

  it('treats a malformed seq as part of a legacy cursor', () => {
    expect(parseMessageCursor(`${TS}|abc`)).toEqual({
      timestamp: `${TS}|abc`,
      seq: null,
    });
  });
});
