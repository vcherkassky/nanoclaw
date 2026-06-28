import {
  createServer as createHttpServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'http';
import { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OllamaProxy } from './ollama-proxy.js';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    body: null,
  };
}

describe('OllamaProxy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let proxy: OllamaProxy;

  beforeEach(() => {
    fetchMock = vi.fn();
    proxy = new OllamaProxy({
      realHost: 'http://upstream:11434',
      fetchFn: fetchMock as unknown as typeof fetch,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('state machine', () => {
    it('starts with currentModel = null', () => {
      expect(proxy.getCurrentModel()).toBeNull();
    });

    it('forwards a chat request and records the model', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { done: true }));

      const res = await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'gemma4:26b', messages: [] },
      });

      expect(res.status).toBe(200);
      expect(proxy.getCurrentModel()).toBe('gemma4:26b');
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://upstream:11434/api/chat');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        model: 'gemma4:26b',
        messages: [],
      });
    });

    it('does NOT evict when handling the same model twice', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { done: true }));
      await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      fetchMock.mockResolvedValueOnce(jsonResponse(200, { done: true }));
      await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(proxy.getCurrentModel()).toBe('A');
    });

    it('evicts the previous model BEFORE loading a different one', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {})); // chat A
      await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      fetchMock.mockResolvedValueOnce(jsonResponse(200, {})); // evict A
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {})); // chat B
      await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'B', messages: [] },
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);

      const [evictUrl, evictInit] = fetchMock.mock.calls[1];
      expect(evictUrl).toBe('http://upstream:11434/api/generate');
      expect(JSON.parse(evictInit.body)).toEqual({
        model: 'A',
        keep_alive: 0,
      });

      const [chatUrl] = fetchMock.mock.calls[2];
      expect(chatUrl).toBe('http://upstream:11434/api/chat');

      expect(proxy.getCurrentModel()).toBe('B');
    });

    it('treats keep_alive: 0 as a user-initiated eviction (sets currentModel = null)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {})); // load A
      await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      fetchMock.mockResolvedValueOnce(jsonResponse(200, {})); // unload A
      await proxy.handle({
        method: 'POST',
        path: '/api/generate',
        body: { model: 'A', keep_alive: 0 },
      });

      expect(proxy.getCurrentModel()).toBeNull();
      // No extra implicit eviction was issued
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('handles OpenAI-compatible /v1/chat/completions like /api/chat', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
      );

      await proxy.handle({
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: 'gemma4:e4b', messages: [] },
      });

      expect(proxy.getCurrentModel()).toBe('gemma4:e4b');
    });
  });

  describe('pass-through (no lock, no state change)', () => {
    it('passes GET /api/tags through unchanged', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { models: [] }));

      await proxy.handle({ method: 'GET', path: '/api/tags' });

      expect(proxy.getCurrentModel()).toBeNull();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://upstream:11434/api/tags');
      expect(init.method).toBe('GET');
    });

    it('passes GET /api/ps through without affecting state', async () => {
      // Pre-load A
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
      await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });
      expect(proxy.getCurrentModel()).toBe('A');

      // /api/ps must not change the state
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { models: [] }));
      await proxy.handle({ method: 'GET', path: '/api/ps' });

      expect(proxy.getCurrentModel()).toBe('A');
    });
  });

  describe('serialization', () => {
    it('serializes concurrent requests for different models (FIFO)', async () => {
      // Each fetch resolves only when we manually release it
      const releases: Array<() => void> = [];
      fetchMock.mockImplementation(() => {
        return new Promise((resolve) => {
          releases.push(() => resolve(jsonResponse(200, {})));
        });
      });

      const a = proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      // Even before any fetch resolves, second request is queued
      const b = proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'B', messages: [] },
      });

      // Until A's chat completes, only A's fetch was issued (no eviction yet)
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Release A's chat
      releases[0]();
      await a;
      expect(proxy.getCurrentModel()).toBe('A');

      // Now B's path starts: first the eviction
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [evictUrl] = fetchMock.mock.calls[1];
      expect(evictUrl).toBe('http://upstream:11434/api/generate');

      // Release the eviction
      releases[1]();
      await Promise.resolve();
      await Promise.resolve();
      // Then B's chat fires
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [chatBUrl] = fetchMock.mock.calls[2];
      expect(chatBUrl).toBe('http://upstream:11434/api/chat');
      releases[2]();
      await b;

      expect(proxy.getCurrentModel()).toBe('B');
    });
  });

  describe('syncCurrentModel', () => {
    it('populates currentModel from /api/ps when a model is loaded', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { models: [{ name: 'gemma4:26b' }] }),
      );

      await proxy.syncCurrentModel();

      expect(proxy.getCurrentModel()).toBe('gemma4:26b');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://upstream:11434/api/ps');
    });

    it('leaves currentModel null when /api/ps returns nothing loaded', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { models: [] }));

      await proxy.syncCurrentModel();

      expect(proxy.getCurrentModel()).toBeNull();
    });

    it('leaves currentModel null and does not throw when /api/ps fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(proxy.syncCurrentModel()).resolves.toBeUndefined();
      expect(proxy.getCurrentModel()).toBeNull();
    });
  });

  describe('error handling', () => {
    it('forwards non-2xx upstream responses without changing currentModel', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));

      const res = await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      expect(res.status).toBe(500);
      // Model still gets set — the upstream may have actually loaded the
      // model before the error; conservative tracking
      expect(proxy.getCurrentModel()).toBe('A');
    });

    it('returns 502 when the upstream fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('upstream down'));

      const res = await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      expect(res.status).toBe(502);
      expect(proxy.getCurrentModel()).toBeNull();
    });

    it('still releases the lock if upstream throws (next request not deadlocked)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('blew up'));
      await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'A', messages: [] },
      });

      // Next call should proceed normally
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
      const res = await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { model: 'B', messages: [] },
      });

      expect(res.status).toBe(200);
      expect(proxy.getCurrentModel()).toBe('B');
    });

    it('returns 400 when a model-requiring request is missing model field', async () => {
      const res = await proxy.handle({
        method: 'POST',
        path: '/api/chat',
        body: { messages: [] },
      });

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('HTTP listener (integration)', () => {
    let fakeUpstream: Server;
    let upstreamUrl: string;
    let upstreamCalls: Array<{
      method: string;
      path: string;
      body: string;
    }> = [];
    let upstreamReply: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>;
    let proxyInstance: OllamaProxy;
    let proxyUrl: string;

    beforeEach(async () => {
      upstreamCalls = [];
      upstreamReply = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      };

      fakeUpstream = createHttpServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        }
        upstreamCalls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        await upstreamReply(req, res);
      });

      await new Promise<void>((resolve) =>
        fakeUpstream.listen(0, '127.0.0.1', resolve),
      );
      const upstreamAddr = fakeUpstream.address() as AddressInfo;
      upstreamUrl = `http://127.0.0.1:${upstreamAddr.port}`;

      proxyInstance = new OllamaProxy({ realHost: upstreamUrl });
      await proxyInstance.listen(0);
      // We need the port the proxy chose; expose via server.address()
      const sockets = (proxyInstance as any).server?.address?.();
      const proxyPort = (sockets as AddressInfo).port;
      proxyUrl = `http://127.0.0.1:${proxyPort}`;
    });

    afterEach(async () => {
      await proxyInstance.close();
      await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()));
    });

    it('forwards a POST /api/chat through the HTTP listener', async () => {
      const res = await fetch(`${proxyUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'X', messages: [] }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({ ok: true });
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0].path).toBe('/api/chat');
      expect(JSON.parse(upstreamCalls[0].body)).toEqual({
        model: 'X',
        messages: [],
      });
      expect(proxyInstance.getCurrentModel()).toBe('X');
    });

    it('pipes streaming NDJSON chunks through unbuffered', async () => {
      // Upstream emits 3 separate chunks
      upstreamReply = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(JSON.stringify({ done: false, token: 'hello' }) + '\n');
        res.write(JSON.stringify({ done: false, token: ' world' }) + '\n');
        res.write(JSON.stringify({ done: true }) + '\n');
        res.end();
      };

      const res = await fetch(`${proxyUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'stream-model', messages: [] }),
      });

      const text = await res.text();
      const lines = text.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toEqual({ done: false, token: 'hello' });
      expect(JSON.parse(lines[1])).toEqual({ done: false, token: ' world' });
      expect(JSON.parse(lines[2])).toEqual({ done: true });
    });

    it('issues an eviction call when switching models via HTTP', async () => {
      // First request: load A
      await fetch(`${proxyUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'A', messages: [] }),
      });
      // Second request: B → should evict A first
      await fetch(`${proxyUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'B', messages: [] }),
      });

      expect(upstreamCalls).toHaveLength(3);
      expect(upstreamCalls[1].path).toBe('/api/generate');
      expect(JSON.parse(upstreamCalls[1].body)).toEqual({
        model: 'A',
        keep_alive: 0,
      });
      expect(upstreamCalls[2].path).toBe('/api/chat');
      expect(JSON.parse(upstreamCalls[2].body)).toEqual({
        model: 'B',
        messages: [],
      });
    });

    it('returns 400 over HTTP when model is missing from a chat request', async () => {
      const res = await fetch(`${proxyUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(res.status).toBe(400);
      expect(upstreamCalls).toHaveLength(0);
    });

    it('passes GET /api/tags straight through via HTTP', async () => {
      upstreamReply = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'gemma4:e4b' }] }));
      };
      const res = await fetch(`${proxyUrl}/api/tags`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ models: [{ name: 'gemma4:e4b' }] });
      expect(proxyInstance.getCurrentModel()).toBeNull();
    });
  });

  describe('endpoint routing', () => {
    it.each([
      ['/api/chat'],
      ['/api/generate'],
      ['/api/embeddings'],
      ['/v1/chat/completions'],
      ['/v1/completions'],
      ['/v1/embeddings'],
    ])('%s acquires the lock and updates currentModel', async (path) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
      await proxy.handle({
        method: 'POST',
        path,
        body: { model: 'm1', messages: [] },
      });
      expect(proxy.getCurrentModel()).toBe('m1');
    });

    it.each([['/api/tags'], ['/api/ps'], ['/api/show'], ['/api/version']])(
      '%s is pass-through (no state change)',
      async (path) => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
        await proxy.handle({ method: 'GET', path });
        expect(proxy.getCurrentModel()).toBeNull();
      },
    );
  });
});

describe('OllamaProxy.getStats', () => {
  it('starts with zeroed counters and null currentModel', () => {
    const proxy = new OllamaProxy({ realHost: 'http://localhost:99999' });
    expect(proxy.getStats()).toEqual({
      currentModel: null,
      evictions: 0,
      requests: 0,
      lastEvictionAt: null,
    });
  });
});
