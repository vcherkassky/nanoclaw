import { describe, it, expect } from 'vitest';

import { StatusManager } from './manager.js';
import type { StatusProvider } from './types.js';

function makeProvider(
  name: string,
  bucket: 'system',
  delay: number,
  rows = [{ label: 'k', value: 'v' }],
): StatusProvider {
  return {
    name,
    collect: async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { bucket, title: name, rows };
    },
  };
}

describe('StatusManager', () => {
  it('runs providers in parallel and returns contributions in order', async () => {
    const mgr = new StatusManager({
      providers: [
        makeProvider('a', 'system', 50, [{ label: 'a', value: 'v' }]),
        makeProvider('b', 'system', 50, [{ label: 'b', value: 'v' }]),
      ],
      perProviderTimeoutMs: 1000,
    });
    const start = Date.now();
    const results = await mgr.collectAll();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(120); // parallel, not 100ms sequential
    expect(results.map((r) => r.title)).toEqual(['a', 'b']);
  });

  it('replaces a timing-out provider with a warn contribution', async () => {
    const slow: StatusProvider = {
      name: 'slow',
      collect: () => new Promise(() => {}), // never resolves
    };
    const mgr = new StatusManager({
      providers: [slow, makeProvider('ok', 'system', 0)],
      perProviderTimeoutMs: 30,
    });
    const results = await mgr.collectAll();
    expect(results[0].warn).toMatch(/timeout/i);
    expect(results[0].rows).toEqual([]);
    expect(results[1].title).toBe('ok');
  });

  it('replaces a throwing provider with a warn contribution', async () => {
    const broken: StatusProvider = {
      name: 'broken',
      collect: async () => {
        throw new Error('boom');
      },
    };
    const mgr = new StatusManager({
      providers: [broken],
      perProviderTimeoutMs: 1000,
    });
    const [r] = await mgr.collectAll();
    expect(r.warn).toBe('collection failed: boom');
  });
});
