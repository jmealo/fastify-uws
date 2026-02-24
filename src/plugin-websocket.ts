import type { FastifyPluginCallback, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';

import { kRes, kWs } from './symbols';
import type { WsUserData } from './websocket-server';
import { WebSocket, WebSocketServer } from './websocket-server';

const WS_KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

export function isValidWebSocketKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!WS_KEY_PATTERN.test(value)) return false;
  return Buffer.from(value, 'base64').byteLength === 16;
}

function defaultErrorHandler(err: Error, conn: WebSocket, request: FastifyRequest) {
  request.log.error(err);
  conn.close();
}

const fastifyUws: FastifyPluginCallback<
  {
    errorHandler?: typeof defaultErrorHandler;
    options?: any;
  },
  any
> = (fastify, opts, next) => {
  const { server } = fastify;
  const { errorHandler = defaultErrorHandler, options } = opts;

  if (errorHandler && typeof errorHandler !== 'function') {
    return next(new Error('invalid errorHandler function'));
  }

  const websocketServer = new WebSocketServer(options);
  (server as any)[kWs] = websocketServer;

  (fastify as any).decorate('websocketServer', websocketServer);

  fastify.addHook('onRoute', (routeOptions: RouteOptions & { websocket?: boolean; ws?: any }) => {
    const isWebSocket = !!routeOptions.websocket;
    if (!isWebSocket || routeOptions.method === 'HEAD' || routeOptions.method === 'OPTIONS') return;

    const wsOptions = typeof routeOptions.ws === 'object' ? routeOptions.ws : {};
    const handler = routeOptions.handler as unknown as (this: any, socket: WebSocket, request: FastifyRequest, reply: FastifyReply) => void | Promise<any>;
    const namespace = Buffer.from(routeOptions.url || '/');

    const topics: Record<string, Buffer> = {};
    if (wsOptions.topics) {
      for (const topic of wsOptions.topics) {
        topics[topic] = WebSocket.allocTopic(namespace, topic) as Buffer;
      }
    }

    routeOptions.handler = function (this: any, request: FastifyRequest, reply: FastifyReply) {
      const requestRaw = request.raw as any;
      if (requestRaw[kWs]) {
        const wsKey = requestRaw.headers['sec-websocket-key'];
        if (!isValidWebSocketKey(wsKey)) {
          reply.code(400).send('Invalid sec-websocket-key header');
          return;
        }
        reply.hijack();
        const uRes = requestRaw.socket[kRes];
        requestRaw.socket[kWs] = true;
        if (requestRaw.socket.aborted || (requestRaw.socket as any).destroyed) return;
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

                result = (handler as any).call(this, conn, request, reply);
              } catch (err) {
                return errorHandler.call(this, err as Error, conn, request);
              }

              if (result && typeof result.catch === 'function') {
                result.catch((err: any) => errorHandler.call(this, err, conn, request));
              }
            },
          } as WsUserData,
          requestRaw.headers['sec-websocket-key'],
          requestRaw.headers['sec-websocket-protocol'],
          requestRaw.headers['sec-websocket-extensions'],
          requestRaw[kWs],
        );
      } else {
        return (handler as any).call(this, request, reply);
      }
    };
  });

  next();
};

export default fp(fastifyUws, {
  fastify: '5.x',
  name: '@fastify/websocket',
});
