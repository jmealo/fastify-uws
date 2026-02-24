import fastify from 'fastify';
import { serverFactory } from '../../dist/index.js';

const app = fastify({ serverFactory, logger: false });

app.get('/ping', async () => ({ ok: true }));

await app.listen({ port: 0, host: '127.0.0.1' });
process.send({ port: app.server.address().port });
process.on('SIGTERM', () => {
  app.close();
  process.exit(0);
});
