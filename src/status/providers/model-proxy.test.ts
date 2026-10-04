import { describe, it, expect } from 'vitest';

import { ModelProxyProvider } from './model-proxy.js';

describe('ModelProxyProvider', () => {
  it('renders stats from the provided getter', async () => {
    const provider = new ModelProxyProvider({
      getStats: () => ({
        loadedModels: ['gemma4:26b'],
        requests: 287,
      }),
    });
    const result = await provider.collect();
    expect(result.bucket).toBe('proxy');
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Loaded']).toBe('gemma4:26b');
    expect(byLabel['Requests']).toBe('287');
    expect(result.rows.map((r) => r.label).join(' ')).not.toMatch(/evict/i);
  });

  it('lists every loaded model', async () => {
    const provider = new ModelProxyProvider({
      getStats: () => ({
        loadedModels: ['gemma4:26b', 'nomic-embed-text:latest'],
        requests: 3,
      }),
    });
    const result = await provider.collect();
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Loaded']).toBe('gemma4:26b, nomic-embed-text:latest');
  });

  it('renders "(none)" when no model is loaded', async () => {
    const provider = new ModelProxyProvider({
      getStats: () => ({
        loadedModels: [],
        requests: 0,
      }),
    });
    const result = await provider.collect();
    const byLabel = Object.fromEntries(
      result.rows.map((r) => [r.label, r.value]),
    );
    expect(byLabel['Loaded']).toBe('(none)');
    expect(byLabel['Requests']).toBe('0');
  });
});
