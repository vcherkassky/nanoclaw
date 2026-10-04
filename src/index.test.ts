import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

const H = vi.hoisted(() => ({
  dataDir: `${process.env.TMPDIR ?? '/tmp'}/nanoclaw-index-test-${process.pid}`,
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Claw',
  TRIGGER_PATTERN: /@Claw/i,
  IDLE_TIMEOUT: 30_000,
  POLL_INTERVAL: 1_000,
  TIMEZONE: 'UTC',
  CREDENTIAL_PROXY_PORT: 9999,
  PUBLIC_INBOX_TARGET_JID: 'pa-inbox@g.us',
  DATA_DIR: H.dataDir,
  CONTEXT_WARN_TOKENS: 80_000,
  MODEL_CONTEXT_LIMITS: {},
  DEFAULT_CONTEXT_LIMIT: 0,
  MAX_CONCURRENT_CONTAINERS: 2,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  initDatabase: vi.fn(),
  getRouterState: vi.fn(() => null),
  setRouterState: vi.fn(),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getMaxMessageSeq: vi.fn(() => 0),
  getAllChats: vi.fn(() => []),
  getMessagesSince: vi.fn(),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getRegisteredGroup: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setSession: vi.fn(),
  deleteSession: vi.fn(),
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
  return {
    ...actual,
    default: { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() },
  };
});

// --- Imports (after mocks) ---

import fs from 'fs';
import path from 'path';
import {
  deleteSession,
  getMessagesSince,
  getAllTasks,
  setSession,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { clearContextMonitorCache } from './context-monitor.js';
import {
  runContainerAgent,
  writeTasksSnapshot,
  writeGroupsSnapshot,
} from './container-runner.js';
import { findChannel } from './router.js';
import {
  _processGroupMessages,
  _processEmailHeadless,
  _resetLastAgentTimestamp,
  _dispatchGroupMessages,
  _setChannels,
  _setRegisteredGroups,
  _setSessions,
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
    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'timeout',
    });

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
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _register, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: 'Here is my answer',
            newSessionId: undefined,
          });
        }
        return { status: 'error', result: null, error: 'post-output failure' };
      },
    );

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
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _register, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: 'Done!',
            newSessionId: undefined,
          });
        }
        return { status: 'success', result: 'Done!' };
      },
    );

    const result = await _processGroupMessages(GROUP_JID);

    const errorCall = vi
      .mocked(channel.sendMessage)
      .mock.calls.find((args) => args[1] === 'Agent error — please try again.');
    expect(errorCall).toBeUndefined();
    expect(result).toBe(true);
  });
});

// --- processEmailHeadless tests ---

const PA_JID = 'pa-inbox@g.us';

function makeEmailMsg(content = 'From: test@example.com\nSubject: Hi\n\nBody') {
  return {
    id: 'msg1',
    chat_jid: PA_JID,
    sender: 'test@example.com',
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
  };
}

describe('processEmailHeadless', () => {
  beforeEach(() => {
    vi.mocked(getAllTasks).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extracts <notify> tag and sends to WhatsApp', async () => {
    const channel = makeMockChannel();
    _setChannels([channel as any]);
    vi.mocked(findChannel).mockReturnValue(channel as any);
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _register, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result:
              'Logged.\n<notify>New invoice from Acme — £1,200 due Friday</notify>',
          });
        }
        return { status: 'success', result: null };
      },
    );

    await _processEmailHeadless(makeEmailMsg() as any);

    expect(channel.sendMessage).toHaveBeenCalledOnce();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      PA_JID,
      'New invoice from Acme — £1,200 due Friday',
    );
  });

  it('sends nothing when output contains no <notify> tag', async () => {
    const channel = makeMockChannel();
    _setChannels([channel as any]);
    vi.mocked(findChannel).mockReturnValue(channel as any);
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _register, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: 'Logged. No action needed.',
          });
        }
        return { status: 'success', result: null };
      },
    );

    await _processEmailHeadless(makeEmailMsg() as any);

    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('writes _close sentinel after first output to prevent 10-min idle wait', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _register, onOutput) => {
        if (onOutput) await onOutput({ status: 'success', result: 'Done.' });
        return { status: 'success', result: null };
      },
    );

    await _processEmailHeadless(makeEmailMsg() as any);

    const writeFileCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const closeCalls = writeFileCalls.filter((args) =>
      String(args[0]).endsWith('_close'),
    );
    expect(closeCalls).toHaveLength(1);
  });

  it('writes task and group snapshots before spawning the container', async () => {
    const spawnOrder: string[] = [];
    vi.mocked(writeTasksSnapshot).mockImplementation(() => {
      spawnOrder.push('tasks');
    });
    vi.mocked(writeGroupsSnapshot).mockImplementation(() => {
      spawnOrder.push('groups');
    });
    vi.mocked(runContainerAgent).mockImplementation(async () => {
      spawnOrder.push('spawn');
      return { status: 'success', result: null };
    });

    await _processEmailHeadless(makeEmailMsg() as any);

    expect(spawnOrder.indexOf('tasks')).toBeLessThan(
      spawnOrder.indexOf('spawn'),
    );
    expect(spawnOrder.indexOf('groups')).toBeLessThan(
      spawnOrder.indexOf('spawn'),
    );
  });

  it('throws when the container returns an error', async () => {
    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'container timeout',
    });

    await expect(_processEmailHeadless(makeEmailMsg() as any)).rejects.toThrow(
      'container timeout',
    );
  });
});

// --- Session lifecycle: /clear, /context, reconcile, batching, warnings ---

describe('processGroupMessages — session lifecycle', () => {
  const projDir = path.join(
    H.dataDir,
    'sessions',
    TEST_GROUP.folder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  let realFs: typeof import('fs');
  let store: Array<Record<string, unknown>>;
  let seq: number;
  let channel: ReturnType<typeof makeMockChannel>;

  function say(content: string) {
    seq++;
    store.push({
      id: `m${seq}`,
      chat_jid: GROUP_JID,
      sender: 'user@s.whatsapp.net',
      content,
      timestamp: `2026-01-02T00:00:${String(seq).padStart(2, '0')}.000Z`,
      is_from_me: true,
      is_bot_message: false,
    });
  }

  function writeSession(id: string, body = 'x\n', mtimeMs?: number) {
    realFs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, `${id}.jsonl`);
    realFs.writeFileSync(file, body);
    if (mtimeMs) realFs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  /** One normal turn in which the agent reports `sessionId` as its session. */
  async function turnWithSession(sessionId: string) {
    say('@Claw hi');
    vi.mocked(runContainerAgent).mockImplementationOnce(
      async (_g, _i, _r, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'hello',
          newSessionId: sessionId,
        });
        return { status: 'success', result: null, newSessionId: sessionId };
      },
    );
    await _processGroupMessages(GROUP_JID);
  }

  const sent = () => channel.sendMessage.mock.calls.map((c) => c[1]);

  beforeEach(async () => {
    realFs = await vi.importActual<typeof import('fs')>('fs');
    realFs.rmSync(H.dataDir, { recursive: true, force: true });
    // index.test mocks fs.mkdirSync/writeFileSync as no-ops; the archive and
    // IPC code under test need real directories here.
    vi.mocked(fs.mkdirSync).mockImplementation(realFs.mkdirSync as any);
    clearContextMonitorCache();
    store = [];
    seq = 0;
    _setRegisteredGroups({ [GROUP_JID]: TEST_GROUP });
    _setSessions({});
    _resetLastAgentTimestamp();
    channel = makeMockChannel();
    _setChannels([channel as any]);
    vi.mocked(findChannel).mockReturnValue(channel as any);
    vi.mocked(getMessagesSince).mockImplementation(
      (_jid: string, since: string) =>
        store.filter((m) => (m.timestamp as string) > since) as any,
    );
  });

  afterEach(() => {
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(runContainerAgent).mockReset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    realFs.rmSync(H.dataDir, { recursive: true, force: true });
  });

  describe('/clear', () => {
    it('drops the tracked session, archives every transcript and confirms', async () => {
      writeSession('older-sess', 'old\n', Date.now() - 60_000);
      writeSession('cur-sess', 'cur\n');
      realFs.mkdirSync(path.join(projDir, 'cur-sess', 'subagents'), {
        recursive: true,
      });
      await turnWithSession('cur-sess');
      expect(setSession).toHaveBeenCalledWith(TEST_GROUP.folder, 'cur-sess');
      channel.sendMessage.mockClear();
      vi.mocked(runContainerAgent).mockClear();

      say('/clear');
      const ok = await _processGroupMessages(GROUP_JID);

      expect(ok).toBe(true);
      expect(runContainerAgent).not.toHaveBeenCalled();
      expect(deleteSession).toHaveBeenCalledWith(TEST_GROUP.folder);
      expect(sent()).toEqual([
        '🧹 Session cleared. Your next message starts a fresh conversation (long-term memory in CLAUDE.md is kept).',
      ]);
      expect(realFs.readdirSync(projDir)).toEqual(['cleared']);
      const archived = realFs.readdirSync(path.join(projDir, 'cleared'));
      expect(
        archived.filter((f) => f.endsWith('-cur-sess.jsonl')),
      ).toHaveLength(1);
      expect(
        archived.filter((f) => f.endsWith('-older-sess.jsonl')),
      ).toHaveLength(1);
      expect(archived.filter((f) => f.endsWith('-cur-sess'))).toHaveLength(1);
    });

    it('makes /context report no session afterwards', async () => {
      writeSession('cur-sess', 'x'.repeat(4000));
      await turnWithSession('cur-sess');
      say('/clear');
      await _processGroupMessages(GROUP_JID);
      channel.sendMessage.mockClear();

      say('/context');
      await _processGroupMessages(GROUP_JID);

      expect(sent()).toHaveLength(1);
      expect(sent()[0].toLowerCase()).toContain('no active session yet');
      expect(sent()[0]).not.toContain('cur-sess'.slice(0, 8));
    });

    it('starts the next message with no sessionId and tracks the new session', async () => {
      writeSession('cur-sess');
      await turnWithSession('cur-sess');
      say('/clear');
      await _processGroupMessages(GROUP_JID);
      vi.mocked(setSession).mockClear();

      let seenSessionId: string | undefined = 'unset';
      say('@Claw fresh start');
      vi.mocked(runContainerAgent).mockImplementationOnce(
        async (_g, input, _r, onOutput) => {
          seenSessionId = input.sessionId;
          await onOutput?.({
            status: 'success',
            result: 'hi again',
            newSessionId: 'brand-new',
          });
          return { status: 'success', result: null, newSessionId: 'brand-new' };
        },
      );
      await _processGroupMessages(GROUP_JID);

      expect(seenSessionId).toBeUndefined();
      expect(setSession).toHaveBeenCalledWith(TEST_GROUP.folder, 'brand-new');
    });

    it('reconcile fallback never re-adopts an archived session', async () => {
      writeSession('cur-sess');
      await turnWithSession('cur-sess');
      say('/clear');
      await _processGroupMessages(GROUP_JID);
      vi.mocked(setSession).mockClear();

      // Streaming marker lost and no new transcript on disk.
      say('@Claw are you there');
      vi.mocked(runContainerAgent).mockResolvedValueOnce({
        status: 'success',
        result: null,
      });
      await _processGroupMessages(GROUP_JID);
      expect(setSession).not.toHaveBeenCalled();

      // Streaming marker lost, but the fresh session's transcript exists:
      // the fallback must pick it, not anything from cleared/.
      say('@Claw again');
      vi.mocked(runContainerAgent).mockImplementationOnce(async () => {
        writeSession('fresh-on-disk');
        return { status: 'success', result: null };
      });
      await _processGroupMessages(GROUP_JID);
      expect(setSession).toHaveBeenCalledTimes(1);
      expect(setSession).toHaveBeenCalledWith(
        TEST_GROUP.folder,
        'fresh-on-disk',
      );
    });
  });

  describe('queued session commands', () => {
    it('re-enqueues the group when more messages are pending after a handled command', async () => {
      const enqueue = vi
        .spyOn(GroupQueue.prototype, 'enqueueMessageCheck')
        .mockImplementation(() => {});
      say('/status');
      say('/context');

      await _processGroupMessages(GROUP_JID);
      expect(sent()).toEqual(['Status digest is not configured.']);
      expect(enqueue).toHaveBeenCalledWith(GROUP_JID);

      // The drain run handles the second command.
      enqueue.mockClear();
      await _processGroupMessages(GROUP_JID);
      expect(sent()[1].toLowerCase()).toContain('no active session yet');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('does not re-enqueue when the command was the last pending message', async () => {
      const enqueue = vi
        .spyOn(GroupQueue.prototype, 'enqueueMessageCheck')
        .mockImplementation(() => {});
      say('/context');
      await _processGroupMessages(GROUP_JID);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('a failing earlier message never blocks /clear (the escape hatch)', async () => {
      const enqueue = vi
        .spyOn(GroupQueue.prototype, 'enqueueMessageCheck')
        .mockImplementation(() => {});
      writeSession('cur-sess');
      await turnWithSession('cur-sess');
      channel.sendMessage.mockClear();
      vi.mocked(runContainerAgent).mockReset();
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'error',
        result: null,
        error: 'model down',
      });
      say('@Claw hi');
      say('/clear');

      const ok = await _processGroupMessages(GROUP_JID);

      expect(ok).toBe(true);
      expect(runContainerAgent).toHaveBeenCalledOnce();
      expect(deleteSession).toHaveBeenCalledOnce();
      expect(sent()).toEqual([
        "Your earlier message couldn't be processed and was dropped — please resend it after the clear.",
        '🧹 Session cleared. Your next message starts a fresh conversation (long-term memory in CLAUDE.md is kept).',
      ]);
      expect(enqueue).not.toHaveBeenCalled();

      // Nothing is left pending: another pass does no work.
      expect(await _processGroupMessages(GROUP_JID)).toBe(true);
      expect(runContainerAgent).toHaveBeenCalledOnce();
      expect(deleteSession).toHaveBeenCalledOnce();
    });

    it('a /compact skipped after a failed earlier message never runs later', async () => {
      say('@Claw question');
      say('/compact');
      vi.mocked(runContainerAgent).mockImplementationOnce(
        async (_g, _i, _r, onOutput) => {
          await onOutput?.({ status: 'success', result: 'partial answer' });
          return { status: 'error', result: null, error: 'crash' };
        },
      );
      await _processGroupMessages(GROUP_JID);
      expect(sent().at(-1)).toContain('/compact was not run');

      say('@Claw thanks');
      const prompts: string[] = [];
      vi.mocked(runContainerAgent).mockImplementationOnce(async (_g, input) => {
        prompts.push(input.prompt);
        return { status: 'success', result: null };
      });
      await _processGroupMessages(GROUP_JID);

      expect(prompts).toEqual(['formatted messages']);
      expect(
        vi
          .mocked(runContainerAgent)
          .mock.calls.some(([, input]) => input.prompt === '/compact'),
      ).toBe(false);
    });

    it('answers a question sent just before /clear, then clears', async () => {
      writeSession('cur-sess');
      await turnWithSession('cur-sess');
      channel.sendMessage.mockClear();
      say('@Claw what is 2+2?');
      say('/clear');
      let promptSessionId: string | undefined;
      vi.mocked(runContainerAgent).mockImplementationOnce(
        async (_g, input, _r, onOutput) => {
          promptSessionId = input.sessionId;
          await onOutput?.({
            status: 'success',
            result: '4',
            newSessionId: 'cur-sess',
          });
          await onOutput?.({
            status: 'success',
            result: null,
            newSessionId: 'cur-sess',
          });
          return { status: 'success', result: null, newSessionId: 'cur-sess' };
        },
      );

      await _processGroupMessages(GROUP_JID);

      expect(promptSessionId).toBe('cur-sess'); // answered in the old session
      expect(sent()).toEqual([
        '4',
        '🧹 Session cleared. Your next message starts a fresh conversation (long-term memory in CLAUDE.md is kept).',
      ]);
      expect(deleteSession).toHaveBeenCalledWith(TEST_GROUP.folder);
    });
  });

  describe('message loop dispatch', () => {
    let pipe: ReturnType<typeof vi.spyOn>;
    let enqueue: ReturnType<typeof vi.spyOn>;
    let close: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Pretend a container is alive and accepting piped messages.
      pipe = vi
        .spyOn(GroupQueue.prototype, 'sendMessage')
        .mockReturnValue(true);
      enqueue = vi
        .spyOn(GroupQueue.prototype, 'enqueueMessageCheck')
        .mockImplementation(() => {});
      close = vi
        .spyOn(GroupQueue.prototype, 'closeStdin')
        .mockImplementation(() => {});
    });

    const latest = () => [store[store.length - 1]] as any;

    it('pipes an ordinary message into the live container', () => {
      say('@Claw hello');
      _dispatchGroupMessages(GROUP_JID, latest());
      expect(pipe).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('closes the live container and enqueues for an authorized command', () => {
      say('/clear');
      _dispatchGroupMessages(GROUP_JID, latest());
      expect(close).toHaveBeenCalledWith(GROUP_JID);
      expect(enqueue).toHaveBeenCalledWith(GROUP_JID);
      expect(pipe).not.toHaveBeenCalled();
    });

    it('does not pipe a follow-up while an earlier command is still pending', () => {
      say('/clear'); // seen by an earlier poll, not yet handled
      say('@Claw hi'); // this poll
      _dispatchGroupMessages(GROUP_JID, latest());
      expect(pipe).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith(GROUP_JID);
    });

    it('does not let a non-admin command close the container', () => {
      _setRegisteredGroups({
        [GROUP_JID]: { ...TEST_GROUP, isMain: false, requiresTrigger: false },
      });
      say('/clear');
      store[store.length - 1].is_from_me = false;
      _dispatchGroupMessages(GROUP_JID, latest());
      expect(close).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith(GROUP_JID);
    });
  });

  describe('context-size warning', () => {
    const usageLine = (n: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { model: 'gemma4:26b', usage: { input_tokens: n } },
      });
    // ~400 kB of transcript → bytes/4 ≈ 100k tokens, above the 80k threshold.
    const padding = JSON.stringify({ type: 'user', pad: 'p'.repeat(400_000) });

    const warnings = () =>
      sent().filter((t: string) => t.includes('Conversation context at'));

    it('uses the model-reported size and stays quiet when it is under the threshold', async () => {
      writeSession('warn-a', `${padding}\n${usageLine(50_912)}\n`);
      await turnWithSession('warn-a');
      say('@Claw next');
      vi.mocked(runContainerAgent).mockResolvedValueOnce({
        status: 'success',
        result: null,
        newSessionId: 'warn-a',
      });
      await _processGroupMessages(GROUP_JID);
      expect(warnings()).toEqual([]);
    });

    it('reports the model-reported size without "estimated" when over the threshold', async () => {
      writeSession('warn-b', `${usageLine(90_000)}\n`);
      await turnWithSession('warn-b');
      say('@Claw next');
      vi.mocked(runContainerAgent).mockResolvedValueOnce({
        status: 'success',
        result: null,
        newSessionId: 'warn-b',
      });
      await _processGroupMessages(GROUP_JID);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('at 90k tokens');
      expect(warnings()[0]).not.toContain('estimated');
    });

    it('falls back to the byte estimate, labelled as such, when no usage is recorded', async () => {
      writeSession('warn-c', `${padding}\n`);
      await turnWithSession('warn-c');
      say('@Claw next');
      vi.mocked(runContainerAgent).mockResolvedValueOnce({
        status: 'success',
        result: null,
        newSessionId: 'warn-c',
      });
      await _processGroupMessages(GROUP_JID);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toMatch(/at ~100k tokens \(estimated\)/);
    });

    it('re-arms after a successful /compact (the session id does not change)', async () => {
      writeSession('warn-d', `${usageLine(90_000)}\n`);
      await turnWithSession('warn-d');
      say('@Claw next');
      vi.mocked(runContainerAgent).mockResolvedValueOnce({
        status: 'success',
        result: null,
        newSessionId: 'warn-d',
      });
      await _processGroupMessages(GROUP_JID);
      expect(warnings()).toHaveLength(1);

      say('/compact');
      vi.mocked(runContainerAgent).mockImplementationOnce(
        async (_g, _i, _r, onOutput) => {
          realFs.appendFileSync(
            path.join(projDir, 'warn-d.jsonl'),
            JSON.stringify({
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: { preTokens: 90_000 },
            }) + '\n',
          );
          await onOutput?.({
            status: 'success',
            result: 'Conversation compacted.',
            newSessionId: 'warn-d',
          });
          return { status: 'success', result: null, newSessionId: 'warn-d' };
        },
      );
      await _processGroupMessages(GROUP_JID);
      expect(sent().some((t: string) => t.startsWith('🗜️ Compacted'))).toBe(
        true,
      );

      // The conversation grows past the threshold again in the same session.
      realFs.appendFileSync(
        path.join(projDir, 'warn-d.jsonl'),
        usageLine(85_000) + '\n',
      );
      clearContextMonitorCache();
      say('@Claw more');
      vi.mocked(runContainerAgent).mockResolvedValueOnce({
        status: 'success',
        result: null,
        newSessionId: 'warn-d',
      });
      await _processGroupMessages(GROUP_JID);
      expect(warnings()).toHaveLength(2);
      expect(warnings()[1]).toContain('at 85k tokens');
    });
  });
});
