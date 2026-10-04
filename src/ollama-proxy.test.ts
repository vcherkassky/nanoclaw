import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  IncomingHttpHeaders,
  IncomingMessage,
  request as httpRequest,
  Server,
  ServerResponse,
} from 'http';
import { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OllamaProxy } from './ollama-proxy.js';

interface UpstreamCall {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function listenOn(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function proxyPort(proxy: OllamaProxy): number {
  return ((proxy as any).server.address() as AddressInfo).port;
}

/** Plain node:http client so tests control bytes and headers exactly. */
function rawRequest(
  port: number,
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    // Explicit length: node:http won't chunk a GET/DELETE body by default
    if (opts.body !== undefined) {
      req.setHeader('content-length', Buffer.byteLength(opts.body));
    }
    req.end(opts.body);
  });
}

function postJson(port: number, path: string, body: unknown) {
  return rawRequest(port, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('OllamaProxy (pass-through over a fake upstream)', () => {
  let fakeUpstream: Server;
  let upstreamHost: string;
  let upstreamCalls: UpstreamCall[];
  let upstreamReply: (
    req: IncomingMessage,
    res: ServerResponse,
    call: UpstreamCall,
  ) => void | Promise<void>;
  let proxy: OllamaProxy;
  let port: number;

  beforeEach(async () => {
    upstreamCalls = [];
    upstreamReply = (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    };

    fakeUpstream = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const call: UpstreamCall = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      upstreamCalls.push(call);
      await upstreamReply(req, res, call);
    });
    const upstreamPort = await listenOn(fakeUpstream);
    upstreamHost = `127.0.0.1:${upstreamPort}`;

    // Poller disabled by default so upstreamCalls only shows proxied traffic
    proxy = new OllamaProxy({
      realHost: `http://${upstreamHost}`,
      loadedModelsPollMs: 0,
    });
    await proxy.listen(0);
    port = proxyPort(proxy);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await proxy.close();
    await closeServer(fakeUpstream);
  });

  describe('transport', () => {
    it('forwards method, path, query, headers and body byte-for-byte', async () => {
      // Odd spacing, unicode and a >1 MB payload: must not be re-serialized
      const big = 'x'.repeat(2 * 1024 * 1024);
      const body = Buffer.from(
        `{ "model" :"gemma4:26b",  "prompt": "héllo ✓", "pad": "${big}" }`,
        'utf8',
      );
      upstreamReply = (_req, res) => {
        res.writeHead(201, {
          'content-type': 'application/octet-stream',
          'x-upstream': 'yes',
        });
        res.end(Buffer.from([0, 1, 2, 255, 254, 10, 13]));
      };

      const res = await rawRequest(port, {
        method: 'POST',
        path: '/api/generate?foo=bar&x=%20y',
        headers: {
          'content-type': 'application/json',
          'x-custom': 'abc',
          authorization: 'Bearer t0k',
          connection: 'keep-alive, x-hop',
          'keep-alive': 'timeout=5',
          'x-hop': 'should-not-pass',
        },
        body,
      });

      expect(upstreamCalls).toHaveLength(1);
      const call = upstreamCalls[0];
      expect(call.method).toBe('POST');
      expect(call.url).toBe('/api/generate?foo=bar&x=%20y');
      expect(call.body.equals(body)).toBe(true);
      expect(call.headers['x-custom']).toBe('abc');
      expect(call.headers['authorization']).toBe('Bearer t0k');
      expect(call.headers['content-type']).toBe('application/json');
      expect(call.headers['host']).toBe(upstreamHost);
      expect(call.headers['keep-alive']).toBeUndefined();
      expect(call.headers['x-hop']).toBeUndefined();

      expect(res.status).toBe(201);
      expect(res.headers['x-upstream']).toBe('yes');
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.body.equals(Buffer.from([0, 1, 2, 255, 254, 10, 13]))).toBe(
        true,
      );
    });

    it.each([
      ['GET', '/api/tags'],
      ['DELETE', '/api/delete'],
      ['PUT', '/some/unknown/path?q=1'],
      ['POST', '/metrics'],
    ])('forwards %s %s untouched', async (method, path) => {
      const res = await rawRequest(port, {
        method,
        path,
        body: method === 'GET' ? undefined : '{"model":"m"}',
      });
      expect(res.status).toBe(200);
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0].method).toBe(method);
      expect(upstreamCalls[0].url).toBe(path);
    });

    it('keeps chunked framing for a chunked DELETE body', async () => {
      // node:http doesn't chunk DELETE bodies by default; the proxy must
      // still frame the streamed body for the upstream
      const res = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'DELETE',
            path: '/api/delete',
            headers: { 'transfer-encoding': 'chunked' },
            agent: false,
          },
          (r) => {
            r.resume();
            r.on('end', () => resolve(r.statusCode!));
          },
        );
        req.on('error', reject);
        req.write('{"model":');
        req.end('"old:1b"}');
      });
      expect(res).toBe(200);
      expect(upstreamCalls[0].body.toString()).toBe('{"model":"old:1b"}');
    });

    it('streams NDJSON incrementally (first chunk arrives before upstream finishes)', async () => {
      const release = deferred();
      upstreamReply = async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"done":false,"message":{"content":"a"}}\n');
        await release.promise;
        res.end('{"done":true,"eval_count":2,"prompt_eval_count":1}\n');
      };

      const chunks: string[] = [];
      const done = new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/chat',
            agent: false,
          },
          (res) => {
            res.setEncoding('utf8');
            res.on('data', (c: string) => {
              chunks.push(c);
              if (chunks.length === 1) release.resolve();
            });
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end('{"model":"N"}');
      });
      await done;

      expect(chunks[0]).toBe('{"done":false,"message":{"content":"a"}}\n');
      expect(chunks.join('')).toBe(
        '{"done":false,"message":{"content":"a"}}\n{"done":true,"eval_count":2,"prompt_eval_count":1}\n',
      );
    });

    it('streams SSE incrementally', async () => {
      const release = deferred();
      upstreamReply = async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
        await release.promise;
        res.end('data: [DONE]\n\n');
      };

      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'S', stream: true }),
      });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const reader = res.body!.getReader();
      const first = await reader.read();
      // Upstream has not finished yet: we only release it now
      expect(new TextDecoder().decode(first.value)).toBe(
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      );
      release.resolve();
      let rest = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      expect(rest).toBe('data: [DONE]\n\n');
    });

    it('waits for slow headers with no timeout and without using fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      upstreamReply = async (_req, res) => {
        await new Promise((r) => setTimeout(r, 2000));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"done":true}');
      };

      const res = await postJson(port, '/api/generate', { model: 'slow' });

      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('{"done":true}');
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 10_000);

    it('does not serialize concurrent requests', async () => {
      const release = deferred();
      upstreamReply = async (_req, res) => {
        await release.promise;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      };

      const a = postJson(port, '/api/chat', { model: 'A' });
      const b = postJson(port, '/api/chat', { model: 'B' });

      // Both reach the upstream while the first is still in flight
      await vi.waitFor(() => expect(upstreamCalls).toHaveLength(2));
      release.resolve();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
    });

    it('passes a 404 for an unknown model through and issues no eviction', async () => {
      await postJson(port, '/api/chat', { model: 'A', messages: [] });
      upstreamReply = (_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"model \'nope\' not found"}');
      };

      const res = await postJson(port, '/api/chat', {
        model: 'nope',
        messages: [],
      });

      expect(res.status).toBe(404);
      expect(res.body.toString()).toBe('{"error":"model \'nope\' not found"}');
      // Only the two proxied requests; no keep_alive:0 unload of A
      expect(upstreamCalls.map((c) => c.url)).toEqual([
        '/api/chat',
        '/api/chat',
      ]);
      expect(
        upstreamCalls.some((c) => c.body.toString().includes('keep_alive')),
      ).toBe(false);
      await vi.waitFor(async () =>
        expect(await proxy.metrics.scrape()).toMatch(
          /ollama_proxy_requests_total\{path="\/api\/chat",status="404",model="nope"\} 1/,
        ),
      );
    });
  });

  describe('client disconnects', () => {
    it('cancels the upstream request mid-stream and records 499', async () => {
      const upstreamClosed = deferred();
      upstreamReply = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const timer = setInterval(() => res.write('{"done":false}\n'), 20);
        res.on('close', () => {
          clearInterval(timer);
          upstreamClosed.resolve();
        });
      };

      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/chat',
            agent: false,
          },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on('error', () => {});
        req.end('{"model":"X"}');
        setTimeout(() => reject(new Error('no data')), 2000);
      });

      await upstreamClosed.promise;
      await vi.waitFor(async () =>
        expect(await proxy.metrics.scrape()).toMatch(
          /ollama_proxy_requests_total\{path="\/api\/chat",status="499",model="X"\} 1/,
        ),
      );
      expect(await proxy.metrics.scrape()).not.toContain(
        'ollama_proxy_upstream_errors_total{',
      );
    });

    it('cancels the upstream request while waiting for headers (prefill)', async () => {
      const upstreamClosed = deferred();
      const upstreamGotRequest = deferred();
      upstreamReply = (_req, res) => {
        upstreamGotRequest.resolve();
        // Never answers, like a long prompt prefill
        res.on('close', () => upstreamClosed.resolve());
      };

      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/messages',
        agent: false,
      });
      req.on('error', () => {});
      req.end('{"model":"P"}');
      await upstreamGotRequest.promise;
      req.destroy();

      await upstreamClosed.promise;
      await vi.waitFor(async () =>
        expect(await proxy.metrics.scrape()).toMatch(
          /ollama_proxy_requests_total\{path="\/v1\/messages",status="499",model="P"\} 1/,
        ),
      );
    });
  });

  describe('upstream failures', () => {
    it('replies 502 when the upstream is unreachable', async () => {
      const dead = createHttpServer();
      const deadPort = await listenOn(dead);
      await closeServer(dead);
      const p = new OllamaProxy({
        realHost: `http://127.0.0.1:${deadPort}`,
        loadedModelsPollMs: 0,
      });
      await p.listen(0);
      try {
        const res = await postJson(proxyPort(p), '/api/chat', { model: 'M' });
        expect(res.status).toBe(502);
        expect(JSON.parse(res.body.toString())).toEqual({
          error: 'upstream unreachable',
        });
        const text = await p.metrics.scrape();
        expect(text).toMatch(
          /ollama_proxy_upstream_errors_total\{path="\/api\/chat"\} 1/,
        );
        expect(text).toMatch(
          /ollama_proxy_requests_total\{path="\/api\/chat",status="502",model="M"\} 1/,
        );
      } finally {
        await p.close();
      }
    });

    it('drains a large request body so the 502 arrives cleanly and keep-alive survives', async () => {
      const dead = createHttpServer();
      const deadPort = await listenOn(dead);
      await closeServer(dead);
      const p = new OllamaProxy({
        realHost: `http://127.0.0.1:${deadPort}`,
        loadedModelsPollMs: 0,
      });
      await p.listen(0);
      const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
      const send = (body: Buffer) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port: proxyPort(p),
              method: 'POST',
              path: '/api/chat',
              headers: {
                'content-type': 'application/json',
                'content-length': body.length,
              },
              agent,
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () =>
                resolve({
                  status: res.statusCode!,
                  body: Buffer.concat(chunks).toString(),
                }),
              );
              res.on('error', reject);
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      try {
        const big = Buffer.from(
          `{"model":"M","pad":"${'x'.repeat(20 * 1024 * 1024)}"}`,
        );
        const first = await send(big);
        expect(first.status).toBe(502);
        expect(JSON.parse(first.body)).toEqual({
          error: 'upstream unreachable',
        });

        const t0 = performance.now();
        const second = await send(Buffer.from('{"model":"M"}'));
        expect(second.status).toBe(502);
        expect(performance.now() - t0).toBeLessThan(1000);
      } finally {
        agent.destroy();
        await p.close();
      }
    }, 20_000);

    it('destroys the client response when the upstream dies mid-stream', async () => {
      upstreamReply = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"done":false}\n');
        setTimeout(() => res.socket?.destroy(), 30);
      };

      const outcome = await new Promise<string>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/chat',
            agent: false,
          },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve('end'));
            res.on('error', () => resolve('error'));
            res.on('aborted', () => resolve('error'));
          },
        );
        req.on('error', () => resolve('error'));
        req.end('{"model":"D"}');
      });

      expect(outcome).toBe('error');
      await vi.waitFor(async () =>
        expect(await proxy.metrics.scrape()).toMatch(
          /ollama_proxy_upstream_errors_total\{path="\/api\/chat"\} 1/,
        ),
      );
    });
  });

  describe('metrics', () => {
    it('records token stats from a streamed NDJSON /api/chat', async () => {
      upstreamReply = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"done":false,"message":{"content":"a"}}\n');
        res.write('{"done":true,"prompt_eval_count":11,');
        res.end(
          '"eval_count":22,"eval_duration":2000000000,"load_duration":3000000000,"prompt_eval_duration":500000000}\n',
        );
      };

      await postJson(port, '/api/chat', { model: 'S', stream: true });

      await vi.waitFor(async () => {
        const text = await proxy.metrics.scrape();
        expect(text).toMatch(
          /gen_ai_client_token_usage_sum\{[^}]*gen_ai_request_model="S"[^}]*gen_ai_token_type="input"[^}]*\} 11/,
        );
        expect(text).toMatch(
          /gen_ai_client_token_usage_sum\{[^}]*gen_ai_request_model="S"[^}]*gen_ai_token_type="output"[^}]*\} 22/,
        );
        expect(text).toMatch(/ollama_eval_tokens_per_second_sum\{[^}]*\} 11/);
        expect(text).toMatch(/ollama_load_duration_sum\{[^}]*\} 3/);
        expect(text).toMatch(/ollama_prompt_eval_duration_sum\{[^}]*\} 0\.5/);
        expect(text).toMatch(
          /ollama_proxy_requests_total\{path="\/api\/chat",status="200",model="S"\} 1/,
        );
      });
      expect(proxy.getStats().requests).toBe(1);
    });

    it('records token stats from OpenAI-style SSE', async () => {
      upstreamReply = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
        res.write(
          'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6}}\n\n',
        );
        res.end('data: [DONE]\n\n');
      };

      await postJson(port, '/v1/chat/completions', {
        model: 'O',
        stream: true,
      });

      await vi.waitFor(async () => {
        const text = await proxy.metrics.scrape();
        expect(text).toMatch(
          /gen_ai_client_token_usage_sum\{[^}]*gen_ai_request_model="O"[^}]*gen_ai_token_type="input"[^}]*\} 4/,
        );
        expect(text).toMatch(
          /gen_ai_client_token_usage_sum\{[^}]*gen_ai_request_model="O"[^}]*gen_ai_token_type="output"[^}]*\} 6/,
        );
      });
    });

    it('records token stats from Anthropic-style SSE on /v1/messages', async () => {
      const events = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hey"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":5,"cache_read_input_tokens":12,"output_tokens":16}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      upstreamReply = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of events) res.write(e);
        res.end();
      };

      const res = await postJson(port, '/v1/messages', {
        model: 'G',
        max_tokens: 16,
        stream: true,
      });
      expect(res.body.toString()).toBe(events.join(''));

      await vi.waitFor(async () => {
        const text = await proxy.metrics.scrape();
        expect(text).toMatch(
          /gen_ai_client_token_usage_sum\{[^}]*gen_ai_token_type="input"[^}]*\} 17/,
        );
        expect(text).toMatch(
          /gen_ai_client_token_usage_sum\{[^}]*gen_ai_token_type="output"[^}]*\} 16/,
        );
      });
    });

    it('records token stats from a plain (non-streamed) JSON response', async () => {
      upstreamReply = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            done: true,
            response: 'hi',
            prompt_eval_count: 30,
            eval_count: 12,
            load_duration: 4_000_000_000,
          }),
        );
      };

      await postJson(port, '/api/generate', { model: 'J', stream: false });

      await vi.waitFor(async () => {
        const text = await proxy.metrics.scrape();
        expect(text).toMatch(
          /gen_ai_client_token_usage_sum\{[^}]*gen_ai_request_model="J"[^}]*gen_ai_token_type="input"[^}]*\} 30/,
        );
        expect(text).toMatch(/ollama_load_duration_sum\{[^}]*\} 4/);
      });
    });

    it('does not record token stats for non-2xx responses', async () => {
      upstreamReply = (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom","eval_count":5,"prompt_eval_count":5}');
      };
      await postJson(port, '/api/chat', { model: 'E' });
      await vi.waitFor(async () =>
        expect(await proxy.metrics.scrape()).toMatch(
          /ollama_proxy_requests_total\{path="\/api\/chat",status="500",model="E"\} 1/,
        ),
      );
      expect(await proxy.metrics.scrape()).not.toContain(
        'gen_ai_client_token_usage_sum{',
      );
    });

    it('records time to first byte, labelled by path and model', async () => {
      upstreamReply = async (_req, res) => {
        await new Promise((r) => setTimeout(r, 150));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {}\n\n');
      };

      await postJson(port, '/v1/messages', { model: 'T', stream: true });

      await vi.waitFor(async () => {
        const text = await proxy.metrics.scrape();
        const m = text.match(
          /ollama_proxy_time_to_first_byte_sum\{path="\/v1\/messages",model="T"\} ([\d.e+-]+)/,
        );
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBeGreaterThanOrEqual(0.14);
        expect(Number(m![1])).toBeLessThan(5);
      });
    });

    it('serves GET and HEAD /metrics locally without forwarding', async () => {
      await postJson(port, '/api/chat', { model: 'X' });
      upstreamCalls = [];

      const res = await rawRequest(port, { path: '/metrics' });
      const head = await rawRequest(port, { method: 'HEAD', path: '/metrics' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.body.toString()).toMatch(
        /ollama_proxy_requests_total\{[^}]*path="\/api\/chat"[^}]*\} 1/,
      );
      // Scrapes are not counted as proxied requests
      expect(res.body.toString()).not.toMatch(/path="\/metrics"/);
      expect(head.status).toBe(200);
      expect(upstreamCalls).toHaveLength(0);
    });
  });

  describe('loaded-models poller', () => {
    it('polls /api/ps and feeds the gauge and getStats()', async () => {
      let psBody: string = JSON.stringify({
        models: [{ name: 'gemma4:26b' }, { name: 'nomic-embed-text:latest' }],
      });
      let psStatus = 200;
      upstreamReply = (req, res) => {
        if (req.url === '/api/ps') {
          res.writeHead(psStatus, { 'content-type': 'application/json' });
          res.end(psBody);
          return;
        }
        res.writeHead(200);
        res.end('{}');
      };

      const p = new OllamaProxy({
        realHost: `http://${upstreamHost}`,
        loadedModelsPollMs: 30,
      });
      expect(p.getStats()).toEqual({ loadedModels: [], requests: 0 });
      await p.listen(0);
      try {
        await vi.waitFor(() =>
          expect(p.getStats().loadedModels).toEqual([
            'gemma4:26b',
            'nomic-embed-text:latest',
          ]),
        );
        const text = await p.metrics.scrape();
        expect(text).toMatch(/ollama_loaded_models\{model="gemma4:26b"\} 1/);
        expect(text).toMatch(
          /ollama_loaded_models\{model="nomic-embed-text:latest"\} 1/,
        );

        // Failures keep the last known value
        psStatus = 500;
        psBody = 'oops';
        const before = upstreamCalls.length;
        await vi.waitFor(() =>
          expect(upstreamCalls.length).toBeGreaterThan(before + 1),
        );
        expect(p.getStats().loadedModels).toEqual([
          'gemma4:26b',
          'nomic-embed-text:latest',
        ]);

        psStatus = 200;
        psBody = JSON.stringify({ models: [] });
        await vi.waitFor(() => expect(p.getStats().loadedModels).toEqual([]));
        expect(await p.metrics.scrape()).not.toMatch(
          /ollama_loaded_models\{[^}]*\} 1/,
        );
      } finally {
        await p.close();
      }

      // close() stops the poller
      const after = upstreamCalls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(upstreamCalls.length).toBe(after);
    });
  });
});
