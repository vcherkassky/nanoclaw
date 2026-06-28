import { formatRelativeTime } from '../format.js';
import type { StatusContribution, StatusProvider } from '../types.js';

export interface ProxyStats {
  currentModel: string | null;
  evictions: number;
  requests: number;
  lastEvictionAt: string | null;
}

export interface ModelProxyProviderOptions {
  getStats: () => ProxyStats;
  now?: () => number;
}

export class ModelProxyProvider implements StatusProvider {
  readonly name = 'model-proxy';

  constructor(private readonly opts: ModelProxyProviderOptions) {}

  async collect(): Promise<StatusContribution> {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const s = this.opts.getStats();
    return {
      bucket: 'proxy',
      title: '🔀 Model Proxy',
      rows: [
        { label: 'Loaded', value: s.currentModel ?? '(none)' },
        { label: 'Evictions (24h)', value: String(s.evictions) },
        { label: 'Requests (24h)', value: String(s.requests) },
        {
          label: 'Last eviction',
          value: formatRelativeTime(s.lastEvictionAt, now),
        },
      ],
    };
  }
}
