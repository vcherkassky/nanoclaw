import type { CompactionOutcome } from './context-monitor.js';
import { messageCursor } from './message-cursor.js';
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
export const CLEAR_PARTIAL_CONFIRMATION =
  "🧹 Session cleared, but some old transcript files couldn't be archived (see logs). Your next message starts a fresh conversation.";

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
      // !!: rows read from SQLite carry is_from_me as 0/1, not a boolean.
      isSessionCommandAllowed(isMainGroup, !!m.is_from_me),
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
  /** Move the group's cursor to `cursor` (see message-cursor.ts). */
  advanceCursor: (cursor: string) => void;
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
   * next message starts a fresh agent session. Used by /clear. Reports how
   * many transcripts could not be archived (tracking is dropped regardless).
   */
  clearSession?: () =>
    | void
    | ClearSessionResult
    | Promise<void | ClearSessionResult>;
  /**
   * Whether messages sent before a host-handled command would normally make
   * the agent respond (trigger/allowlist rules). If false they are not sent to
   * the agent. Defaults to true.
   */
  shouldProcessPreMessages?: (msgs: NewMessage[]) => boolean;
  /** Triggers an immediate status digest refresh. Used by /status. */
  refreshStatus?: () => Promise<void>;
}

export interface ClearSessionResult {
  archiveFailures: number;
}

export type SessionCommandResult =
  | { handled: false }
  | {
      handled: true;
      /**
       * Always true today: a handled command is executed or explicitly
       * consumed in the same pass, and the cursor ends past it. Kept as a
       * boolean for the caller's retry contract.
       */
      success: boolean;
    };

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
 * A found command is never blocked or deferred: it is executed (or, for
 * /compact after a failed earlier message, explicitly consumed) in this pass,
 * and the cursor always ends past it.
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<SessionCommandResult> {
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

  if (!isSessionCommandAllowed(isMainGroup, !!cmdMsg.is_from_me)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(messageCursor(cmdMsg));
    return { handled: true, success: true };
  }

  // AUTHORIZED: process messages sent before the command first (in the
  // current session), then run the command.
  logger.info({ group: groupName, command }, 'Session command');

  const isHostHandled = HOST_HANDLED.has(command);
  const preCmdMsgs = missedMessages.slice(0, missedMessages.indexOf(cmdMsg));

  // Send pre-command messages to the agent so they're answered / in the
  // session context. For host-handled commands only if they'd normally make
  // the agent respond; otherwise the cursor simply moves past them as before.
  if (
    preCmdMsgs.length > 0 &&
    (!isHostHandled || (deps.shouldProcessPreMessages?.(preCmdMsgs) ?? true))
  ) {
    const prePrompt = deps.formatMessages(preCmdMsgs, timezone);
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
      // Session commands are never blocked and never deferred: a failing
      // earlier message must not hold /clear (the escape hatch) hostage, and
      // a command must not run later behind the user's back. Either way the
      // earlier messages are consumed here, and so is the command.
      logger.warn(
        { group: groupName, command, preOutputSent },
        'Messages before session command failed; consuming them',
      );
      if (!isHostHandled) {
        // /compact: don't compact a session whose last turn just failed.
        deps.advanceCursor(messageCursor(cmdMsg));
        await deps.sendMessage(
          preOutputSent
            ? `⚠️ ${command} was not run because the earlier message failed — send ${command} again.`
            : `⚠️ Your earlier message couldn't be processed and was dropped, so ${command} was not run — please resend it, then send ${command} again.`,
        );
        return { handled: true, success: true };
      }
      if (!preOutputSent) {
        await deps.sendMessage(
          command === '/clear'
            ? "Your earlier message couldn't be processed and was dropped — please resend it after the clear."
            : "Your earlier message couldn't be processed and was dropped — please resend it.",
        );
      }
      // Fall through: run the host-handled command in this same pass.
    }
  }

  // Host-handled commands (e.g. /context, /status) don't need the agent.
  if (isHostHandled) {
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
          const res = await deps.clearSession();
          await deps.sendMessage(
            res && res.archiveFailures > 0
              ? CLEAR_PARTIAL_CONFIRMATION
              : CLEAR_CONFIRMATION,
          );
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
    deps.advanceCursor(messageCursor(cmdMsg));
    return { handled: true, success: true };
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
  deps.advanceCursor(messageCursor(cmdMsg));
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
