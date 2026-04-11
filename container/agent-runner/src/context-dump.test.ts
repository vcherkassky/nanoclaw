import { describe, expect, it } from 'vitest';

import { buildDump, estimateTokens, formatDuration, sumComponentTokens } from './context-dump.js';

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('formats sub-second as ms', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds with one decimal place', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(45300)).toBe('45.3s');
    expect(formatDuration(59999)).toBe('60.0s');
  });

  it('formats minutes and whole seconds', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(179_261)).toBe('2m 59s');
    expect(formatDuration(1_993_528)).toBe('33m 14s');
  });

  it('rounds seconds within a minute', () => {
    expect(formatDuration(61_400)).toBe('1m 1s');
    expect(formatDuration(61_600)).toBe('1m 2s');
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for 0 chars', () => {
    expect(estimateTokens(0)).toBe(0);
  });

  it('returns 1 for 4 chars (exactly 1 token)', () => {
    expect(estimateTokens(4)).toBe(1);
  });

  it('rounds to nearest for 7 chars', () => {
    // 7 / 4 = 1.75 → rounds to 2
    expect(estimateTokens(7)).toBe(2);
  });

  it('rounds down for 5 chars', () => {
    // 5 / 4 = 1.25 → rounds to 1
    expect(estimateTokens(5)).toBe(1);
  });

  it('returns 2000 for 8000 chars', () => {
    expect(estimateTokens(8000)).toBe(2000);
  });

  it('returns 956 for 3825 chars (CLAUDE.md example)', () => {
    // 3825 / 4 = 956.25 → rounds to 956
    expect(estimateTokens(3825)).toBe(956);
  });

  it('returns 1755 for 7019 chars (user message example)', () => {
    // 7019 / 4 = 1754.75 → rounds to 1755
    expect(estimateTokens(7019)).toBe(1755);
  });
});

// ---------------------------------------------------------------------------
// sumComponentTokens
// ---------------------------------------------------------------------------

describe('sumComponentTokens', () => {
  it('returns 0 for empty object', () => {
    expect(sumComponentTokens({})).toBe(0);
  });

  it('returns est_tokens for single component', () => {
    expect(sumComponentTokens({ user_message: { chars: 7019, est_tokens: 1755 } })).toBe(1755);
  });

  it('sums est_tokens across mixed components', () => {
    const result = sumComponentTokens({
      user_message: { chars: 7019, est_tokens: 1755 },
      claude_md: { chars: 3825, est_tokens: 956 },
      mcp_gmail: { tools: 19, schema_chars: 14800, est_tokens: 3700 },
    });
    expect(result).toBe(1755 + 956 + 3700);
  });

  it('sums est_tokens regardless of which other fields are present', () => {
    const result = sumComponentTokens({
      a: { est_tokens: 100, tools: 5, schema_chars: 400, chars: 400 },
      b: { est_tokens: 200 },
    });
    expect(result).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// buildDump
// ---------------------------------------------------------------------------

const baseParams = {
  group: 'pa_inbox_monitor',
  modelConfigured: 'qwen3-coder:30b',
  modelResolved: 'qwen3-coder:30b',
  contextWindow: 32768,
  maxOutputTokens: 8192,
  components: {
    user_message: { chars: 7019, est_tokens: 1755 },
    claude_md: { chars: 3825, est_tokens: 956 },
  },
  inputTokens: 299750,
  outputTokens: 1014,
  costUsd: 0.9145,
  durationMs: 34200,
};

describe('buildDump', () => {
  it('sets event, group, and ISO timestamp', () => {
    const dump = buildDump(baseParams);
    expect(dump.event).toBe('context_dump');
    expect(dump.group).toBe('pa_inbox_monitor');
    expect(dump.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes model fields', () => {
    const dump = buildDump(baseParams);
    expect(dump.model_configured).toBe('qwen3-coder:30b');
    expect(dump.model_resolved).toBe('qwen3-coder:30b');
    expect(dump.context_window).toBe(32768);
    expect(dump.max_output_tokens).toBe(8192);
  });

  it('computes context_window_pct rounded to 1 decimal when context exceeded', () => {
    const dump = buildDump({ ...baseParams, inputTokens: 299750, contextWindow: 32768 });
    // 299750 / 32768 * 100 = 914.7583... → 914.8
    expect(dump.actual.context_window_pct).toBe(914.8);
  });

  it('computes context_window_pct for normal usage', () => {
    const dump = buildDump({ ...baseParams, inputTokens: 10000, contextWindow: 32768 });
    // 10000 / 32768 * 100 = 30.5175... → 30.5
    expect(dump.actual.context_window_pct).toBe(30.5);
  });

  it('computes components_est_tokens as sum of component estimates', () => {
    const dump = buildDump(baseParams);
    expect(dump.components_est_tokens).toBe(1755 + 956); // 2711
  });

  it('computes system_prompt_est_tokens as residual (actual - components)', () => {
    const dump = buildDump(baseParams);
    expect(dump.actual.system_prompt_est_tokens).toBe(299750 - 2711); // 297039
  });

  it('system_prompt_est_tokens equals input_tokens when no components', () => {
    const dump = buildDump({ ...baseParams, components: {}, inputTokens: 50000 });
    expect(dump.components_est_tokens).toBe(0);
    expect(dump.actual.system_prompt_est_tokens).toBe(50000);
  });

  it('preserves negative system_prompt_est_tokens without clamping', () => {
    // Components over-estimate actual — result is negative, surfaced as-is
    const dump = buildDump({
      ...baseParams,
      components: { a: { est_tokens: 999999 } },
      inputTokens: 1000,
    });
    expect(dump.actual.system_prompt_est_tokens).toBe(1000 - 999999);
  });

  it('returns null context_window_pct when context_window is null', () => {
    const dump = buildDump({ ...baseParams, contextWindow: null });
    expect(dump.actual.context_window_pct).toBeNull();
    expect(dump.context_window).toBeNull();
  });

  it('returns null context_window_pct when context_window is 0', () => {
    const dump = buildDump({ ...baseParams, contextWindow: 0 });
    expect(dump.actual.context_window_pct).toBeNull();
  });

  it('returns null max_output_tokens when null', () => {
    const dump = buildDump({ ...baseParams, maxOutputTokens: null });
    expect(dump.max_output_tokens).toBeNull();
  });

  it('model_configured and model_resolved can differ', () => {
    const dump = buildDump({
      ...baseParams,
      modelConfigured: 'qwen3-coder:30b',
      modelResolved: 'qwen3-coder:32b-q4_k_m',
    });
    expect(dump.model_configured).toBe('qwen3-coder:30b');
    expect(dump.model_resolved).toBe('qwen3-coder:32b-q4_k_m');
  });

  it('model_resolved can be null when SDK init message was not received', () => {
    const dump = buildDump({ ...baseParams, modelResolved: null });
    expect(dump.model_resolved).toBeNull();
  });

  it('passes through cost and duration from actual', () => {
    const dump = buildDump(baseParams);
    expect(dump.actual.cost_usd).toBe(0.9145);
    expect(dump.actual.duration_ms).toBe(34200);
    expect(dump.actual.input_tokens).toBe(299750);
    expect(dump.actual.output_tokens).toBe(1014);
  });

  it('components are passed through unchanged', () => {
    const dump = buildDump(baseParams);
    expect(dump.components['user_message']).toEqual({ chars: 7019, est_tokens: 1755 });
    expect(dump.components['claude_md']).toEqual({ chars: 3825, est_tokens: 956 });
  });
});
