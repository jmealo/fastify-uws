import { STATUS_CODES } from 'node:http';
import { Writable } from 'streamx';

import { ERR_HEAD_SET, ERR_STREAM_DESTROYED } from './errors';
import type { HTTPSocket } from './http-socket';
import { kHead, kHeaders } from './symbols';

class Header {
  isMultiValue: boolean;
  name: string;
  value: unknown;

  constructor(name: string, value: unknown) {
    this.isMultiValue = Array.isArray(value);
    this.name = name;
    this.value = this.isMultiValue ? value : String(value);
  }
}

const EMPTY = Buffer.alloc(0);

function httpResponse(chunk?: any, end = false) {
  if (!chunk) return { chunk: EMPTY, empty: true, end, byteLength: 0 };
  return {
    chunk,
    empty: false,
    end,
    byteLength: Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk),
  };
}

function onAbort(this: Response) {
  (this as any).emit('aborted');
}

const noop = () => {};

const options = {
  byteLength(data: { byteLength: number }): number {
    return data.byteLength;
  },
};

export class Response extends Writable {
  socket: HTTPSocket;
  statusCode: number;
  statusMessage?: string;
  headersSent: boolean;
  chunked: boolean;
  contentLength: number | null;
  writableEnded: boolean;
  firstChunk: boolean;
  _boundEmitDrain: () => void;
  [kHeaders]: Map<string, Header>;

  constructor(socket: HTTPSocket) {
    super(options);

    this.socket = socket;
    this.statusCode = 200;
    this.headersSent = false;
    this.chunked = false;
    this.contentLength = null;
    this.writableEnded = false;
    this.firstChunk = true;
    this._boundEmitDrain = this._emitDrain.bind(this);

    this[kHeaders] = new Map();

    const destroy = this.destroy.bind(this);
    // Prevent unhandled 'error' event crash — errors propagate via destroy chain
    this.once('error', noop);
    socket.once('error', destroy);
    socket.once('close', destroy);
    socket.once('aborted', onAbort.bind(this));
  }

  get aborted() {
    return this.socket.aborted;
  }

  get finished() {
    return this.socket.writableEnded && !this.socket.aborted;
  }

  get status() {
    return `${this.statusCode} ${this.statusMessage || STATUS_CODES[this.statusCode]}`;
  }

  get bytesWritten() {
    return this.socket.bytesWritten;
  }

  hasHeader(name: string) {
    return this[kHeaders].has(name.toLowerCase());
  }

  getHeader(name: string) {
    return this[kHeaders].get(name.toLowerCase())?.value;
  }

  getHeaders() {
    const headers = {} as Record<string, string>;
    this[kHeaders].forEach((header, key) => {
      headers[key] = header.value as string;
    });
    return headers;
  }

  setHeader(name: string, value: string | string[] | number) {
    if (this.headersSent) throw new ERR_HEAD_SET();

    // Sanitize CRLF from header name to prevent injection
    name = name.replace(/[\r\n]/g, '');
    const key = name.toLowerCase();

    if (key === 'content-length') {
      this.contentLength = Number(value);
      return;
    }

    if (key === 'transfer-encoding') {
      this.chunked = (value as string).includes('chunked');
      return;
    }

    // Sanitize CRLF from header value to prevent injection
    if (typeof value === 'string') {
      value = value.replace(/[\r\n]/g, '');
    } else if (Array.isArray(value)) {
      value = value.map((v) => (typeof v === 'string' ? v.replace(/[\r\n]/g, '') : v));
    }

    this[kHeaders].set(key, new Header(name, value));
  }

  removeHeader(name: string) {
    if (this.headersSent) throw new ERR_HEAD_SET();

    this[kHeaders].delete(name.toLowerCase());
  }

  writeHead(
    statusCode: number,
    statusMessage?: string | Record<string, any>,
    headers?: Record<string, any>,
  ) {
    if (this.headersSent) throw new ERR_HEAD_SET();

    this.statusCode = statusCode;

    if (typeof statusMessage === 'object') {
      headers = statusMessage;
    } else if (statusMessage) {
      // Sanitize CRLF to prevent status line injection
      this.statusMessage =
        typeof statusMessage === 'string' ? statusMessage.replace(/[\r\n]/g, '') : statusMessage;
    }

    if (headers) {
      for (const key of Object.keys(headers)) {
        this.setHeader(key, headers[key]);
      }
    }
  }

  end(data?: any, _?: any, callback?: () => void) {
    if (typeof data === 'function') {
      callback = data;
      data = undefined;
    } else if (typeof _ === 'function') {
      callback = _;
    }
    if (this.aborted) {
      if (callback) process.nextTick(callback);
      return;
    }
    if (this.destroyed) throw new ERR_STREAM_DESTROYED();
    this.writableEnded = true;
    if (callback) this.once('finish', callback);
    return super.end(httpResponse(data, true));
  }

  addTrailers() {
    // no-op: uWS does not support trailers
  }

  destroy(err?: Error) {
    if (this.destroyed || this.destroying || this.aborted) return;
    this.socket.destroy(err);
  }

  write(data: any): boolean {
    if (this.aborted) return false;
    if (this.destroyed) throw new ERR_STREAM_DESTROYED();

    const resp = httpResponse(data);

    // Content-length fast-end: single chunk matches expected length
    if (this.firstChunk && this.contentLength !== null && this.contentLength === resp.byteLength) {
      resp.end = true;
      this.writableEnded = true;
      super.end(resp);
      return true;
    }

    this.firstChunk = false;

    // Ensure headers are queued for the socket
    if (!this.headersSent) {
      this.headersSent = true;
      this.socket[kHead] = {
        headers: this[kHeaders],
        status: this.status,
      };
    }

    // Fast path: write directly to socket, bypassing streamx queue.
    // The drain callback emits 'drain' on this Response when backpressure clears.
    this.socket.write(resp, null, this._boundEmitDrain);
    return !this.socket.writableNeedDrain;
  }

  _emitDrain() {
    this.emit('drain');
  }

  _write(data: any, cb: (err?: Error | null) => void) {
    if (this.aborted) return cb();

    if (!this.headersSent) {
      this.headersSent = true;
      this.socket[kHead] = {
        headers: this[kHeaders],
        status: this.status,
      };
    }

    if (data.end) {
      this.socket.end(data, null, cb);
      return;
    }

    this.socket.write(data, null, cb);
  }

  _destroy(cb: (err?: Error | null) => void) {
    if (this.socket.destroyed) return cb();
    this.socket.once('close', cb);
  }
}
