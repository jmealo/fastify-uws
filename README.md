![fastify-uws](./.github/assets/logo.png)

# fastify-uws

A performant HTTP and WebSocket server for Fastify with [uWebSockets](https://github.com/uNetworking/uWebSockets.js).

## Installation

Install `@jmealo/fastify-uws` with your favorite package manager:

```sh
$ npm i @jmealo/fastify-uws
# or
$ yarn add @jmealo/fastify-uws
# or
$ pnpm i @jmealo/fastify-uws
# or
$ bun add @jmealo/fastify-uws
```

## Supported

`fastify-uws` v1.x supports the following versions:

- Node.js: v20, v22, and v24
- `fastify`: v5.x
- `@fastify/websocket`: v11.x

## Release (CD)

GitHub Actions publishes to npm on semver tags (`v*.*.*`) via [cd.yml](./.github/workflows/cd.yml) using npm Trusted Publishing (OIDC).

One-time npm setup (no `NPM_TOKEN` secret needed):

- npm package: `@jmealo/fastify-uws`
- npm trusted publisher:
  - Owner: `jmealo`
  - Repository: `jmealo/fastify-uws`
  - Workflow file: `.github/workflows/cd.yml`
  - Environment: leave empty unless you deliberately scope to a GitHub Environment

## Usage

Just two lines are needed to speed up your Fastify application.

```ts
// app.ts
import fastify from 'fastify';
import { serverFactory } from '@jmealo/fastify-uws'; // Import here

import router from '~/plugins/router';

export default () => {
  const app = fastify({
    logger: {
      transport: {
        target: '@fastify/one-line-logger',
      },
    },
    serverFactory, // And use here
  });

  app.register(router);

  return app;
};
```

```ts
// server.ts
import app from './app';

const server = app();

const start = async () => {
  try {
    await server.listen({
      host: '127.0.0.1',
      port: 3000,
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
```

### Use [Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)

```ts
// src/routes/hello-http/+handler.ts
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';

export default (async (app) => {
  app.get(
    '',
    {
      schema: {
        response: {
          200: Type.Object({
            message: Type.String(),
          }),
        },
      },
    },
    async (req, reply) => {
      return reply.send({
        message: 'Hello, World!',
      });
    },
  );
}) as FastifyPluginAsyncTypebox;
```

#### With [FormData](https://developer.mozilla.org/en-US/docs/Web/API/FormData)

```ts
// app.ts
import multipart from '@fastify/multipart';

app.register(multipart);
```

```ts
// src/routes/hello-fd/+handler.ts
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

export default (async (app) => {
  app.post('', async (req, reply) => {
    const data = await req.file();

    data.file; // stream
    data.fields; // other parsed parts
    data.fieldname;
    data.filename;
    data.encoding;
    data.mimetype;

    await pipeline(data.file, fs.createWriteStream(data.filename));
    // or
    // await data.toBuffer(); // Buffer

    return reply.send({ message: 'ok' });
  });
}) as FastifyPluginAsyncTypebox;
```

### Use [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)

Just a single line of change can speed up your WebSocket application in Fastify.

```diff
- import websocket from '@fastify/websocket';
+ import { websocket } from '@jmealo/fastify-uws';
```

```ts
// app.ts
import { websocket } from '@jmealo/fastify-uws';

app.register(websocket);
```

```ts
// src/routes/hello-ws/+handler.ts
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

export default (async (app) => {
  // $ node client-ws.mjs
  app.get('', { websocket: true }, (socket) => {
    app.log.info('Client connected');

    socket.on('message', (message: MessageEvent) => {
      console.log(`Client message: ${message}`);
      socket.send('Hello from Fastify!');
    });

    socket.on('close', () => {
      app.log.info('Client disconnected');
    });
  });
}) as FastifyPluginAsyncTypebox;
```

### Use [EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)

```ts
// app.ts
import { sse } from '@jmealo/fastify-uws';

app.register(sse);
```

```ts
// src/routes/hello-sse/+handler.ts
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

export default (async (app) => {
  // $ node client-es.mjs
  app.get('', { sse: true }, async (request, reply) => {
    app.log.info('Client connected');

    await reply.sse.send({ data: 'Hello from Fastify!' });

    request.raw.on('close', () => {
      app.log.info('Client disconnected');
    });
  });
}) as FastifyPluginAsyncTypebox;
```

### TLS/SSL: `http2` and `https`

```ts
import fs from 'node:fs';
import fastify from 'fastify';
import { serverFactory, websocket } from '@jmealo/fastify-uws';
// [...]
export default () => {
  const app = fastify({
    http2: true,
    https: {
      key: fs.readFileSync(process.env.HTTPS_KEY),
      cert: fs.readFileSync(process.env.HTTPS_CERT),
    },
    logger: {
      transport: {
        target: '@fastify/one-line-logger',
      },
    },
    serverFactory,
  });

  app.register(websocket);
  // [...]
};
// [...]
```

## Benchmarks

### Quick Comparison

> Measured with `pnpm bench` — 100 connections, 60s duration, pipelining 10

#### HTTP — `GET /ping` → `{ ok: true }`

| | Req/sec | Latency (mean) | Latency (p99) |
| :--- | ---: | ---: | ---: |
| fastify | 78,113.9 | 12.3 ms | 30 ms |
| **fastify-uws** | **147,132.8** | **6.3 ms** | **16 ms** |
| | **+88.4%** | **-48.7%** | **-46.7%** |

#### WebSocket — 100 clients, 64B echo flood, 60s

| | Messages/sec |
| :--- | ---: |
| @fastify/websocket (ws) | 62,398 |
| **fastify-uws** | **59,649** |
| | **-4.4%** |

#### SSE — 100 clients, 64B events, 60s

| | Events/sec |
| :--- | ---: |
| @fastify/sse (default) | 414,717 |
| @fastify/sse + fastify-uws (compat) | 162,781 |
| **fastify-uws native sse plugin** | **937,420** |
| Δ compat vs default | -60.7% |
| Δ native vs default | +126.0% |
| Δ native vs compat | +475.9% |

> Results vary by machine. Run `pnpm bench` to reproduce.

## Credits

This project is based on [`@geut/fastify-uws`](https://github.com/geut/fastify-uws) and is licensed under the MIT License.
