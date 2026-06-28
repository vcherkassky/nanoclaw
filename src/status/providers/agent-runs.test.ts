import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, recordAgentRun } from '../../db.js';
import { AgentRunsProvider } from './agent-runs.js';

beforeEach(() => _initTestDatabase());

describe('AgentRunsProvider', () => {
  it('returns sensible defaults when empty', async () => {
    const provider = new AgentRunsProvider({
      now: () => new Date('2026-06-28T12:00:00.000Z').getTime(),
    });
    const result = await provider.collect();
    expect(result.bucket).toBe('agent');
    const byLabel = Object.fromEntries(result.rows.map((r) => [r.label, r.value]));
    expect(byLabel['Total (24h)']).toBe('0');
    expect(byLabel['Last run']).toBe('never');
    expect(byLabel['Crashes (24h)']).toBe('0');
  });

  it('summarises recorded runs by group and model', async () => {
    recordAgentRun({
      group_folder: 'main',
      started_at: '2026-06-28T08:00:00.000Z',
      ended_at: '2026-06-28T08:01:00.000Z',
      duration_ms: 60_000,
      exit_code: 0,
      model: 'opus',
      error_class: null,
    });
    recordAgentRun({
      group_folder: 'pa',
      started_at: '2026-06-28T08:05:00.000Z',
      ended_at: '2026-06-28T08:06:00.000Z',
      duration_ms: 60_000,
      exit_code: 137,
      model: 'gemma',
      error_class: 'timeout',
    });

    const result = await new AgentRunsProvider({
      now: () => new Date('2026-06-28T12:00:00.000Z').getTime(),
    }).collect();
    const byLabel = Object.fromEntries(result.rows.map((r) => [r.label, r.value]));
    expect(byLabel['Total (24h)']).toBe('2');
    expect(byLabel['By group (24h)']).toMatch(/main 1/);
    expect(byLabel['By group (24h)']).toMatch(/pa 1/);
    expect(byLabel['By model (24h)']).toMatch(/opus 1/);
    expect(byLabel['By model (24h)']).toMatch(/gemma 1/);
    expect(byLabel['Crashes (24h)']).toBe('1');
    expect(byLabel['Last run']).toMatch(/ago$/);
    expect(byLabel['Last duration']).toBe('1m 0s');
    expect(byLabel['Last exit']).toBe('✗');
  });
});
