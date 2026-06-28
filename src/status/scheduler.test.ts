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
        sched.stop(); // halt self-rescheduling for the test
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
        sched.stop(); // halt self-rescheduling for the test
      },
      timezoneOffsetMinutes: 0,
      missedFireWindowMs: 4 * 3_600_000,
    });
    sched.start();
    await vi.runAllTimersAsync();
    expect(ran.length).toBe(1);
  });

  it('re-arms after firing for the next day', async () => {
    vi.setSystemTime(new Date('2026-06-28T05:00:00.000Z'));
    const ran: number[] = [];
    const sched = new StatusScheduler({
      hour: 8,
      minute: 0,
      onFire: async () => {
        ran.push(Date.now());
        if (ran.length >= 2) sched.stop();
      },
      timezoneOffsetMinutes: 0,
    });
    sched.start();
    // Start at 05:00. Advance 28h to land at 09:00 next day, past the
    // second scheduled fire at 08:00 tomorrow.
    await vi.advanceTimersByTimeAsync(28 * 3_600_000);
    expect(ran).toHaveLength(2);
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
