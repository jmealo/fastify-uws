# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- TLS/SSL support for HTTP2 and HTTPS configurations
- `setTimeout` method on HTTPSocket (was called by `Request.setTimeout()` but missing)
- CI workflow (GitHub Actions) testing Node.js 20, 22, and 24
- Comprehensive integration tests (HTTP, WebSocket, streaming, abort, security)
- SSE (Server-Sent Events) support via `@fastify/sse`

### Fixed
- All TypeScript declaration errors (~80) for clean `vite build` output
- Biome lint warnings in type augmentation block
- Cookie handling fix
- CRLF injection prevention in HTTP headers and status lines

### Changed
- Migrated test runner from legacy spec files to vitest
- Removed deprecated `plugin-eventsource.ts` (replaced by `@fastify/sse` support)
- Replaced `fastify-uws.ts` barrel export with `index.ts`

## [1.0.0] - 2024

### Added
- Initial release
- Fastify `serverFactory` backed by uWebSockets.js
- WebSocket plugin (`@fastify/websocket`-compatible drop-in replacement)
- HTTP request/response implementation over uWS (`Request`, `Response`, `HTTPSocket`)
- Custom error classes via `@fastify/error`
- Benchmarks comparing Node.js, Bun, Deno, and Rust HTTP frameworks

[Unreleased]: https://github.com/jmealo/fastify-uws/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jmealo/fastify-uws/releases/tag/v1.0.0
