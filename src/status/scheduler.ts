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
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const now = Date.now();
    const missedWindow = this.opts.missedFireWindowMs ?? 86_400_000;
    const today = this.todayFireTime(now);

    let delayMs: number;
    if (today < now && now - today < missedWindow) {
      // Missed today's window — fire immediately as a backfill.
      delayMs = 0;
    } else {
      delayMs = this.nextFireTime(now) - now;
    }

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
    this.scheduleNext();
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
