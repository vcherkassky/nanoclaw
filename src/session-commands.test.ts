import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  _initTestDatabase,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  CLEAR_CONFIRMATION,
  extractSessionCommand,
  handleSessionCommand,
  hasPendingAuthorizedSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });

  it('detects bare /context', () => {
    expect(extractSessionCommand('/context', trigger)).toBe('/context');
  });

  it('detects /context with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /context', trigger)).toBe('/context');
  });

  it('detects bare /status', () => {
    expect(extractSessionCommand('/status', trigger)).toBe('/status');
  });

  it('detects /status with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /status', trigger)).toBe('/status');
  });

  it('detects bare /clear', () => {
    expect(extractSessionCommand('/clear', trigger)).toBe('/clear');
  });

  it('detects /clear with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /clear', trigger)).toBe('/clear');
  });

  it('rejects /clear with extra text', () => {
    expect(extractSessionCommand('/clear everything', trigger)).toBeNull();
  });
});

describe('hasPendingAuthorizedSessionCommand', () => {
  const trigger = /^@Andy\b/i;
  const msg = (content: string, is_from_me = false) =>
    ({
      id: content,
      chat_jid: 'g',
      sender: 's',
      sender_name: 'S',
      content,
      timestamp: '1',
      is_from_me,
    }) as NewMessage;

  it('is true when an authorized /clear is still pending behind new messages', () => {
    expect(
      hasPendingAuthorizedSessionCommand(
        [msg('/clear'), msg('hello')],
        true,
        trigger,
      ),
    ).toBe(true);
  });

  it('is false when nothing pending is a session command', () => {
    expect(
      hasPendingAuthorizedSessionCommand([msg('hello')], true, trigger),
    ).toBe(false);
  });

  it('ignores commands the sender is not allowed to run', () => {
    // An untrusted /clear doesn't close the container, so it must not stop
    // follow-up messages from being piped to it either.
    expect(
      hasPendingAuthorizedSessionCommand(
        [msg('/clear', false), msg('hello')],
        false,
        trigger,
      ),
    ).toBe(false);
    expect(
      hasPendingAuthorizedSessionCommand(
        [msg('/clear', true), msg('hello')],
        false,
        trigger,
      ),
    ).toBe(true);
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  describe('/compact outcome reporting', () => {
    // The agent emits its own text ("Conversation compacted.", or a short
    // apology) — that must never reach the chat alongside the host message.
    const agentSays = (text: string, status: 'success' | 'error' = 'success') =>
      vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status, result: text });
        await onOutput({ status: 'success', result: null });
        return status;
      });

    it('sends exactly one stats message when a new boundary was written', async () => {
      const finish = vi.fn().mockReturnValue({
        compacted: true,
        summary: '🗜️ Compacted: 30,000 → ~1,900 tokens (94% smaller).',
      });
      const beginCompaction = vi.fn().mockReturnValue(finish);
      const deps = makeDeps({
        beginCompaction,
        runAgent: agentSays('Conversation compacted.'),
      });
      const result = await handleSessionCommand({
        missedMessages: [makeMsg('/compact')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(result).toEqual({ handled: true, success: true });
      // Snapshot taken before the agent runs, outcome checked after.
      expect(beginCompaction.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(deps.runAgent).mock.invocationCallOrder[0],
      );
      expect(finish).toHaveBeenCalledOnce();
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        '🗜️ Compacted: 30,000 → ~1,900 tokens (94% smaller).',
      );
      expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    });

    it('sends exactly one failure message with the reason when no boundary was written', async () => {
      const deps = makeDeps({
        beginCompaction: vi.fn().mockReturnValue(() => ({
          compacted: false,
          reason:
            "API Error: Claude's response exceeded the 20000 output token maximum",
        })),
        runAgent: agentSays('Sorry, something went wrong.'),
      });
      await handleSessionCommand({
        missedMessages: [makeMsg('/compact')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const text = vi.mocked(deps.sendMessage).mock.calls[0][0];
      expect(text).toBe(
        "⚠️ Compaction failed: API Error: Claude's response exceeded the 20000 output token maximum. Session unchanged — use /clear to start fresh.",
      );
      expect(text).not.toContain('Compaction complete');
    });

    it('sends one generic failure message when no reason is recorded', async () => {
      const deps = makeDeps({
        beginCompaction: vi
          .fn()
          .mockReturnValue(() => ({ compacted: false, reason: null })),
        runAgent: agentSays('Conversation compacted.'),
      });
      await handleSessionCommand({
        missedMessages: [makeMsg('/compact')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const text = vi.mocked(deps.sendMessage).mock.calls[0][0];
      expect(text).toMatch(/^⚠️ Compaction failed: /);
      expect(text).toContain('Session unchanged');
      expect(text).not.toContain('Conversation compacted');
    });

    it('sends one failure message when the agent itself errors', async () => {
      const deps = makeDeps({
        beginCompaction: vi
          .fn()
          .mockReturnValue(() => ({ compacted: false, reason: null })),
        runAgent: agentSays('boom', 'error'),
      });
      await handleSessionCommand({
        missedMessages: [makeMsg('/compact')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.sendMessage).mock.calls[0][0]).toMatch(
        /^⚠️ Compaction failed: .*agent.*error/i,
      );
    });

    it('still reports success if the boundary exists despite an agent error', async () => {
      const deps = makeDeps({
        beginCompaction: vi
          .fn()
          .mockReturnValue(() => ({ compacted: true, summary: 'stats' })),
        runAgent: agentSays('late error', 'error'),
      });
      await handleSessionCommand({
        missedMessages: [makeMsg('/compact')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      expect(deps.sendMessage).toHaveBeenCalledWith('stats');
    });
  });

  describe('/clear', () => {
    it('clears the session host-side, closes any live container and confirms once', async () => {
      const clearSession = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({ clearSession });
      const result = await handleSessionCommand({
        missedMessages: [makeMsg('/clear')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(result).toEqual({ handled: true, success: true });
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(deps.closeStdin).toHaveBeenCalledOnce();
      // The container is told to close before its session is pulled away.
      expect(
        vi.mocked(deps.closeStdin).mock.invocationCallOrder[0],
      ).toBeLessThan(clearSession.mock.invocationCallOrder[0]);
      expect(clearSession).toHaveBeenCalledOnce();
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        '🧹 Session cleared. Your next message starts a fresh conversation (long-term memory in CLAUDE.md is kept).',
      );
      expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    });

    it('reports failure (and still consumes the command) when clearing throws', async () => {
      const deps = makeDeps({
        clearSession: vi.fn().mockRejectedValue(new Error('EACCES')),
      });
      const result = await handleSessionCommand({
        missedMessages: [makeMsg('/clear')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(result).toEqual({ handled: true, success: true });
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.sendMessage).mock.calls[0][0]).toMatch(
        /failed to clear/i,
      );
      expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    });

    it('sends a stub message when clearing is not wired up', async () => {
      const deps = makeDeps({ clearSession: undefined });
      await handleSessionCommand({
        missedMessages: [makeMsg('/clear')],
        isMainGroup: true,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'Session clearing is not available in this build.',
      );
    });

    it('is admin-gated like the other session commands', async () => {
      const clearSession = vi.fn();
      const deps = makeDeps({ clearSession });
      const result = await handleSessionCommand({
        missedMessages: [makeMsg('/clear', { is_from_me: false })],
        isMainGroup: false,
        groupName: 'test',
        triggerPattern: trigger,
        timezone: 'UTC',
        deps,
      });
      expect(result).toEqual({ handled: true, success: true });
      expect(clearSession).not.toHaveBeenCalled();
      expect(deps.closeStdin).not.toHaveBeenCalled();
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'Session commands require admin access.',
      );
    });
  });

  it('handles /status host-side via refreshStatus (no agent invoked, no chat reply)', async () => {
    const refreshStatus = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ refreshStatus });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/status')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(refreshStatus).toHaveBeenCalledOnce();
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('/status sends a "not configured" message when refreshStatus is missing', async () => {
    const deps = makeDeps({ refreshStatus: undefined });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/status')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Status digest is not configured.',
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('/status reports failure when refreshStatus throws', async () => {
    const refreshStatus = vi.fn().mockRejectedValue(new Error('boom'));
    const deps = makeDeps({ refreshStatus });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/status')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Status refresh failed; see logs.',
    );
    // Cursor still advances — we treat a logged failure as "handled."
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('handles /context host-side via describeContext (no agent invoked)', async () => {
    const deps = makeDeps({
      describeContext: vi.fn().mockReturnValue('Session abc: ~80k tokens'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/context')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Session abc: ~80k tokens');
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('/context falls back to a stub message when describeContext is missing', async () => {
    const deps = makeDeps({ describeContext: undefined });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/context')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Context inspection is not available in this build.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });
});

describe('handleSessionCommand: messages before the command', () => {
  const run = (msgs: NewMessage[], deps: SessionCommandDeps) =>
    handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

  const answering = (text: string) =>
    vi.fn().mockImplementation(async (_prompt, onOutput) => {
      await onOutput({ status: 'success', result: text });
      await onOutput({ status: 'success', result: null });
      return 'success';
    });

  it('answers a question sent before /clear in the old session, then clears', async () => {
    const clearSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ clearSession, runAgent: answering('4') });
    const msgs = [
      makeMsg('what is 2+2?', { timestamp: '99' }),
      makeMsg('/clear', { timestamp: '100' }),
    ];

    const result = await run(msgs, deps);

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    expect(deps.runAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.runAgent).mock.invocationCallOrder[0]).toBeLessThan(
      clearSession.mock.invocationCallOrder[0],
    );
    expect(vi.mocked(deps.sendMessage).mock.calls.map((c) => c[0])).toEqual([
      '4',
      CLEAR_CONFIRMATION,
    ]);
    expect(deps.advanceCursor).toHaveBeenLastCalledWith('100');
  });

  it('answers messages before /context and /status too', async () => {
    for (const cmd of ['/context', '/status']) {
      const deps = makeDeps({
        runAgent: answering('answer'),
        describeContext: () => 'ctx',
        refreshStatus: vi.fn().mockResolvedValue(undefined),
      });
      await run(
        [
          makeMsg('question', { timestamp: '99' }),
          makeMsg(cmd, { timestamp: '100' }),
        ],
        deps,
      );
      expect(deps.runAgent).toHaveBeenCalledOnce();
      expect(deps.sendMessage).toHaveBeenCalledWith('answer');
      expect(deps.advanceCursor).toHaveBeenLastCalledWith('100');
    }
  });

  it('skips the agent for earlier messages that would not trigger it', async () => {
    const clearSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      clearSession,
      shouldProcessPreMessages: vi.fn().mockReturnValue(false),
    });
    await run(
      [
        makeMsg('idle chatter', { timestamp: '99' }),
        makeMsg('/clear', { timestamp: '100' }),
      ],
      deps,
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(clearSession).toHaveBeenCalledOnce();
  });

  it('does not run the host command when answering earlier messages fails', async () => {
    const clearSession = vi.fn();
    const deps = makeDeps({
      clearSession,
      runAgent: vi.fn().mockResolvedValue('error'),
    });
    const result = await run(
      [
        makeMsg('question', { timestamp: '99' }),
        makeMsg('/clear', { timestamp: '100' }),
      ],
      deps,
    );
    expect(result).toEqual({ handled: true, success: false });
    expect(clearSession).not.toHaveBeenCalled();
    expect(deps.advanceCursor).not.toHaveBeenCalled();
  });

  it('flags the command as still pending when the pre-step fails after output', async () => {
    const clearSession = vi.fn();
    const deps = makeDeps({
      clearSession,
      runAgent: vi.fn().mockImplementation(async (_p, onOutput) => {
        await onOutput({ status: 'success', result: 'partial answer' });
        return 'error';
      }),
    });
    const result = await run(
      [
        makeMsg('question', { timestamp: '99' }),
        makeMsg('/clear', { timestamp: '100' }),
      ],
      deps,
    );
    // The user was told to try again: the caller must not re-run it now.
    expect(result).toEqual({
      handled: true,
      success: true,
      commandPending: true,
    });
    expect(clearSession).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('99');
  });

  it('is accurate when the session was cleared but some files could not be archived', async () => {
    const deps = makeDeps({
      clearSession: vi.fn().mockResolvedValue({ archiveFailures: 2 }),
    });
    await run([makeMsg('/clear')], deps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendMessage).mock.calls[0][0];
    expect(text).toMatch(/^🧹 Session cleared/);
    expect(text).toContain("couldn't be archived");
    expect(text).not.toMatch(/failed to clear/i);
  });
});

describe('admin session commands with messages read back from SQLite', () => {
  // SQLite stores is_from_me as 0/1; this guards against comparing it with
  // `=== true`, which silently denied every admin command in non-main groups.
  const JID = 'tg:-100';
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata(JID, '2026-01-01T00:00:00.000Z');
  });

  const storeAndLoad = (content: string, isFromMe: boolean) => {
    storeMessage({
      id: '1',
      chat_jid: JID,
      sender: 'me',
      sender_name: 'Me',
      content,
      timestamp: '2026-01-01T00:00:01.000Z',
      is_from_me: isFromMe,
    });
    return getMessagesSince(JID, '', 'Claw');
  };

  it('allows an is_from_me /clear in a non-main group', async () => {
    const msgs = storeAndLoad('@Andy /clear', true);
    const clearSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ clearSession });

    await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(clearSession).toHaveBeenCalledOnce();
    expect(deps.sendMessage).not.toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(hasPendingAuthorizedSessionCommand(msgs, false, trigger)).toBe(true);
  });

  it('still denies a non-admin /clear in a non-main group', async () => {
    const msgs = storeAndLoad('@Andy /clear', false);
    const clearSession = vi.fn();
    const deps = makeDeps({ clearSession });
    await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(clearSession).not.toHaveBeenCalled();
    expect(hasPendingAuthorizedSessionCommand(msgs, false, trigger)).toBe(
      false,
    );
  });
});
