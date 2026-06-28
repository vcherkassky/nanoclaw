/**
 * Local HTTP proxy in front of Ollama that enforces a single loaded model.
 *
 * Inbound requests are queued through a FIFO async mutex. When a request
 * targets a different model than the currently loaded one, the proxy first
 * fires an eviction (POST /api/generate with keep_alive: 0) for the old
 * model, then forwards the new request. This eliminates the back-to-back
 * model-load race that makes Ollama hang under memory pressure.
 *
 * Read-only / non-loading endpoints (/api/tags, /api/ps, /api/show,
 * /api/version) bypass the lock entirely. Streaming is preserved by piping
 * the upstream response body directly to the client.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { logger } from './logger.js';

export interface ProxyRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export interface ProxyResponse {
  status: number;
  body?: unknown;
}

export interface OllamaProxyOptions {
  realHost: string;
  fetchFn?: typeof fetch;
}

const MODEL_LOADING_PATHS = new Set([
  '/api/chat',
  '/api/generate',
  '/api/embeddings',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
]);

class AsyncMutex {
  private chain: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn());
    // Swallow errors on the chain so a thrown task doesn't deadlock future ones
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export class OllamaProxy {
  private realHost: string;
  private fetchFn: typeof fetch;
  private currentModel: string | null = null;
  private evictionCount = 0;
  private requestCount = 0;
  private lastEvictionAt: string | null = null;
  private mutex = new AsyncMutex();
  private server: Server | null = null;

  constructor(opts: OllamaProxyOptions) {
    this.realHost = opts.realHost.replace(/\/$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  getCurrentModel(): string | null {
    return this.currentModel;
  }

  getStats(): {
    currentModel: string | null;
    evictions: number;
    requests: number;
    lastEvictionAt: string | null;
  } {
    return {
      currentModel: this.currentModel,
      evictions: this.evictionCount,
      requests: this.requestCount,
      lastEvictionAt: this.lastEvictionAt,
    };
  }

  /**
   * Reconcile in-memory state with the upstream's actual loaded models.
   * Call once at startup so a NanoClaw restart doesn't incorrectly think
   * "no model is loaded" when Ollama still has one warm.
   */
  async syncCurrentModel(): Promise<void> {
    try {
      const res = await this.fetchFn(`${this.realHost}/api/ps`, {
        method: 'GET',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const loaded = data.models?.[0]?.name ?? null;
      this.currentModel = loaded;
      if (loaded) {
        logger.info({ model: loaded }, 'OllamaProxy: synced existing model');
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'OllamaProxy: /api/ps sync failed (continuing with null)',
      );
    }
  }

  async handle(req: ProxyRequest): Promise<ProxyResponse> {
    this.requestCount++;
    if (!MODEL_LOADING_PATHS.has(req.path)) {
      return this.forward(req);
    }

    const requested = (req.body?.model as string | undefined) ?? null;
    if (!requested) {
      return { status: 400, body: { error: 'missing model field' } };
    }

    return this.mutex.runExclusive(async () => {
      if (this.currentModel && this.currentModel !== requested) {
        await this.evict(this.currentModel);
      }

      const response = await this.forward(req);

      // Update state based on outcome
      if (response.status === 502) {
        // Upstream broke — we don't actually know what's loaded; safer null
        this.currentModel = null;
      } else if (req.body?.keep_alive === 0 && req.path === '/api/generate') {
        // User-initiated unload
        this.currentModel = null;
      } else {
        // Optimistic: assume the model was loaded even on non-2xx, since
        // Ollama may have loaded it before erroring on the request itself.
        this.currentModel = requested;
      }

      return response;
    });
  }

  private async evict(model: string): Promise<void> {
    this.evictionCount++;
    this.lastEvictionAt = new Date().toISOString();
    logger.info({ model }, 'OllamaProxy: evicting model before swap');
    try {
      await this.fetchFn(`${this.realHost}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
    } catch (err) {
      logger.warn(
        { model, err: err instanceof Error ? err.message : String(err) },
        'OllamaProxy: eviction request failed (continuing)',
      );
    }
    this.currentModel = null;
  }

  private async forward(req: ProxyRequest): Promise<ProxyResponse> {
    const url = `${this.realHost}${req.path}`;
    try {
      const init: RequestInit = { method: req.method };
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
        init.headers = { 'Content-Type': 'application/json' };
      }
      const res = await this.fetchFn(url, init);
      const body = await res.json().catch(() => undefined);
      return { status: res.status, body };
    } catch (err) {
      logger.warn(
        {
          path: req.path,
          err: err instanceof Error ? err.message : String(err),
        },
        'OllamaProxy: upstream fetch failed',
      );
      return { status: 502, body: { error: 'upstream unreachable' } };
    }
  }

  /**
   * Boot an HTTP listener that adapts incoming requests into handle() calls.
   * Streaming responses (Ollama's NDJSON or SSE) are piped through verbatim.
   */
  async listen(port: number): Promise<void> {
    if (this.server) throw new Error('OllamaProxy already listening');

    this.server = createServer((req, res) =>
      this.httpHandler(req, res).catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'OllamaProxy: unhandled error in HTTP handler',
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'proxy internal error' }));
        }
      }),
    );

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        logger.info({ port }, 'OllamaProxy listening');
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async httpHandler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];

    // For model-loading paths we need to peek at the JSON body to read the
    // model field. For passthrough paths we could stream-forward, but
    // buffering is fine — Ollama request bodies are small.
    const body = await this.readJsonBody(req);

    if (MODEL_LOADING_PATHS.has(path) || method === 'GET') {
      // For pass-through GETs we can use handle() (the upstream returns JSON
      // for /api/tags, /api/ps, /api/show, /api/version — all small bodies).
      if (!MODEL_LOADING_PATHS.has(path)) {
        const result = await this.handle({ method, path, body });
        res.statusCode = result.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result.body ?? null));
        return;
      }

      // For model-loading paths we stream upstream straight back so SSE
      // (stream: true) flows token-by-token. We still acquire the lock
      // around model swap.
      await this.mutex.runExclusive(async () => {
        const requested = body?.model as string | undefined;
        if (!requested) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'missing model field' }));
          return;
        }

        if (this.currentModel && this.currentModel !== requested) {
          await this.evict(this.currentModel);
        }

        try {
          const upstream = await this.fetchFn(`${this.realHost}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          res.statusCode = upstream.status;
          upstream.headers.forEach((v, k) => {
            // Skip hop-by-hop and length headers since we stream
            if (
              k === 'transfer-encoding' ||
              k === 'connection' ||
              k === 'content-length'
            ) {
              return;
            }
            res.setHeader(k, v);
          });

          if (upstream.body) {
            const reader = upstream.body.getReader();
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) res.write(Buffer.from(value));
              }
            } finally {
              reader.releaseLock();
            }
          }
          res.end();

          if (body?.keep_alive === 0 && path === '/api/generate') {
            this.currentModel = null;
          } else if (upstream.status !== 502) {
            this.currentModel = requested;
          } else {
            this.currentModel = null;
          }
        } catch (err) {
          logger.warn(
            {
              path,
              err: err instanceof Error ? err.message : String(err),
            },
            'OllamaProxy: streaming forward failed',
          );
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'upstream unreachable' }));
          } else {
            res.end();
          }
          this.currentModel = null;
        }
      });
      return;
    }

    // Other methods: pure pass-through
    const result = await this.handle({ method, path, body });
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body ?? null));
  }

  private async readJsonBody(
    req: IncomingMessage,
  ): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}
