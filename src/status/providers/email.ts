import fs from 'fs';

import { _rawDb, getRouterState } from '../../db.js';
import { formatRelativeTime } from '../format.js';
import type { StatusContribution, StatusProvider } from '../types.js';

export interface EmailProviderOptions {
  quarantinePath: string;
  classifierErrorCount: () => number;
  now?: () => number;
}

export class EmailProvider implements StatusProvider {
  readonly name = 'email';

  constructor(private readonly opts: EmailProviderOptions) {}

  async collect(): Promise<StatusContribution> {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const cutoffMs = now - 86_400_000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const db = _rawDb();

    const received = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM messages m
           JOIN chats c ON m.chat_jid = c.jid
           WHERE c.channel = 'gmail' AND m.timestamp > ?`,
        )
        .get(cutoffIso) as { c: number }
    ).c;

    let quarantined = 0;
    try {
      const text = fs.readFileSync(this.opts.quarantinePath, 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { timestamp?: string };
          if (obj.timestamp && new Date(obj.timestamp).getTime() > cutoffMs) {
            quarantined++;
          }
        } catch {
          /* malformed line, skip */
        }
      }
    } catch {
      /* missing file = 0 */
    }

    const safe = Math.max(0, received - quarantined);
    const lastPoll = getRouterState('channel:gmail:last_poll') ?? null;

    return {
      bucket: 'email',
      title: '📧 Email Pipeline',
      rows: [
        { label: 'Received (24h)', value: String(received) },
        { label: 'Safe (24h)', value: String(safe) },
        { label: 'Quarantined (24h)', value: String(quarantined) },
        {
          label: 'Classifier errors (1h)',
          value: String(this.opts.classifierErrorCount()),
        },
        { label: 'Last poll', value: formatRelativeTime(lastPoll, now) },
      ],
    };
  }
}
