import { describe, expect, it } from 'vitest';

import { messageCursor, parseMessageCursor } from './message-cursor.js';

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

  it('treats a malformed seq as part of a legacy cursor', () => {
    expect(parseMessageCursor(`${TS}|abc`)).toEqual({
      timestamp: `${TS}|abc`,
      seq: null,
    });
  });
});
