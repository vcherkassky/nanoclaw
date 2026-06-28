import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from '../../db.js';
import { ChannelsProvider } from './channels.js';

beforeEach(() => _initTestDatabase());

function fakeChannel(name: string, connected: boolean) {
  return {
    name,
    isConnected: () => connected,
    ownsJid: () => false,
    sendMessage: async () => {},
    connect: async () => {},
    disconnect: async () => {},
  };
}

describe('ChannelsProvider', () => {
  it('reports connection state + last poll + 24h volume per channel', async () => {
    storeChatMetadata('tg:1', '2026-06-28T08:00:00.000Z', 'Main', 'telegram', false);
    storeMessage({
      id: 'm1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'u',
      content: 'hi',
      timestamp: '2026-06-28T08:30:00.000Z',
      is_from_me: false,
    });
    setRouterState('channel:telegram:last_poll', '2026-06-28T07:55:00.000Z');

    const provider = new ChannelsProvider({
      channels: [fakeChannel('telegram', true)],
      now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
    });
    const result = await provider.collect();
    expect(result.bucket).toBe('channels');
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.label).toBe('telegram');
    expect(row.value).toContain('Connected');
    expect(row.value).toContain('1 (24h)');
    expect(row.value).toContain('1h ago'); // last poll was 1h05m ago — formatRelativeTime floors
  });

  it('shows "never" for last poll when KV is empty', async () => {
    const provider = new ChannelsProvider({
      channels: [fakeChannel('telegram', true)],
      now: () => Date.now(),
    });
    const result = await provider.collect();
    expect(result.rows[0].value).toContain('last poll never');
  });

  it('marks disconnected channels accordingly', async () => {
    const provider = new ChannelsProvider({
      channels: [fakeChannel('whatsapp', false)],
      now: () => Date.now(),
    });
    const result = await provider.collect();
    expect(result.rows[0].value).toContain('Disconnected');
  });
});
