import {
  createServer,
  IncomingHttpHeaders,
  request as httpRequest,
  Server,
} from 'http';
import { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('./env.js', () => ({
  readEnvFile: () => env.values,
}));

import { startCredentialProxy } from './credential-proxy.js';

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

describe('credential proxy', () => {
  let upstream: Server;
  let upstreamHandler: Parameters<typeof createServer>[1];
  let proxy: Server;
  let proxyPort: number;

  beforeEach(async () => {
    upstreamHandler = (_req, res) => res.end('ok');
    upstream = createServer((req, res) => upstreamHandler!(req, res));
    const upstreamPort = await listenOn(upstream);
    env.values = {
      ANTHROPIC_API_KEY: 'sk-real',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    };
    proxy = await startCredentialProxy(0);
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await closeServer(proxy);
    await closeServer(upstream);
  });

  it('injects the API key and forwards the response', async () => {
    let seen: IncomingHttpHeaders = {};
    upstreamHandler = (req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    };

    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'placeholder' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(seen['x-api-key']).toBe('sk-real');
  });

  it('destroys the upstream request when the client disconnects mid-stream', async () => {
    let resolveClosed!: () => void;
    const upstreamClosed = new Promise<void>((r) => (resolveClosed = r));
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write('data: {}\n\n'), 20);
      res.on('close', () => {
        clearInterval(timer);
        resolveClosed();
      });
    };

    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'POST',
          path: '/v1/messages',
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
      req.end('{}');
    });

    await upstreamClosed;
  });

  it('destroys the upstream request when the client disconnects before headers', async () => {
    let resolveClosed!: () => void;
    const upstreamClosed = new Promise<void>((r) => (resolveClosed = r));
    let resolveGot!: () => void;
    const upstreamGot = new Promise<void>((r) => (resolveGot = r));
    upstreamHandler = (_req, res) => {
      resolveGot();
      res.on('close', () => resolveClosed());
    };

    const req = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'POST',
      path: '/v1/messages',
      agent: false,
    });
    req.on('error', () => {});
    req.end('{}');
    await upstreamGot;
    req.destroy();

    await upstreamClosed;
  });
});
