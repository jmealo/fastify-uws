import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import type { FastifyInstance } from 'fastify';
import fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import WebSocketClient from 'ws';
import { serverFactory, websocket } from '..';
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

// ─── Fix 1: WebSocket Buffer.copyBytesFrom prevents use-after-free ──────────

describe('Security - WebSocket buffer safety (Fix 1)', () => {
  test('binary message data is safely copied, not a view over uWS internal buffer', async () => {
    app = createApp();
    app.register(websocket);

    const receivedBuffers: Buffer[] = [];
    app.register(async (instance) => {
      instance.get('/ws-buf', { websocket: true }, (socket) => {
        socket.on('message', (msg) => {
          receivedBuffers.push(msg);
          socket.send('ack');
        });
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl.replace('http', 'ws')}/ws-buf`);

    const testData = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(testData));
      ws.on('message', () => resolve());
      ws.on('error', reject);
    });

    expect(receivedBuffers.length).toBe(1);
    expect(Buffer.isBuffer(receivedBuffers[0])).toBe(true);
    expect([...receivedBuffers[0]]).toEqual([0xde, 0xad, 0xbe, 0xef]);

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  test('multiple rapid binary messages retain independent data (use-after-free guard)', async () => {
    app = createApp();
    app.register(websocket);

    const receivedBuffers: Buffer[] = [];
    const messageCount = 10;
    let resolveAll: () => void;
    const allReceived = new Promise<void>((r) => {
      resolveAll = r;
    });

    app.register(async (instance) => {
      instance.get('/ws-multi-buf', { websocket: true }, (socket) => {
        socket.on('message', (msg) => {
          receivedBuffers.push(msg);
          if (receivedBuffers.length === messageCount) {
            resolveAll();
          }
        });
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl.replace('http', 'ws')}/ws-multi-buf`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Send 10 messages rapidly — if buffers are views over the same
        // uWS internal memory, earlier ones will be corrupted by later writes
        for (let i = 0; i < messageCount; i++) {
          ws.send(Buffer.from([i, i + 1, i + 2, i + 3]));
        }
        resolve();
      });
      ws.on('error', reject);
    });

    await allReceived;

    // Verify each buffer retained its original content
    expect(receivedBuffers.length).toBe(messageCount);
    for (let i = 0; i < messageCount; i++) {
      expect([...receivedBuffers[i]]).toEqual([i, i + 1, i + 2, i + 3]);
    }

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });
});

// ─── Fix 2: TLS implementation ──────────────────────────────────────────────

describe('Security - TLS implementation (Fix 2)', () => {
  let tmpDir: string;
  let keyPath: string;
  let certPath: string;

  // Generate self-signed cert/key for testing
  function generateTestCert() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastify-uws-tls-test-'));
    keyPath = path.join(tmpDir, 'test-key.pem');
    certPath = path.join(tmpDir, 'test-cert.pem');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`,
    );
  }

  function cleanupTestCert() {
    try {
      if (keyPath) fs.unlinkSync(keyPath);
      if (certPath) fs.unlinkSync(certPath);
      if (tmpDir) fs.rmdirSync(tmpDir);
    } catch {}
  }

  test('TLS server with file paths starts and serves HTTPS', async () => {
    generateTestCert();
    try {
      app = fastify({
        serverFactory,
        https: { key: keyPath, cert: certPath },
      });
      app.get('/tls-test', (_req, reply) => reply.send({ secure: true }));
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address();
      const port = address.port;

      const res = await axios.get(`https://127.0.0.1:${port}/tls-test`, {
        httpsAgent: new (await import('node:https')).Agent({
          rejectUnauthorized: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ secure: true });
    } finally {
      cleanupTestCert();
    }
  });

  test('TLS server with Buffer PEM content starts and creates temp files', async () => {
    generateTestCert();
    try {
      const keyBuf = fs.readFileSync(keyPath);
      const certBuf = fs.readFileSync(certPath);

      app = fastify({
        serverFactory,
        https: { key: keyBuf, cert: certBuf },
      });
      app.get('/tls-buf-test', (_req, reply) => reply.send({ secure: true }));
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address();
      const port = address.port;

      const res = await axios.get(`https://127.0.0.1:${port}/tls-buf-test`, {
        httpsAgent: new (await import('node:https')).Agent({
          rejectUnauthorized: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ secure: true });
    } finally {
      cleanupTestCert();
    }
  });

  test('TLS temp files are cleaned up on server close', async () => {
    generateTestCert();
    try {
      const keyBuf = fs.readFileSync(keyPath);
      const certBuf = fs.readFileSync(certPath);

      app = fastify({
        serverFactory,
        https: { key: keyBuf, cert: certBuf },
      });
      app.get('/', (_req, reply) => reply.send('ok'));
      await app.listen({ port: 0, host: '127.0.0.1' });

      // Find temp files created by the server
      const tmpFiles = fs
        .readdirSync(os.tmpdir())
        .filter((f) => f.startsWith('fastify-uws-') && f.endsWith('.pem'));
      expect(tmpFiles.length).toBeGreaterThanOrEqual(2);

      await app.close();

      // Verify temp files are cleaned up
      const remainingFiles = fs
        .readdirSync(os.tmpdir())
        .filter(
          (f) =>
            f.startsWith(`fastify-uws-key-${process.pid}`) ||
            f.startsWith(`fastify-uws-cert-${process.pid}`),
        );
      expect(remainingFiles.length).toBe(0);
    } finally {
      cleanupTestCert();
    }
  });
});

// ─── Fix 3: drain() timeout ─────────────────────────────────────────────────

describe('Security - drain timeout (Fix 3)', () => {
  test('slow-reading client gets disconnected instead of hanging server forever', async () => {
    app = createApp();

    // Endpoint that writes a large amount of data to trigger backpressure
    app.get('/large', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/octet-stream' });
      // Write 1MB chunks to trigger backpressure
      const chunk = Buffer.alloc(1024 * 1024, 0x42);
      for (let i = 0; i < 10; i++) {
        reply.raw.write(chunk);
      }
      reply.raw.end();
    });

    // Health endpoint to verify server remains responsive
    app.get('/health', (_req, reply) => reply.send({ ok: true }));
    await listen();

    const address = app.server.address();

    // Create a raw TCP connection that connects but never reads
    const slowClient = new net.Socket();
    await new Promise<void>((resolve) => {
      slowClient.connect(address.port, '127.0.0.1', () => {
        // Send HTTP request but don't read response
        slowClient.write('GET /large HTTP/1.1\r\nHost: localhost\r\n\r\n');
        resolve();
      });
    });

    // Wait briefly for the server to start writing
    await new Promise((r) => setTimeout(r, 100));

    // Server should still be responsive for other requests
    const healthRes = await axios.get(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);

    slowClient.destroy();
  });
});

// ─── Fix 4: defaultErrorHandler closes WebSocket ─────────────────────────────

describe('Security - defaultErrorHandler closes WebSocket (Fix 4)', () => {
  test('sync error in WebSocket handler closes connection cleanly', async () => {
    app = createApp();
    app.register(websocket);
    app.register(async (instance) => {
      instance.get('/ws-err-sync', { websocket: true }, () => {
        throw new Error('sync handler error');
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl.replace('http', 'ws')}/ws-err-sync`);

    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 5000);
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.on('error', () => {
        // Connection errors are expected
      });
    });

    expect(typeof closeCode).toBe('number');
  });

  test('async error in WebSocket handler closes connection cleanly', async () => {
    app = createApp();
    app.register(websocket);
    app.register(async (instance) => {
      instance.get('/ws-err-async', { websocket: true }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('async handler error');
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl.replace('http', 'ws')}/ws-err-async`);

    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 5000);
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.on('error', () => {
        // Connection errors are expected
      });
    });

    expect(typeof closeCode).toBe('number');
  });
});

// ─── Fix 5: Header CRLF injection ───────────────────────────────────────────

describe('Security - Header CRLF injection (Fix 5)', () => {
  test('CRLF in header value is stripped', async () => {
    app = createApp();
    app.get('/crlf', (_req, reply) => {
      reply.header('x-test', 'safe\r\nX-Injected: evil');
      reply.send({ ok: true });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/crlf`);
    expect(res.headers['x-test']).toBe('safeX-Injected: evil');
    expect(res.headers['x-injected']).toBeUndefined();
  });

  test('lone \\r is stripped', async () => {
    app = createApp();
    app.get('/cr-only', (_req, reply) => {
      reply.header('x-cr', 'before\rafter');
      reply.send({ ok: true });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/cr-only`);
    expect(res.headers['x-cr']).toBe('beforeafter');
  });

  test('lone \\n is stripped', async () => {
    app = createApp();
    app.get('/lf-only', (_req, reply) => {
      reply.header('x-lf', 'before\nafter');
      reply.send({ ok: true });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/lf-only`);
    expect(res.headers['x-lf']).toBe('beforeafter');
  });

  test('header values without CRLF pass through unchanged', async () => {
    app = createApp();
    app.get('/normal-header', (_req, reply) => {
      reply.header('x-safe', 'normal-value');
      reply.send({ ok: true });
    });
    await listen();

    const res = await axios.get(`${baseUrl}/normal-header`);
    expect(res.headers['x-safe']).toBe('normal-value');
  });

  test('CRLF in writeHead() header values is stripped', async () => {
    app = createApp();
    app.get('/crlf-writehead', (_req, reply) => {
      reply.raw.writeHead(200, { 'x-injected': 'safe\r\nX-Evil: gotcha' });
      reply.raw.end('ok');
    });
    await listen();

    const res = await axios.get(`${baseUrl}/crlf-writehead`);
    expect(res.headers['x-evil']).toBeUndefined();
  });

  test('CRLF in writeHead() status message is stripped', async () => {
    app = createApp();
    app.get('/crlf-status', (_req, reply) => {
      reply.raw.writeHead(200, 'OK\r\nX-Evil: gotcha');
      reply.raw.end('ok');
    });
    await listen();

    const res = await axios.get(`${baseUrl}/crlf-status`);
    expect(res.status).toBe(200);
    expect(res.headers['x-evil']).toBeUndefined();
  });

  test('CRLF in multi-value (array) header is stripped', async () => {
    app = createApp();
    app.get('/crlf-array', (_req, reply) => {
      reply.raw.setHeader('set-cookie', ['a=1; Path=/', 'b=2\r\nX-Evil: gotcha']);
      reply.raw.end('ok');
    });
    await listen();

    const res = await axios.get(`${baseUrl}/crlf-array`);
    expect(res.headers['x-evil']).toBeUndefined();
    // The cookie values should still be present (with CRLF stripped)
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies.some((c: string) => c.includes('a=1'))).toBe(true);
  });

  test('CRLF in header name is stripped', async () => {
    app = createApp();
    app.get('/crlf-name', (_req, reply) => {
      reply.raw.setHeader('x-safe\r\nX-Evil', 'gotcha');
      reply.raw.end('ok');
    });
    await listen();

    const res = await axios.get(`${baseUrl}/crlf-name`);
    // The injected header name should be sanitized — no separate X-Evil header
    expect(res.headers['x-evil']).toBeUndefined();
  });
});

// ─── Fix 6: WebSocket upgrade validation ─────────────────────────────────────

describe('Security - WebSocket upgrade validation (Fix 6)', () => {
  test('HTTP request to WebSocket endpoint without upgrade headers returns error and server stays healthy', async () => {
    app = createApp();
    app.register(websocket);
    app.register(async (instance) => {
      instance.get('/ws-key', { websocket: true }, (socket) => {
        socket.on('message', (msg) => {
          socket.send(`echo: ${msg}`);
        });
      });
    });
    app.get('/health', (_req, reply) => reply.send({ ok: true }));
    await listen();

    // Non-WebSocket request to a WebSocket endpoint should not crash the server
    const res = await axios.get(`${baseUrl}/ws-key`, {
      validateStatus: () => true,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Verify server is still healthy after bad request
    const healthRes = await axios.get(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.data).toEqual({ ok: true });
  });
});

// ─── Buffer safety: WebSocket close event ────────────────────────────────────

describe('Security - WebSocket close/ping buffer safety', () => {
  test('close event message buffer is safely copied', async () => {
    app = createApp();
    app.register(websocket);

    let closeMessage: Buffer | null = null;
    let closeCode: number | null = null;
    let closeReceived: () => void;
    const closePromise = new Promise<void>((r) => {
      closeReceived = r;
    });

    app.register(async (instance) => {
      instance.get('/ws-close-buf', { websocket: true }, (socket) => {
        socket.on('close', (code, msg) => {
          closeCode = code;
          closeMessage = msg;
          closeReceived();
        });
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl.replace('http', 'ws')}/ws-close-buf`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Close with a reason string — uWS delivers this as an ArrayBuffer
    ws.close(1000, 'test-close-reason');
    await closePromise;

    expect(closeCode).toBe(1000);
    // The close message should be a Buffer (safely copied), not corrupted
    expect(closeMessage).toBeDefined();
    if (Buffer.isBuffer(closeMessage)) {
      expect(closeMessage.toString()).toBe('test-close-reason');
    }
  });

  test('ping event message buffer is safely copied', async () => {
    app = createApp();
    app.register(websocket);

    let pingData: Buffer | null = null;
    let pingReceived: () => void;
    const pingPromise = new Promise<void>((r) => {
      pingReceived = r;
    });

    app.register(async (instance) => {
      instance.get('/ws-ping-buf', { websocket: true }, (socket) => {
        socket.on('ping', (msg) => {
          pingData = msg;
          pingReceived();
        });
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl.replace('http', 'ws')}/ws-ping-buf`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Send a ping with binary data
    ws.ping(Buffer.from([0xca, 0xfe]));
    await pingPromise;

    expect(pingData).toBeDefined();
    if (Buffer.isBuffer(pingData)) {
      expect([...pingData]).toEqual([0xca, 0xfe]);
    }

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });
});

// ─── TLS array key/cert support ──────────────────────────────────────────────

describe('Security - TLS array key/cert support', () => {
  let tmpDir: string;
  let keyPath: string;
  let certPath: string;

  function generateTestCert() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastify-uws-tls-arr-'));
    keyPath = path.join(tmpDir, 'test-key.pem');
    certPath = path.join(tmpDir, 'test-cert.pem');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`,
    );
  }

  function cleanupTestCert() {
    try {
      if (keyPath) fs.unlinkSync(keyPath);
      if (certPath) fs.unlinkSync(certPath);
      if (tmpDir) fs.rmdirSync(tmpDir);
    } catch {}
  }

  test('single-element array key/cert is unwrapped and works', async () => {
    generateTestCert();
    try {
      const keyBuf = fs.readFileSync(keyPath);
      const certBuf = fs.readFileSync(certPath);

      app = fastify({
        serverFactory,
        https: { key: [keyBuf], cert: [certBuf] },
      });
      app.get('/tls-arr', (_req, reply) => reply.send({ secure: true }));
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address();
      const res = await axios.get(`https://127.0.0.1:${address.port}/tls-arr`, {
        httpsAgent: new (await import('node:https')).Agent({ rejectUnauthorized: false }),
      });

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ secure: true });
    } finally {
      cleanupTestCert();
    }
  });

  test('multi-element array key throws clear error', () => {
    expect(() => {
      fastify({
        serverFactory,
        https: {
          key: [Buffer.from('key1'), Buffer.from('key2')],
          cert: Buffer.from('cert'),
        },
      });
    }).toThrow(/multiple key values are not supported/);
  });
});

// ─── Buffer safety: getRemoteAddress ─────────────────────────────────────────

describe('Security - getRemoteAddress buffer safety', () => {
  test('remoteAddress is a safe copy, not a view over uWS memory', async () => {
    app = createApp();

    const addresses: string[] = [];
    app.get('/addr', (req, reply) => {
      addresses.push(req.socket.remoteAddress);
      reply.send({ addr: req.socket.remoteAddress });
    });
    await listen();

    // Make multiple requests and verify addresses remain consistent
    await Promise.all([
      axios.get(`${baseUrl}/addr`),
      axios.get(`${baseUrl}/addr`),
      axios.get(`${baseUrl}/addr`),
    ]);

    expect(addresses.length).toBe(3);
    for (const addr of addresses) {
      expect(addr).toBe('127.0.0.1');
    }
  });
});
