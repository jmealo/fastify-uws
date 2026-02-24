import uws from 'uWebSockets.js';
import { EventEmitter } from 'eventemitter3';
import { Duplex } from 'streamx';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HTTPSocket } from './http-socket';
import { Request } from './request';
import { Response } from './response';
import type { Server } from './server';
import { kApp, kEnded, kHandler, kTopic, kWs } from './symbols';

const defaultWebSocketConfig = {
  compression: uws.SHARED_COMPRESSOR,
  maxPayloadLength: 16 * 1024 * 1024,
  idleTimeout: 16,
};

const SEP = '!';
const SEP_BUFFER = Buffer.from(SEP);

export interface WsUserData {
  req: Request;
  handler: (ws: uws.WebSocket<WsUserData>) => void;
  websocket?: WebSocket;
}

export class WebSocket extends EventEmitter {
  namespace: Buffer;
  connection: uws.WebSocket<WsUserData>;
  topics: Record<string, Buffer>;
  [kEnded]: boolean;

  static allocTopic(namespace: Buffer, topic: Buffer | string) {
    if ((topic as any)[kTopic]) return topic;

    const buf = Buffer.concat([
      namespace,
      SEP_BUFFER,
      Buffer.isBuffer(topic) ? topic : Buffer.from(topic),
    ]);

    (buf as any)[kTopic] = true;
    return buf;
  }

  constructor(
    namespace: Buffer,
    connection: uws.WebSocket<WsUserData>,
    topics: Record<string, Buffer> = {},
  ) {
    super();

    this.namespace = namespace;
    this.connection = connection;
    (connection as unknown as WsUserData).websocket = this;
    this.topics = topics; // we maintain a cache of buffer topics
    this[kEnded] = false;
  }

  get uws() {
    return true;
  }

  allocTopic(topic: Buffer | string) {
    if (this.topics[topic as string]) return this.topics[topic as string];
    return WebSocket.allocTopic(this.namespace, topic);
  }

  send(message: uws.RecognizedString, isBinary: boolean, compress: boolean) {
    if (this[kEnded]) return;
    return this.connection.send(message, isBinary, compress);
  }

  publish(
    topic: Buffer | string,
    message: uws.RecognizedString,
    isBinary: boolean,
    compress: boolean,
  ) {
    if (this[kEnded]) return;
    return this.connection.publish(this.allocTopic(topic), message, isBinary, compress);
  }

  subscribe(topic: Buffer | string) {
    if (this[kEnded]) return;
    return this.connection.subscribe(this.allocTopic(topic));
  }

  unsubscribe(topic: Buffer | string) {
    if (this[kEnded]) return;
    return this.connection.unsubscribe(this.allocTopic(topic));
  }

  isSubscribed(topic: Buffer | string) {
    if (this[kEnded]) return false;
    return this.connection.isSubscribed(this.allocTopic(topic));
  }

  getTopics() {
    if (this[kEnded]) return [];
    return this.connection.getTopics().map((topic) => topic.slice(topic.indexOf(SEP) + 1));
  }

  close() {
    if (this[kEnded]) return;
    this[kEnded] = true;
    return this.connection.close();
  }

  end(code: number, shortMessage: uws.RecognizedString) {
    if (this[kEnded]) return;
    this[kEnded] = true;
    return this.connection.end(code, shortMessage);
  }

  cork(cb: () => void) {
    if (this[kEnded]) return;
    return this.connection.cork(cb);
  }

  getBufferedAmount() {
    if (this[kEnded]) return 0;
    return this.connection.getBufferedAmount();
  }

  ping(message: uws.RecognizedString) {
    if (this[kEnded]) return;
    return this.connection.ping(message);
  }
}

export class WebSocketStream extends Duplex {
  socket: WebSocket;

  constructor(
    socket: WebSocket,
    opts: {
      compress?: boolean | false;
      highWaterMark?: number | 16384;
      mapReadable?: (packet: { data: any; isBinary: boolean }) => any; // optional function to map input data
      byteLengthReadable?: (packet: { data: any; isBinary: boolean }) => number | 1024; // optional function that calculates the byte size of input data,
      mapWritable?: (data: any) => { data: any; isBinary: boolean; compress: boolean }; // optional function to map input data
      byteLengthWritable?: (packet: {
        data: any;
        isBinary: boolean;
        compress: boolean;
      }) => number | 1024; // optional function that calculates the byte size of input data
    } = {},
  ) {
    const { compress = false } = opts;

    super({
      highWaterMark: opts.highWaterMark,
      mapReadable: (packet: any) => {
        if (opts.mapReadable) return opts.mapReadable(packet);
        return packet.data;
      },
      byteLengthReadable: (packet: any) => {
        if (opts.byteLengthReadable) return opts.byteLengthReadable(packet);
        return packet.isBinary ? packet.data.byteLength : 1024;
      },
      mapWritable: (data: any) => {
        if (opts.mapWritable) return opts.mapWritable(data);
        return { data, isBinary: Buffer.isBuffer(data), compress };
      },
      byteLengthWritable: (packet: any) => {
        if (opts.byteLengthWritable) return opts.byteLengthWritable(packet);
        return packet.isBinary ? packet.data.byteLength : 1024;
      },
    });

    this.socket = socket;
    this._onMessage = this._onMessage.bind(this);
  }

  _open(cb: () => void) {
    this.socket.on('message', this._onMessage);
    cb();
  }

  _close(cb: () => void) {
    this.socket.off('message', this._onMessage);
    this.socket.close();
    cb();
  }

  _onMessage(data: any, isBinary: boolean) {
    this.push({ data, isBinary });
  }

  _write(packet: any, cb: (err?: Error | null) => void) {
    const status = this.socket.send(packet.data, packet.isBinary, packet.compress);
    if (status === 1) return cb();

    if (status === 0) {
      // Wait for uWS drain before marking this write as complete.
      const onDrain = () => {
        this.socket.off('close', onClose);
        cb();
      };
      const onClose = () => {
        this.socket.off('drain', onDrain);
        cb(new Error('WebSocket closed before drain'));
      };

      this.socket.once('drain', onDrain);
      this.socket.once('close', onClose);
      return;
    }

    if (status === 2) {
      return cb(new Error('WebSocket send dropped due to backpressure limit'));
    }

    cb(new Error('WebSocket is closed'));
  }
}

type WSOptions = {
  closeOnBackpressureLimit?: boolean;
  compression?: number;
  idleTimeout?: number;
  maxBackpressure?: number;
  maxLifetime?: number;
  maxPayloadLength?: number;
  sendPingsAutomatically?: boolean;
};

export class WebSocketServer extends EventEmitter {
  options: WSOptions & typeof defaultWebSocketConfig;
  connections: Set<uws.WebSocket<WsUserData>>;

  constructor(options: WSOptions = {}) {
    super();
    this.options = { ...defaultWebSocketConfig, ...options };
    this.connections = new Set();
  }

  addServer(server: Server) {
    const { options } = this;
    const app: uws.TemplatedApp = server[kApp];
    const listenerHandler = server[kHandler];

    app.ws<WsUserData>('/*', {
      upgrade: (res, req, context) => {
        const method = req.getMethod().toUpperCase();
        const socket = new HTTPSocket(server, res, method === 'GET' || method === 'HEAD');
        const request = new Request(req, socket, method);
        const response = new Response(socket);
        request[kWs] = context;
        server.emit('upgrade', request, socket);
        listenerHandler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
      },
      open: (ws) => {
        this.connections.add(ws);
        (ws as unknown as WsUserData).handler(ws);
        this.emit('open', ws);
      },
      close: (ws, code: number, message) => {
        this.connections.delete(ws);
        const userData = ws as unknown as WsUserData;
        const websocket = userData.websocket;
        if (websocket) {
          websocket[kEnded] = true;
        }
        userData.req.socket.destroy();
        const _message =
          message instanceof ArrayBuffer ? Buffer.copyBytesFrom(new Uint8Array(message)) : message;
        websocket?.emit('close', code, _message);
        this.emit('close', ws, code, _message);
      },
      drain: (ws) => {
        (ws as unknown as WsUserData).websocket?.emit('drain');
        this.emit('drain', ws);
      },
      message: (ws, message, isBinary) => {
        const _message =
          message instanceof ArrayBuffer ? Buffer.copyBytesFrom(new Uint8Array(message)) : message;
        (ws as unknown as WsUserData).websocket?.emit('message', _message, isBinary);
        this.emit('message', ws, _message, isBinary);
      },
      ping: (ws, message) => {
        const _message =
          message instanceof ArrayBuffer ? Buffer.copyBytesFrom(new Uint8Array(message)) : message;
        (ws as unknown as WsUserData).websocket?.emit('ping', _message);
        this.emit('ping', ws, _message);
      },
      pong: (ws, message) => {
        const _message =
          message instanceof ArrayBuffer ? Buffer.copyBytesFrom(new Uint8Array(message)) : message;
        (ws as unknown as WsUserData).websocket?.emit('pong', _message);
        this.emit('pong', ws, _message);
      },
      ...options,
    });
  }
}
