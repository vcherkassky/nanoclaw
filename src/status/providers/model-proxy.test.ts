import { describe, it, expect } from 'vitest';

import { ModelProxyProvider } from './model-proxy.js';

describe('ModelProxyProvider', () => {
  it('renders stats from the provided getter', async () => {
    const provider = new ModelProxyProvider({
      getStats: () => ({
        currentModel: 'gemma4:26b',
        evictions: 2,
        requests: 287,
        lastEvictionAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    const result = await provider.collect();
    expect(result.bucket).toBe('proxy');
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Loaded']).toBe('gemma4:26b');
    expect(byLabel['Evictions (24h)']).toBe('2');
    expect(byLabel['Requests (24h)']).toBe('287');
    expect(byLabel['Last eviction']).toMatch(/ago$/);
  });

  it('renders "(none)" when no model is loaded', async () => {
    const provider = new ModelProxyProvider({
      getStats: () => ({
        currentModel: null,
        evictions: 0,
        requests: 0,
        lastEvictionAt: null,
      }),
    });
    const result = await provider.collect();
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Loaded']).toBe('(none)');
    expect(byLabel['Last eviction']).toBe('never');
  });
});
