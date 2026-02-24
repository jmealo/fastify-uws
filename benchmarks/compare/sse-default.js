import fastify from 'fastify';
import sse from '@fastify/sse';

const app = fastify({ logger: false });

await app.register(sse);

app.get('/sse', { sse: true }, async (request, reply) => {
  reply.sse.keepAlive();
  while (reply.sse.isConnected) {
    await reply.sse.send({ data: 'x'.repeat(64) });
  }
});

await app.listen({ port: 0, host: '127.0.0.1' });
process.send({ port: app.server.address().port });
process.on('SIGTERM', () => {
  app.close();
  process.exit(0);
});
