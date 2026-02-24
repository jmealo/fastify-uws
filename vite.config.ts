import { resolve } from 'node:path';
import nodeExternals from 'rollup-plugin-node-externals';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      fileName: '[name]',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      output: {
        exports: 'named',
        preserveModules: true,
        preserveModulesRoot: resolve(import.meta.dirname, 'src'),
      },
    },
  },
  plugins: [
    dts({
      exclude: ['vite.config.ts', '**/__tests__/**'],
    }),
    {
      ...nodeExternals(),
      enforce: 'pre',
      apply: 'build',
    },
  ],
  test: {
    globals: true,
    coverage: {
      include: ['src/**'],
      exclude: ['benchmarks/**', 'examples/**'],
      thresholds: {
        branches: 70,
        functions: 80,
        lines: 80,
        statements: 80,
        'src/plugin-websocket.ts': {
          branches: 90,
          functions: 100,
          lines: 100,
          statements: 95,
        },
        'src/websocket-server.ts': {
          branches: 95,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
