import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const autocannon = require('autocannon');

const __dirname = dirname(fileURLToPath(import.meta.url));

import http from 'node:http';

const HTTP_DURATION = Number(process.env.BENCH_HTTP_DURATION_SECONDS || 30);
const HTTP_CONNECTIONS = Number(process.env.BENCH_HTTP_CONNECTIONS || 100);
const HTTP_PIPELINING = Number(process.env.BENCH_HTTP_PIPELINING || 10);
const WS_DURATION = Number(process.env.BENCH_WS_DURATION_MS || 30_000);
const WS_CLIENTS = Number(process.env.BENCH_WS_CLIENTS || 100);
const WS_PAYLOAD = Buffer.alloc(64, 'x');
const SSE_DURATION = Number(process.env.BENCH_SSE_DURATION_MS || 30_000);
const SSE_CLIENTS = Number(process.env.BENCH_SSE_CLIENTS || 100);
const STARTUP_TIMEOUT = Number(process.env.BENCH_STARTUP_TIMEOUT_MS || 10_000);

// ── Helpers ──────────────────────────────────────────────────────────

function spawnServer(file) {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, file), {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Server ${file} failed to start within ${STARTUP_TIMEOUT}ms`));
    }, STARTUP_TIMEOUT);

    child.on('message', (msg) => {
      clearTimeout(timer);
      resolve({ child, port: msg.port });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code && code !== 0 && code !== null) {
        reject(new Error(`Server ${file} exited with code ${code}`));
      }
    });
  });
}

function killServer(child) {
  return new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
  });
}

function runAutocannon(port) {
  return new Promise((resolve, reject) => {
    const instance = autocannon({
      url: `http://127.0.0.1:${port}/ping`,
      connections: HTTP_CONNECTIONS,
      pipelining: HTTP_PIPELINING,
      duration: HTTP_DURATION,
    });
    autocannon.track(instance, { renderProgressBar: false });
    instance.on('done', resolve);
    instance.on('error', reject);
  });
}

function runWsBench(port) {
  return new Promise((resolve) => {
    let totalMessages = 0;
    const clients = [];
    let done = false;

    for (let i = 0; i < WS_CLIENTS; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      clients.push(ws);

      ws.on('open', () => {
        ws.send(WS_PAYLOAD);
      });

      ws.on('message', () => {
        totalMessages++;
        if (!done) {
          ws.send(WS_PAYLOAD);
        }
      });

      ws.on('error', () => {});
    }

    setTimeout(() => {
      done = true;
      // Grace period to let in-flight messages complete
      setTimeout(() => {
        for (const ws of clients) {
          try { ws.close(); } catch {}
        }
        resolve({ totalMessages, duration: WS_DURATION });
      }, 500);
    }, WS_DURATION);
  });
}

function fmt(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function pct(a, b) {
  const v = ((a - b) / b) * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

// ── HTTP Benchmark ───────────────────────────────────────────────────

async function benchHTTP() {
  console.log('  HTTP: fastify (default Node.js server)...');
  const def = await spawnServer('http-default.js');
  const defResult = await runAutocannon(def.port);
  await killServer(def.child);

  console.log('  HTTP: fastify-uws (uWebSockets.js)...');
  const uws = await spawnServer('http-uws.js');
  const uwsResult = await runAutocannon(uws.port);
  await killServer(uws.child);

  return { defResult, uwsResult };
}

// ── WebSocket Benchmark ──────────────────────────────────────────────

async function benchWS() {
  console.log('  WS: fastify + @fastify/websocket (ws)...');
  const def = await spawnServer('ws-default.js');
  const defResult = await runWsBench(def.port);
  await killServer(def.child);

  console.log('  WS: fastify-uws websocket...');
  const uws = await spawnServer('ws-uws.js');
  const uwsResult = await runWsBench(uws.port);
  await killServer(uws.child);

  return { defResult, uwsResult };
}

// ── SSE Benchmark ────────────────────────────────────────────────────

function runSseBench(port) {
  return new Promise((resolve) => {
    let totalEvents = 0;
    const clients = [];
    let done = false;

    for (let i = 0; i < SSE_CLIENTS; i++) {
      const req = http.get(
        `http://127.0.0.1:${port}/sse`,
        { headers: { accept: 'text/event-stream' } },
        (res) => {
          let buf = '';
          res.on('data', (chunk) => {
            if (done) return;
            buf += chunk.toString();
            // Count complete SSE events (terminated by \n\n)
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              totalEvents++;
              buf = buf.slice(idx + 2);
            }
          });
        }
      );
      req.on('error', () => {});
      clients.push(req);
    }

    setTimeout(() => {
      done = true;
      for (const req of clients) {
        try { req.destroy(); } catch {}
      }
      resolve({ totalEvents, duration: SSE_DURATION });
    }, SSE_DURATION);
  });
}

async function benchSSE() {
  console.log('  SSE: fastify + @fastify/sse (default)...');
  const def = await spawnServer('sse-default.js');
  const defResult = await runSseBench(def.port);
  await killServer(def.child);

  console.log('  SSE: fastify-uws + @fastify/sse (compat mode)...');
  const compat = await spawnServer('sse-uws.js');
  const compatResult = await runSseBench(compat.port);
  await killServer(compat.child);

  console.log('  SSE: fastify-uws native sse plugin...');
  const native = await spawnServer('sse-uws-native.js');
  const nativeResult = await runSseBench(native.port);
  await killServer(native.child);

  return { defResult, compatResult, nativeResult };
}

// ── Main ─────────────────────────────────────────────────────────────

console.log('\nfastify vs fastify-uws benchmark');
console.log(`  HTTP: ${HTTP_CONNECTIONS} connections, pipelining ${HTTP_PIPELINING}, ${HTTP_DURATION}s`);
console.log(`  WS:   ${WS_CLIENTS} clients, ${WS_PAYLOAD.length}B echo, ${WS_DURATION / 1000}s`);
console.log(`  SSE:  ${SSE_CLIENTS} clients, 64B events, ${SSE_DURATION / 1000}s\n`);

const httpResult = await benchHTTP();
console.log('');
const ws = await benchWS();
console.log('');
const sse = await benchSSE();

// ── Output ───────────────────────────────────────────────────────────

const defReqs = httpResult.defResult.requests.average;
const uwsReqs = httpResult.uwsResult.requests.average;
const defLat = httpResult.defResult.latency.mean;
const uwsLat = httpResult.uwsResult.latency.mean;
const defP99 = httpResult.defResult.latency.p99;
const uwsP99 = httpResult.uwsResult.latency.p99;

const defMps = Math.round(ws.defResult.totalMessages / (WS_DURATION / 1000));
const uwsMps = Math.round(ws.uwsResult.totalMessages / (WS_DURATION / 1000));

const defEps = Math.round(sse.defResult.totalEvents / (SSE_DURATION / 1000));
const compatEps = Math.round(sse.compatResult.totalEvents / (SSE_DURATION / 1000));
const nativeEps = Math.round(sse.nativeResult.totalEvents / (SSE_DURATION / 1000));

console.log('\n---\n');
console.log('### Quick Comparison\n');
console.log(`> Measured with \`pnpm bench\` — ${HTTP_CONNECTIONS} connections, ${HTTP_DURATION}s duration, pipelining ${HTTP_PIPELINING}\n`);

console.log('#### HTTP — `GET /ping` → `{ ok: true }`\n');
console.log('| | Req/sec | Latency (mean) | Latency (p99) |');
console.log('| :--- | ---: | ---: | ---: |');
console.log(`| fastify | ${fmt(defReqs)} | ${fmt(defLat)} ms | ${fmt(defP99)} ms |`);
console.log(`| **fastify-uws** | **${fmt(uwsReqs)}** | **${fmt(uwsLat)} ms** | **${fmt(uwsP99)} ms** |`);
console.log(`| | **${pct(uwsReqs, defReqs)}** | **${pct(uwsLat, defLat)}** | **${pct(uwsP99, defP99)}** |`);

console.log(`\n#### WebSocket — ${WS_CLIENTS} clients, ${WS_PAYLOAD.length}B echo flood, ${WS_DURATION / 1000}s\n`);
console.log('| | Messages/sec |');
console.log('| :--- | ---: |');
console.log(`| @fastify/websocket (ws) | ${fmt(defMps)} |`);
console.log(`| **fastify-uws** | **${fmt(uwsMps)}** |`);
console.log(`| | **${pct(uwsMps, defMps)}** |`);

console.log(`\n#### SSE — ${SSE_CLIENTS} clients, 64B events, ${SSE_DURATION / 1000}s\n`);
console.log('| | Events/sec |');
console.log('| :--- | ---: |');
console.log(`| @fastify/sse (default) | ${fmt(defEps)} |`);
console.log(`| @fastify/sse + fastify-uws (compat) | ${fmt(compatEps)} |`);
console.log(`| **fastify-uws native sse plugin** | **${fmt(nativeEps)}** |`);
console.log(`| Δ compat vs default | ${pct(compatEps, defEps)} |`);
console.log(`| Δ native vs default | ${pct(nativeEps, defEps)} |`);
console.log(`| Δ native vs compat | ${pct(nativeEps, compatEps)} |`);

console.log('\n---\n');
