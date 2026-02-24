import { EventEmitter } from 'eventemitter3';
import { describe, expect, test, vi } from 'vitest';
import type uws from 'uWebSockets.js';
import { kApp, kEnded, kHandler, kTopic } from '../symbols';
import { WebSocket, WebSocketServer, WebSocketStream } from '../websocket-server';

function createConnectionMock(overrides: Partial<uws.WebSocket<any>> = {}) {
  const conn: any = {
    send: vi.fn(() => 1),
    publish: vi.fn(() => true),
    subscribe: vi.fn(() => true),
    unsubscribe: vi.fn(() => true),
    isSubscribed: vi.fn(() => true),
    getTopics: vi.fn(() => ['room!a']),
    close: vi.fn(),
    end: vi.fn(),
    cork: vi.fn((cb: () => void) => {
      cb();
      return conn;
    }),
    getBufferedAmount: vi.fn(() => 7),
    ping: vi.fn(() => 1),
    ...overrides,
  };

  return conn as uws.WebSocket<any>;
}

describe('websocket-server unit', () => {
  test('WebSocket topic helpers and methods honor ended guard', () => {
    const namespace = Buffer.from('room');
    const preTagged = Buffer.from('room!pre');
    (preTagged as any)[kTopic] = true;
    expect(WebSocket.allocTopic(namespace, preTagged)).toBe(preTagged);

    const conn = createConnectionMock();
    const ws = new WebSocket(namespace, conn);

    expect(ws.uws).toBe(true);

    const allocated = ws.allocTopic('chat');
    expect(Buffer.isBuffer(allocated)).toBe(true);
    expect((allocated as Buffer).toString()).toBe('room!chat');
    const allocatedBufferTopic = ws.allocTopic(Buffer.from('buf-topic'));
    expect((allocatedBufferTopic as Buffer).toString()).toBe('room!buf-topic');

    const cached = Buffer.from('room!cached');
    const wsWithCache = new WebSocket(namespace, conn, { cached });
    expect(wsWithCache.allocTopic('cached')).toBe(cached);

    expect(ws.send('hello', false, false)).toBe(1);
    expect(ws.publish('chat', 'data', false, false)).toBe(true);
    expect(ws.subscribe('chat')).toBe(true);
    expect(ws.unsubscribe('chat')).toBe(true);
    expect(ws.isSubscribed('chat')).toBe(true);
    expect(ws.getTopics()).toEqual(['a']);
    expect(ws.getBufferedAmount()).toBe(7);
    expect(ws.ping('p')).toBe(1);
    ws.cork(() => {});
    expect((conn.cork as any).mock.calls.length).toBe(1);

    ws.close();
    expect((conn.close as any).mock.calls.length).toBe(1);
    expect(ws.send('x', false, false)).toBeUndefined();
    expect(ws.publish('chat', 'x', false, false)).toBeUndefined();
    expect(ws.subscribe('chat')).toBeUndefined();
    expect(ws.unsubscribe('chat')).toBeUndefined();
    expect(ws.isSubscribed('chat')).toBe(false);
    expect(ws.getTopics()).toEqual([]);
    expect(ws.getBufferedAmount()).toBe(0);
    expect(ws.ping('x')).toBeUndefined();
    expect(ws.cork(() => {})).toBeUndefined();
    expect(ws.close()).toBeUndefined();

    const conn2 = createConnectionMock();
    const ws2 = new WebSocket(namespace, conn2);
    ws2.end(1000, 'done');
    expect((conn2.end as any).mock.calls.length).toBe(1);
    expect(ws2.end(1000, 'done')).toBeUndefined();
  });

  test('WebSocketStream handles open/close and writable backpressure states', () => {
    const conn = createConnectionMock();
    const ws = new WebSocket(Buffer.from('stream'), conn);
    const stream = new WebSocketStream(ws);
    const defaultWritableMap = (stream as any)._writableState.map;
    const defaultWritableByteLength = (stream as any)._writableState.byteLength;
    const defaultReadableByteLength = (stream as any)._readableState.byteLength;

    const mappedBin = defaultWritableMap(Buffer.from('abc'));
    expect(mappedBin).toEqual({ data: Buffer.from('abc'), isBinary: true, compress: false });
    expect(defaultWritableByteLength(mappedBin)).toBe(3);

    const mappedText = defaultWritableMap('text');
    expect(mappedText).toEqual({ data: 'text', isBinary: false, compress: false });
    expect(defaultWritableByteLength(mappedText)).toBe(1024);
    expect(defaultReadableByteLength({ data: Buffer.from('abc'), isBinary: true })).toBe(3);
    expect(defaultReadableByteLength({ data: 'text', isBinary: false })).toBe(1024);

    const pushSpy = vi.spyOn(stream, 'push');
    const openCb = vi.fn();
    stream._open(openCb);
    expect(openCb).toHaveBeenCalledTimes(1);
    ws.emit('message', Buffer.from('abc'), true);
    expect(pushSpy).toHaveBeenCalledWith({ data: Buffer.from('abc'), isBinary: true });

    const writeOk = vi.fn();
    (conn.send as any).mockReturnValueOnce(1);
    stream._write({ data: 'ok', isBinary: false, compress: false }, writeOk);
    expect(writeOk).toHaveBeenCalledWith();

    const writeDrain = vi.fn();
    (conn.send as any).mockReturnValueOnce(0);
    stream._write({ data: 'wait', isBinary: false, compress: false }, writeDrain);
    expect(writeDrain).not.toHaveBeenCalled();
    ws.emit('drain');
    expect(writeDrain).toHaveBeenCalledWith();

    const writeCloseBeforeDrain = vi.fn();
    (conn.send as any).mockReturnValueOnce(0);
    stream._write({ data: 'wait-close', isBinary: false, compress: false }, writeCloseBeforeDrain);
    expect(writeCloseBeforeDrain).not.toHaveBeenCalled();
    ws.emit('close', 1000, Buffer.from('bye'));
    expect(writeCloseBeforeDrain).toHaveBeenCalledTimes(1);
    expect(writeCloseBeforeDrain.mock.calls[0][0]).toBeInstanceOf(Error);

    const writeDrop = vi.fn();
    (conn.send as any).mockReturnValueOnce(2);
    stream._write({ data: 'drop', isBinary: false, compress: false }, writeDrop);
    expect(writeDrop).toHaveBeenCalledTimes(1);
    expect(writeDrop.mock.calls[0][0]).toBeInstanceOf(Error);

    const writeClosed = vi.fn();
    (ws as any)[kEnded] = true;
    stream._write({ data: 'closed', isBinary: false, compress: false }, writeClosed);
    expect(writeClosed).toHaveBeenCalledTimes(1);
    expect(writeClosed.mock.calls[0][0]).toBeInstanceOf(Error);

    (ws as any)[kEnded] = false;
    const closeCb = vi.fn();
    stream._close(closeCb);
    expect(closeCb).toHaveBeenCalledTimes(1);
    expect((conn.close as any).mock.calls.length).toBe(1);
  });

  test('WebSocketStream uses custom map/byteLength functions when provided', () => {
    const conn = createConnectionMock();
    const ws = new WebSocket(Buffer.from('custom'), conn);

    const stream = new WebSocketStream(ws, {
      mapReadable: (packet) => `${packet.data}:${packet.isBinary ? 'b' : 't'}`,
      byteLengthReadable: (packet) => (packet.isBinary ? 10 : 20),
      mapWritable: (data) => ({ data: `mapped:${data}`, isBinary: false, compress: true }),
      byteLengthWritable: (_packet) => 123,
    });

    const readableMap = (stream as any)._readableState.map;
    const readableByteLength = (stream as any)._readableState.byteLength;
    const writableMap = (stream as any)._writableState.map;
    const writableByteLength = (stream as any)._writableState.byteLength;

    expect(readableMap({ data: 'hello', isBinary: false })).toBe('hello:t');
    expect(readableByteLength({ data: 'hello', isBinary: false })).toBe(20);

    const mappedWritable = writableMap('payload');
    expect(mappedWritable).toEqual({ data: 'mapped:payload', isBinary: false, compress: true });
    expect(writableByteLength(mappedWritable)).toBe(123);

    stream._write(mappedWritable, () => {});
    expect((conn.send as any).mock.calls[0]).toEqual(['mapped:payload', false, true]);
  });

  test('WebSocketServer forwards ws lifecycle events and copies ArrayBuffer payloads', () => {
    let handlers: any;
    const app = {
      ws: vi.fn((_route: string, opts: any) => {
        handlers = opts;
      }),
    };

    const listenerHandler = vi.fn();
    const server = Object.assign(new EventEmitter(), {
      [kApp]: app,
      [kHandler]: listenerHandler,
    });

    const wss = new WebSocketServer({ maxPayloadLength: 1024 });
    const openSpy = vi.fn();
    const closeSpy = vi.fn();
    const drainSpy = vi.fn();
    const messageSpy = vi.fn();
    const pingSpy = vi.fn();
    const pongSpy = vi.fn();
    wss.on('open', openSpy);
    wss.on('close', closeSpy);
    wss.on('drain', drainSpy);
    wss.on('message', messageSpy);
    wss.on('ping', pingSpy);
    wss.on('pong', pongSpy);

    wss.addServer(server as any);

    expect(app.ws).toHaveBeenCalledTimes(1);
    expect(wss.options.maxPayloadLength).toBe(1024);
    expect(wss.options.idleTimeout).toBe(16);

    const socketEmitter = new EventEmitter();
    const rawWs: any = {
      req: {
        socket: {
          destroy: vi.fn(),
        },
      },
      handler: vi.fn(),
      websocket: socketEmitter,
    };
    (socketEmitter as any)[kEnded] = false;

    const socketDrainSpy = vi.fn();
    const socketMessageSpy = vi.fn();
    const socketPingSpy = vi.fn();
    const socketPongSpy = vi.fn();
    const socketCloseSpy = vi.fn();
    socketEmitter.on('drain', socketDrainSpy);
    socketEmitter.on('message', socketMessageSpy);
    socketEmitter.on('ping', socketPingSpy);
    socketEmitter.on('pong', socketPongSpy);
    socketEmitter.on('close', socketCloseSpy);

    handlers.open(rawWs);
    expect(wss.connections.has(rawWs)).toBe(true);
    expect(rawWs.handler).toHaveBeenCalledWith(rawWs);
    expect(openSpy).toHaveBeenCalledWith(rawWs);

    handlers.drain(rawWs);
    expect(socketDrainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith(rawWs);

    const msgAb = Uint8Array.from([1, 2, 3]).buffer;
    handlers.message(rawWs, msgAb, true);
    expect(socketMessageSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(socketMessageSpy.mock.calls[0][0])).toBe(true);
    expect(messageSpy).toHaveBeenCalledWith(rawWs, Buffer.from([1, 2, 3]), true);

    const pingAb = Uint8Array.from([4]).buffer;
    handlers.ping(rawWs, pingAb);
    expect(socketPingSpy).toHaveBeenCalledWith(Buffer.from([4]));
    expect(pingSpy).toHaveBeenCalledWith(rawWs, Buffer.from([4]));

    const pongAb = Uint8Array.from([5]).buffer;
    handlers.pong(rawWs, pongAb);
    expect(socketPongSpy).toHaveBeenCalledWith(Buffer.from([5]));
    expect(pongSpy).toHaveBeenCalledWith(rawWs, Buffer.from([5]));

    handlers.message(rawWs, 'plain', false);
    expect(socketMessageSpy).toHaveBeenCalledWith('plain', false);
    expect(messageSpy).toHaveBeenCalledWith(rawWs, 'plain', false);

    handlers.ping(rawWs, 'ping-text');
    expect(socketPingSpy).toHaveBeenCalledWith('ping-text');
    expect(pingSpy).toHaveBeenCalledWith(rawWs, 'ping-text');

    handlers.pong(rawWs, 'pong-text');
    expect(socketPongSpy).toHaveBeenCalledWith('pong-text');
    expect(pongSpy).toHaveBeenCalledWith(rawWs, 'pong-text');

    const closeAb = Uint8Array.from([6, 7]).buffer;
    handlers.close(rawWs, 1000, closeAb);
    expect(wss.connections.has(rawWs)).toBe(false);
    expect((socketEmitter as any)[kEnded]).toBe(true);
    expect(rawWs.req.socket.destroy).toHaveBeenCalledTimes(1);
    expect(socketCloseSpy).toHaveBeenCalledWith(1000, Buffer.from([6, 7]));
    expect(closeSpy).toHaveBeenCalledWith(rawWs, 1000, Buffer.from([6, 7]));

    const rawWsStringClose: any = {
      req: {
        socket: {
          destroy: vi.fn(),
        },
      },
      handler: vi.fn(),
      websocket: new EventEmitter(),
    };
    const closeStringSpy = vi.fn();
    rawWsStringClose.websocket.on('close', closeStringSpy);
    handlers.open(rawWsStringClose);
    handlers.close(rawWsStringClose, 1001, 'bye');
    expect(closeStringSpy).toHaveBeenCalledWith(1001, 'bye');
  });

  test('WebSocketServer allows custom uWS callbacks to override defaults', () => {
    let handlers: any;
    const app = {
      ws: vi.fn((_route: string, opts: any) => {
        handlers = opts;
      }),
    };
    const server = Object.assign(new EventEmitter(), {
      [kApp]: app,
      [kHandler]: vi.fn(),
    });

    const customOpen = vi.fn();
    const wss = new WebSocketServer({ open: customOpen } as any);
    wss.addServer(server as any);

    const rawWs: any = { handler: vi.fn() };
    handlers.open(rawWs);
    expect(customOpen).toHaveBeenCalledWith(rawWs);
    expect(rawWs.handler).not.toHaveBeenCalled();
  });
});
