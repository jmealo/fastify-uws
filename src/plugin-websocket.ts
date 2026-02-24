import fp from 'fastify-plugin';

import { kRes, kWs } from './symbols';
import type { WsUserData } from './websocket-server';
import { WebSocket, WebSocketServer } from './websocket-server';

function defaultErrorHandler(err: Error, conn: WebSocket, request: any) {
  request.log.error(err);
  conn.close();
}

function fastifyUws(fastify: any, opts: any, next: (err?: Error) => void) {
  const { server } = fastify;
  const { errorHandler = defaultErrorHandler, options } = opts;

  if (errorHandler && typeof errorHandler !== 'function') {
    return next(new Error('invalid errorHandler function'));
  }

  const websocketServer = new WebSocketServer(options);
  server[kWs] = websocketServer;

  fastify.decorate('websocketServer', websocketServer);

  fastify.addHook('onRoute', (routeOptions: any) => {
    const isWebSocket = !!routeOptions.websocket;
    if (!isWebSocket || routeOptions.method === 'HEAD' || routeOptions.method === 'OPTIONS') return;

    const wsOptions = typeof routeOptions.ws === 'object' ? routeOptions.ws : {};
    const handler = routeOptions.handler;
    const namespace = Buffer.from(routeOptions.url);

    const topics: Record<string, Buffer> = {};
    if (wsOptions.topics) {
      for (const topic of wsOptions.topics) {
        topics[topic] = WebSocket.allocTopic(namespace, topic) as Buffer;
      }
    }

    routeOptions.handler = function (this: any, request: any, reply: any) {
      const requestRaw = request.raw;
      if (requestRaw[kWs]) {
        const wsKey = requestRaw.headers['sec-websocket-key'];
        if (!wsKey) {
          reply.code(400).send('Missing sec-websocket-key header');
          return;
        }
        reply.hijack();
        const uRes = requestRaw.socket[kRes];
        requestRaw.socket[kWs] = true;
        if (requestRaw.socket.aborted || requestRaw.socket.destroyed) return;
        uRes.upgrade(
          {
            req: requestRaw,
            handler: (ws: any) => {
              const conn = new WebSocket(namespace, ws, topics);

              let result: any;
              try {
                requestRaw.once('error', () => {
                  conn.close();
                });

                requestRaw.once('close', () => {
                  conn.end(1000, 'Normal Closure');
                });

                result = handler.call(this, conn, request, reply);
              } catch (err) {
                return errorHandler.call(this, err, conn, request, reply);
              }

              if (result && typeof result.catch === 'function') {
                result.catch((err: any) => errorHandler.call(this, err, conn, request, reply));
              }
            },
          } as WsUserData,
          requestRaw.headers['sec-websocket-key'],
          requestRaw.headers['sec-websocket-protocol'],
          requestRaw.headers['sec-websocket-extensions'],
          requestRaw[kWs],
        );
      } else {
        return handler.call(this, request, reply);
      }
    };
  });

  next();
}

export default fp(fastifyUws, {
  fastify: '5.x',
  name: '@fastify/websocket',
});
