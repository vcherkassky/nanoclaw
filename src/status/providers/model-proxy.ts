import type { StatusContribution, StatusProvider } from '../types.js';

export interface ProxyStats {
  /** Models Ollama reports as loaded (last /api/ps poll). */
  loadedModels: string[];
  /** Requests proxied since NanoClaw started. */
  requests: number;
}

export interface ModelProxyProviderOptions {
  getStats: () => ProxyStats;
}

export class ModelProxyProvider implements StatusProvider {
  readonly name = 'model-proxy';

  constructor(private readonly opts: ModelProxyProviderOptions) {}

  async collect(): Promise<StatusContribution> {
    const s = this.opts.getStats();
    return {
      bucket: 'proxy',
      title: '🔀 Model Proxy',
      rows: [
        {
          label: 'Loaded',
          value: s.loadedModels.length ? s.loadedModels.join(', ') : '(none)',
        },
        { label: 'Requests', value: String(s.requests) },
      ],
    };
  }
}
