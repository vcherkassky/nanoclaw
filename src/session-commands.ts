import type { CompactionOutcome } from './context-monitor.js';
import type { NewMessage } from './types.js';
import { logger } from './logger.js';

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  if (text === '/compact') return '/compact';
  if (text === '/context') return '/context';
  if (text === '/status') return '/status';
  if (text === '/clear') return '/clear';
  return null;
}

/** Commands that are handled entirely on the host (no agent invocation). */
const HOST_HANDLED = new Set(['/context', '/status', '/clear']);

export const CLEAR_CONFIRMATION =
  '🧹 Session cleared. Your next message starts a fresh conversation (long-term memory in CLAUDE.md is kept).';
/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/**
 * True if `pending` (messages past the group's cursor) still holds a session
 * command the sender may run. The message loop must not pipe follow-ups into
 * a live container in that case: doing so advances the cursor past the
 * command (so it is never handled) and, for /clear, would deliver the
 * follow-up into the session that is about to be cleared.
 */
export function hasPendingAuthorizedSessionCommand(
  pending: NewMessage[],
  isMainGroup: boolean,
  triggerPattern: RegExp,
): boolean {
  return pending.some(
    (m) =>
      extractSessionCommand(m.content, triggerPattern) !== null &&
      isSessionCommandAllowed(isMainGroup, m.is_from_me === true),
  );
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Returns a human-readable summary of current session context size. Used by /context. */
  describeContext?: () => string;
  /**
   * Called just before /compact is sent to the agent; snapshots the session
   * transcript and returns a checker to call afterwards that reports whether
   * a new compact_boundary was written (with stats) or why it failed.
   * When provided, the agent's own /compact text is suppressed so exactly one
   * host message reports the outcome.
   */
  beginCompaction?: () => () => CompactionOutcome;
  /**
   * Forgets the group's tracked session and archives its transcripts so the
   * next message starts a fresh agent session. Used by /clear.
   */
  clearSession?: () => void | Promise<void>;
  /** Triggers an immediate status digest refresh. Used by /status. */
  refreshStatus?: () => Promise<void>;
}

function compactionFailureMessage(reason: string): string {
  return `⚠️ Compaction failed: ${reason}. Session unchanged — use /clear to start fresh.`;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (!isSessionCommandAllowed(isMainGroup, cmdMsg.is_from_me === true)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
  logger.info({ group: groupName, command }, 'Session command');

  // Host-handled commands (e.g. /context, /status) don't need the agent.
  if (HOST_HANDLED.has(command)) {
    if (command === '/status') {
      if (deps.refreshStatus) {
        try {
          await deps.refreshStatus();
        } catch (err) {
          logger.warn({ err }, '/status: refreshStatus failed');
          await deps.sendMessage('Status refresh failed; see logs.');
        }
      } else {
        await deps.sendMessage('Status digest is not configured.');
      }
    } else if (command === '/clear') {
      // Defensive: this runs inside processGroupMessages, which the GroupQueue
      // serializes per group, so no container for this group is normally
      // alive here (the message loop already wrote _close to any idle one
      // when the command arrived). closeStdin no-ops when nothing is running.
      deps.closeStdin();
      if (deps.clearSession) {
        try {
          await deps.clearSession();
          await deps.sendMessage(CLEAR_CONFIRMATION);
        } catch (err) {
          logger.error({ err, group: groupName }, '/clear failed');
          await deps.sendMessage('Failed to clear the session; see logs.');
        }
      } else {
        await deps.sendMessage(
          'Session clearing is not available in this build.',
        );
      }
    } else {
      const text = deps.describeContext
        ? deps.describeContext()
        : 'Context inspection is not available in this build.';
      await deps.sendMessage(text);
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  // For /compact, the host reports the outcome from the transcript itself; the
  // agent's text ("Conversation compacted.", or an apology from a local model)
  // is not evidence of anything and would make a second message.
  const finishCompaction =
    command === '/compact' ? deps.beginCompaction?.() : undefined;

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    if (finishCompaction) return;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });
  const agentFailed = cmdOutput === 'error' || hadCmdError;

  // Advance cursor to the command — messages AFTER it remain pending.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (finishCompaction) {
    const outcome = finishCompaction();
    if (outcome.compacted) {
      await deps.sendMessage(outcome.summary);
    } else {
      const reason =
        outcome.reason ??
        (agentFailed
          ? 'the agent reported an error'
          : 'no compaction was recorded in the session');
      logger.warn({ group: groupName, reason }, '/compact did not compact');
      await deps.sendMessage(compactionFailureMessage(reason));
    }
  } else if (agentFailed) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
