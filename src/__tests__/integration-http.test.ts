import axios from 'axios';
import type { FastifyInstance } from 'fastify';
import { createApp } from './helpers';

let app: FastifyInstance;
let baseUrl: string;

async function listen() {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (app) {
    await app.close();
  }
});

describe('HTTP Integration - Request handling', () => {
  test('GET returns JSON response with correct status/headers/body', async () => {
    app = createApp();
    app.get('/test', (_req, reply) => {
      reply.send({ message: 'hello' });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/test`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ message: 'hello' });
    expect(res.headers['content-type']).toContain('application/json');
  });

  test('POST with JSON body parsed correctly', async () => {
    app = createApp();
    app.post('/echo', (req, reply) => {
      reply.send(req.body);
    });
    await listen();

    const res = await axios.post(`${baseUrl}/echo`, { key: 'value' });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ key: 'value' });
  });

  test('request URL includes query string', async () => {
    app = createApp();
    app.get('/qs', (req, reply) => {
      reply.send({ url: req.raw.url });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/qs?foo=bar&baz=1`);
    expect(res.data.url).toBe('/qs?foo=bar&baz=1');
  });

  test('request headers are properly captured', async () => {
    app = createApp();
    app.get('/headers', (req, reply) => {
      reply.send({ custom: req.headers['x-custom-header'] });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/headers`, {
      headers: { 'x-custom-header': 'test-value' },
    });
    expect(res.data.custom).toBe('test-value');
  });

  test('URL and headers available in async handler', async () => {
    app = createApp();
    app.get('/async', async (req, _reply) => {
      // Introduce async gap - this is the critical test for eager caching
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { url: req.raw.url, host: req.headers.host };
    });
    await listen();

    const res = await axios.get(`${baseUrl}/async?key=val`);
    expect(res.data.url).toBe('/async?key=val');
    expect(res.data.host).toBeDefined();
  });

  test('204 No Content response', async () => {
    app = createApp();
    app.get('/no-content', (_req, reply) => {
      reply.code(204).send();
    });
    await listen();

    const res = await axios.get(`${baseUrl}/no-content`, { validateStatus: () => true });
    expect(res.status).toBe(204);
    expect(res.data).toBe('');
  });

  test('HEAD request returns headers without body', async () => {
    app = createApp();
    app.head('/head-test', (_req, reply) => {
      reply.header('x-test', 'yes').send();
    });
    await listen();

    const res = await axios.head(`${baseUrl}/head-test`);
    expect(res.status).toBe(200);
    expect(res.data).toBe('');
  });
});

describe('HTTP Integration - Socket properties', () => {
  test('socket.remoteAddress returns valid IP', async () => {
    app = createApp();
    app.get('/remote', (req, reply) => {
      reply.send({ address: req.socket.remoteAddress });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/remote`);
    expect(res.data.address).toBe('127.0.0.1');
  });

  test('socket.remoteFamily returns IPv4/IPv6', async () => {
    app = createApp();
    app.get('/family', (req, reply) => {
      reply.send({ family: req.socket.remoteFamily });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/family`);
    expect(['IPv4', 'IPv6']).toContain(res.data.family);
  });
});

describe('HTTP Integration - Response features', () => {
  test('custom response headers sent correctly', async () => {
    app = createApp();
    app.get('/custom-headers', (_req, reply) => {
      reply.header('x-custom', 'custom-value').send({ ok: true });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/custom-headers`);
    expect(res.headers['x-custom']).toBe('custom-value');
  });

  test('writeHead() with status code and headers', async () => {
    app = createApp();
    app.get('/write-head', (_req, reply) => {
      reply.raw.writeHead(201, { 'x-write-head': 'test' });
      reply.raw.end(JSON.stringify({ created: true }));
    });
    await listen();

    const res = await axios.get(`${baseUrl}/write-head`, { validateStatus: () => true });
    expect(res.status).toBe(201);
    expect(res.headers['x-write-head']).toBe('test');
  });

  test('write() returns boolean', async () => {
    app = createApp();
    let writeResult: any;
    app.get('/write-return', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      writeResult = reply.raw.write('hello');
      reply.raw.end(' world');
    });
    await listen();

    const res = await axios.get(`${baseUrl}/write-return`);
    expect(res.data).toBe('hello world');
    expect(typeof writeResult).toBe('boolean');
  });

  test('addTrailers() does not crash', async () => {
    app = createApp();
    app.get('/trailers', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      reply.raw.addTrailers({ 'x-trailer': 'value' });
      reply.raw.end('done');
    });
    await listen();

    const res = await axios.get(`${baseUrl}/trailers`);
    expect(res.status).toBe(200);
  });
});
