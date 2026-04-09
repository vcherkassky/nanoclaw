/**
 * Leaky-bucket error accumulator with rate-limited notifications.
 *
 * Records errors into a sliding time window. When the count reaches the
 * configured threshold, signals that a notification should be sent, then
 * drains the bucket. A separate daily cap prevents notification storms.
 *
 * All time-related behaviour is injectable via `opts.now` for deterministic
 * unit testing.
 */

export interface ErrorBucketOptions {
  /** Sliding window for counting errors. Default: 3 600 000 ms (1 hour). */
  windowMs?: number;
  /** Number of errors in the window before triggering. Default: 20. */
  threshold?: number;
  /** Maximum notifications per rolling day. Default: 3. */
  maxPerDay?: number;
  /** Rolling day window size. Default: 86 400 000 ms (24 h). */
  dayMs?: number;
  /** Clock function — injectable for tests. Default: Date.now. */
  now?: () => number;
}

export interface BucketTrigger {
  /** Number of errors that accumulated before the trigger fired. */
  count: number;
  /** True when the daily cap was already reached — notification was suppressed. */
  suppressed: boolean;
}

export class ErrorBucket {
  private errors: number[] = [];
  private notificationsSent: number[] = [];

  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly maxPerDay: number;
  private readonly dayMs: number;
  readonly now: () => number;

  constructor(opts: ErrorBucketOptions = {}) {
    this.windowMs = opts.windowMs ?? 3_600_000;
    this.threshold = opts.threshold ?? 20;
    this.maxPerDay = opts.maxPerDay ?? 3;
    this.dayMs = opts.dayMs ?? 86_400_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record one error.
   *
   * Returns a `BucketTrigger` when the threshold is crossed, `null` otherwise.
   * The caller is responsible for sending a notification when a non-suppressed
   * trigger is returned.
   *
   * After triggering the bucket is drained so the next error starts a fresh
   * accumulation cycle.
   */
  record(): BucketTrigger | null {
    const ts = this.now();

    this.prune(ts);
    this.errors.push(ts);

    if (this.errors.length < this.threshold) return null;

    // Threshold crossed — drain regardless so we don't re-trigger every error
    const count = this.errors.length;
    this.errors = [];

    const withinDayCap = this.notificationsSent.length < this.maxPerDay;
    if (withinDayCap) {
      this.notificationsSent.push(ts);
    }

    return { count, suppressed: !withinDayCap };
  }

  /** Number of errors currently in the sliding window. */
  get errorCount(): number {
    const ts = this.now();
    return this.errors.filter((t) => ts - t < this.windowMs).length;
  }

  /** Number of notifications sent within the rolling day window. */
  get notificationCount(): number {
    const ts = this.now();
    return this.notificationsSent.filter((t) => ts - t < this.dayMs).length;
  }

  private prune(ts: number): void {
    this.errors = this.errors.filter((t) => ts - t < this.windowMs);
    this.notificationsSent = this.notificationsSent.filter(
      (t) => ts - t < this.dayMs,
    );
  }
}
