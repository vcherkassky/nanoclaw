import type { StatusContribution, StatusProvider } from './types.js';

export interface StatusManagerOptions {
  providers: StatusProvider[];
  perProviderTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class StatusManager {
  constructor(private readonly opts: StatusManagerOptions) {}

  async collectAll(): Promise<StatusContribution[]> {
    const timeoutMs = this.opts.perProviderTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    return Promise.all(
      this.opts.providers.map((p) => this.collectOne(p, timeoutMs)),
    );
  }

  private async collectOne(
    provider: StatusProvider,
    timeoutMs: number,
  ): Promise<StatusContribution> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<StatusContribution>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            bucket: 'system',
            title: provider.name,
            rows: [],
            warn: `timeout after ${timeoutMs}ms`,
          }),
        timeoutMs,
      );
    });
    try {
      const result = await Promise.race([provider.collect(), timeout]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      const reason = err instanceof Error ? err.message : String(err);
      return {
        bucket: 'system',
        title: provider.name,
        rows: [],
        warn: `collection failed: ${reason}`,
      };
    }
  }
}
