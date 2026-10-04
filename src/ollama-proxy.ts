/**
 * Local HTTP proxy in front of Ollama: a passive, streaming pass-through
 * that exists to observe traffic for metrics.
 *
 * Every request (any method, path and query) is forwarded with node:http,
 * minus hop-by-hop headers, and the upstream response is piped back as it
 * arrives. The proxy adds no queueing, no model eviction and no timeouts:
 * Ollama schedules and evicts models itself, and a cold long prompt can
 * take more than five minutes before Ollama sends its first header byte.
 *
 * If the client goes away before the response finishes, the upstream
 * request is destroyed so Ollama cancels the generation.
 *
 * Metrics come from a passive tap on the response body (token usage and
 * timings via StreamStatsTail), plus a poll of GET /api/ps for the models
 * Ollama currently has loaded. GET/HEAD /metrics serves them in Prometheus
 * format (see ollama-metrics.ts) and is never forwarded.
 */
import {
  Agent,
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  request as httpRequest,
  Server,
  ServerResponse,
} from 'http';
import { pipeline, Transform } from 'stream';

import { logger } from './logger.js';
import { OllamaMetrics, StreamStatsTail } from './ollama-metrics.js';

export interface OllamaProxyOptions {
  realHost: string;
  /** How often to poll upstream /api/ps for loaded models; 0 disables. */
  loadedModelsPollMs?: number;
}

const METRICS_PATH = '/metrics';
const DEFAULT_LOADED_MODELS_POLL_MS = 15_000;
// Only the poller has a timeout; proxied requests never do
const LOADED_MODELS_POLL_TIMEOUT_MS = 10_000;
// Request bodies are buffered (alongside streaming) only to read the
// `model` field for metric labels; give up on anything larger.
const MAX_MODEL_PEEK_BYTES = 32 * 1024 * 1024;

// Responses on these paths carry token counts / timings worth tapping
const INFERENCE_PATHS = new Set([
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/messages',
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function secondsSince(start: number): number {
  return (performance.now() - start) / 1000;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Copy headers minus hop-by-hop ones, including any named in Connection. */
function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function modelFromBody(chunks: Buffer[]): string | undefined {
  if (chunks.length === 0) return undefined;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      model?: unknown;
    };
    return typeof body?.model === 'string' ? body.model : undefined;
  } catch {
    return undefined;
  }
}

export class OllamaProxy {
  private upstream: URL;
  // No keep-alive: a fresh localhost connection costs nothing next to an
  // inference request, and it rules out reusing a socket Ollama just closed
  private agent = new Agent({ keepAlive: false });
  private loadedModelsPollMs: number;
  private loadedModels: string[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private poll: Promise<void> | null = null;
  private requestCount = 0;
  private server: Server | null = null;
  readonly metrics: OllamaMetrics;

  constructor(opts: OllamaProxyOptions) {
    this.upstream = new URL(opts.realHost);
    if (this.upstream.protocol !== 'http:') {
      throw new Error(
        `OllamaProxy: only http:// upstreams are supported (got ${opts.realHost})`,
      );
    }
    this.loadedModelsPollMs =
      opts.loadedModelsPollMs ?? DEFAULT_LOADED_MODELS_POLL_MS;
    this.metrics = new OllamaMetrics({
      getLoadedModels: () => this.loadedModels,
    });
  }

  getStats(): { loadedModels: string[]; requests: number } {
    return {
      loadedModels: [...this.loadedModels],
      requests: this.requestCount,
    };
  }

  async listen(port: number): Promise<void> {
    if (this.server) throw new Error('OllamaProxy already listening');

    const server = createServer((req, res) => this.handleRequest(req, res));
    // Node's default 300 s requestTimeout must not apply to a proxy
    server.requestTimeout = 0;
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        logger.info({ port }, 'OllamaProxy listening');
        resolve();
      });
    });

    if (this.loadedModelsPollMs > 0) {
      void this.refreshLoadedModels();
      this.pollTimer = setInterval(
        () => void this.refreshLoadedModels(),
        this.loadedModelsPollMs,
      );
      this.pollTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Let an in-flight poll settle (bounded by its own timeout)
    await this.poll;
    const server = this.server;
    if (server) {
      this.server = null;
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      // Don't let a long in-flight generation hold up shutdown
      server.closeAllConnections();
      await closed;
    }
    this.agent.destroy();
  }

  /**
   * Poll upstream GET /api/ps and remember which models are loaded. On any
   * failure the last known value is kept. Concurrent calls share one poll.
   */
  refreshLoadedModels(): Promise<void> {
    this.poll ??= this.pollLoadedModels().finally(() => {
      this.poll = null;
    });
    return this.poll;
  }

  private async pollLoadedModels(): Promise<void> {
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: this.upstream.hostname,
            port: this.upstream.port || 80,
            method: 'GET',
            path: '/api/ps',
            agent: this.agent,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('error', reject);
            res.on('end', () => {
              if (res.statusCode !== 200) {
                reject(new Error(`/api/ps returned ${res.statusCode}`));
              } else {
                resolve(Buffer.concat(chunks).toString('utf8'));
              }
            });
          },
        );
        req.setTimeout(LOADED_MODELS_POLL_TIMEOUT_MS, () =>
          req.destroy(new Error('/api/ps timed out')),
        );
        req.on('error', reject);
        req.end();
      });
      const data = JSON.parse(body) as {
        models?: Array<{ name?: unknown; model?: unknown }>;
      };
      this.loadedModels = (data.models ?? [])
        .map((m) => m.name ?? m.model)
        .filter((m): m is string => typeof m === 'string');
    } catch (err) {
      logger.debug(
        { err: errMessage(err) },
        'OllamaProxy: /api/ps poll failed (keeping last value)',
      );
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const start = performance.now();
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if ((method === 'GET' || method === 'HEAD') && path === METRICS_PATH) {
      this.metrics.handleScrape(req, res);
      return;
    }

    this.requestCount++;

    let model: string | undefined;
    let status = 502;
    let tail: StreamStatsTail | null = null;
    let clientGone = false;
    let upstreamFailed = false;
    let recorded = false;

    const record = (finalStatus: number) => {
      if (recorded) return;
      recorded = true;
      this.metrics.recordRequest(
        { path, model, status: finalStatus },
        secondsSince(start),
      );
      const stats = tail?.finish();
      if (stats && finalStatus >= 200 && finalStatus < 300) {
        this.metrics.recordInference(model ?? 'unknown', stats);
      }
    };

    const headers = endToEndHeaders(req.headers);
    headers.host = this.upstream.host;
    // Transfer-Encoding is hop-by-hop, but a chunked inbound body is still
    // streamed without a length; node:http only chunks POST/PUT/PATCH by
    // default, so ask for chunked framing explicitly.
    if (req.headers['transfer-encoding'] && !req.headers['content-length']) {
      headers['transfer-encoding'] = 'chunked';
    }

    const upstreamReq = httpRequest({
      hostname: this.upstream.hostname,
      port: this.upstream.port || 80,
      method,
      path: url,
      headers,
      agent: this.agent,
    });

    const onUpstreamError = (err: unknown) => {
      if (clientGone || upstreamFailed) return;
      upstreamFailed = true;
      this.metrics.recordUpstreamError(path);
      logger.warn(
        { path, model, err: errMessage(err) },
        'OllamaProxy: upstream request failed',
      );
      if (!res.headersSent) {
        // Keep reading (and discarding) the rest of the client's body: if it
        // backs up, a large POST gets EPIPE instead of the 502 and the
        // keep-alive connection stalls.
        modelPeek.unpipe(upstreamReq);
        modelPeek.resume();
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream unreachable' }));
      } else {
        res.destroy();
      }
      record(502);
    };

    // Client went away before the response finished (killed container,
    // classifier timeout): cancel upstream so Ollama stops the work.
    res.on('close', () => {
      if (res.writableFinished || upstreamFailed) return;
      clientGone = true;
      upstreamReq.destroy();
      logger.info(
        { path, model },
        'OllamaProxy: client disconnected, upstream request cancelled',
      );
      // 499 = client closed request (nginx convention)
      record(499);
    });

    upstreamReq.on('error', onUpstreamError);

    upstreamReq.on('response', (upstreamRes) => {
      this.metrics.recordTimeToFirstByte({ path, model }, secondsSince(start));
      status = upstreamRes.statusCode ?? 502;
      if (clientGone) {
        upstreamRes.destroy();
        return;
      }
      upstreamRes.on('error', onUpstreamError);
      upstreamRes.on('aborted', () =>
        onUpstreamError(new Error('upstream response aborted')),
      );

      if (status >= 200 && status < 300 && INFERENCE_PATHS.has(path)) {
        tail = new StreamStatsTail();
      }
      const statsTap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          tail?.push(chunk);
          cb(null, chunk);
        },
      });

      res.writeHead(status, endToEndHeaders(upstreamRes.headers));
      pipeline(upstreamRes, statsTap, res, (err) => {
        if (!err) record(status);
        else onUpstreamError(err);
      });
    });

    // Stream the body upstream unchanged, keeping a copy to read `model`.
    // Not pipeline(): an upstream error must not destroy the client socket
    // before the 502 is written. A client abort is handled by res 'close'.
    const bodyCopy: Buffer[] = [];
    let copied = 0;
    const modelPeek = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        copied += chunk.length;
        if (copied <= MAX_MODEL_PEEK_BYTES) bodyCopy.push(chunk);
        cb(null, chunk);
      },
      flush(cb) {
        if (copied <= MAX_MODEL_PEEK_BYTES) model = modelFromBody(bodyCopy);
        bodyCopy.length = 0;
        cb();
      },
    });
    req.pipe(modelPeek).pipe(upstreamReq);
  }
}
