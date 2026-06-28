import { _rawDb, getRouterState } from '../../db.js';
import type { Channel } from '../../types.js';
import { formatRelativeTime } from '../format.js';
import type { StatusContribution, StatusProvider } from '../types.js';

export interface ChannelsProviderOptions {
  channels: Channel[];
  now?: () => number;
}

export class ChannelsProvider implements StatusProvider {
  readonly name = 'channels';

  constructor(private readonly opts: ChannelsProviderOptions) {}

  async collect(): Promise<StatusContribution> {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const cutoff = new Date(now - 86_400_000).toISOString();
    const db = _rawDb();

    const volumeRow = db.prepare(
      `SELECT COUNT(*) AS c FROM messages m
       JOIN chats c ON m.chat_jid = c.jid
       WHERE c.channel = ? AND m.is_from_me = 0 AND m.timestamp > ?`,
    );
    const lastMsgRow = db.prepare(
      `SELECT MAX(m.timestamp) AS t FROM messages m
       JOIN chats c ON m.chat_jid = c.jid
       WHERE c.channel = ? AND m.is_from_me = 0`,
    );

    const rows = this.opts.channels.map((ch) => {
      const volume = (volumeRow.get(ch.name, cutoff) as { c: number }).c;
      const lastMsg = (lastMsgRow.get(ch.name) as { t: string | null }).t;
      const lastPoll = getRouterState(`channel:${ch.name}:last_poll`) ?? null;
      const state = ch.isConnected() ? '✅ Connected' : '❌ Disconnected';
      const value = [
        state,
        `last msg ${formatRelativeTime(lastMsg, now)}`,
        `last poll ${formatRelativeTime(lastPoll, now)}`,
        `${volume} (24h)`,
      ].join(' · ');
      return { label: ch.name, value };
    });

    return { bucket: 'channels', title: '📡 Channels & Connections', rows };
  }
}
