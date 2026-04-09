import { describe, expect, it } from 'vitest';

import { ErrorBucket } from './error-bucket.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A controllable clock. Advance with tick(ms). */
function makeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

function makeBucket(opts: {
  threshold?: number;
  windowMs?: number;
  maxPerDay?: number;
  dayMs?: number;
  startMs?: number;
}) {
  const clock = makeClock(opts.startMs ?? 0);
  const bucket = new ErrorBucket({
    threshold: opts.threshold ?? 20,
    windowMs: opts.windowMs ?? 3_600_000,
    maxPerDay: opts.maxPerDay ?? 3,
    dayMs: opts.dayMs ?? 86_400_000,
    now: clock.now,
  });
  return { bucket, clock };
}

/** Record n errors and return all trigger results (non-null only). */
function recordN(bucket: ErrorBucket, n: number) {
  const triggers = [];
  for (let i = 0; i < n; i++) {
    const t = bucket.record();
    if (t) triggers.push(t);
  }
  return triggers;
}

// ---------------------------------------------------------------------------
// Basic threshold behaviour
// ---------------------------------------------------------------------------

describe('threshold', () => {
  it('returns null for errors below the threshold', () => {
    const { bucket } = makeBucket({ threshold: 5 });
    for (let i = 0; i < 4; i++) {
      expect(bucket.record()).toBeNull();
    }
  });

  it('triggers exactly at the threshold', () => {
    const { bucket } = makeBucket({ threshold: 5 });
    const triggers = recordN(bucket, 5);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].count).toBe(5);
    expect(triggers[0].suppressed).toBe(false);
  });

  it('triggers multiple times within a single window', () => {
    const { bucket } = makeBucket({ threshold: 3, maxPerDay: 10 });
    // 7 errors: triggers at 3 (bucket drained), triggers again at 3 more = 6, 1 remaining
    const triggers = recordN(bucket, 7);
    expect(triggers).toHaveLength(2);
    expect(triggers[0].count).toBe(3);
    expect(triggers[1].count).toBe(3);
    expect(bucket.errorCount).toBe(1);
  });

  it('drains bucket after trigger so next cycle starts fresh', () => {
    const { bucket } = makeBucket({ threshold: 3, maxPerDay: 10 });
    recordN(bucket, 3); // first trigger
    expect(bucket.errorCount).toBe(0);
    // Two more errors — below threshold, no trigger
    expect(bucket.record()).toBeNull();
    expect(bucket.record()).toBeNull();
    expect(bucket.errorCount).toBe(2);
  });

  it('can trigger multiple times within the same window', () => {
    const { bucket } = makeBucket({ threshold: 3, maxPerDay: 10 });
    const t1 = recordN(bucket, 3);
    const t2 = recordN(bucket, 3);
    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sliding window expiry
// ---------------------------------------------------------------------------

describe('sliding window', () => {
  it('does not count errors that have expired', () => {
    const { bucket, clock } = makeBucket({ threshold: 3, windowMs: 60_000 });
    bucket.record();
    bucket.record();
    clock.tick(61_000); // both errors now outside the window
    bucket.record(); // 1 fresh error — below threshold
    expect(bucket.record()).toBeNull();
    expect(bucket.errorCount).toBe(2); // only the two fresh ones count
  });

  it('triggers if threshold met by a mix of old (within window) and new errors', () => {
    const { bucket, clock } = makeBucket({ threshold: 4, windowMs: 60_000 });
    bucket.record();
    bucket.record(); // 2 errors at t=0
    clock.tick(30_000);
    bucket.record();
    const trigger = bucket.record(); // 4th error, all within window
    expect(trigger).not.toBeNull();
    expect(trigger!.count).toBe(4);
  });

  it('does not trigger when some errors have fallen outside the window', () => {
    const { bucket, clock } = makeBucket({ threshold: 3, windowMs: 60_000 });
    bucket.record();
    bucket.record(); // 2 at t=0
    clock.tick(61_000);
    // First two have expired — only 1 fresh error below threshold
    expect(bucket.record()).toBeNull();
    expect(bucket.errorCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Daily notification cap
// ---------------------------------------------------------------------------

describe('daily cap', () => {
  it('suppresses trigger when daily cap is reached', () => {
    const { bucket } = makeBucket({ threshold: 2, maxPerDay: 2 });
    recordN(bucket, 2); // notification 1
    recordN(bucket, 2); // notification 2 — cap reached
    const triggers = recordN(bucket, 2); // notification 3 — suppressed
    expect(triggers).toHaveLength(1);
    expect(triggers[0].suppressed).toBe(true);
  });

  it('suppressed trigger still drains the bucket', () => {
    const { bucket } = makeBucket({ threshold: 2, maxPerDay: 1 });
    recordN(bucket, 2); // first trigger, sends notification
    recordN(bucket, 2); // second trigger, suppressed — but bucket must drain
    expect(bucket.errorCount).toBe(0);
    // Next error starts fresh
    expect(bucket.record()).toBeNull();
  });

  it('does not count suppressed triggers against the daily cap', () => {
    const { bucket } = makeBucket({ threshold: 2, maxPerDay: 2 });
    recordN(bucket, 2); // sends notification 1
    recordN(bucket, 2); // sends notification 2 — cap reached
    recordN(bucket, 2); // suppressed (cap at 2)
    expect(bucket.notificationCount).toBe(2);
  });

  it('resets daily cap after the day window expires', () => {
    const { bucket, clock } = makeBucket({
      threshold: 2,
      maxPerDay: 1,
      dayMs: 86_400_000,
    });
    recordN(bucket, 2); // uses the one daily slot
    const suppressed = recordN(bucket, 2);
    expect(suppressed[0].suppressed).toBe(true);

    clock.tick(86_400_001); // advance past 24 h
    const nextDay = recordN(bucket, 2);
    expect(nextDay[0].suppressed).toBe(false);
    expect(bucket.notificationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// errorCount and notificationCount getters
// ---------------------------------------------------------------------------

describe('getters', () => {
  it('errorCount reflects current errors in window', () => {
    const { bucket } = makeBucket({ threshold: 10 });
    expect(bucket.errorCount).toBe(0);
    bucket.record();
    bucket.record();
    expect(bucket.errorCount).toBe(2);
  });

  it('errorCount is zero after a trigger drains the bucket', () => {
    const { bucket } = makeBucket({ threshold: 2 });
    recordN(bucket, 2);
    expect(bucket.errorCount).toBe(0);
  });

  it('errorCount excludes expired errors', () => {
    const { bucket, clock } = makeBucket({ threshold: 10, windowMs: 60_000 });
    bucket.record();
    clock.tick(61_000);
    bucket.record();
    expect(bucket.errorCount).toBe(1); // only the fresh one
  });

  it('notificationCount starts at zero', () => {
    const { bucket } = makeBucket({});
    expect(bucket.notificationCount).toBe(0);
  });

  it('notificationCount increments on non-suppressed triggers', () => {
    const { bucket } = makeBucket({ threshold: 2, maxPerDay: 5 });
    recordN(bucket, 2);
    expect(bucket.notificationCount).toBe(1);
    recordN(bucket, 2);
    expect(bucket.notificationCount).toBe(2);
  });

  it('notificationCount excludes expired notifications', () => {
    const { bucket, clock } = makeBucket({
      threshold: 2,
      maxPerDay: 5,
      dayMs: 3_600_000,
    });
    recordN(bucket, 2);
    expect(bucket.notificationCount).toBe(1);
    clock.tick(3_600_001);
    expect(bucket.notificationCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Clock injection / determinism
// ---------------------------------------------------------------------------

describe('clock injection', () => {
  it('uses the injected clock exclusively', () => {
    const clock = makeClock(1_000_000);
    const bucket = new ErrorBucket({ threshold: 2, windowMs: 60_000, now: clock.now });
    bucket.record(); // recorded at t=1_000_000
    clock.tick(30_000); // advance 30s — first error still in 60s window
    const trigger = bucket.record(); // second error — threshold=2 met
    // If real Date.now were used the two errors would be far apart and the window
    // logic would behave differently; with the injected clock they are 30s apart.
    expect(trigger).not.toBeNull();
    expect(trigger!.suppressed).toBe(false);
    expect(bucket.errorCount).toBe(0); // drained after trigger
  });

  it('exposes now() so callers can timestamp notifications consistently', () => {
    const clock = makeClock(42_000);
    const bucket = new ErrorBucket({ now: clock.now });
    expect(bucket.now()).toBe(42_000);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('threshold of 1 triggers on every error', () => {
    const { bucket } = makeBucket({ threshold: 1, maxPerDay: 100 });
    for (let i = 0; i < 5; i++) {
      const t = bucket.record();
      expect(t).not.toBeNull();
      expect(t!.suppressed).toBe(false);
    }
  });

  it('maxPerDay of 0 always suppresses', () => {
    const { bucket } = makeBucket({ threshold: 1, maxPerDay: 0 });
    const t = bucket.record();
    expect(t).not.toBeNull();
    expect(t!.suppressed).toBe(true);
  });

  it('handles a large burst without throwing', () => {
    const { bucket } = makeBucket({ threshold: 5, maxPerDay: 100 });
    expect(() => recordN(bucket, 1000)).not.toThrow();
  });

  it('second window cycle produces fresh triggers after full drain', () => {
    const { bucket, clock } = makeBucket({
      threshold: 3,
      maxPerDay: 10,
      windowMs: 60_000,
    });
    recordN(bucket, 3); // first trigger, bucket drained
    clock.tick(60_001); // window expired
    const triggers = recordN(bucket, 3); // fresh window
    expect(triggers).toHaveLength(1);
    expect(triggers[0].suppressed).toBe(false);
  });
});
