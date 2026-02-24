import type { AddressInfo } from 'node:net';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import axios from 'axios';
import type { FastifyInstance } from 'fastify';
import type { UwsServer } from '..';
import { createApp } from './helpers';

let app: FastifyInstance<UwsServer>;
let baseUrl: string;
let port: number;

async function listen() {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  port = address.port;
  baseUrl = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (app) {
    await app.close();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Request Body Streaming (inbound)
// ────────────────────────────────────────────────────────────────────────────

describe('Request Body Streaming (inbound)', () => {
  test('POST large JSON body (>64KB) arrives intact via multi-chunk onData', async () => {
    app = createApp();
    app.post('/large-json', (req, reply) => {
      reply.send({
        length: JSON.stringify(req.body).length,
        echo: req.body,
        bytesRead: req.raw.socket.bytesRead,
      });
    });
    await listen();

    // Create a JSON payload larger than 64KB to force multi-chunk delivery
    const largeValue = 'x'.repeat(128 * 1024);
    const payload = { data: largeValue };

    const res = await axios.post(`${baseUrl}/large-json`, payload, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    expect(res.status).toBe(200);
    expect(res.data.echo.data).toBe(largeValue);
    expect(res.data.echo.data.length).toBe(128 * 1024);
    // Verify HTTPSocket.bytesRead accumulated across chunks
    expect(res.data.bytesRead).toBeGreaterThan(128 * 1024);
  });

  test('streaming request body via raw socket with chunked transfer encoding', async () => {
    app = createApp();
    app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    app.post('/chunked-in', (req, reply) => {
      const buf = req.body as Buffer;
      reply.send({
        size: buf.length,
        content: buf.toString('utf-8'),
        readableEnded: req.raw.readableEnded,
      });
    });
    await listen();

    // Send chunked HTTP request via raw socket with Connection: close
    // so the server closes the socket after sending the response
    const chunks = ['Hello, ', 'streaming ', 'world!'];
    const result = await new Promise<string>((resolve, reject) => {
      const socket = new net.Socket();
      let data = '';
      socket.connect(port, '127.0.0.1', () => {
        socket.write(
          'POST /chunked-in HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: text/plain\r\n' +
            'Transfer-Encoding: chunked\r\n' +
            'Connection: close\r\n' +
            '\r\n',
        );

        let i = 0;
        const sendNext = () => {
          if (i < chunks.length) {
            const chunk = chunks[i++];
            socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
            setTimeout(sendNext, 10);
          } else {
            socket.write('0\r\n\r\n');
          }
        };
        sendNext();
      });
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error('timeout'));
      }, 2000);
    });

    // Parse the HTTP response body (after headers)
    const bodyStr = result.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    const body = JSON.parse(bodyStr);
    expect(body.content).toBe('Hello, streaming world!');
    expect(body.size).toBe(23);
    // Verify Request.readableEnded is set after all chunks consumed
    expect(body.readableEnded).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Response Body Streaming (outbound)
// ────────────────────────────────────────────────────────────────────────────

describe('Response Body Streaming (outbound)', () => {
  test('chunked response via multiple write() calls', async () => {
    app = createApp();
    app.get('/chunked-out', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      reply.raw.write('chunk1-');
      reply.raw.write('chunk2-');
      // Known limitation: end() with no data after multiple synchronous write()
      // calls stalls in the streamx queue. Use end(data) instead.
      reply.raw.end('chunk3');
    });
    await listen();

    const res = await axios.get(`${baseUrl}/chunked-out`);
    expect(res.status).toBe(200);
    expect(res.data).toBe('chunk1-chunk2-chunk3');
  });

  test('large response body (>64KB) arrives intact', async () => {
    const largeBody = 'A'.repeat(128 * 1024);

    app = createApp();
    app.get('/large-out', (_req, reply) => {
      reply.type('text/plain').send(largeBody);
    });
    await listen();

    const res = await axios.get(`${baseUrl}/large-out`);
    expect(res.status).toBe(200);
    expect(res.data.length).toBe(128 * 1024);
    expect(res.data).toBe(largeBody);
  });

  test('reply.raw.end(data, encoding, callback) invokes callback', async () => {
    let callbackInvoked = false;
    let bytesWrittenValue = 0;

    app = createApp();
    app.get('/end-cb', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      reply.raw.end('done', 'utf-8', () => {
        callbackInvoked = true;
        bytesWrittenValue = (reply.raw as any).bytesWritten;
      });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/end-cb`);
    expect(res.status).toBe(200);
    expect(res.data).toBe('done');

    // Give the callback a tick to fire
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callbackInvoked).toBe(true);
    // Verify HTTPSocket.bytesWritten accumulated correctly
    expect(bytesWrittenValue).toBe(Buffer.byteLength('done'));
  });

  test('multi-chunk binary streaming via write() + end()', async () => {
    const chunks = [
      crypto.randomBytes(8 * 1024),
      crypto.randomBytes(8 * 1024),
      crypto.randomBytes(8 * 1024),
      crypto.randomBytes(8 * 1024),
    ];
    const expected = Buffer.concat(chunks);

    app = createApp();
    app.get('/stream-out', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'application/octet-stream',
      });
      for (let i = 0; i < chunks.length - 1; i++) {
        reply.raw.write(chunks[i]);
      }
      // See chunked response test: end(data) avoids streamx empty-end stall
      reply.raw.end(chunks[chunks.length - 1]);
    });
    await listen();

    const res = await axios.get(`${baseUrl}/stream-out`, {
      responseType: 'arraybuffer',
    });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.data).equals(expected)).toBe(true);
  });

  test('response with explicit Content-Length triggers fast-end optimization', async () => {
    const body = 'Hello, Content-Length!';

    app = createApp();
    app.get('/content-length', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(body)),
      });
      reply.raw.write(body);
    });
    await listen();

    const res = await axios.get(`${baseUrl}/content-length`);
    expect(res.status).toBe(200);
    expect(res.data).toBe(body);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Binary Data
// ────────────────────────────────────────────────────────────────────────────

describe('Binary Data', () => {
  test('binary response (Buffer) arrives intact at client', async () => {
    const binary = crypto.randomBytes(4096);

    app = createApp();
    app.get('/binary-out', (_req, reply) => {
      reply.header('content-type', 'application/octet-stream').send(binary);
    });
    await listen();

    const res = await axios.get(`${baseUrl}/binary-out`, {
      responseType: 'arraybuffer',
    });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.data).equals(binary)).toBe(true);
  });

  test('binary request body round-trip preserves bytes', async () => {
    // Use all 256 byte values to catch any byte-value-specific corruption
    // (e.g., 0x00 null termination, 0xFF sign issues)
    const original = Buffer.alloc(2048);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }

    app = createApp();
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );
    app.post('/binary-roundtrip', (req, reply) => {
      reply.header('content-type', 'application/octet-stream').send(req.body as Buffer);
    });
    await listen();

    const res = await axios.post(`${baseUrl}/binary-roundtrip`, original, {
      headers: { 'content-type': 'application/octet-stream' },
      responseType: 'arraybuffer',
    });

    expect(res.status).toBe(200);
    const received = Buffer.from(res.data);
    expect(received.length).toBe(original.length);
    expect(received.equals(original)).toBe(true);
  });

  test('large binary payload (~256KB) survives full pipeline', async () => {
    const original = crypto.randomBytes(256 * 1024);

    app = createApp();
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );
    app.post('/large-binary', (req, reply) => {
      const buf = req.body as Buffer;
      reply.header('content-type', 'application/octet-stream').send(buf);
    });
    await listen();

    const res = await axios.post(`${baseUrl}/large-binary`, original, {
      headers: { 'content-type': 'application/octet-stream' },
      responseType: 'arraybuffer',
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    expect(res.status).toBe(200);
    const received = Buffer.from(res.data);
    expect(received.length).toBe(original.length);
    expect(received.equals(original)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Abort During Streaming
// ────────────────────────────────────────────────────────────────────────────

describe('Abort During Streaming', () => {
  test('client disconnect during chunked response does not crash server', async () => {
    app = createApp();

    app.get('/slow-stream', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });

      let i = 0;
      const interval = setInterval(() => {
        try {
          if (i >= 20) {
            clearInterval(interval);
            reply.raw.end();
            return;
          }
          reply.raw.write(`chunk-${i++}\n`);
        } catch (_err) {
          clearInterval(interval);
        }
      }, 20);
    });

    app.get('/health', (_req, reply) => {
      reply.send({ ok: true });
    });
    await listen();

    // Connect and read a bit, then disconnect abruptly
    const socket = new net.Socket();
    await new Promise<void>((resolve) => {
      socket.connect(port, '127.0.0.1', () => {
        socket.write('GET /slow-stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
        // Give server time to start streaming, then kill connection
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 60);
      });
    });

    // Wait for the server to handle the abort
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Server should still be alive and healthy
    const res = await axios.get(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });
});
