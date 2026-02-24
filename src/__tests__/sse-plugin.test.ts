import http from 'node:http';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import fastify from 'fastify';
import { serverFactory, sse } from '..';

let app: FastifyInstance;
let baseUrl: string;

async function startApp() {
  app = fastify({ serverFactory, logger: false });
  await app.register(sse);
  return app;
}

async function listen() {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function sseGet(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}${path}`,
      {
        headers: { accept: 'text/event-stream', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}

function collectSSEEvents(path: string, maxEvents: number, timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const req = http.get(
      `${baseUrl}${path}`,
      {
        headers: { accept: 'text/event-stream' },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          let idx = buf.indexOf('\n\n');
          while (idx !== -1) {
            events.push(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
            if (events.length >= maxEvents) {
              req.destroy();
              resolve(events);
              return;
            }
            idx = buf.indexOf('\n\n');
          }
        });
        res.on('end', () => resolve(events));
      },
    );
    req.on('error', (err) => {
      if (events.length > 0) resolve(events);
      else reject(err);
    });
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

afterEach(async () => {
  if (app) await app.close().catch(() => {});
});

// ── SSE Injection Prevention ──────────────────────────────────────────

test('SSE: id field with newlines is sanitized', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.send({ id: '123\ndata: injected\n\nevent: evil', data: 'safe' });
  });
  await listen();

  const events = await collectSSEEvents('/sse', 1);
  expect(events.length).toBe(1);
  // Newlines are stripped from the id field, so the injected content is collapsed into a single id value
  // Verify the injection did NOT create separate SSE lines
  const lines = events[0].split('\n');
  const dataLines = lines.filter((l: string) => l.startsWith('data: '));
  const eventLines = lines.filter((l: string) => l.startsWith('event: '));
  // Only one data line (our actual data), no injected event lines
  expect(dataLines).toEqual(['data: "safe"']);
  expect(eventLines).toHaveLength(0);
  // The id field has the injected content collapsed (newlines stripped)
  expect(events[0]).toContain('id: 123data: injectedevent: evil');
});

test('SSE: event field with newlines is sanitized', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.send({ event: 'test\ndata: injected', data: 'safe' });
  });
  await listen();

  const events = await collectSSEEvents('/sse', 1);
  expect(events.length).toBe(1);
  expect(events[0]).not.toContain('\ndata: injected\n');
  expect(events[0]).toContain('event: testdata: injected');
});

test('SSE: retry field with newlines is sanitized', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.send({ retry: '5000\ndata: injected', data: 'safe' });
  });
  await listen();

  const events = await collectSSEEvents('/sse', 1);
  expect(events.length).toBe(1);
  expect(events[0]).toContain('retry: 5000data: injected');
});

// ── SSE Message Formatting ────────────────────────────────────────────

test('SSE: send string message', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.send('hello world');
  });
  await listen();

  const events = await collectSSEEvents('/sse', 1);
  expect(events[0]).toBe('data: hello world');
});

test('SSE: send multiline string message', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.send('line1\nline2\nline3');
  });
  await listen();

  const events = await collectSSEEvents('/sse', 1);
  expect(events[0]).toBe('data: line1\ndata: line2\ndata: line3');
});

test('SSE: send object with all fields', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.send({ id: '42', event: 'update', data: { msg: 'hi' }, retry: '3000' });
  });
  await listen();

  const events = await collectSSEEvents('/sse', 1);
  expect(events[0]).toContain('id: 42');
  expect(events[0]).toContain('event: update');
  expect(events[0]).toContain('data: {"msg":"hi"}');
  expect(events[0]).toContain('retry: 3000');
});

// ── SSE Headers ───────────────────────────────────────────────────────

test('SSE: correct response headers', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.send({ data: 'test' });
  });
  await listen();

  const res = await sseGet('/sse');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('text/event-stream');
  expect(res.headers['cache-control']).toBe('no-cache');
});

// ── SSE Accept Header Fallback ────────────────────────────────────────

test('SSE: non-SSE request falls back to original handler', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    return reply.send({ fallback: true });
  });
  await listen();

  // Request without text/event-stream accept header
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get(`${baseUrl}/sse`, { headers: { accept: 'application/json' } }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      })
      .on('error', reject);
  });

  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ fallback: true });
});

// ── SSE keepAlive + close ─────────────────────────────────────────────

test('SSE: keepAlive prevents auto-close', async () => {
  await startApp();
  let sseCtx: any;
  app.get('/sse', { sse: true }, async (_req, reply) => {
    reply.sse.keepAlive();
    sseCtx = reply.sse;
    await reply.sse.send({ data: 'start' });
    // Handler returns but connection stays open due to keepAlive
  });
  await listen();

  const events = await collectSSEEvents('/sse', 2, 1000);
  // Should receive at least the first event
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0]).toContain('data: "start"');

  // Manually close after test
  if (sseCtx) sseCtx.close();
});

test('SSE: onClose callbacks are invoked', async () => {
  await startApp();
  let closeCalled = false;
  app.get('/sse', { sse: true }, async (_req, reply) => {
    reply.sse.onClose(() => {
      closeCalled = true;
    });
    await reply.sse.send({ data: 'test' });
  });
  await listen();

  await collectSSEEvents('/sse', 1);
  // Wait for close to propagate
  await new Promise((r) => setTimeout(r, 100));
  expect(closeCalled).toBe(true);
});

// ── SSE lastEventId ──────────────────────────────────────────────────

test('SSE: lastEventId from Last-Event-ID header', async () => {
  await startApp();
  let receivedId: string | null = null;
  app.get('/sse', { sse: true }, async (_req, reply) => {
    receivedId = reply.sse.lastEventId;
    await reply.sse.send({ data: 'test' });
  });
  await listen();

  await sseGet('/sse', { 'last-event-id': 'evt-42' });
  expect(receivedId).toBe('evt-42');
});

// ── SSE Readable stream source ───────────────────────────────────────

test('SSE: send Readable stream', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    const stream = new Readable({
      objectMode: true,
      read() {
        this.push({ data: 'chunk1' });
        this.push({ data: 'chunk2' });
        this.push(null);
      },
    });
    await reply.sse.send(stream);
  });
  await listen();

  const events = await collectSSEEvents('/sse', 2);
  expect(events.length).toBe(2);
  expect(events[0]).toContain('data: "chunk1"');
  expect(events[1]).toContain('data: "chunk2"');
});

// ── SSE async iterable source ────────────────────────────────────────

test('SSE: send async iterable', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    async function* generate() {
      yield { data: 'iter1' };
      yield { data: 'iter2' };
    }
    await reply.sse.send(generate());
  });
  await listen();

  const events = await collectSSEEvents('/sse', 2);
  expect(events.length).toBe(2);
  expect(events[0]).toContain('data: "iter1"');
  expect(events[1]).toContain('data: "iter2"');
});

test('SSE: async iterable error is handled gracefully', async () => {
  await startApp();
  app.get('/sse', { sse: true }, async (_req, reply) => {
    async function* failingGen() {
      yield { data: 'ok' };
      throw new Error('generator failed');
    }
    await reply.sse.send(failingGen());
  });
  await listen();

  // Should not crash the server — collect what we can
  const events = await collectSSEEvents('/sse', 2, 1000);
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0]).toContain('data: "ok"');
});

// ── SSE replay ───────────────────────────────────────────────────────

test('SSE: replay callback invoked with lastEventId', async () => {
  await startApp();
  let replayedId: string | null = null;
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.replay(async (id) => {
      replayedId = id;
    });
    await reply.sse.send({ data: 'test' });
  });
  await listen();

  await sseGet('/sse', { 'last-event-id': 'replay-99' });
  expect(replayedId).toBe('replay-99');
});

test('SSE: replay callback not invoked without lastEventId', async () => {
  await startApp();
  let replayCalled = false;
  app.get('/sse', { sse: true }, async (_req, reply) => {
    await reply.sse.replay(async () => {
      replayCalled = true;
    });
    await reply.sse.send({ data: 'test' });
  });
  await listen();

  await sseGet('/sse');
  expect(replayCalled).toBe(false);
});
