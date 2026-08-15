import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock db so attempt-tracking helpers don't touch SQLite
vi.mock('../db.js', () => ({
  clearEmailAttempt: vi.fn(),
  getEmailAttempt: vi.fn(() => null),
  recordEmailAttempt: vi.fn(),
  setRouterState: vi.fn(),
}));

import { GmailChannel, GmailChannelOpts } from './gmail.js';

interface ModifyCall {
  userId: string;
  id: string;
  requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

function withMockGmail(channel: GmailChannel): {
  modify: ReturnType<typeof vi.fn>;
} {
  const modify = vi.fn(async () => ({}));
  (channel as unknown as { gmail: unknown }).gmail = {
    users: { messages: { modify } },
  };
  return { modify };
}

function trackProcessing(
  channel: GmailChannel,
  messageId: string,
  quarantined: boolean,
): Promise<void> {
  return (
    channel as unknown as {
      trackProcessing: (id: string, q: boolean) => Promise<void>;
    }
  ).trackProcessing(messageId, quarantined);
}

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('trackProcessing (PA channel, no labelTracking)', () => {
    it('marks a quarantined email as read so it is not re-fetched every poll', async () => {
      const ch = new GmailChannel(makeOpts({ labelTracking: false }));
      const { modify } = withMockGmail(ch);

      await trackProcessing(ch, 'msg-quarantined', true);

      expect(modify).toHaveBeenCalledTimes(1);
      const arg = modify.mock.calls[0][0] as ModifyCall;
      expect(arg.id).toBe('msg-quarantined');
      expect(arg.requestBody.removeLabelIds).toEqual(['UNREAD']);
    });

    it('marks a safe email as read', async () => {
      const ch = new GmailChannel(makeOpts({ labelTracking: false }));
      const { modify } = withMockGmail(ch);

      await trackProcessing(ch, 'msg-safe', false);

      const arg = modify.mock.calls[0][0] as ModifyCall;
      expect(arg.requestBody.removeLabelIds).toEqual(['UNREAD']);
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 30000);
      expect(ch.name).toBe('gmail');
    });

    it('defaults to unread query when no filter configured', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread category:primary');
    });

    it('defaults with no options provided', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.name).toBe('gmail');
    });
  });
});
