import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  _initTestDatabase,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from '../../db.js';
import { EmailProvider } from './email.js';

let tmpQuarantine: string;
beforeEach(() => {
  _initTestDatabase();
  tmpQuarantine = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'q-')),
    'q.jsonl',
  );
});

describe('EmailProvider', () => {
  it('handles a clean pipeline with no quarantine', async () => {
    storeChatMetadata(
      'gmail:1',
      '2026-06-28T08:00:00.000Z',
      'inbox',
      'gmail',
      false,
    );
    storeMessage({
      id: 'a',
      chat_jid: 'gmail:1',
      sender: 'x@y.com',
      sender_name: 'x',
      content: 'hi',
      timestamp: '2026-06-28T08:30:00.000Z',
      is_from_me: false,
    });
    setRouterState('channel:gmail:last_poll', '2026-06-28T08:55:00.000Z');

    const provider = new EmailProvider({
      quarantinePath: tmpQuarantine, // file does not exist — treat as 0
      classifierErrorCount: () => 0,
      now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
    });
    const result = await provider.collect();
    expect(result.bucket).toBe('email');
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Received (24h)']).toBe('1');
    expect(byLabel['Safe (24h)']).toBe('1');
    expect(byLabel['Quarantined (24h)']).toBe('0');
    expect(byLabel['Classifier errors (1h)']).toBe('0');
    expect(byLabel['Last poll']).toMatch(/ago$/);
  });

  it('counts quarantine entries within the 24h window', async () => {
    fs.writeFileSync(
      tmpQuarantine,
      [
        JSON.stringify({ timestamp: '2026-06-28T08:00:00.000Z' }),
        JSON.stringify({ timestamp: '2026-06-26T08:00:00.000Z' }), // outside window
      ].join('\n'),
    );
    const provider = new EmailProvider({
      quarantinePath: tmpQuarantine,
      classifierErrorCount: () => 0,
      now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
    });
    const result = await provider.collect();
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Quarantined (24h)']).toBe('1');
  });
});
