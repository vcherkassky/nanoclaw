import { logger } from '../logger.js';

export interface StatusSchedulerOptions {
  hour: number;
  minute: number;
  onFire: () => Promise<void>;
  /** Offset in minutes for "local time" semantics; 0 for UTC. Tests inject 0. */
  timezoneOffsetMinutes?: number;
  /** If start() finds today's fire window passed but within this many ms, fire now. */
  missedFireWindowMs?: number;
}

/**
 * Fires onFire once at the next scheduled daily slot (or immediately on
 * missed-fire backfill), then re-arms itself for the following day.
 * Call start() to begin; stop() cancels the pending timer.
 */
export class StatusScheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly opts: StatusSchedulerOptions) {}

  start(): void {
    this.stopped = false;
    // Startup-only backfill: if today's window has passed but is recent
    // enough, fire immediately. Otherwise schedule the next future slot.
    const now = Date.now();
    const today = this.todayFireTime(now);
    const missedWindow = this.opts.missedFireWindowMs ?? 86_400_000;
    if (today < now && now - today < missedWindow) {
      this.timer = setTimeout(() => {
        void this.fire();
      }, 0);
    } else {
      this.scheduleNextFutureSlot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Arm a timer for the NEXT scheduled slot (always in the future). */
  private scheduleNextFutureSlot(): void {
    if (this.stopped) return;
    const now = Date.now();
    const delayMs = this.nextFireTime(now) - now;
    this.timer = setTimeout(() => {
      void this.fire();
    }, delayMs);
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    this.timer = undefined;
    try {
      await this.opts.onFire();
    } catch (err) {
      logger.warn({ err }, 'StatusScheduler: onFire threw');
    }
    // After firing, ALWAYS schedule the next future slot — never re-enter
    // the missed-fire backfill path. That path is for startup only; running
    // it after a fire would cause an immediate re-fire loop.
    this.scheduleNextFutureSlot();
  }

  private todayFireTime(nowMs: number): number {
    const tzOffset = (this.opts.timezoneOffsetMinutes ?? 0) * 60_000;
    const local = new Date(nowMs + tzOffset);
    local.setUTCHours(this.opts.hour, this.opts.minute, 0, 0);
    return local.getTime() - tzOffset;
  }

  private nextFireTime(nowMs: number): number {
    const today = this.todayFireTime(nowMs);
    if (today > nowMs) return today;
    return today + 86_400_000;
  }
}
