import { formatBytes, formatDuration } from '../format.js';
import type { StatusContribution, StatusProvider } from '../types.js';

export interface SystemProviderOptions {
  version: string;
}

export class SystemProvider implements StatusProvider {
  readonly name = 'system';

  constructor(private readonly opts: SystemProviderOptions) {}

  async collect(): Promise<StatusContribution> {
    const uptimeMs = Math.floor(process.uptime() * 1000);
    const mem = process.memoryUsage().heapUsed;
    return {
      bucket: 'system',
      title: '⚙️ System',
      rows: [
        { label: 'Uptime', value: formatDuration(uptimeMs) },
        { label: 'Version', value: this.opts.version },
        { label: 'Memory', value: formatBytes(mem) },
        { label: 'Node', value: process.version },
        { label: 'Platform', value: process.platform },
      ],
    };
  }
}
