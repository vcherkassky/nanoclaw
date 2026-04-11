import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { convert as htmlToText } from 'html-to-text';

import { ErrorBucket } from '../error-bucket.js';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// isMain flag is used instead of MAIN_GROUP_FOLDER constant
import { classifyEmail, sanitizeEmail } from '../email-classifier.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendNotification?: (text: string, jid?: string) => Promise<void>;
  allowedSenders?: Set<string>; // if set, only these addresses trigger the agent
  targetJid?: string; // if set, deliver to this group JID instead of first main group
  credentialsDir?: string; // defaults to ~/.gmail-mcp
  useClassifier?: boolean; // run Ollama security sandbox before passing to agent
  labelTracking?: boolean; // use label-based tracking instead of mark-as-read
  processedLabel?: string; // label name for processed emails; default '🤖✅'
  quarantineLabel?: string; // label name for quarantined emails; default '🤖⚠️'
  startDateFile?: string; // path to start-date cursor file
  maxResultsPerPoll?: number; // max emails per poll cycle; default 10
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private consecutiveErrors = 0;
  private userEmail = '';
  private reauthInProgress = false;
  private processedLabelId: string | null = null;
  private quarantinedLabelId: string | null = null;
  private startDate: string | null = null;
  private readonly errorBucket: ErrorBucket | null;

  constructor(opts: GmailChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
    this.errorBucket = opts.useClassifier
      ? new ErrorBucket({ threshold: 20, windowMs: 3_600_000, maxPerDay: 3 })
      : null;
  }

  async connect(): Promise<void> {
    const credDir =
      this.opts.credentialsDir ?? path.join(os.homedir(), '.gmail-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
      );
      return;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug('Gmail OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    if (this.opts.labelTracking) {
      await this.ensureLabels();
      await this.loadOrCreateStartDate();
    }

    // Verify connection
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info({ email: this.userEmail }, 'Gmail channel connected');

    // Start polling with error backoff
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Gmail poll error'))
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    // For the monitor channel, run the first poll in the background with a short
    // delay. This lets connect() return immediately so all other channels (WhatsApp)
    // join the channels array and start connecting before any notifications are sent.
    // WhatsApp's sendMessage already queues outbound messages while connecting, so
    // quarantine alerts won't be lost even if WhatsApp is still warming up.
    if (this.opts.useClassifier) {
      setTimeout(() => {
        this.pollForMessages()
          .catch((err) =>
            logger.error({ err }, 'Gmail monitor: initial poll error'),
          )
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, 30_000);
    } else {
      await this.pollForMessages();
      schedulePoll();
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(headers)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private buildQuery(): string {
    if (this.opts.labelTracking && this.startDate) {
      const label = this.opts.processedLabel ?? '🤖✅';
      return `NOT label:${label} after:${this.startDate}`;
    }
    return 'is:unread category:primary';
  }

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    try {
      const query = this.buildQuery();
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: this.opts.maxResultsPerPoll ?? 10,
      });

      const messages = res.data.messages || [];

      for (const stub of messages) {
        if (!stub.id || this.processedIds.has(stub.id)) continue;
        this.processedIds.add(stub.id);

        await this.processMessage(stub.id);
      }

      // Cap processed ID set to prevent unbounded growth
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const status =
        (err as any)?.response?.status ??
        (err as any)?.status ??
        (err as any)?.code;
      const isInvalidGrant =
        (err as any)?.response?.data?.error === 'invalid_grant' ||
        (err as any)?.message === 'invalid_grant';
      if (
        (status === 401 || status === 403 || isInvalidGrant) &&
        !this.reauthInProgress
      ) {
        logger.error(
          { err },
          'Gmail auth error detected, starting re-auth flow',
        );
        this.startReauthFlow().catch((e) =>
          logger.error({ e }, 'Gmail re-auth flow failed'),
        );
        return;
      }
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Gmail poll failed',
      );
    }
  }

  private async startReauthFlow(): Promise<void> {
    if (this.reauthInProgress || !this.oauth2Client) return;
    this.reauthInProgress = true;

    const credDir =
      this.opts.credentialsDir ?? path.join(os.homedir(), '.gmail-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    let port = 3000;
    let callbackPath = '/oauth2callback';
    try {
      const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
      const clientConfig = keys.installed || keys.web || keys;
      const redirectUri: string = clientConfig.redirect_uris?.[0] || '';
      if (redirectUri && redirectUri.startsWith('http')) {
        const u = new URL(redirectUri);
        port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
        callbackPath = u.pathname;
      }
    } catch (err) {
      logger.warn(
        { err },
        'Gmail re-auth: could not parse redirect URI from keys',
      );
    }

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.send',
      ],
      prompt: 'consent',
    });

    try {
      await this.opts.sendNotification?.(
        `Gmail authorization has expired.\n\nOpen this link in a browser on the machine running NanoClaw (not your phone):\n${authUrl}`,
      );
    } catch (err) {
      logger.warn({ err }, 'Gmail re-auth: failed to send notification');
    }

    logger.info(
      { port, callbackPath },
      'Gmail re-auth: waiting for OAuth callback',
    );

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url!, `http://localhost:${port}`);
      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      try {
        const { tokens } = await this.oauth2Client!.getToken(code);
        this.oauth2Client!.setCredentials(tokens);

        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, tokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.info('Gmail re-auth: tokens saved');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Gmail re-authorized successfully!</h2><p>You can close this tab.</p></body></html>',
        );
      } catch (err) {
        logger.error({ err }, 'Gmail re-auth: token exchange failed');
        res.writeHead(500);
        res.end('Authorization failed. Check logs.');
      } finally {
        server.close();
        this.reauthInProgress = false;
        this.consecutiveErrors = 0;

        // Reinitialize gmail client with fresh credentials
        this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client! });

        try {
          await this.opts.sendNotification?.(
            'Gmail re-authorized successfully. Resuming.',
          );
        } catch {}
        logger.info('Gmail re-auth: channel reconnected');
      }
    });

    server.on('error', (err) => {
      logger.error({ err, port }, 'Gmail re-auth: local server error');
      this.reauthInProgress = false;
    });

    server.listen(port);
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    // Extract sender name and email
    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    // Skip emails from self (our own replies)
    if (senderEmail === this.userEmail) return;

    // Enforce sender allowlist if configured
    if (
      this.opts.allowedSenders &&
      this.opts.allowedSenders.size > 0 &&
      !this.opts.allowedSenders.has(senderEmail.toLowerCase())
    ) {
      logger.debug(
        { senderEmail, subject },
        'Gmail: sender not in allowlist, skipping',
      );
      return;
    }

    // Extract body text
    const body = this.extractTextBody(msg.data.payload);

    if (!body) {
      logger.debug({ messageId, subject }, 'Skipping email with no text body');
      return;
    }

    const chatJid = `gmail:${threadId}`;

    // Cache thread metadata for replies
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    // Find the target group to deliver the email notification
    const groups = this.opts.registeredGroups();
    let mainJid: string;
    if (this.opts.targetJid) {
      if (!groups[this.opts.targetJid]) {
        logger.debug(
          { chatJid, targetJid: this.opts.targetJid },
          'GMAIL_TARGET_JID not registered, skipping email',
        );
        return;
      }
      mainJid = this.opts.targetJid;
    } else {
      const mainEntry = Object.entries(groups).find(
        ([, g]) => g.isMain === true,
      );
      if (!mainEntry) {
        logger.debug(
          { chatJid, subject },
          'No main group registered, skipping email',
        );
        return;
      }
      mainJid = mainEntry[0];
    }
    const trunc = (s: string, n: number) =>
      s.length > n ? s.slice(0, n - 1) + '…' : s;
    const shortFrom = trunc(senderName || senderEmail, 20);
    const shortSubject = trunc(subject, 20);

    let quarantined = false;

    // Security sandbox — only active for channels with useClassifier: true
    if (this.opts.useClassifier) {
      const sanitized = sanitizeEmail(messageId, senderEmail, subject, body);
      if (!sanitized) {
        logger.warn(
          { messageId, senderEmail },
          'Gmail: email failed sanitization, skipping',
        );
        const trigger = this.errorBucket?.record();
        if (trigger) {
          if (trigger.suppressed) {
            logger.error(
              { messageId, senderEmail },
              'Gmail Monitor: daily error notification cap reached — errors are being silently dropped',
            );
          } else {
            await this.opts
              .sendNotification?.(
                `⚠️ Gmail Monitor: ${trigger.count} classifier errors in the last hour\nFrom: ${shortFrom} | Subj: ${shortSubject}\nCause: sanitization failure`,
                this.opts.targetJid,
              )
              .catch((err) =>
                logger.error(
                  { err },
                  'Gmail: failed to send error notification',
                ),
              );
          }
        }
        return;
      }

      const classification = await classifyEmail(sanitized);

      if ('retry' in classification) {
        // Classifier unavailable (Ollama down) — un-track so next poll retries
        this.processedIds.delete(messageId);
        logger.warn(
          { messageId, reason: classification.reason },
          'Gmail: classifier unavailable, email will be retried',
        );
        const trigger = this.errorBucket?.record();
        if (trigger) {
          if (trigger.suppressed) {
            logger.error(
              { messageId, reason: classification.reason },
              'Gmail Monitor: daily error notification cap reached — errors are being silently dropped',
            );
          } else {
            await this.opts
              .sendNotification?.(
                `⚠️ Gmail Monitor: ${trigger.count} classifier errors in the last hour\nFrom: ${shortFrom} | Subj: ${shortSubject}\nCause: ${classification.reason}`,
                this.opts.targetJid,
              )
              .catch((err) =>
                logger.error(
                  { err },
                  'Gmail: failed to send error notification',
                ),
              );
          }
        }
        return; // do NOT apply label or mark as read
      }

      if (!classification.safe) {
        const notifMsg = `⚠️ Quarantined\nFrom: ${shortFrom} | Subj: ${shortSubject}\nReason: ${classification.reason}`;
        await this.opts
          .sendNotification?.(notifMsg, this.opts.targetJid)
          .catch((err) =>
            logger.error(
              { err },
              'Gmail: failed to send quarantine notification',
            ),
          );
        quarantined = true;
        // Fall through to tracking section
      }
    }

    if (!quarantined) {
      const content = `[Email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

      this.opts.onMessage(mainJid, {
        id: messageId,
        chat_jid: mainJid,
        sender: senderEmail,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    }

    // Track processing: label (monitor channel) or mark-as-read (PA channel)
    if (this.opts.labelTracking) {
      const labelId = quarantined
        ? this.quarantinedLabelId
        : this.processedLabelId;
      if (labelId) {
        try {
          await this.gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: { addLabelIds: [labelId] },
          });
        } catch (err) {
          logger.warn(
            { messageId, err },
            'Gmail: failed to apply tracking label — will retry on next poll',
          );
          this.processedIds.delete(messageId);
        }
      }
    } else if (!quarantined) {
      // PA channel: mark as read (quarantined emails don't reach here without labelTracking)
      try {
        await this.gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
      } catch (err) {
        logger.warn({ messageId, err }, 'Failed to mark email as read');
      }
    }

    if (!quarantined) {
      logger.info(
        { mainJid, from: senderName, subject },
        'Gmail email delivered to main group',
      );
    }
  }

  private async ensureLabels(): Promise<void> {
    if (!this.gmail) return;

    const processedName = this.opts.processedLabel ?? '🤖✅';
    const quarantineName = this.opts.quarantineLabel ?? '🤖⚠️';

    try {
      const res = await this.gmail.users.labels.list({ userId: 'me' });
      const existing = res.data.labels || [];

      const findOrCreate = async (name: string): Promise<string | null> => {
        const found = existing.find((l) => l.name === name);
        if (found?.id) return found.id;

        const created = await this.gmail!.users.labels.create({
          userId: 'me',
          requestBody: { name },
        });
        return created.data.id ?? null;
      };

      this.processedLabelId = await findOrCreate(processedName);
      this.quarantinedLabelId = await findOrCreate(quarantineName);

      logger.info(
        {
          processed: `${processedName} → ${this.processedLabelId}`,
          quarantined: `${quarantineName} → ${this.quarantinedLabelId}`,
        },
        'Gmail Monitor: labels ready',
      );
    } catch (err) {
      logger.error({ err }, 'Gmail Monitor: failed to ensure labels');
    }
  }

  private async loadOrCreateStartDate(): Promise<void> {
    const filePath =
      this.opts.startDateFile ??
      path.join(process.cwd(), 'store', 'gmail-monitor-start.txt');

    if (fs.existsSync(filePath)) {
      this.startDate = fs.readFileSync(filePath, 'utf-8').trim();
      logger.info(
        { startDate: this.startDate },
        'Gmail Monitor: loaded start date cursor',
      );
      return;
    }

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    this.startDate = `${yyyy}/${mm}/${dd}`;

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, this.startDate, 'utf-8');
      logger.info(
        { startDate: this.startDate, filePath },
        'Gmail Monitor: created start date cursor',
      );
    } catch (err) {
      logger.warn({ err }, 'Gmail Monitor: could not write start date file');
    }
  }

  private extractTextBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    // Direct text/plain body
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    // Direct text/html body — convert to plain text
    if (payload.mimeType === 'text/html' && payload.body?.data) {
      const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      return htmlToText(html, { wordwrap: false });
    }

    // Multipart: search parts recursively, preferring text/plain
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }

    return '';
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn('Gmail: credentials not found in ~/.gmail-mcp/');
    return null;
  }

  const env = readEnvFile(['GMAIL_ALLOWED_SENDERS', 'GMAIL_TARGET_JID']);
  const rawSenders = env['GMAIL_ALLOWED_SENDERS'];
  const allowedSenders = rawSenders
    ? new Set<string>(
        rawSenders
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      )
    : undefined;
  const targetJid = env['GMAIL_TARGET_JID'] || undefined;

  return new GmailChannel({ ...opts, allowedSenders, targetJid });
});

registerChannel('gmail-monitor', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'MONITOR_GMAIL_CREDENTIALS_DIR',
    'PUBLIC_INBOX_TARGET_JID',
    'MONITOR_PROCESSED_LABEL',
    'MONITOR_QUARANTINE_LABEL',
  ]);
  const credDir =
    env['MONITOR_GMAIL_CREDENTIALS_DIR'] ??
    path.join(os.homedir(), '.gmail-monitor');

  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn(
      `Gmail Monitor: credentials not found in ${credDir}. Run the Gmail auth flow for the monitored account.`,
    );
    return null;
  }

  const targetJid = env['PUBLIC_INBOX_TARGET_JID'] || undefined;

  return new GmailChannel({
    ...opts,
    credentialsDir: credDir,
    useClassifier: true,
    labelTracking: true,
    processedLabel: env['MONITOR_PROCESSED_LABEL'] || '🤖✅',
    quarantineLabel: env['MONITOR_QUARANTINE_LABEL'] || '🤖⚠️',
    startDateFile: path.join(process.cwd(), 'store', 'gmail-monitor-start.txt'),
    maxResultsPerPoll: 10,
    allowedSenders: undefined, // public inbox — no sender restriction
    targetJid,
  });
});
