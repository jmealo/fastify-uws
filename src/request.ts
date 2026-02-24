import type uws from 'uWebSockets.js';
import { Readable } from 'streamx';

import type { HTTPSocket } from './http-socket';
import { kHeaders, kUrl, kWs } from './symbols';

const noop = () => {};

function onAbort(this: Request) {
  (this as any).emit('aborted');
}
export class Request extends Readable {
  socket: HTTPSocket;
  method: string;
  httpVersion: string;
  readableEnded: boolean;
  [kUrl]: string;
  [kHeaders]: Record<string, string>;
  [kWs]?: uws.us_socket_context_t;

  constructor(req: uws.HttpRequest, socket: HTTPSocket, method: string) {
    super();

    this.socket = socket;
    this.method = method;
    this.httpVersion = '1.1';
    this.readableEnded = false;

    // Eagerly cache url and headers - uWS invalidates HttpRequest after handler returns
    const query = req.getQuery();
    this[kUrl] = req.getUrl() + (query && query.length > 0 ? `?${query}` : '');
    const headers: Record<string, string> = {};
    req.forEach((k, v) => {
      headers[k] = v;
    });
    this[kHeaders] = headers;

    // Prevent unhandled 'error' event crash — errors propagate via destroy chain
    this.once('error', noop);
    const destroy = super.destroy.bind(this);
    socket.once('error', destroy);
    socket.once('close', destroy);
    socket.once('aborted', onAbort.bind(this));
  }

  get aborted() {
    return this.socket.aborted;
  }

  get url() {
    return this[kUrl];
  }

  set url(url) {
    this[kUrl] = url;
  }

  get headers() {
    return this[kHeaders];
  }

  setEncoding(encoding: string) {
    this.socket.setEncoding(encoding);
  }

  setTimeout(timeout: number) {
    this.socket.setTimeout(timeout);
  }

  destroy(err?: Error) {
    if (this.destroyed || this.destroying) return;
    this.socket.destroy(err);
  }

  unpipe(writable: any) {
    // Intentionally more aggressive than Node.js — destroy writable to prevent stale uWS response references
    writable.destroy();
  }

  _read(cb: (err?: Error | null) => void) {
    if (this.destroyed || this.destroying || this.socket.destroyed) return cb();

    this.socket.onRead((err, data) => {
      if (err) return cb(err);

      if (this.destroyed || this.destroying) return cb();

      this.push(data);

      if (!data) {
        this.readableEnded = true;
        cb();
      }
    });
  }
}
