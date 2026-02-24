import type {
  ContextConfigDefault,
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  FastifySchema,
  FastifyServerFactory,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
  RequestGenericInterface,
} from 'fastify';
import { Server } from './server';
import { Request } from './request';
import { Response } from './response';
import { WebSocket as UwsWebSocket, WebSocketServer, WebSocketStream } from './websocket-server';

export type UwsServer = RawServerDefault & Server;
export type UwsRequest = Request;
export type UwsResponse = Response;

export type FastifyUwsInstance<
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
> = FastifyInstance<any, any, any, Logger, TypeProvider>;

export type FastifyUwsRequest<
  RequestGeneric extends RequestGenericInterface = RequestGenericInterface,
  SchemaCompiler extends FastifySchema = FastifySchema,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
  ContextConfig = ContextConfigDefault,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
> = FastifyRequest<RequestGeneric, any, any, SchemaCompiler, TypeProvider, ContextConfig, Logger>;

export type FastifyUwsReply<
  RequestGeneric extends RequestGenericInterface = RequestGenericInterface,
  SchemaCompiler extends FastifySchema = FastifySchema,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
  ContextConfig = ContextConfigDefault,
> = FastifyReply<RequestGeneric, any, any, any, ContextConfig, SchemaCompiler, TypeProvider>;

export const serverFactory: FastifyServerFactory<any> = (handler, options) => {
  return new Server(handler as any, options);
};

export { default as websocket } from './plugin-websocket';
export { UwsWebSocket as WebSocket, WebSocketServer, WebSocketStream, Server, Request, Response };

declare module 'fastify' {
  interface RouteOptions {
    websocket?: boolean;
  }

  // biome-ignore lint/correctness/noUnusedVariables: must match Fastify's type parameter name for declaration merging
  interface RouteShorthandOptions<RawServer extends RawServerBase = RawServerDefault> {
    websocket?: boolean;
  }

  interface RouteShorthandMethod<
    RawServer extends RawServerBase = RawServerDefault,
    RawRequest extends
      RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
    RawReply extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
    // biome-ignore lint/correctness/noUnusedVariables: must match Fastify's type parameter name for declaration merging
    TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
    // biome-ignore lint/correctness/noUnusedVariables: must match Fastify's type parameter name for declaration merging
    Logger extends FastifyBaseLogger = FastifyBaseLogger,
  > {
    <
      RequestGeneric extends RequestGenericInterface = RequestGenericInterface,
      ContextConfig = ContextConfigDefault,
      SchemaCompiler extends FastifySchema = FastifySchema,
      TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
      Logger extends FastifyBaseLogger = FastifyBaseLogger,
    >(
      path: string,
      opts: RouteShorthandOptions<
        RawServer,
        RawRequest,
        RawReply,
        RequestGeneric,
        ContextConfig,
        SchemaCompiler,
        TypeProvider,
        Logger
      > & { websocket: true },
      handler?: (
        socket: UwsWebSocket,
        req: FastifyRequest<
          RequestGeneric,
          RawServer,
          RawRequest,
          SchemaCompiler,
          TypeProvider,
          ContextConfig,
          Logger
        >,
      ) => void | Promise<any>,
    ): FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>;
  }
}
