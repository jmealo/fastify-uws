import type {
  ContextConfigDefault,
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
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
import type WebSocket from 'ws';
import { Server } from './server';

export const serverFactory: FastifyServerFactory<any> = (handler, options) => {
  return new Server(handler as any, options);
};

export { default as websocket } from './plugin-websocket';

declare module 'fastify' {
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
        socket: WebSocket,
        req: FastifyRequest<
          RequestGeneric,
          RawServer,
          RawRequest,
          SchemaCompiler,
          TypeProvider,
          ContextConfig,
          Logger
        >,
      ) => undefined | Promise<any>,
    ): FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>;
  }
}
