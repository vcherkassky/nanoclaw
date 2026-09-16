import { describe, it, expect, vi } from 'vitest';

// Env resolves OLLAMA_HOST to the proxy port used by this install.
vi.mock('./env.js', () => ({
  readEnvFile: () => ({ OLLAMA_HOST: 'http://localhost:11500' }),
}));

import { isOllamaReachable } from './ollama-health.js';

describe('isOllamaReachable', () => {
  it('returns true when /api/tags responds ok', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }) as Response);

    const reachable = await isOllamaReachable(undefined, fetchFn);

    expect(reachable).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:11500/api/tags',
      expect.anything(),
    );
  });

  it('returns false when the backend is unreachable (fetch rejects)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    expect(await isOllamaReachable(undefined, fetchFn)).toBe(false);
  });

  it('returns false on a non-ok response (e.g. 502 upstream unreachable)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 502 }) as Response);

    expect(await isOllamaReachable(undefined, fetchFn)).toBe(false);
  });

  it('honours an explicit host argument over the env default', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }) as Response);

    await isOllamaReachable('http://example:9999', fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      'http://example:9999/api/tags',
      expect.anything(),
    );
  });
});
