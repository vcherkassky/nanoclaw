/**
 * Calendar-rules end-to-end test harness.
 *
 * Spawns the agent container directly (bypassing Telegram), feeds it a
 * crafted prompt, waits for the agent to finish, then queries Google
 * Calendar to verify the resulting event obeys the per-category rules
 * documented in groups/telegram_main/CLAUDE.md.
 *
 * Each test:
 *   1. records the cutoff time before the run
 *   2. spawns a fresh container with the prompt + a fresh session
 *   3. reads the agent output (success / error)
 *   4. lists calendar events created after the cutoff time
 *   5. asserts category-specific expectations
 *   6. deletes the test event so the test calendar stays clean
 *
 * Usage:
 *   npx tsx scripts/test-calendar-rules.ts                  # all cases
 *   npx tsx scripts/test-calendar-rules.ts haircut          # one case
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, type calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { execSync } from 'child_process';

import {
  runContainerAgent,
  type ContainerInput,
  type ContainerOutput,
} from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

// ---------------------------------------------------------------------------
// Calendar helper
// ---------------------------------------------------------------------------

function makeCalendar(): calendar_v3.Calendar {
  const dir = path.join(os.homedir(), '.calendar-mcp');
  const keys = JSON.parse(
    fs.readFileSync(path.join(dir, 'gcp-oauth.keys.json'), 'utf8'),
  );
  const k = keys.installed || keys.web;
  const oauth = new OAuth2Client(
    k.client_id,
    k.client_secret,
    'http://localhost:3000/oauth2callback',
  );
  oauth.setCredentials(
    JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')),
  );
  return google.calendar({ version: 'v3', auth: oauth });
}

async function findCreatedSince(
  cal: calendar_v3.Calendar,
  cutoff: Date,
): Promise<calendar_v3.Schema$Event[]> {
  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: true,
    maxResults: 50,
    orderBy: 'updated',
  });
  return (res.data.items ?? []).filter(
    (e) => e.created && new Date(e.created) >= cutoff,
  );
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestCase {
  id: string;
  prompt: string;
  /** Returns null if the event passes all checks; otherwise an array of failure strings. */
  check: (e: calendar_v3.Schema$Event) => string[];
}

const POPUP_MINUTES = (e: calendar_v3.Schema$Event): number[] =>
  (e.reminders?.overrides ?? [])
    .filter((o) => o.method === 'popup')
    .map((o) => o.minutes ?? -1)
    .sort((a, b) => b - a);

const expectReminders = (
  e: calendar_v3.Schema$Event,
  expected: number[],
): string[] => {
  const got = POPUP_MINUTES(e);
  if (
    got.length !== expected.length ||
    got.some((m, i) => m !== expected[i])
  ) {
    return [`reminders mismatch — got [${got.join(', ')}], expected [${expected.join(', ')}]`];
  }
  if (e.reminders?.useDefault) {
    return ['reminders.useDefault is true; expected false'];
  }
  return [];
};

const expectNoOverrides = (e: calendar_v3.Schema$Event): string[] => {
  const overrides = e.reminders?.overrides ?? [];
  if (overrides.length > 0) {
    return [`expected default reminders (no overrides), got ${overrides.length}`];
  }
  return [];
};

const CASES: TestCase[] = [
  {
    id: 'haircut',
    prompt:
      "Schedule a haircut next Wednesday (1 July 2026) at 4pm. It'll take 30 minutes.",
    check: (e) => {
      const fails: string[] = [];
      // Time should be 15:55 - 16:25 (5 min earlier than stated 16:00–16:30)
      const start = e.start?.dateTime ?? '';
      const end = e.end?.dateTime ?? '';
      if (!start.includes('15:55')) {
        fails.push(`start time wrong — got ${start}, expected …15:55…`);
      }
      if (!end.includes('16:25')) {
        fails.push(`end time wrong — got ${end}, expected …16:25…`);
      }
      // Description must mention the actual time
      const desc = e.description ?? '';
      if (!desc.toLowerCase().includes('actual appointment time')) {
        fails.push(
          `description missing "Actual appointment time…" — got ${JSON.stringify(desc)}`,
        );
      }
      if (!desc.includes('16:00')) {
        fails.push(`description should reference original time 16:00 — got ${JSON.stringify(desc)}`);
      }
      // Reminders 1440, 120, 15
      fails.push(...expectReminders(e, [1440, 120, 15]));
      return fails;
    },
  },
  {
    id: 'service',
    prompt:
      'Add a repair appointment: dishwasher service tech coming over on 2 July 2026 at 11am for an hour.',
    check: (e) => {
      const fails: string[] = [];
      // For an 11am event, the same-day reminder stays at 240 (event is past 10am)
      fails.push(...expectReminders(e, [10080, 1440, 240]));
      return fails;
    },
  },
  {
    id: 'travel-start',
    prompt:
      'Add an event for my flight out to Berlin on 10 July 2026, departing at 9:30am. Flight is 2 hours. Just the outbound leg.',
    check: (e) => {
      const fails: string[] = [];
      // 9:30 is before 10am — same-day reminder swaps 240 → 60
      fails.push(...expectReminders(e, [20160, 10080, 1440, 60]));
      return fails;
    },
  },
  {
    id: 'routine',
    prompt:
      'Add a weekly team standup on 6 July 2026 at 10am for 30 minutes.',
    check: (e) => {
      const fails: string[] = [];
      // "Everything else" → no overrides
      fails.push(...expectNoOverrides(e));
      return fails;
    },
  },
];

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

async function runOnce(prompt: string): Promise<{
  status: 'success' | 'error';
  text: string;
}> {
  const group: RegisteredGroup = {
    name: 'Viktor',
    folder: 'telegram_main',
    trigger: '@Claw',
    added_at: '2020-01-01T00:00:00Z',
    isMain: true,
    requiresTrigger: false,
  };

  const input: ContainerInput = {
    prompt,
    sessionId: undefined, // fresh session — no resumption bias
    groupFolder: 'telegram_main',
    chatJid: 'tg:480940102',
    isMain: true,
    assistantName: 'Claw',
  };

  const outputs: ContainerOutput[] = [];
  let containerName: string | null = null;

  // For tests we want the container to exit after the first agent reply
  // (otherwise it would sit at idle for up to 30 min waiting for more
  // messages). Once we see a `result` with non-empty text, we docker-stop
  // the container in the background so runContainerAgent returns promptly.
  await runContainerAgent(
    group,
    input,
    (_proc, name) => {
      containerName = name;
    },
    async (output) => {
      outputs.push(output);
      if (
        containerName &&
        output.status === 'success' &&
        typeof output.result === 'string' &&
        output.result.trim().length > 0
      ) {
        // Detach the stop so we don't block the callback chain
        setTimeout(() => {
          try {
            execSync(`docker stop -t 2 ${containerName}`, { stdio: 'ignore' });
          } catch {
            /* container may have already exited */
          }
        }, 250);
      }
    },
  );

  // We deliberately SIGKILL the container after the first success result, so
  // runContainerAgent always reports `status: error` even though the agent
  // did its work. The source of truth for test pass/fail is whether ANY
  // success output came through plus the calendar verification — not the
  // exit code.
  const sawSuccess = outputs.some(
    (o) =>
      o.status === 'success' &&
      typeof o.result === 'string' &&
      o.result.trim().length > 0,
  );
  const finalText = outputs
    .map((o) => (typeof o.result === 'string' ? o.result : ''))
    .filter(Boolean)
    .join('\n\n');

  return { status: sawSuccess ? 'success' : 'error', text: finalText };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const only = process.argv[2];
  const cal = makeCalendar();
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  if (cases.length === 0) {
    console.error(`No test case named "${only}". Known: ${CASES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Running ${cases.length} case(s)…`);
  const summary: Array<{ id: string; passed: boolean; details: string[] }> = [];

  for (const tc of cases) {
    console.log(`\n=== ${tc.id} ===`);
    console.log(`prompt: ${tc.prompt}`);
    const cutoff = new Date();
    const t0 = Date.now();
    const { status, text } = await runOnce(tc.prompt);
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`agent status: ${status} (${dur}s)`);
    console.log(`agent text  : ${text.slice(0, 240)}…`);

    if (status !== 'success') {
      summary.push({ id: tc.id, passed: false, details: ['agent reported error'] });
      continue;
    }

    // Give the calendar API a beat to reflect the just-created event
    await new Promise((r) => setTimeout(r, 1500));
    const fresh = await findCreatedSince(cal, cutoff);
    if (fresh.length === 0) {
      summary.push({ id: tc.id, passed: false, details: ['no event was created'] });
      continue;
    }
    const event = fresh[fresh.length - 1]; // most recent
    console.log(
      `event       : ${event.summary} (${event.start?.dateTime ?? event.start?.date})`,
    );

    const fails = tc.check(event);
    summary.push({ id: tc.id, passed: fails.length === 0, details: fails });

    // Clean up — delete the test event
    if (event.id) {
      try {
        await cal.events.delete({ calendarId: 'primary', eventId: event.id });
        console.log(`cleanup     : deleted event ${event.id}`);
      } catch (err) {
        console.log(`cleanup     : delete failed (${err})`);
      }
    }
  }

  // Final report
  console.log('\n\n========== SUMMARY ==========');
  let anyFailed = false;
  for (const s of summary) {
    const tag = s.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${tag}  ${s.id}`);
    for (const d of s.details) console.log(`         · ${d}`);
    if (!s.passed) anyFailed = true;
  }
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
