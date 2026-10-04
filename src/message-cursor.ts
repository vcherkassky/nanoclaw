/**
 * Message cursors: the high-water marks stored in router_state
 * (`last_timestamp`, `last_agent_timestamp`).
 *
 * Telegram timestamps have 1-second resolution, so a timestamp alone can't
 * say "everything up to THIS message": advancing to a message's timestamp
 * would also skip a later message from the same second. A cursor is
 * therefore `<timestamp>|<seq>`, where seq is the message's SQLite rowid
 * (insertion order). A plain `<timestamp>` (legacy, or a message without a
 * seq) still works and means "after everything at that timestamp", exactly
 * as before — no migration is needed.
 */
import type { NewMessage } from './types.js';

const SEP = '|';

export function messageCursor(msg: Pick<NewMessage, 'timestamp' | 'seq'>) {
  return typeof msg.seq === 'number'
    ? `${msg.timestamp}${SEP}${msg.seq}`
    : msg.timestamp;
}

/** Split a cursor into its timestamp and seq (null for legacy cursors). */
export function parseMessageCursor(cursor: string): {
  timestamp: string;
  seq: number | null;
} {
  const i = cursor.lastIndexOf(SEP);
  if (i === -1) return { timestamp: cursor, seq: null };
  const seq = Number(cursor.slice(i + 1));
  if (!Number.isInteger(seq)) return { timestamp: cursor, seq: null };
  return { timestamp: cursor.slice(0, i), seq };
}
