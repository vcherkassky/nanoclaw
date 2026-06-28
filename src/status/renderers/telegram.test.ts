import { describe, it, expect } from 'vitest';

import { renderTelegramStatus } from './telegram.js';
import type { StatusContribution } from '../types.js';

describe('renderTelegramStatus', () => {
  it('renders header + each bucket in input order', () => {
    const contributions: StatusContribution[] = [
      {
        bucket: 'channels',
        title: '📡 Channels',
        rows: [{ label: 'a', value: 'b' }],
      },
      {
        bucket: 'email',
        title: '📧 Email',
        rows: [{ label: 'c', value: 'd' }],
      },
    ];
    const out = renderTelegramStatus(
      contributions,
      new Date('2026-06-28T08:00:00.000Z'),
    );
    expect(out).toContain('📊 NANOCLAW STATUS');
    expect(out).toContain('2026-06-28');
    expect(out).toContain('📡 Channels');
    expect(out).toContain('📧 Email');
    expect(out.indexOf('Channels')).toBeLessThan(out.indexOf('Email'));
  });

  it('renders warn line above rows when set', () => {
    const out = renderTelegramStatus(
      [
        {
          bucket: 'agent',
          title: '🤖 Agent',
          rows: [{ label: 'k', value: 'v' }],
          warn: 'collection failed: boom',
        },
      ],
      new Date('2026-06-28T08:00:00.000Z'),
    );
    expect(out).toContain('⚠️ collection failed: boom');
  });

  it('truncates the rendered output at the 4096-char Telegram limit', () => {
    const huge: StatusContribution[] = [
      {
        bucket: 'system',
        title: '⚙️ System',
        rows: Array.from({ length: 1000 }, (_, i) => ({
          label: `row${i}`,
          value: 'x'.repeat(20),
        })),
      },
    ];
    const out = renderTelegramStatus(huge, new Date());
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith('…')).toBe(true);
  });
});
