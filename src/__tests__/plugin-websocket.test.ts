import { describe, expect, test, vi } from 'vitest';
import pluginWebsocket, { isValidWebSocketKey } from '../plugin-websocket';
import { kRes, kWs } from '../symbols';
import { WebSocket } from '../websocket-server';

function setupPlugin(opts: any = {}) {
  let onRouteHook: any;
  const fastify: any = {
    server: {},
    decorate: vi.fn(),
    addHook: vi.fn((name: string, fn: any) => {
      if (name === 'onRoute') onRouteHook = fn;
    }),
  };
  const next = vi.fn();
  (pluginWebsocket as any)(fastify, opts, next);
  return { fastify, next, onRouteHook };
}

describe('plugin-websocket unit', () => {
  test('isValidWebSocketKey follows RFC6455 key constraints', () => {
    expect(isValidWebSocketKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe(true);
    expect(isValidWebSocketKey('invalid-key')).toBe(false);
    expect(isValidWebSocketKey('dGhlIHNhbXBsZSBub25jZQ=')).toBe(false);
    expect(isValidWebSocketKey(Buffer.from('dGhlIHNhbXBsZSBub25jZQ=='))).toBe(false);
  });

  test('rejects malformed sec-websocket-key before hijack/upgrade', () => {
    const { next, onRouteHook } = setupPlugin();
    expect(next).toHaveBeenCalledWith();

    const routeOptions: any = {
      websocket: true,
      method: 'GET',
      url: '/ws-invalid',
      handler: vi.fn(),
    };
    onRouteHook(routeOptions);

    const upgrade = vi.fn();
    const requestRaw: any = {
      [kWs]: {},
      headers: {
        'sec-websocket-key': 'invalid-key',
      },
      socket: {
        aborted: false,
        destroyed: false,
        [kRes]: {
          upgrade,
        },
      },
    };
    const request: any = { raw: requestRaw };
    const reply: any = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
      hijack: vi.fn(),
    };

    routeOptions.handler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith('Invalid sec-websocket-key header');
    expect(reply.hijack).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  });

  test('calls upgrade with valid websocket key', () => {
    const { onRouteHook } = setupPlugin();

    const wsHandler = vi.fn();
    const routeOptions: any = {
      websocket: true,
      method: 'GET',
      url: '/ws-valid',
      handler: wsHandler,
    };
    onRouteHook(routeOptions);

    const upgrade = vi.fn();
    const context = {} as any;
    const requestRaw: any = {
      [kWs]: context,
      headers: {
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': '',
        'sec-websocket-extensions': '',
      },
      socket: {
        aborted: false,
        destroyed: false,
        [kRes]: {
          upgrade,
        },
      },
      once: vi.fn(),
    };
    const request: any = { raw: requestRaw };
    const reply: any = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
      hijack: vi.fn(),
    };

    routeOptions.handler(request, reply);

    expect(reply.hijack).toHaveBeenCalledTimes(1);
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(upgrade.mock.calls[0][1]).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(upgrade.mock.calls[0][4]).toBe(context);
  });

  test('precomputes topics and closes upgraded connection on raw error/close events', () => {
    const { onRouteHook } = setupPlugin();
    const allocSpy = vi.spyOn(WebSocket, 'allocTopic');
    const closeSpy = vi.spyOn(WebSocket.prototype, 'close');
    const endSpy = vi.spyOn(WebSocket.prototype, 'end');

    const routeOptions: any = {
      websocket: true,
      method: 'GET',
      url: '/ws-events',
      ws: { topics: ['a', 'b'] },
      handler: vi.fn(),
    };
    onRouteHook(routeOptions);

    expect(allocSpy).toHaveBeenCalledWith(Buffer.from('/ws-events'), 'a');
    expect(allocSpy).toHaveBeenCalledWith(Buffer.from('/ws-events'), 'b');

    const upgrade = vi.fn();
    const onceHandlers: Record<string, (() => void) | undefined> = {};
    const requestRaw: any = {
      [kWs]: {},
      headers: {
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': '',
        'sec-websocket-extensions': '',
      },
      socket: {
        aborted: false,
        destroyed: false,
        [kRes]: {
          upgrade,
        },
      },
      once: vi.fn((event: string, cb: () => void) => {
        onceHandlers[event] = cb;
      }),
    };
    const request: any = { raw: requestRaw };
    const reply: any = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
      hijack: vi.fn(),
    };

    routeOptions.handler(request, reply);

    const userData = upgrade.mock.calls[0][0];
    const rawWs = {
      close: vi.fn(),
      end: vi.fn(),
    };
    userData.handler(rawWs);

    onceHandlers.error?.();
    onceHandlers.close?.();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledWith(1000, 'Normal Closure');

    closeSpy.mockRestore();
    endSpy.mockRestore();
    allocSpy.mockRestore();
  });

  test('returns a clear error when errorHandler is not a function', () => {
    const { next } = setupPlugin({ errorHandler: 42 });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(next.mock.calls[0][0].message).toBe('invalid errorHandler function');
  });
});
