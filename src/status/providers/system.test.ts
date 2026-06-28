import { describe, it, expect } from 'vitest';

import { SystemProvider } from './system.js';

describe('SystemProvider', () => {
  it('returns a contribution with the system bucket and stable rows', async () => {
    const provider = new SystemProvider({ version: '1.2.3' });
    const result = await provider.collect();
    expect(result.bucket).toBe('system');
    expect(result.title).toMatch(/system/i);
    const labels = result.rows.map((r) => r.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Uptime',
        'Version',
        'Memory',
        'Node',
        'Platform',
      ]),
    );
    const versionRow = result.rows.find((r) => r.label === 'Version')!;
    expect(versionRow.value).toContain('1.2.3');
  });
});
