import { _rawDb } from '../../db.js';
import { formatRelativeTime } from '../format.js';
import type { StatusContribution, StatusProvider } from '../types.js';

export interface ScheduledTasksProviderOptions {
  now?: () => number;
}

export class ScheduledTasksProvider implements StatusProvider {
  readonly name = 'scheduled-tasks';

  constructor(private readonly opts: ScheduledTasksProviderOptions = {}) {}

  async collect(): Promise<StatusContribution> {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const cutoff = new Date(now - 86_400_000).toISOString();
    const db = _rawDb();

    const active = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM scheduled_tasks WHERE status = 'active'`,
        )
        .get() as { c: number }
    ).c;

    const next = db
      .prepare(
        `SELECT id, next_run FROM scheduled_tasks
         WHERE status = 'active' AND next_run IS NOT NULL
         ORDER BY next_run LIMIT 3`,
      )
      .all() as { id: string; next_run: string }[];
    const nextStr = next.length
      ? next
          .map(
            (n) =>
              `${n.id} ${new Date(n.next_run).toISOString().slice(11, 16)}`,
          )
          .join(' · ')
      : '—';

    const failures = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM task_run_logs WHERE status = 'error' AND run_at > ?`,
        )
        .get(cutoff) as { c: number }
    ).c;

    const lastSuccess = db
      .prepare(
        `SELECT MAX(run_at) AS m FROM task_run_logs WHERE status = 'success'`,
      )
      .get() as { m: string | null };

    return {
      bucket: 'tasks',
      title: '⏱ Scheduled Tasks',
      rows: [
        { label: 'Active', value: String(active) },
        { label: 'Next runs', value: nextStr },
        { label: 'Failures (24h)', value: String(failures) },
        {
          label: 'Last success',
          value: formatRelativeTime(lastSuccess.m, now),
        },
      ],
    };
  }
}
