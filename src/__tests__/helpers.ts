import type { FastifyInstance } from 'fastify';
import fastify from 'fastify';
import { serverFactory } from '..';

export async function createServer(opts = {}) {
  const app: FastifyInstance = fastify({ serverFactory, ...opts });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { app, baseUrl, port };
}

export function createApp(opts = {}) {
  return fastify({ serverFactory, ...opts });
}
