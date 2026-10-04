/**
 * OpenTelemetry metrics for the Ollama proxy, exposed in Prometheus text
 * format via the proxy's own GET /metrics route (no extra port).
 *
 * Two families:
 *  - proxy behaviour: request counts/latency, time to first byte,
 *    upstream errors, models loaded in Ollama (polled from /api/ps)
 *  - inference stats parsed from Ollama's responses: token usage
 *    (GenAI semantic conventions), tokens/sec, load and prompt-eval time
 */
import type { IncomingMessage, ServerResponse } from 'http';

import type { Attributes, Counter, Histogram } from '@opentelemetry/api';
import {
  PrometheusExporter,
  PrometheusSerializer,
} from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

export interface InferenceStats {
  inputTokens?: number;
  outputTokens?: number;
  loadSeconds?: number;
  promptEvalSeconds?: number;
  evalSeconds?: number;
}

export interface RequestLabels {
  path: string;
  model?: string;
  status: number;
}

export interface TimeToFirstByteLabels {
  path: string;
  model?: string;
}

const SECONDS_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
  600, 1200,
];
const TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144];
const TPS_BUCKETS = [1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300];

const NS_PER_S = 1e9;

// Known Ollama endpoints; anything else is labelled "other" so arbitrary
// URLs can't create unbounded metric series.
const KNOWN_PATHS = new Set([
  '/',
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
  '/api/tags',
  '/api/ps',
  '/api/show',
  '/api/version',
  '/api/pull',
  '/api/push',
  '/api/create',
  '/api/copy',
  '/api/delete',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/models',
  '/v1/messages',
]);

export function pathLabel(path: string): string {
  return KNOWN_PATHS.has(path) ? path : 'other';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Pull token counts and timings out of an Ollama response object. Handles
 * native /api/* responses (durations in ns), OpenAI-compatible /v1/*
 * responses and Anthropic-compatible /v1/messages responses (`usage` block,
 * no timings). Returns null if nothing is present.
 */
export function extractInferenceStats(obj: unknown): InferenceStats | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const stats: InferenceStats = {};

  // Anthropic message_start nests usage under `message`
  const message = o.message as Record<string, unknown> | undefined;
  const usage = (o.usage ?? message?.usage) as
    | Record<string, unknown>
    | undefined;
  if (usage && typeof usage === 'object') {
    if ('input_tokens' in usage || 'output_tokens' in usage) {
      // Anthropic: input_tokens excludes cache reads/writes; count them all
      const input = num(usage.input_tokens);
      stats.inputTokens =
        input === undefined
          ? undefined
          : input +
            (num(usage.cache_read_input_tokens) ?? 0) +
            (num(usage.cache_creation_input_tokens) ?? 0);
      stats.outputTokens = num(usage.output_tokens);
    } else {
      stats.inputTokens = num(usage.prompt_tokens);
      stats.outputTokens = num(usage.completion_tokens);
    }
  } else {
    stats.inputTokens = num(o.prompt_eval_count);
    stats.outputTokens = num(o.eval_count);
    const load = num(o.load_duration);
    const promptEval = num(o.prompt_eval_duration);
    const evalD = num(o.eval_duration);
    if (load !== undefined) stats.loadSeconds = load / NS_PER_S;
    if (promptEval !== undefined)
      stats.promptEvalSeconds = promptEval / NS_PER_S;
    if (evalD !== undefined) stats.evalSeconds = evalD / NS_PER_S;
  }

  for (const k of Object.keys(stats) as (keyof InferenceStats)[]) {
    if (stats[k] === undefined) delete stats[k];
  }
  return Object.keys(stats).length > 0 ? stats : null;
}

/**
 * Watches a streamed NDJSON or SSE body for the lines carrying stats,
 * without buffering the whole stream. Fields are merged across lines with
 * later values winning, since Anthropic streams split usage between
 * message_start (input) and message_delta (output). Only lines that mention a stats field
 * are JSON-parsed, so per-token chunks cost a substring check.
 */
export class StreamStatsTail {
  private decoder = new TextDecoder();
  private partial = '';
  private last: InferenceStats | null = null;

  push(chunk: Uint8Array): void {
    this.partial += this.decoder.decode(chunk, { stream: true });
    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.consider(line);
  }

  finish(): InferenceStats | null {
    this.partial += this.decoder.decode();
    this.consider(this.partial);
    this.partial = '';
    return this.last;
  }

  private consider(raw: string): void {
    let line = raw.trim();
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line.includes('eval_count') && !line.includes('"usage"')) return;
    try {
      const stats = extractInferenceStats(JSON.parse(line));
      if (stats) this.last = { ...this.last, ...stats };
    } catch {
      // Not JSON (or truncated) — ignore
    }
  }
}

export interface OllamaMetricsOptions {
  /** Models Ollama currently has loaded (last /api/ps poll). */
  getLoadedModels: () => readonly string[];
}

export class OllamaMetrics {
  private exporter: PrometheusExporter;
  private provider: MeterProvider;
  // Single meter, so the otel_scope_* labels add nothing but noise
  private serializer = new PrometheusSerializer(
    undefined,
    false,
    undefined,
    false,
    true,
  );

  private requests: Counter;
  private requestDuration: Histogram;
  private timeToFirstByte: Histogram;
  private upstreamErrors: Counter;
  private tokenUsage: Histogram;
  private tokensPerSecond: Histogram;
  private loadDuration: Histogram;
  private promptEvalDuration: Histogram;

  constructor(opts: OllamaMetricsOptions) {
    this.exporter = new PrometheusExporter({
      preventServerStart: true,
      withoutScopeInfo: true,
    });
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({
        'service.name': 'nanoclaw-ollama-proxy',
      }),
      readers: [this.exporter],
    });
    const meter = this.provider.getMeter('nanoclaw.ollama-proxy');

    this.requests = meter.createCounter('ollama_proxy.requests', {
      description: 'Requests handled by the Ollama proxy',
    });
    this.requestDuration = meter.createHistogram(
      'ollama_proxy.request.duration',
      {
        description: 'End-to-end request duration through the proxy',
        unit: 's',
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      },
    );
    this.timeToFirstByte = meter.createHistogram(
      'ollama_proxy.time_to_first_byte',
      {
        description:
          'Time from receiving a request to the first upstream response byte (includes prompt prefill)',
        unit: 's',
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      },
    );
    this.upstreamErrors = meter.createCounter('ollama_proxy.upstream.errors', {
      description: 'Requests where the upstream Ollama was unreachable',
    });
    // The SDK keeps exporting a series' last value once it has been
    // observed, so models that were loaded before are reported as 0 rather
    // than silently left at 1.
    const seenModels = new Set<string>();
    meter
      .createObservableGauge('ollama.loaded_models', {
        description:
          'Models loaded in Ollama per /api/ps (1 = loaded, 0 = loaded earlier)',
      })
      .addCallback((result) => {
        const loaded = new Set(opts.getLoadedModels());
        for (const model of loaded) seenModels.add(model);
        for (const model of seenModels) {
          result.observe(loaded.has(model) ? 1 : 0, { model });
        }
      });

    this.tokenUsage = meter.createHistogram('gen_ai.client.token.usage', {
      description: 'Tokens per request, by gen_ai.token.type',
      unit: '{token}',
      advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
    });
    this.tokensPerSecond = meter.createHistogram(
      'ollama.eval.tokens_per_second',
      {
        description: 'Generation throughput (eval_count / eval_duration)',
        unit: '{token}/s',
        advice: { explicitBucketBoundaries: TPS_BUCKETS },
      },
    );
    this.loadDuration = meter.createHistogram('ollama.load.duration', {
      description: 'Model load time reported by Ollama',
      unit: 's',
      advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
    });
    this.promptEvalDuration = meter.createHistogram(
      'ollama.prompt_eval.duration',
      {
        description: 'Prompt evaluation time reported by Ollama',
        unit: 's',
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      },
    );
  }

  recordRequest(labels: RequestLabels, durationSeconds: number): void {
    const attrs: Attributes = {
      path: pathLabel(labels.path),
      status: labels.status,
    };
    if (labels.model) attrs.model = labels.model;
    this.requests.add(1, attrs);
    this.requestDuration.record(durationSeconds, attrs);
  }

  recordTimeToFirstByte(labels: TimeToFirstByteLabels, seconds: number): void {
    const attrs: Attributes = { path: pathLabel(labels.path) };
    if (labels.model) attrs.model = labels.model;
    this.timeToFirstByte.record(seconds, attrs);
  }

  recordUpstreamError(path: string): void {
    this.upstreamErrors.add(1, { path: pathLabel(path) });
  }

  recordInference(model: string, stats: InferenceStats): void {
    const base = { 'gen_ai.system': 'ollama', 'gen_ai.request.model': model };
    if (stats.inputTokens !== undefined) {
      this.tokenUsage.record(stats.inputTokens, {
        ...base,
        'gen_ai.token.type': 'input',
      });
    }
    if (stats.outputTokens !== undefined) {
      this.tokenUsage.record(stats.outputTokens, {
        ...base,
        'gen_ai.token.type': 'output',
      });
      if (stats.evalSeconds) {
        this.tokensPerSecond.record(
          stats.outputTokens / stats.evalSeconds,
          base,
        );
      }
    }
    if (stats.loadSeconds !== undefined) {
      this.loadDuration.record(stats.loadSeconds, base);
    }
    if (stats.promptEvalSeconds !== undefined) {
      this.promptEvalDuration.record(stats.promptEvalSeconds, base);
    }
  }

  /** Serve a Prometheus scrape. */
  handleScrape(req: IncomingMessage, res: ServerResponse): void {
    this.exporter.getMetricsRequestHandler(req, res);
  }

  /** Current metrics as Prometheus text (used by tests). */
  async scrape(): Promise<string> {
    const { resourceMetrics } = await this.exporter.collect();
    return this.serializer.serialize(resourceMetrics);
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}
