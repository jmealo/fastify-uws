import uws from 'uWebSockets.js';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { METHODS } from 'node:http';
import type { ServerOptions } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'eventemitter3';
import type { FastifyServerFactoryHandler, FastifyServerOptions } from 'fastify';
import ipaddr from 'ipaddr.js';

import {
  ERR_ADDRINUSE,
  ERR_ENOTFOUND,
  ERR_INVALID_METHOD,
  ERR_SERVER_DESTROYED,
  ERR_SOCKET_BAD_PORT,
} from './errors';
import { HTTPSocket } from './http-socket';
import { Request } from './request';
import { Response } from './response';
import {
  kAddress,
  kApp,
  kClientError,
  kClosed,
  kHandler,
  kHttps,
  kListen,
  kListenAll,
  kListening,
  kListenSocket,
  kTempFiles,
  kWs,
} from './symbols';
import type { WebSocketServer } from './websocket-server';

interface FastifyUwsOptions extends FastifyServerOptions {
  http2?: boolean;
  https?: ServerOptions | null;
}

function resolveFileOrBuffer(
  value: string | Buffer | string[] | Buffer[] | undefined,
  label: string,
  tempFiles: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;

  // Unwrap single-element arrays; reject multi-element (uWS limitation)
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    if (value.length > 1) {
      throw new Error(`fastify-uws: multiple ${label} values are not supported by uWebSockets.js`);
    }
    value = value[0];
  }

  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) {
    const tmp = path.join(os.tmpdir(), `fastify-uws-${label}-${process.pid}-${Date.now()}.pem`);
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    tempFiles.push(tmp);
    return tmp;
  }
  return undefined;
}

function createApp(opts: Pick<FastifyUwsOptions, 'http2' | 'https'>): {
  app: uws.TemplatedApp;
  tempFiles: string[];
} {
  if (opts.https) {
    const tempFiles: string[] = [];
    const keyPath = resolveFileOrBuffer(
      opts.https.key as string | Buffer | string[] | Buffer[] | undefined,
      'key',
      tempFiles,
    );
    const certPath = resolveFileOrBuffer(
      opts.https.cert as string | Buffer | string[] | Buffer[] | undefined,
      'cert',
      tempFiles,
    );
    const caPath = resolveFileOrBuffer(
      opts.https.ca as string | Buffer | string[] | Buffer[] | undefined,
      'ca',
      tempFiles,
    );

    const sslOpts: Record<string, string> = {};
    if (keyPath) sslOpts.key_file_name = keyPath;
    if (certPath) sslOpts.cert_file_name = certPath;
    if (caPath) sslOpts.ca_file_name = caPath;
    if (opts.https.passphrase) sslOpts.passphrase = opts.https.passphrase as string;

    return { app: uws.SSLApp(sslOpts), tempFiles };
  }

  return { app: uws.App(), tempFiles: [] };
}

const VALID_METHODS = new Map(METHODS.map((method) => [method.toLowerCase(), method]));

// Port → Server map for WebSocket server sharing across Fastify instances on the same port
const mainServer: Record<number, Server> = {};

export class Server extends EventEmitter {
  [kHandler]: FastifyServerFactoryHandler;
  timeout?: number;
  [kHttps]?: FastifyUwsOptions['https'];
  [kWs]?: WebSocketServer | null;
  [kAddress]?: null | any;
  [kListenSocket]?: null | any;
  [kApp]: uws.TemplatedApp;
  [kClosed]?: boolean;
  [kListenAll]?: boolean;
  [kListening]?: boolean;
  [kTempFiles]: string[];

  constructor(handler: FastifyServerFactoryHandler, opts: FastifyUwsOptions = {}) {
    super();

    const { http2 = false, https = null, connectionTimeout = 0 } = opts;

    this[kHandler] = handler;
    this.timeout = connectionTimeout;
    this[kHttps] = https;
    this[kWs] = null;
    this[kAddress] = null;
    this[kListenSocket] = null;
    const { app, tempFiles } = createApp({ http2, https });
    this[kApp] = app;
    this[kTempFiles] = tempFiles;
    this[kClosed] = false;
  }

  get encrypted() {
    return !!this[kHttps];
  }

  get listening() {
    return this[kListening];
  }

  setTimeout(timeout: number) {
    this.timeout = timeout;
  }

  address() {
    return this[kAddress];
  }

  listen(listenOptions: { host: string; port: number; signal?: AbortSignal }, cb?: () => void) {
    if (listenOptions?.signal) {
      listenOptions.signal.addEventListener(
        'abort',
        () => {
          this.close();
        },
        { once: true },
      );
    }

    this[kListen](listenOptions)
      .then(() => {
        this[kListening] = true;
        cb?.();
        this.emit('listening');
      })
      .catch((err) => {
        this[kAddress] = null;
        process.nextTick(() => this.emit('error', err));
      });
  }

  closeIdleConnections() {
    // no-op: uWS manages connections internally
  }

  close(cb = () => {}) {
    if (this[kClosed]) return cb();
    const port = this[kAddress]?.port;
    if (port !== undefined && mainServer[port] === this) {
      delete mainServer[port];
    }
    this[kAddress] = null;
    this[kListening] = false;
    this[kClosed] = true;
    if (this[kListenSocket]) {
      uws.us_listen_socket_close(this[kListenSocket]);
      this[kListenSocket] = null;
    }
    if (this[kWs]) {
      for (const conn of this[kWs].connections) {
        conn.close();
      }
    }
    for (const f of this[kTempFiles]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    this[kTempFiles] = [];
    process.nextTick(() => {
      this.emit('close');
      cb();
    });
  }

  ref() {}

  unref() {}

  async [kListen]({ port: rawPort, host }: { port?: number; host: string }) {
    if (this[kClosed]) throw new ERR_SERVER_DESTROYED();

    if (rawPort !== undefined && rawPort !== null && Number.isNaN(Number(rawPort))) {
      throw new ERR_SOCKET_BAD_PORT(rawPort);
    }

    let port: number = rawPort === undefined || rawPort === null ? 0 : Number(rawPort);

    const lookupAddress = await dns.lookup(host);

    this[kAddress] = {
      ...lookupAddress,
      port,
    };

    if (this[kAddress].address.startsWith('[')) throw new ERR_ENOTFOUND(this[kAddress].address);

    const parsedAddress = ipaddr.parse(this[kAddress].address);
    this[kAddress].family = parsedAddress.kind() === 'ipv6' ? 'IPv6' : 'IPv4';
    const longAddress = parsedAddress.toNormalizedString();

    const app = this[kApp];

    const onRequest = (res: uws.HttpResponse, req: uws.HttpRequest) => {
      const method = VALID_METHODS.get(req.getMethod());
      const socket = new HTTPSocket(this, res, method === 'GET' || method === 'HEAD');

      if (!method) {
        socket[kClientError] = true;
        this.emit('clientError', new ERR_INVALID_METHOD(), socket);
        return;
      }

      const request = new Request(req, socket, method);
      const response = new Response(socket);
      if (request.headers.upgrade) {
        this.emit('upgrade', request, socket);
      }
      this[kHandler](request as any, response as any);
    };

    app.any('/*', onRequest);

    if (port !== 0 && mainServer[port]) {
      this[kWs] = mainServer[port][kWs];
    }

    if (this[kWs]) {
      this[kWs].addServer(this);
    }

    return new Promise<void>((resolve, reject) => {
      const onListen = (listenSocket: uws.us_listen_socket | false) => {
        if (!listenSocket) return reject(new ERR_ADDRINUSE(this[kAddress].address, port));
        this[kListenSocket] = listenSocket;
        port = this[kAddress].port = uws.us_socket_local_port(listenSocket);
        if (!mainServer[port]) mainServer[port] = this;
        resolve();
      };

      this[kListenAll] = host === 'localhost';
      if (this[kListenAll]) {
        app.listen(port, onListen);
      } else {
        app.listen(longAddress, port, onListen);
      }
    });
  }
}
