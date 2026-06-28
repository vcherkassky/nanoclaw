import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StatusScheduler } from './scheduler.js';

describe('StatusScheduler', () => {
  beforeEach(() => vi.useFakeTimers());

  it('computes next fire at the configured hour today if not yet passed', () => {
    vi.setSystemTime(new Date('2026-06-28T05:00:00.000Z'));
    const ran: number[] = [];
    const sched = new StatusScheduler({
      hour: 8,
      minute: 0,
      onFire: async () => {
        ran.push(Date.now());
      },
      timezoneOffsetMinutes: 0,
    });
    sched.start();
    vi.advanceTimersByTime(3 * 3_600_000); // jump to 08:00 UTC
    expect(ran).toHaveLength(1);
  });

  it("fires immediately on start if today's window has already passed", async () => {
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));
    const ran: number[] = [];
    const sched = new StatusScheduler({
      hour: 8,
      minute: 0,
      onFire: async () => {
        ran.push(Date.now());
      },
      timezoneOffsetMinutes: 0,
      missedFireWindowMs: 4 * 3_600_000,
    });
    sched.start();
    await vi.runAllTimersAsync();
    expect(ran.length).toBeGreaterThanOrEqual(1);
  });

  it('respects stop() and does not fire again', () => {
    vi.setSystemTime(new Date('2026-06-28T05:00:00.000Z'));
    const ran: number[] = [];
    const sched = new StatusScheduler({
      hour: 8,
      minute: 0,
      onFire: async () => {
        ran.push(Date.now());
      },
      timezoneOffsetMinutes: 0,
    });
    sched.start();
    sched.stop();
    vi.advanceTimersByTime(3 * 3_600_000);
    expect(ran).toEqual([]);
  });
});
