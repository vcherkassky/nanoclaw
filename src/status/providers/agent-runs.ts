import {
  countAgentCrashesSince,
  countAgentRunsByGroupSince,
  countAgentRunsByModelSince,
  countAgentRunsSince,
  getLastAgentRun,
} from '../../db.js';
import { formatDuration, formatRelativeTime } from '../format.js';
import type { StatusContribution, StatusProvider } from '../types.js';

export interface AgentRunsProviderOptions {
  now?: () => number;
}

export class AgentRunsProvider implements StatusProvider {
  readonly name = 'agent-runs';

  constructor(private readonly opts: AgentRunsProviderOptions = {}) {}

  async collect(): Promise<StatusContribution> {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const cutoff = new Date(now - 86_400_000).toISOString();
    const total = countAgentRunsSince(cutoff);
    const crashes = countAgentCrashesSince(cutoff);
    const byGroup = countAgentRunsByGroupSince(cutoff);
    const byModel = countAgentRunsByModelSince(cutoff);
    const last = getLastAgentRun();

    const fmtBreakdown = (rec: Record<string, number>) =>
      Object.entries(rec).length
        ? Object.entries(rec)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')
        : '—';

    return {
      bucket: 'agent',
      title: '🤖 Agent Runs',
      rows: [
        { label: 'Total (24h)', value: String(total) },
        { label: 'By group (24h)', value: fmtBreakdown(byGroup) },
        { label: 'By model (24h)', value: fmtBreakdown(byModel) },
        {
          label: 'Last run',
          value: formatRelativeTime(last?.started_at ?? null, now),
        },
        {
          label: 'Last duration',
          value: last ? formatDuration(last.duration_ms) : '—',
        },
        {
          label: 'Last exit',
          value: last ? (last.exit_code === 0 ? '✓' : '✗') : '—',
        },
        { label: 'Crashes (24h)', value: String(crashes) },
      ],
    };
  }
}
