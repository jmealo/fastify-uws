import type uws from 'uWebSockets.js';
import { Readable, Writable } from 'node:stream';
import fp from 'fastify-plugin';

import type { HTTPSocket } from './http-socket';
import { kHead, kRes } from './symbols';

const DRAIN_TIMEOUT_MS = 30_000;
const FLUSH_BATCH_SIZE = 32;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024; // 1 MB

// SSE fields (id, event, retry) must be single-line; strip CR/LF to prevent event injection
function sanitizeField(value: string): string {
  return String(value).replace(/[\r\n]/g, '');
}

/**
 * Format an SSE message according to the WHATWG Server-Sent Events specification.
 */
// Split on all line ending styles: CRLF, CR, or LF
const LINE_SPLIT_RE = /\r\n|\r|\n/;

function formatSSEMessage(message: any, serializer: (data: any) => string): string {
  let payload = '';

  if (typeof message === 'string') {
    for (const line of message.split(LINE_SPLIT_RE)) {
      payload += `data: ${line}\n`;
    }
  } else if (Buffer.isBuffer(message)) {
    const str = message.toString('utf-8');
    for (const line of str.split(LINE_SPLIT_RE)) {
      payload += `data: ${line}\n`;
    }
  } else {
    if (message.id) payload += `id: ${sanitizeField(message.id)}\n`;
    if (message.event) payload += `event: ${sanitizeField(message.event)}\n`;
    if (message.data !== undefined) {
      const dataStr = serializer(message.data);
      for (const line of dataStr.split(LINE_SPLIT_RE)) {
        payload += `data: ${line}\n`;
      }
    }
    if (message.retry) payload += `retry: ${sanitizeField(String(message.retry))}\n`;
  }

  if (payload) payload += '\n';
  return payload;
}

const SSE_HEADERS = [
  { name: 'Content-Type', value: 'text/event-stream', isMultiValue: false },
  { name: 'Cache-Control', value: 'no-cache', isMultiValue: false },
  { name: 'Connection', value: 'keep-alive', isMultiValue: false },
  { name: 'X-Accel-Buffering', value: 'no', isMultiValue: false },
];

function isSSEMessage(value: any): boolean {
  return typeof value === 'object' && value !== null && 'data' in value;
}

function isAsyncIterable(value: any): boolean {
  return value != null && typeof value[Symbol.asyncIterator] === 'function';
}

function writeHead(res: uws.HttpResponse, head: any) {
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

class SSEContext {
  reply: any;
  serializer: (data: any) => string;
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  closeCallbacks: (() => void)[] = [];

  #socket: HTTPSocket;
  #res: uws.HttpResponse;
  #connected = true;
  #keepAlive = false;
  #headersSent = false;
  #lastEventId: string | null;
  #drainResolve: (() => void) | null = null;

  // Write-combining buffer: accumulate events, flush when batch is full
  #buffer = '';
  #bufferCount = 0;
  #backpressured = false;
  #drainPromise: Promise<void> | null = null;

  // Pre-bound methods
  #boundCorkFlush: () => void;

  // Cork state
  #corkDrained = true;

  constructor(opts: {
    reply: any;
    socket: HTTPSocket;
    lastEventId: string | null;
    heartbeatInterval: number;
    serializer: (data: any) => string;
  }) {
    this.reply = opts.reply;
    this.#socket = opts.socket;
    this.#res = opts.socket[kRes];
    this.#lastEventId = opts.lastEventId || null;
    this.serializer = opts.serializer;

    this.#boundCorkFlush = this._corkFlush.bind(this);

    const onDisconnect = () => {
      if (!this.#connected) return;
      this.#connected = false;
      this.#drainPromise = null;
      const resolve = this.#drainResolve;
      this.#drainResolve = null;
      if (resolve) resolve();
      this.cleanup();
    };

    opts.socket.once('close', onDisconnect);
    opts.socket.once('aborted', onDisconnect);

    if (opts.heartbeatInterval > 0) {
      this.startHeartbeat(opts.heartbeatInterval);
    }
  }

  get lastEventId(): string | null {
    return this.#lastEventId;
  }

  get isConnected(): boolean {
    return this.#connected;
  }

  get shouldKeepAlive(): boolean {
    return this.#keepAlive;
  }

  keepAlive(): void {
    this.#keepAlive = true;
  }

  flush(): void {
    if (this.#buffer && this.#connected) {
      this.#flush();
    }
  }

  close(): void {
    if (!this.#connected) return;
    // Flush any buffered events before marking disconnected
    if (this.#buffer) {
      this.#flush();
    }
    this.#connected = false;
    this.cleanup();
    if (!this.#socket.destroyed && !this.#socket.writableEnded) {
      try {
        this.#socket.end(undefined, undefined);
      } catch {}
    }
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
  }

  async replay(callback: (lastEventId: string) => Promise<void>): Promise<void> {
    if (!this.#lastEventId) return;
    await callback(this.#lastEventId);
  }

  sendHeaders(): void {
    if (this.#headersSent) return;
    this.#headersSent = true;

    const headers = new Map<string, { name: string; value: string; isMultiValue: boolean }>();
    for (const h of SSE_HEADERS) {
      headers.set(h.name.toLowerCase(), h);
    }

    try {
      const replyHeaders = this.reply.getHeaders();
      for (const [name, value] of Object.entries(replyHeaders)) {
        const key = name.toLowerCase();
        if (!headers.has(key)) {
          headers.set(key, { name, value: String(value), isMultiValue: false });
        }
      }
    } catch {}

    this.#socket[kHead] = {
      status: '200 OK',
      headers,
    };
  }

  async send(source: any): Promise<void> {
    if (!this.#connected) throw new Error('SSE connection is closed');

    if (typeof source === 'string' || Buffer.isBuffer(source) || isSSEMessage(source)) {
      const formatted = formatSSEMessage(source, this.serializer);
      return this.writeToSocket(formatted);
    }

    // Stream sources use batched writes (flush every FLUSH_BATCH_SIZE events)
    if (source instanceof Readable) {
      try {
        for await (const chunk of source) {
          if (!this.#connected) {
            source.destroy();
            break;
          }
          const formatted = formatSSEMessage(chunk, this.serializer);
          await this.writeToSocket(formatted);
        }
        // Flush remaining buffered events after stream ends
        if (this.#buffer && this.#connected) this.#flush();
      } catch (error: any) {
        if (this.#buffer && this.#connected) this.#flush();
        this.#connected = false;
        this.cleanup();
        if (error?.code !== 'ECONNRESET' && error?.code !== 'EPIPE') {
          this.reply.log?.error?.({ err: error }, 'Unexpected error in SSE stream');
        }
      }
      return;
    }

    if (isAsyncIterable(source)) {
      try {
        for await (const chunk of source) {
          if (!this.#connected) break;
          const formatted = formatSSEMessage(chunk, this.serializer);
          await this.writeToSocket(formatted);
        }
        // Flush remaining buffered events after iteration
        if (this.#buffer && this.#connected) this.#flush();
      } catch (error: any) {
        if (this.#buffer && this.#connected) this.#flush();
        this.#connected = false;
        this.cleanup();
        if (error?.code !== 'ECONNRESET' && error?.code !== 'EPIPE') {
          this.reply.log?.error?.({ err: error }, 'Unexpected error in SSE async iterable');
        }
      }
      return;
    }

    throw new TypeError('Invalid SSE source type');
  }

  stream(): Writable {
    if (!this.#connected) throw new Error('SSE connection is closed');

    const ctx = this;
    return new Writable({
      objectMode: true,
      write(chunk: any, _encoding: string, callback: (err?: Error | null) => void) {
        if (!ctx.#connected) {
          callback(new Error('SSE connection is closed'));
          return;
        }
        try {
          const formatted = formatSSEMessage(chunk, ctx.serializer);
          const result = ctx.writeToSocket(formatted);
          if (result === undefined) {
            callback();
          } else {
            result.then(() => callback(), callback);
          }
        } catch (error: any) {
          callback(error);
        }
      },
    });
  }

  /**
   * Write-combining SSE writer.
   *
   * Events are accumulated in a string buffer. When the buffer reaches
   * FLUSH_BATCH_SIZE events, all events are flushed in a single corked write
   * to the uWS HttpResponse. This reduces C++ boundary crossings from
   * one-per-event to one-per-batch.
   *
   * If there's active backpressure from a previous flush, the send() caller
   * receives a Promise that resolves when the drain completes.
   */
  writeToSocket(data: string): Promise<void> | undefined {
    if (!this.#connected) throw new Error('SSE connection is closed');
    this.sendHeaders();

    // Enforce buffer size limit to prevent unbounded memory growth
    if (this.#backpressured && this.#buffer.length + data.length > MAX_SSE_BUFFER_BYTES) {
      this.close();
      throw new Error('SSE buffer overflow: client too slow');
    }

    this.#buffer += data;
    this.#bufferCount++;

    // If previous flush had backpressure, return the shared drain promise
    if (this.#backpressured) {
      return this.#drainPromise!;
    }

    // Flush when batch is full
    if (this.#bufferCount >= FLUSH_BATCH_SIZE) {
      return this.#flush();
    }

    return undefined;
  }

  /**
   * Flush buffered events to the uWS HttpResponse in a single corked write.
   */
  #flush(): Promise<void> | undefined {
    if (!this.#buffer || !this.#connected) return undefined;

    this.#res.cork(this.#boundCorkFlush);

    this.#buffer = '';
    this.#bufferCount = 0;

    if (this.#corkDrained) return undefined;

    // Backpressure from the corked write — create a single shared promise
    this.#backpressured = true;
    this.#drainPromise = new Promise<void>((resolve) => {
      this.#drainResolve = resolve;
      this.#socket.writableNeedDrain = true;
      this.#socket._drainCb = () => {
        this.#socket.writableNeedDrain = false;
        this.#backpressured = false;
        this.#drainPromise = null;
        const r = this.#drainResolve;
        this.#drainResolve = null;
        if (r) r();
      };
      this.#socket._drainTimer = setTimeout(this.#socket._boundDrainTimeout, DRAIN_TIMEOUT_MS);
    });
    return this.#drainPromise;
  }

  /**
   * Pre-bound cork callback. Writes headers (first call only) + buffered data.
   */
  _corkFlush(): void {
    const head = this.#socket[kHead];
    if (head) {
      writeHead(this.#res, head);
      this.#socket[kHead] = null;
    }
    this.#corkDrained = this.#res.write(this.#buffer);
  }

  startHeartbeat(interval: number): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.#connected) {
        // Add heartbeat to buffer, flush immediately
        this.sendHeaders();
        this.#buffer += ': heartbeat\n\n';
        this.#bufferCount++;
        this.#flush();
      } else {
        this.stopHeartbeat();
      }
    }, interval);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  cleanup(): void {
    this.stopHeartbeat();
    for (const callback of this.closeCallbacks) {
      try {
        callback();
      } catch {}
    }
    this.closeCallbacks = [];
  }
}

function fastifySSE(fastify: any, opts: any, next: (err?: Error) => void) {
  const { heartbeatInterval = 30000, serializer = JSON.stringify } = opts;

  fastify.addHook('onRoute', (routeOptions: any) => {
    if (!routeOptions.sse) return;

    const originalHandler = routeOptions.handler;
    const sseOptions = typeof routeOptions.sse === 'object' ? routeOptions.sse : {};

    routeOptions.handler = async function sseHandler(this: any, request: any, reply: any) {
      const acceptHeader = request.headers.accept || '';
      if (!acceptHeader.includes('text/event-stream')) {
        return originalHandler.call(this, request, reply);
      }

      reply.hijack();

      const socket = request.raw.socket as HTTPSocket;
      if (socket.aborted || socket.destroyed) return;

      const context = new SSEContext({
        reply,
        socket,
        lastEventId: request.headers['last-event-id'] || null,
        heartbeatInterval: sseOptions.heartbeat !== false ? heartbeatInterval : 0,
        serializer: sseOptions.serializer || serializer,
      });

      reply.sse = context;

      try {
        await originalHandler.call(this, request, reply);
      } catch (error) {
        if (!context.shouldKeepAlive) context.close();
        throw error;
      }

      // Flush any buffered events after the handler returns
      context.flush();

      if (!context.shouldKeepAlive) context.close();
    };
  });

  next();
}

export { SSEContext };

export default fp(fastifySSE, {
  fastify: '5.x',
  name: '@fastify/sse',
});
