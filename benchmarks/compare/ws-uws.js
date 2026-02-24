import fastify from 'fastify';
import { serverFactory, websocket } from '../../dist/index.js';

const app = fastify({ serverFactory, logger: false });

await app.register(websocket);

app.get('/ws', { websocket: true }, (socket) => {
  socket.on('message', (msg) => socket.send(msg));
});

await app.listen({ port: 0, host: '127.0.0.1' });
process.send({ port: app.server.address().port });
process.on('SIGTERM', () => {
  app.close();
  process.exit(0);
});
