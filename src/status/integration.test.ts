import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  recordAgentRun,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import { StatusManager } from './manager.js';
import { AgentRunsProvider } from './providers/agent-runs.js';
import { ChannelsProvider } from './providers/channels.js';
import { EmailProvider } from './providers/email.js';
import { ModelProxyProvider } from './providers/model-proxy.js';
import { ScheduledTasksProvider } from './providers/scheduled.js';
import { SystemProvider } from './providers/system.js';
import { renderTelegramStatus } from './renderers/telegram.js';

beforeEach(() => _initTestDatabase());

describe('status integration', () => {
  it('seeds DB and produces a pinned-message text containing every section', async () => {
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
    setRouterState('channel:telegram:last_poll', '2026-06-28T08:55:00.000Z');
    recordAgentRun({
      group_folder: 'main',
      started_at: '2026-06-28T08:31:00.000Z',
      ended_at: '2026-06-28T08:32:00.000Z',
      duration_ms: 60_000,
      exit_code: 0,
      model: 'gemma4:26b',
      error_class: null,
    });

    const fakeChannel = {
      name: 'telegram',
      isConnected: () => true,
      ownsJid: () => false,
      sendMessage: async () => {},
      connect: async () => {},
      disconnect: async () => {},
    };

    const mgr = new StatusManager({
      providers: [
        new ChannelsProvider({
          channels: [fakeChannel as any],
          now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
        }),
        new EmailProvider({
          quarantinePath: '/nonexistent',
          classifierErrorCount: () => 0,
          now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
        }),
        new AgentRunsProvider({
          now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
        }),
        new ModelProxyProvider({
          getStats: () => ({
            currentModel: 'gemma4:26b',
            evictions: 1,
            requests: 12,
            lastEvictionAt: '2026-06-28T08:00:00.000Z',
          }),
        }),
        new ScheduledTasksProvider({
          now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
        }),
        new SystemProvider({ version: '1.2.14' }),
      ],
    });

    const results = await mgr.collectAll();
    const text = renderTelegramStatus(results, new Date('2026-06-28T09:00:00.000Z'));
    for (const marker of [
      '📊 NANOCLAW STATUS',
      '📡 Channels & Connections',
      '📧 Email Pipeline',
      '🤖 Agent Runs',
      '🔀 Model Proxy',
      '⏱ Scheduled Tasks',
      '⚙️ System',
    ]) {
      expect(text).toContain(marker);
    }
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});
