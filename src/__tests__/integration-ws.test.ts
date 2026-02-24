import type { FastifyInstance } from 'fastify';
import WebSocketClient from 'ws';
import { websocket } from '..';
import { createApp } from './helpers';

let app: FastifyInstance;
let baseUrl: string;

async function listen() {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `ws://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (app) {
    await app.close();
  }
});

describe('WebSocket Integration', () => {
  test('WebSocket connection and message exchange', async () => {
    app = createApp();
    app.register(websocket);
    app.register(async (instance) => {
      instance.get('/ws', { websocket: true }, (socket) => {
        socket.on('message', (msg) => {
          socket.send(`echo: ${msg}`);
        });
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl}/ws`);

    const message = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => resolve(data.toString()));
      ws.on('error', reject);
    });

    expect(message).toBe('echo: hello');
    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  test('binary message support', async () => {
    app = createApp();
    app.register(websocket);
    app.register(async (instance) => {
      instance.get('/ws-bin', { websocket: true }, (socket) => {
        socket.on('message', (msg) => {
          socket.send(msg, true, false);
        });
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl}/ws-bin`);

    const message = await new Promise<Buffer>((resolve, reject) => {
      ws.on('open', () => ws.send(Buffer.from([1, 2, 3])));
      ws.on('message', (data) => resolve(data as Buffer));
      ws.on('error', reject);
    });

    expect(Buffer.isBuffer(message)).toBe(true);
    expect([...message]).toEqual([1, 2, 3]);
    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  test('multiple concurrent WebSocket connections', async () => {
    app = createApp();
    app.register(websocket);
    app.register(async (instance) => {
      instance.get('/ws-multi', { websocket: true }, (socket) => {
        socket.on('message', (msg) => {
          socket.send(`reply: ${msg}`);
        });
      });
    });
    await listen();

    const clients = Array.from({ length: 3 }, () => new WebSocketClient(`${baseUrl}/ws-multi`));

    const results = await Promise.all(
      clients.map(
        (ws, i) =>
          new Promise<string>((resolve, reject) => {
            ws.on('open', () => ws.send(`client-${i}`));
            ws.on('message', (data) => resolve(data.toString()));
            ws.on('error', reject);
          }),
      ),
    );

    expect(results).toEqual(['reply: client-0', 'reply: client-1', 'reply: client-2']);

    await Promise.all(
      clients.map((ws) => {
        ws.close();
        return new Promise((resolve) => ws.on('close', resolve));
      }),
    );
  });

  test('clean close with code and message', async () => {
    app = createApp();
    app.register(websocket);
    app.register(async (instance) => {
      instance.get('/ws-close', { websocket: true }, (socket) => {
        socket.on('message', () => {
          socket.end(1000, 'goodbye');
        });
      });
    });
    await listen();

    const ws = new WebSocketClient(`${baseUrl}/ws-close`);

    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      ws.on('open', () => ws.send('close-me'));
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      ws.on('error', reject);
    });

    expect(closeInfo.code).toBe(1000);
    expect(closeInfo.reason).toBe('goodbye');
  });
});
