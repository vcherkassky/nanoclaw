import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, createTask, logTaskRun } from '../../db.js';
import { ScheduledTasksProvider } from './scheduled.js';

beforeEach(() => _initTestDatabase());

describe('ScheduledTasksProvider', () => {
  it('shows active count, next runs, recent failures, last success', async () => {
    createTask({
      id: 'morning',
      group_folder: 'main',
      chat_jid: 'tg:1',
      prompt: 'wake',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'isolated',
      next_run: '2026-06-29T08:00:00.000Z',
      status: 'active',
      created_at: '2026-06-28T00:00:00.000Z',
    });
    logTaskRun({
      task_id: 'morning',
      run_at: '2026-06-28T07:00:00.000Z',
      duration_ms: 1_000,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'morning',
      run_at: '2026-06-28T07:30:00.000Z',
      duration_ms: 1_000,
      status: 'error',
      result: null,
      error: 'boom',
    });

    const result = await new ScheduledTasksProvider({
      now: () => new Date('2026-06-28T09:00:00.000Z').getTime(),
    }).collect();
    expect(result.bucket).toBe('tasks');
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Active']).toBe('1');
    expect(byLabel['Next runs']).toContain('morning');
    expect(byLabel['Failures (24h)']).toBe('1');
    expect(byLabel['Last success']).toMatch(/ago$/);
  });

  it('handles empty schedule cleanly', async () => {
    const result = await new ScheduledTasksProvider({
      now: () => Date.now(),
    }).collect();
    expect(result.bucket).toBe('tasks');
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Active']).toBe('0');
    expect(byLabel['Next runs']).toBe('—');
    expect(byLabel['Last success']).toBe('never');
  });
});
