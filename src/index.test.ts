import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Claw',
  TRIGGER_PATTERN: /@Claw/i,
  IDLE_TIMEOUT: 30_000,
  POLL_INTERVAL: 1_000,
  TIMEZONE: 'UTC',
  CREDENTIAL_PROXY_PORT: 9999,
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('./db.js', () => ({
  initDatabase: vi.fn(),
  getRouterState: vi.fn(() => null),
  setRouterState: vi.fn(),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  getMessagesSince: vi.fn(),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getRegisteredGroup: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setSession: vi.fn(),
  storeMessage: vi.fn(),
  storeChatMetadata: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./router.js', () => ({
  findChannel: vi.fn(),
  formatMessages: vi.fn(() => 'formatted messages'),
  formatOutbound: vi.fn((t: string) => t),
  escapeXml: vi.fn((t: string) => t),
}));

vi.mock('./sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({})),
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  shouldDropMessage: vi.fn(() => false),
}));

vi.mock('./channels/index.js', () => ({}));
vi.mock('./channels/registry.js', () => ({
  getRegisteredChannelNames: vi.fn(() => []),
  getChannelFactory: vi.fn(),
}));

vi.mock('./container-runtime.js', () => ({
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
  PROXY_BIND_HOST: '127.0.0.1',
}));

vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: vi.fn(async () => ({ close: vi.fn() })),
}));

vi.mock('./ipc.js', () => ({ startIpcWatcher: vi.fn() }));
vi.mock('./task-scheduler.js', () => ({ startSchedulerLoop: vi.fn() }));
vi.mock('./remote-control.js', () => ({
  restoreRemoteControl: vi.fn(),
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-group'),
  resolveGroupIpcPath: vi.fn(() => '/tmp/test-group/ipc'),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, mkdirSync: vi.fn() } };
});

// --- Imports (after mocks) ---

import { getMessagesSince } from './db.js';
import { runContainerAgent } from './container-runner.js';
import { findChannel } from './router.js';
import {
  _processGroupMessages,
  _resetLastAgentTimestamp,
  _setChannels,
  _setRegisteredGroups,
} from './index.js';

// --- Helpers ---

const GROUP_JID = 'group1@g.us';
const TEST_GROUP = {
  name: 'Test Group',
  folder: 'test_group',
  trigger: '@Claw',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};

const TEST_MESSAGES = [
  {
    id: '1',
    chat_jid: GROUP_JID,
    sender: 'user@s.whatsapp.net',
    content: '@Claw hello',
    timestamp: '2026-01-01T00:00:01.000Z',
    is_from_me: false,
    is_bot_message: false,
  },
];

function makeMockChannel() {
  return {
    name: 'whatsapp',
    ownsJid: vi.fn((_jid: string) => true),
    sendMessage: vi.fn(async (_jid: string, _text: string) => {}),
    setTyping: vi.fn(async (_jid: string, _on: boolean) => {}),
    markRead: vi.fn(async (_jid: string, _msgs: unknown[]) => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
}

// --- Tests ---

describe('processGroupMessages — error notification', () => {
  beforeEach(() => {
    _setRegisteredGroups({ [GROUP_JID]: TEST_GROUP });
    _resetLastAgentTimestamp();
    vi.mocked(getMessagesSince).mockReturnValue(TEST_MESSAGES as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends error message to channel when container errors with no prior output', async () => {
    const channel = makeMockChannel();
    _setChannels([channel as any]);
    vi.mocked(findChannel).mockReturnValue(channel as any);
    vi.mocked(runContainerAgent).mockResolvedValue({ status: 'error', result: null, error: 'timeout' });

    const result = await _processGroupMessages(GROUP_JID);

    expect(channel.sendMessage).toHaveBeenCalledWith(
      GROUP_JID,
      'Agent error — please try again.',
    );
    // Cursor rolled back → returns false so the queue can retry
    expect(result).toBe(false);
  });

  it('does not send error message when container errors after output was already sent', async () => {
    const channel = makeMockChannel();
    _setChannels([channel as any]);
    vi.mocked(findChannel).mockReturnValue(channel as any);

    // Simulate: streaming callback fires with a result first, then container returns error
    vi.mocked(runContainerAgent).mockImplementation(async (_group, _input, _register, onOutput) => {
      if (onOutput) {
        await onOutput({ status: 'success', result: 'Here is my answer', newSessionId: undefined });
      }
      return { status: 'error', result: null, error: 'post-output failure' };
    });

    await _processGroupMessages(GROUP_JID);

    // sendMessage was called once for the output, but NOT a second time for the error
    const calls = vi.mocked(channel.sendMessage).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).not.toBe('Agent error — please try again.');
  });

  it('does not send error message on successful container run', async () => {
    const channel = makeMockChannel();
    _setChannels([channel as any]);
    vi.mocked(findChannel).mockReturnValue(channel as any);
    vi.mocked(runContainerAgent).mockImplementation(async (_group, _input, _register, onOutput) => {
      if (onOutput) {
        await onOutput({ status: 'success', result: 'Done!', newSessionId: undefined });
      }
      return { status: 'success', result: 'Done!' };
    });

    const result = await _processGroupMessages(GROUP_JID);

    const errorCall = vi.mocked(channel.sendMessage).mock.calls.find(
      (args) => args[1] === 'Agent error — please try again.',
    );
    expect(errorCall).toBeUndefined();
    expect(result).toBe(true);
  });
});
