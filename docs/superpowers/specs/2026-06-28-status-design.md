# Status — Design Spec

**Date:** 2026-06-28
**Status:** Approved for implementation planning

## Goal

Introduce **status** as a first-class observability surface for NanoClaw. Today, the only way to see whether the bot is healthy, what it has been doing, and what's scheduled is to tail logs or inspect SQLite directly. Status exposes this through a channel-native affordance — for v1, a pinned message in the Telegram main group, edited once per day.

Status is an **observability/telemetry surface**, not a liveness ping. It carries two layers:

1. **Technical stats** — connection state, errors, uptime, memory, models in use, last context size.
2. **Per-function stats** — Gmail pipeline (received/quarantined/classifier errors), scheduled task health, agent-run history.

The data-collection layer is channel-agnostic so future surfaces (Slack bot status, WhatsApp About) can be added without rework.

## Non-goals (v1)

- Hourly or event-driven status updates. Cadence is daily.
- Slack/WhatsApp/Discord surface rendering. Telegram-only.
- Aggregating historical metrics into a time-series store. Daily snapshot only.
- Token usage trends, sender-domain breakdowns, classifier-latency histograms, send-failure counters across channels. Deferred to v1.1.

## Architecture

New module under `src/status/`:

```
src/status/
├── types.ts              # StatusProvider interface, StatusContribution
├── manager.ts            # Registers providers, runs collect, dispatches to renderer
├── scheduler.ts          # Daily tick (configurable hour)
├── format.ts             # formatDuration, formatRelativeTime, formatBytes
├── providers/
│   ├── channels.ts
│   ├── email.ts
│   ├── agent-runs.ts
│   ├── model-proxy.ts
│   ├── scheduled.ts
│   └── system.ts
└── renderers/
    └── telegram.ts
```

**Provider model — pull-based.** Each provider implements `collect(): Promise<StatusContribution>`. Manager calls all providers in parallel via `Promise.allSettled` with a 5s per-provider timeout. Failed/timed-out providers are replaced with a placeholder contribution containing a `warn` field so a single broken provider never blocks the digest.

**Core types:**

```ts
export interface StatusContribution {
  bucket: 'channels' | 'email' | 'agent' | 'proxy' | 'tasks' | 'system';
  title: string;                              // e.g. "📡 Channels & Connections"
  rows: Array<{ label: string; value: string }>;
  warn?: string;                              // optional one-line health flag
}

export interface StatusProvider {
  name: string;
  collect(): Promise<StatusContribution>;
}
```

This mirrors NanoClaw's existing optional-capability pattern on `Channel` (`setTyping?`, `markRead?`, `syncGroups?`). Sources own their truth; no global mutable store; easy to test in isolation.

## v1 metric inventory

### 📡 Channels & connections (per registered channel)

| Metric | Source | Computation |
|---|---|---|
| Connected state | `channel.isConnected()` | Direct call |
| 24h inbound volume | `messages` table | `COUNT(*) WHERE chat_jid IN (chats for channel) AND is_from_me=0 AND timestamp > now-1d` |
| Last inbound message | `messages` table | `MAX(timestamp) WHERE chat_jid IN (chats for channel) AND is_from_me=0` |
| Last poll/connect | `router_state` KV | Key `channel:<name>:last_poll`, written by each channel on success |

### 📧 Email pipeline

| Metric | Source | Computation |
|---|---|---|
| Emails received (24h) | `messages` table | `COUNT WHERE channel='gmail' AND timestamp > now-1d` |
| Quarantined (24h) | `store/email-quarantine.jsonl` | Line count with `timestamp > now-1d` |
| Safe (24h) | derived | `received - quarantined` |
| Classifier errors (1h) | `GmailChannel.errorBucket.errorCount` | In-memory getter |
| Alert saturation | `GmailChannel.errorBucket.notificationCount` | In-memory getter, format `n/cap` |
| Last poll | `router_state` KV | Key `channel:gmail:last_poll`, written on each successful poll (same mechanism as channels bucket — no duplication) |

### 🤖 Agent runs

| Metric | Source | Computation |
|---|---|---|
| Total runs (24h) | new `agent_runs` table | `COUNT WHERE started_at > now-1d` |
| Runs by group (24h) | `agent_runs` | `SELECT group_folder, COUNT(*) ... GROUP BY group_folder ORDER BY 2 DESC` |
| Runs by model (24h) | `agent_runs` | `SELECT model, COUNT(*) ... GROUP BY model` |
| Last run | `agent_runs` | `MAX(started_at)`, formatted via `formatRelativeTime` |
| Last session context size | existing `estimateSessionTokens()` | Call on the active main-group session file |
| Last container duration | `agent_runs.duration_ms` | Formatted via `formatDuration` |
| Last exit code | `agent_runs.exit_code` | Render ✓ if 0, ✗ otherwise |
| Container crashes (24h) | `agent_runs` | `COUNT WHERE exit_code != 0 AND started_at > now-1d` |

### 🔀 Model proxy (Ollama)

The local Ollama proxy (`src/ollama-proxy.ts`) enforces a single-model invariant for the whole process. Surface its state so the digest reveals model thrashing or proxy issues.

| Metric | Source | Computation |
|---|---|---|
| Currently loaded model | `OllamaProxy.currentModel` | In-memory getter on the proxy instance |
| Evictions (24h) | new in-memory counter on `OllamaProxy` | Incremented in `evict()`; resets on process restart (acceptable, daily cadence) |
| Total requests proxied (24h) | new in-memory counter on `OllamaProxy` | Incremented per inbound request |
| Last eviction timestamp | new in-memory field on `OllamaProxy` | Set in `evict()`, formatted via `formatRelativeTime` |

Implementation note: add a `getStats(): { currentModel, evictions, requests, lastEvictionAt }` method on `OllamaProxy`. The `ModelProxyProvider` reads it; no schema change. Counters reset on restart — fine for a daily digest. If long-horizon trends matter later, persist via the same `agent_runs`-style approach.

### ⏱ Scheduled tasks

| Metric | Source | Computation |
|---|---|---|
| Active count | `scheduled_tasks` | `COUNT WHERE status='active'` |
| Next 3 runs | `scheduled_tasks` | `SELECT id, next_run ... ORDER BY next_run LIMIT 3` |
| Failures (24h) | `task_run_logs` | `COUNT WHERE status='error' AND run_at > now-1d` |
| Last success | `task_run_logs` | `MAX(run_at) WHERE status='success'`, rendered via `formatRelativeTime` |

### ⚙️ System

| Metric | Source | Computation |
|---|---|---|
| Uptime | `process.uptime()` | Session uptime; resets on restart (intentional) |
| Version | `package.json` | Cached at provider construction |
| Memory | `process.memoryUsage().heapUsed` | `formatBytes` |
| Node version | `process.version` | Static at construction |
| Platform | `process.platform` | Static at construction |

### Formatting

All numeric/temporal values pass through helpers in `src/status/format.ts`:

- `formatDuration(ms)` — "35m 14s", "2h 15m", "3d 4h". Never raw milliseconds.
- `formatRelativeTime(timestamp)` — "just now", "5m ago", "2h ago", "3d ago".
- `formatBytes(n)` — "85.2 MB", "1.2 GB".

Providers never emit raw numbers in `value` strings; renderer never re-formats.

## Data flow & scheduling

**Daily tick.** A `StatusScheduler` runs in-process. On startup it computes the next fire time from config (default `08:00` local time) and uses chained `setTimeout`. On startup it checks `router_state.status_last_refresh_ts` — if today's fire window already passed without a refresh (e.g. machine asleep), refresh immediately; otherwise sleep until fire time.

**Refresh flow:**

1. Manager calls `Promise.allSettled(providers.map(p => withTimeout(p.collect(), 5000)))`
2. Failed providers replaced with `{ bucket, title, rows: [], warn: 'collection failed' }`
3. Renderer composes the full message (header with timestamp, each bucket's section)
4. Dispatcher finds the Telegram main group from `registeredGroups`, locates the channel
5. If `router_state.status_pinned_message_id:<jid>` exists → `channel.editMessage(jid, id, text)`
6. If edit throws "message to edit not found" / "message_id is invalid" → fall through to create path
7. Create path: `channel.sendMessageReturningId(jid, text)` → `channel.pinMessage(jid, id)` → persist ID
8. Set `status_last_refresh_ts` regardless of outcome (next refresh tomorrow either way)

**Failure modes:**
- Telegram unreachable → log, skip, retry next day. No queueing — cadence is daily.
- Pinned message deleted/unpinned by user → caught via `not-found`, recreate.
- Provider hangs → 5s per-provider timeout; one slow provider doesn't block others.
- No Telegram main group registered → status disabled; no-op.

**Manual trigger.** `/status` session command in the main group runs an immediate refresh. Single command, single action. Useful for testing and on-demand checks.

## Config (in `src/config.ts`)

- `STATUS_ENABLED` — default `true` if a Telegram main group exists, else `false`.
- `STATUS_REFRESH_HOUR` — default `8`.
- `STATUS_REFRESH_MINUTE` — default `0`.
- Timezone: system local time via `Intl.DateTimeFormat().resolvedOptions().timeZone`.

## Channel interface additions

`Channel` gains three optional methods (same opt-in pattern as `setTyping?`):

```ts
sendMessageReturningId?(jid: string, text: string): Promise<string>;
editMessage?(jid: string, messageId: string, text: string): Promise<void>;
pinMessage?(jid: string, messageId: string): Promise<void>;
```

Only Telegram implements them in v1. The status manager checks `typeof channel.editMessage === 'function'` before activating. Existing `sendMessage` keeps its `void` return — extending it would force every channel to thread IDs.

Telegram errors mapped to recreate-fallback: `message_id is invalid`, `message to edit not found`, `message can't be edited`, `message is not modified` (the last one is silently ignored — text didn't change is fine).

## New persistence

### 1. New `agent_runs` table (in `db.ts`)

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  started_at TEXT NOT NULL,         -- ISO timestamp
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  exit_code INTEGER NOT NULL,
  model TEXT,                       -- env var at spawn time, may be null
  error_class TEXT                  -- 'timeout' | 'crash' | 'spawn_failure' | null
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);
```

Write hook: in `container-runner.ts`, on `container.on('close')`, insert a row. One INSERT per agent invocation.

### 2. New keys in existing `router_state` KV table (no schema change)

- `channel:<name>:last_poll` — written by each channel on successful poll/connect (e.g. `channel:gmail:last_poll`).
- `status_pinned_message_id:<jid>` — set once when the Telegram pinned message is first created.
- `status_last_refresh_ts` — set every successful refresh.

### Deliberately NOT added

- `status_metrics` aggregation table — not needed; metrics derive from existing tables.
- `started_at` row in `router_state` for process uptime — `process.uptime()` is correct semantics.
- Per-channel error tables — deferred to v1.1 with send-failure counters.

## Testing

One test file per module, following the existing `*.test.ts` convention.

| File | Coverage |
|---|---|
| `src/status/manager.test.ts` | Providers run in parallel; one slow provider doesn't block others; failed provider yields `warn` row; message routes to correct channel; edit→create fallback on `not-found` |
| `src/status/scheduler.test.ts` | Next fire time across DST/midnight; backfills if start-of-day fire was missed; respects `STATUS_ENABLED=false`; fires exactly once per day |
| `src/status/providers/channels.test.ts` | Each row reflects `isConnected()`; 24h volume window correct; `router_state` lookup for `last_poll` |
| `src/status/providers/email.test.ts` | Counts JSONL quarantine entries within window; missing file handled; surfaces `errorBucket` counts |
| `src/status/providers/agent-runs.test.ts` | Reads from `agent_runs`; empty-table case; 24h crash aggregation correct; per-group and per-model counts |
| `src/status/providers/model-proxy.test.ts` | Reads `OllamaProxy.getStats()`; renders currentModel / evictions / requests / lastEvictionAt; handles never-evicted case (lastEvictionAt = null) |
| `src/status/providers/scheduled.test.ts` | Active count, next-3 ordering, 24h failures, last success |
| `src/status/providers/system.test.ts` | Uptime/memory/version reflect `process.*`; version cached from `package.json` at construction |
| `src/status/renderers/telegram.test.ts` | Renders fixture contributions to expected text; preserves bucket order; truncates if over 4096 chars (Telegram limit); duration/bytes/relative-time formatting respected |
| `src/status/format.test.ts` | `formatDuration`, `formatRelativeTime`, `formatBytes` boundary cases (0, 1ms, 999ms, 1h, 25h, 30d) |
| `src/status/integration.test.ts` | `:memory:` SQLite, seeded data, full pipeline → asserts pinned message text |

Channel-side: `src/channels/telegram.test.ts` gains tests for `sendMessageReturningId`, `editMessage`, `pinMessage` with mocked Telegraf, including error-mapping to recreate-fallback.

## Rendered example

```
📊 NANOCLAW STATUS · Updated 2026-06-28 08:00 (Europe/Dublin)

📡 Channels & Connections
  Telegram   ✅ Connected · last msg 5m ago · 127 (24h)
  Slack      ✅ Connected · last msg 3d ago · 0 (24h)
  Gmail      ✅ Connected · last poll 8m ago · monitoring
  WhatsApp   ❌ Disconnected · last msg 6h ago

📧 Email Pipeline
  Received (24h)    12
  Status            11 ✅ safe · 1 ⚠️ quarantined
  Classifier        0 errors/1h · 1/3 daily alerts
  Last poll         8m ago

🤖 Agent Runs
  Total (24h)       42 · 38 main · 4 pa_email_processor
  By model (24h)    claude-opus-4-7 38 · gemma4:26b 4
  Last run          3m ago · exit ✓ · 35m 14s
  Session context   ~12.4k tokens
  Crashes (24h)     0

🔀 Model Proxy
  Loaded            gemma4:26b
  Evictions (24h)   2 · last 1h 12m ago
  Requests (24h)    287

⏱ Scheduled Tasks
  Active            7
  Next runs         daily-standup 14:00 · backup-data 22:30 · cleanup 03:00
  Failures (24h)    0
  Last success      2h 15m ago

⚙️ System
  Uptime            12h 34m
  Version           1.2.14 · Node v22.10.0 · darwin
  Memory            85.2 MB
```

## Rollout

1. Land schema + types + format helpers + manager/scheduler scaffold (no providers yet, no scheduler firing).
2. Add providers one at a time, each with its tests.
3. Add Telegram channel methods + their tests.
4. Wire the manager into `index.ts` startup; gate behind `STATUS_ENABLED`.
5. Add `/status` session command.
6. Manually verify in a test Telegram group, then enable for real.
