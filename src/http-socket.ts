import type uws from 'uWebSockets.js';
import { EventEmitter } from 'node:events';
import { ERR_STREAM_DESTROYED } from './errors';
import type { Server } from './server';
import {
  kAddress,
  kClientError,
  kEncoding,
  kHead,
  kHttps,
  kReadyState,
  kRemoteAddress,
  kRes,
  kServer,
  kTimeoutRef,
  kUwsRemoteAddress,
  kWriteOnly,
  kWs,
} from './symbols';

const localAddressIpv6 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

const toHex = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('hex');

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

const noop = () => {};

export interface UwsHead {
  status?: string;
  headers?: Map<string, { name: string; value: any; isMultiValue: boolean }>;
}

function onAbort(this: HTTPSocket) {
  this._clearTimeout();
  this.aborted = true;
  // Resolve any pending drain before emitting events
  this._resolveDrain();
  this.emit('aborted');
  if (this.errored) this.emit('error', this.errored);
  this.emit('close');
}

function onDrain(this: HTTPSocket, _offset: number) {
  this._resolveDrain();
  return true;
}

function onTimeout(this: HTTPSocket) {
  if (!this.destroyed) {
    this.emit('timeout');
    this.abort();
  }
}

function writeHead(res: uws.HttpResponse, head: UwsHead) {
  if (head.status) res.writeStatus(head.status);
  if (head.headers) {
    for (const header of head.headers.values()) {
      if (header.isMultiValue) {
        for (const value of header.value) {
          res.writeHeader(header.name, value);
        }
      } else {
        res.writeHeader(header.name, header.value);
      }
    }
  }
}

function byteLength(data: { byteLength?: number; empty?: boolean } | Buffer | string): number {
  if ((data as any).empty) return 0;
  if ((data as any).byteLength !== undefined) return (data as any).byteLength;
  return Buffer.byteLength(data as string | Buffer);
}

function getChunk(data: any): any {
  if (data?.chunk) return data.chunk;
  return data;
}

export class HTTPSocket extends EventEmitter {
  aborted = false;
  writableNeedDrain = false;
  bytesRead = 0;
  bytesWritten = 0;
  writableEnded = false;
  errored: Error | null = null;
  drainTimeout = DEFAULT_DRAIN_TIMEOUT_MS;
  _drainCb: (() => void) | null = null;
  _drainTimer: NodeJS.Timeout | null = null;
  _pendingData: any = null;
  _pendingCb: () => void = noop;
  _boundCorkWrite: () => void;
  _boundCorkEnd: () => void;
  _boundDrainTimeout: () => void;

  [kServer]: Server;
  [kRes]: uws.HttpResponse;
  [kWriteOnly]: boolean;
  [kReadyState]: { read: boolean; write: boolean } = { read: false, write: false };
  [kEncoding]: string | null = null;
  [kRemoteAddress]: string | null = null;
  [kUwsRemoteAddress]: Buffer | null = null;
  [kHead]: UwsHead | null = null;
  [kClientError] = false;
  [kTimeoutRef]?: NodeJS.Timeout;
  [kWs]?: boolean;

  constructor(server: Server, res: uws.HttpResponse, writeOnly: boolean) {
    super();

    this[kServer] = server;
    this[kRes] = res;
    this[kWriteOnly] = writeOnly;

    if (server.drainTimeout) {
      this.drainTimeout = server.drainTimeout;
    }

    this._boundCorkWrite = this._corkWrite.bind(this);
    this._boundCorkEnd = this._corkEnd.bind(this);
    this._boundDrainTimeout = this._onDrainTimeout.bind(this);

    // Prevent unhandled 'error' event crash — errors propagate via destroy chain
    this.once('error', noop);
    res.onAborted(onAbort.bind(this));
    res.onWritable(onDrain.bind(this));

    if (server.timeout) {
      this[kTimeoutRef] = setTimeout(onTimeout.bind(this), server.timeout);
    }
  }

  get readyState() {
    const state = this[kReadyState];
    if (state.read && !state.write) return 'readOnly';
    if (!state.read && state.write) return 'writeOnly';
    if (state.read) return 'open';
    return 'opening';
  }

  get writable() {
    return true;
  }

  get readable() {
    return true;
  }

  get encrypted() {
    return !!this[kServer][kHttps];
  }

  get remoteAddress() {
    if (this.aborted) return undefined;

    let remoteAddress = this[kRemoteAddress];
    if (remoteAddress) return remoteAddress;

    let buf = this[kUwsRemoteAddress];
    if (!buf) {
      buf = this[kUwsRemoteAddress] = Buffer.copyBytesFrom(
        new Uint8Array(this[kRes].getRemoteAddress()),
      );
    }

    if (buf.length === 4) {
      remoteAddress = `${buf.readUInt8(0)}.${buf.readUInt8(1)}.${buf.readUInt8(2)}.${buf.readUInt8(3)}`;
    } else {
      // avoid to call toHex if local
      if (buf.equals(localAddressIpv6)) {
        remoteAddress = '::1';
      } else {
        remoteAddress = `${toHex(buf, 0, 2)}:${toHex(buf, 2, 4)}:${toHex(buf, 4, 6)}:${toHex(buf, 6, 8)}:${toHex(buf, 8, 10)}:${toHex(buf, 10, 12)}:${toHex(buf, 12, 14)}:${toHex(buf, 14, buf.length)}`;
      }
    }

    this[kRemoteAddress] = remoteAddress;
    return remoteAddress;
  }

  get remoteFamily() {
    if (this.aborted) return undefined;

    if (!this[kUwsRemoteAddress]) {
      this[kUwsRemoteAddress] = Buffer.copyBytesFrom(new Uint8Array(this[kRes].getRemoteAddress()));
    }

    return this[kUwsRemoteAddress].length === 4 ? 'IPv4' : 'IPv6';
  }

  get destroyed() {
    return this.writableEnded || this.aborted;
  }

  address() {
    return { ...this[kServer][kAddress] };
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    if (!this[kWs] && !this.writableEnded) {
      this[kRes].close();
    }
  }

  setEncoding(encoding: string) {
    this[kEncoding] = encoding;
  }

  setTimeout(timeout: number) {
    this._clearTimeout();
    if (timeout) {
      this[kTimeoutRef] = setTimeout(onTimeout.bind(this), timeout);
    }
  }

  destroy(err?: Error) {
    if (this.aborted) return;
    this._clearTimeout();
    this.errored = err || null;
    this.abort();
  }

  onRead(cb: (err: Error | null, chunk: Buffer | string | null) => void) {
    if (this[kWriteOnly] || this.aborted) return cb(null, null);

    let done = false;
    this[kReadyState].read = true;
    const encoding = this[kEncoding];
    try {
      this[kRes].onData((ab, isLast) => {
        if (done) return;

        this.bytesRead += ab.byteLength;

        const data = encoding
          ? Buffer.copyBytesFrom(new Uint8Array(ab)).toString(encoding as BufferEncoding)
          : Buffer.copyBytesFrom(new Uint8Array(ab));

        this.emit('data', data);

        cb(null, data);
        if (isLast) {
          done = true;
          cb(null, null);
        }
      });
    } catch (err: any) {
      done = true;
      this.destroy(err);
      cb(err, null);
    }
  }

  end(data: any, _?: any, cb: () => void = noop) {
    if (this.aborted) throw new ERR_STREAM_DESTROYED();

    this.writableEnded = true;
    this._clearTimeout();

    this._pendingData = data;
    this._pendingCb = cb;
    this[kRes].cork(this._boundCorkEnd);
  }

  write(data: any, _?: any, cb: () => void = noop) {
    if (this.destroyed) throw new ERR_STREAM_DESTROYED();

    if (this[kClientError] && typeof data === 'string' && data.startsWith('HTTP/')) {
      const [header, body] = data.split('\r\n\r\n');
      const [first, ...headersLines] = header.split('\r\n');
      const [, code, statusText] = first.split(' ');
      const headersMap = new Map<string, { name: string; value: any; isMultiValue: boolean }>();
      for (const line of headersLines) {
        const [name, ...valueParts] = line.split(': ');
        const value = valueParts.join(': ').trim();
        if (name.toLowerCase() !== 'content-length') {
          headersMap.set(name.toLowerCase(), { name, value, isMultiValue: false });
        }
      }
      this[kHead] = {
        headers: headersMap,
        status: `${code} ${statusText}`,
      };
      data = body;
      return this.end(data, _, cb);
    }

    this[kReadyState].write = true;

    this._pendingData = data;
    this._pendingCb = cb;
    this[kRes].cork(this._boundCorkWrite);

    return !this.writableNeedDrain;
  }

  _corkWrite() {
    const cb = this._pendingCb;
    if (this.aborted) return cb();

    const res = this[kRes];
    if (this[kHead]) {
      writeHead(res, this[kHead]);
      this[kHead] = null;
    }

    const drained = res.write(getChunk(this._pendingData));
    this.bytesWritten += byteLength(this._pendingData);

    if (drained) return cb();

    // Backpressure: store callback, invoke when uWS signals writable
    this.writableNeedDrain = true;
    this._drainCb = cb;
    this._drainTimer = setTimeout(this._boundDrainTimeout, this.drainTimeout);
  }

  _corkEnd() {
    const cb = this._pendingCb;
    if (this.aborted) return cb();

    const res = this[kRes];
    if (this[kHead]) {
      writeHead(res, this[kHead]);
      this[kHead] = null;
    }

    const data = this._pendingData;
    res.end(data ? getChunk(data) : undefined);
    if (data) this.bytesWritten += byteLength(data);
    this.emit('close');
    this.emit('finish');
    cb();
  }

  _onDrainTimeout() {
    this._drainTimer = null;
    const cb = this._drainCb;
    this._drainCb = null;
    this.destroy(new Error('drain timeout'));
    if (cb) cb();
  }

  _resolveDrain() {
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    const cb = this._drainCb;
    if (cb) {
      this._drainCb = null;
      this.writableNeedDrain = false;
      cb();
    }
  }

  _clearTimeout() {
    this[kTimeoutRef] && clearTimeout(this[kTimeoutRef]);
  }
}
