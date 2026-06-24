/**
 * Google Calendar MCP Server (stdio)
 *
 * Custom replacement for @gongrzhe/server-calendar-autoauth-mcp so we can
 * expose the full Google Calendar API surface — including per-event
 * reminders, attendees, and time-zone overrides — that the upstream
 * package omits.
 *
 * Credentials are loaded from /home/node/.calendar-mcp (mounted from host):
 *   - gcp-oauth.keys.json (OAuth client; symlinked to gmail's)
 *   - credentials.json     (access + refresh tokens; auto-refreshed by SDK)
 *
 * Authentication itself (first-time consent) is still done on the host with
 *   npx @gongrzhe/server-calendar-autoauth-mcp auth
 * which writes credentials.json. This server only consumes them.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const CONFIG_DIR = path.join(os.homedir(), '.calendar-mcp');
const OAUTH_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

function loadCredentials(): OAuth2Client {
  if (!fs.existsSync(OAUTH_PATH)) {
    process.stderr.write(`OAuth keys not found at ${OAUTH_PATH}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    process.stderr.write(
      `Credentials not found at ${CREDENTIALS_PATH} — run the auth flow on the host first.\n`,
    );
    process.exit(1);
  }
  const keys = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
  const client = keys.installed || keys.web;
  if (!client) {
    process.stderr.write('OAuth keys malformed: missing installed/web block\n');
    process.exit(1);
  }
  const oauth = new OAuth2Client(
    client.client_id,
    client.client_secret,
    'http://localhost:3000/oauth2callback',
  );
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  oauth.setCredentials(creds);
  // Persist refreshed tokens so the next start has them.
  oauth.on('tokens', (tokens) => {
    const updated = { ...creds, ...tokens };
    try {
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2));
    } catch (err) {
      process.stderr.write(`Failed to persist refreshed tokens: ${err}\n`);
    }
  });
  return oauth;
}

const oauth = loadCredentials();
const calendar = google.calendar({ version: 'v3', auth: oauth });
const CAL_ID = process.env.CALENDAR_ID || 'primary';

const server = new Server(
  { name: 'calendar', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const REMINDER_SCHEMA = {
  type: 'object',
  description:
    'Per-event reminder overrides. When set, useDefault is forced to false. ' +
    'Up to 5 overrides; method is "popup" (in-app/mobile) or "email"; ' +
    'minutes is 0–40320 (4 weeks max).',
  properties: {
    useDefault: {
      type: 'boolean',
      description:
        'If true, use the calendar default reminders and ignore overrides.',
    },
    overrides: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['method', 'minutes'],
        properties: {
          method: { type: 'string', enum: ['email', 'popup'] },
          minutes: { type: 'number', minimum: 0, maximum: 40320 },
        },
      },
    },
  },
} as const;

const ATTENDEE_SCHEMA = {
  type: 'array',
  description: 'Attendees to invite. Google sends invitation emails on create.',
  items: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string' },
      displayName: { type: 'string' },
      optional: { type: 'boolean' },
    },
  },
} as const;

const TIME_SCHEMA = {
  type: 'object',
  description:
    'Exactly one of `dateTime` (timed event) or `date` (all-day event) is required. ' +
    'When unsure of a precise time, prefer `date` (all-day) over a guessed `dateTime`.',
  properties: {
    dateTime: {
      type: 'string',
      description:
        'ISO 8601 timestamp for a timed event, e.g. 2026-06-24T15:00:00+01:00. ' +
        'Omit when creating an all-day event.',
    },
    date: {
      type: 'string',
      description:
        'YYYY-MM-DD for an all-day event. Use when the user did not give a precise time. ' +
        'For multi-day all-day events, `end.date` is exclusive (Google convention).',
    },
    timeZone: {
      type: 'string',
      description:
        'IANA TZ (e.g. Europe/Dublin). Optional — inferred from dateTime offset if omitted.',
    },
  },
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_event',
      description: 'Create a new event on the calendar.',
      inputSchema: {
        type: 'object',
        required: ['summary', 'start', 'end'],
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start: TIME_SCHEMA,
          end: TIME_SCHEMA,
          description: { type: 'string' },
          location: { type: 'string' },
          attendees: ATTENDEE_SCHEMA,
          reminders: REMINDER_SCHEMA,
          colorId: {
            type: 'string',
            description: 'Google Calendar color ID (1–11)',
          },
        },
      },
    },
    {
      name: 'get_event',
      description: 'Retrieve a single event by ID.',
      inputSchema: {
        type: 'object',
        required: ['eventId'],
        properties: { eventId: { type: 'string' } },
      },
    },
    {
      name: 'update_event',
      description:
        'Patch an existing event. Only provided fields are modified — others are left untouched.',
      inputSchema: {
        type: 'object',
        required: ['eventId'],
        properties: {
          eventId: { type: 'string' },
          summary: { type: 'string' },
          start: TIME_SCHEMA,
          end: TIME_SCHEMA,
          description: { type: 'string' },
          location: { type: 'string' },
          attendees: ATTENDEE_SCHEMA,
          reminders: REMINDER_SCHEMA,
          colorId: { type: 'string' },
        },
      },
    },
    {
      name: 'delete_event',
      description: 'Cancel an event.',
      inputSchema: {
        type: 'object',
        required: ['eventId'],
        properties: { eventId: { type: 'string' } },
      },
    },
    {
      name: 'list_events',
      description:
        'List events in a time range. Use timeMin/timeMax (ISO 8601) to bound, q to keyword-search, and orderBy=startTime for chronological order.',
      inputSchema: {
        type: 'object',
        properties: {
          timeMin: { type: 'string' },
          timeMax: { type: 'string' },
          q: { type: 'string' },
          maxResults: { type: 'number', minimum: 1, maximum: 250 },
          orderBy: { type: 'string', enum: ['startTime', 'updated'] },
        },
      },
    },
    {
      name: 'freebusy',
      description:
        'Query free/busy intervals for the calendar in a time range. Use to find open slots.',
      inputSchema: {
        type: 'object',
        required: ['timeMin', 'timeMax'],
        properties: {
          timeMin: { type: 'string' },
          timeMax: { type: 'string' },
          timeZone: { type: 'string' },
        },
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function normalizeReminders(
  input: unknown,
): calendar_v3.Schema$Event['reminders'] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const r = input as {
    useDefault?: boolean;
    overrides?: Array<{ method: string; minutes: number }>;
  };
  if (r.overrides && r.overrides.length > 0) {
    // overrides set → useDefault must be false per Google's API
    return { useDefault: false, overrides: r.overrides };
  }
  if (typeof r.useDefault === 'boolean') {
    return { useDefault: r.useDefault };
  }
  return undefined;
}

function summarizeEvent(e: calendar_v3.Schema$Event): string {
  const when = e.start?.dateTime || e.start?.date || '?';
  const reminders =
    e.reminders?.overrides && e.reminders.overrides.length
      ? ` [reminders: ${e.reminders.overrides
          .map((o) => `${o.method}@${o.minutes}m`)
          .join(', ')}]`
      : e.reminders?.useDefault
        ? ' [reminders: default]'
        : '';
  return `${e.id}  ${when}  ${e.summary ?? '(no title)'}${reminders}`;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    if (name === 'create_event') {
      const requestBody: calendar_v3.Schema$Event = {
        summary: args.summary as string,
        start: args.start as calendar_v3.Schema$EventDateTime,
        end: args.end as calendar_v3.Schema$EventDateTime,
        description: args.description as string | undefined,
        location: args.location as string | undefined,
        attendees: args.attendees as calendar_v3.Schema$EventAttendee[] | undefined,
        colorId: args.colorId as string | undefined,
        reminders: normalizeReminders(args.reminders),
      };
      const res = await calendar.events.insert({
        calendarId: CAL_ID,
        requestBody,
        sendUpdates: args.attendees ? 'all' : 'none',
      });
      return {
        content: [
          {
            type: 'text',
            text: `Created event ${res.data.id}\nLink: ${res.data.htmlLink}\n${summarizeEvent(res.data)}`,
          },
        ],
      };
    }

    if (name === 'get_event') {
      const res = await calendar.events.get({
        calendarId: CAL_ID,
        eventId: args.eventId as string,
      });
      const e = res.data;
      const lines = [
        `${e.summary ?? '(no title)'}  [${e.id}]`,
        `When: ${e.start?.dateTime ?? e.start?.date ?? '?'} → ${e.end?.dateTime ?? e.end?.date ?? '?'}`,
        e.location ? `Where: ${e.location}` : '',
        e.attendees?.length
          ? `Attendees: ${e.attendees.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`).join(', ')}`
          : '',
        e.reminders?.overrides?.length
          ? `Reminders: ${e.reminders.overrides.map((o) => `${o.method}@${o.minutes}m`).join(', ')}`
          : e.reminders?.useDefault
            ? 'Reminders: calendar defaults'
            : '',
        e.description ? `\n${e.description}` : '',
        e.htmlLink ? `\nLink: ${e.htmlLink}` : '',
      ].filter(Boolean);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'update_event') {
      const requestBody: calendar_v3.Schema$Event = {};
      if (args.summary !== undefined) requestBody.summary = args.summary as string;
      if (args.start !== undefined)
        requestBody.start = args.start as calendar_v3.Schema$EventDateTime;
      if (args.end !== undefined)
        requestBody.end = args.end as calendar_v3.Schema$EventDateTime;
      if (args.description !== undefined)
        requestBody.description = args.description as string;
      if (args.location !== undefined)
        requestBody.location = args.location as string;
      if (args.attendees !== undefined)
        requestBody.attendees =
          args.attendees as calendar_v3.Schema$EventAttendee[];
      if (args.colorId !== undefined) requestBody.colorId = args.colorId as string;
      if (args.reminders !== undefined)
        requestBody.reminders = normalizeReminders(args.reminders);

      const res = await calendar.events.patch({
        calendarId: CAL_ID,
        eventId: args.eventId as string,
        requestBody,
        sendUpdates: requestBody.attendees ? 'all' : 'none',
      });
      return {
        content: [
          {
            type: 'text',
            text: `Updated event ${res.data.id}\n${summarizeEvent(res.data)}`,
          },
        ],
      };
    }

    if (name === 'delete_event') {
      await calendar.events.delete({
        calendarId: CAL_ID,
        eventId: args.eventId as string,
      });
      return {
        content: [{ type: 'text', text: `Deleted event ${args.eventId}` }],
      };
    }

    if (name === 'list_events') {
      const res = await calendar.events.list({
        calendarId: CAL_ID,
        timeMin: args.timeMin as string | undefined,
        timeMax: args.timeMax as string | undefined,
        q: args.q as string | undefined,
        maxResults: (args.maxResults as number | undefined) ?? 25,
        orderBy: (args.orderBy as 'startTime' | 'updated' | undefined) ?? 'startTime',
        singleEvents: true,
      });
      const items = res.data.items ?? [];
      return {
        content: [
          {
            type: 'text',
            text: items.length
              ? items.map(summarizeEvent).join('\n')
              : 'No events found in this range.',
          },
        ],
      };
    }

    if (name === 'freebusy') {
      const res = await calendar.freebusy.query({
        requestBody: {
          timeMin: args.timeMin as string,
          timeMax: args.timeMax as string,
          timeZone: args.timeZone as string | undefined,
          items: [{ id: CAL_ID }],
        },
      });
      const busy = res.data.calendars?.[CAL_ID]?.busy ?? [];
      return {
        content: [
          {
            type: 'text',
            text: busy.length
              ? `Busy intervals:\n${busy.map((b) => `${b.start} → ${b.end}`).join('\n')}`
              : 'No busy intervals in this range — fully free.',
          },
        ],
      };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
