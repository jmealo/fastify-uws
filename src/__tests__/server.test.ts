import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { UwsServer } from '..';
import { createApp } from './helpers';

let app: FastifyInstance<UwsServer>;

afterEach(async () => {
  if (app) {
    await app.close();
  }
});

describe('Server Lifecycle', () => {
  test('server.listening is true in listen callback', async () => {
    app = createApp();
    app.get('/', (_req, reply) => reply.send({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    expect(app.server.listening).toBe(true);
  });

  test('server.address() returns correct address/port/family', async () => {
    app = createApp();
    app.get('/', (_req, reply) => reply.send({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    expect(address).toBeDefined();
    expect(address.port).toBeGreaterThan(0);
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
  });

  test('server.close() emits close event and cleans up', async () => {
    app = createApp();
    app.get('/', (_req, reply) => reply.send({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });

    let closeFired = false;
    app.server.on('close', () => {
      closeFired = true;
    });

    await app.close();
    expect(closeFired).toBe(true);
    expect(app.server.listening).toBe(false);
  });

  test('server.close() is idempotent', async () => {
    app = createApp();
    app.get('/', (_req, reply) => reply.send({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });

    await app.close();
    // Second close should not throw
    app.server.close();
  });

  test('closeIdleConnections() does not shut down server', async () => {
    app = createApp();
    app.get('/', (_req, reply) => reply.send({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });

    app.server.closeIdleConnections();
    expect(app.server.listening).toBe(true);

    const address = app.server.address() as AddressInfo;
    expect(address).toBeDefined();
    expect(address.port).toBeGreaterThan(0);
  });
});
