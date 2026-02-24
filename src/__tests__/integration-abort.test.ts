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
  const address = app.server.address() as net.AddressInfo;
  port = address.port;
  baseUrl = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (app) {
    await app.close();
  }
});

describe('Abort & Error Handling', () => {
  test('client disconnect during response does not crash', async () => {
    app = createApp();

    app.get('/slow', async (_req, reply) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      reply.send({ ok: true });
    });
    await listen();

    // Use raw socket to connect and immediately abort
    const socket = new net.Socket();
    await new Promise<void>((resolve) => {
      socket.connect(port, '127.0.0.1', () => {
        socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n');
        // Destroy immediately after sending request
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 20);
      });
    });

    // Wait a bit for the server to process the abort
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Server should still be alive
    const res = await axios.get(`${baseUrl}/slow`, { timeout: 5000 });
    expect(res.status).toBe(200);
  });

  test('socket.remoteAddress returns undefined after abort', async () => {
    app = createApp();

    let remoteAddressAfterAbort: any = 'not-set';
    app.get('/abort-addr', async (req, reply) => {
      const socket = req.socket;
      // Access remoteAddress before abort - should work
      socket.remoteAddress;

      await new Promise<void>((resolve) => {
        socket.once('close', () => {
          remoteAddressAfterAbort = socket.remoteAddress;
          resolve();
        });
      });
      // reply won't be sent because the socket was aborted
      try {
        reply.send({ ok: true });
      } catch {
        // Expected - socket is already closed
      }
    });
    await listen();

    const socket = new net.Socket();
    await new Promise<void>((resolve) => {
      socket.connect(port, '127.0.0.1', () => {
        socket.write('GET /abort-addr HTTP/1.1\r\nHost: localhost\r\n\r\n');
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 20);
      });
    });

    // Wait for handler to process
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(remoteAddressAfterAbort).toBeUndefined();
  });

  test('invalid HTTP method triggers clientError', async () => {
    app = createApp();

    let clientErrorFired = false;
    app.server.on('clientError', () => {
      clientErrorFired = true;
    });

    app.get('/', (_req, reply) => reply.send({ ok: true }));
    await listen();

    const socket = new net.Socket();
    await new Promise<void>((resolve) => {
      socket.connect(port, '127.0.0.1', () => {
        socket.write('INVALID / HTTP/1.1\r\nHost: localhost\r\n\r\n');
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 100);
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clientErrorFired).toBe(true);
  });

  test('server handles rapid connect/disconnect cycles without crash', async () => {
    app = createApp();
    app.get('/', (_req, reply) => reply.send({ ok: true }));
    await listen();

    // Rapidly connect and disconnect 10 times
    const promises = Array.from({ length: 10 }, () => {
      return new Promise<void>((resolve) => {
        const socket = new net.Socket();
        socket.connect(port, '127.0.0.1', () => {
          socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
          socket.destroy();
          resolve();
        });
        socket.on('error', () => resolve());
      });
    });

    await Promise.all(promises);

    // Wait for server to process all aborts
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Server should still be healthy
    const res = await axios.get(`${baseUrl}/`);
    expect(res.status).toBe(200);
  });
});
