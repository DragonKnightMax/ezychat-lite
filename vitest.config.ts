import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Inside this monorepo @ezychat/* packages resolve to their TypeScript source through the
// "ezychat-source" export condition (published builds resolve to dist/).
export const sourceResolve = {
  resolve: { conditions: ['ezychat-source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['ezychat-source', ...defaultServerConditions] } },
};

// Server tests build a real app (`makeTestApp()`: data dir, every migration, Fastify) and the Windows CI
// runner is several times slower than a local run: 30 s per test and hook instead of Vitest's 5 s.
export const SERVER_TIMEOUTS = { testTimeout: 30_000, hookTimeout: 30_000 };

// Root config: every workspace is a Vitest project. A workspace may add its own
// vitest.config.ts (e.g. apps/web uses jsdom); the core packages inherit this file here, and their
// own vitest.config.ts reuses `sourceResolve` for `npm test -w @ezychat/<pkg>` runs.
export default defineConfig({
  ...sourceResolve,
  test: {
    projects: [
      ...['shared', 'wa', 'server'].map((name) => ({
        extends: true,
        root: `packages/${name}`,
        test: { name: `@ezychat/${name}`, ...(name === 'server' ? SERVER_TIMEOUTS : {}) },
      })),
      'apps/*',
      { extends: true, test: { name: 'scripts', include: ['scripts/**/*.test.{mjs,ts}'] } },
    ],
    passWithNoTests: true,
    // Transforms dominated test time (~86%); persist them across runs.
    fsModuleCache: true,
    // `npm run test:coverage` (CI on ubuntu). Good to go = changed lines ≥ 90 % covered
    // (scripts/changed-lines-coverage.mjs) and the totals never drop below these floors. Raise the
    // floors whenever the totals rise; the target for every total is 90 % (AGENTS.md).
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx,cts}', 'apps/*/src/**/*.{ts,tsx,cts}'],
      exclude: ['**/*.test.*', '**/*.d.ts', '**/test/**', '**/locales/**'],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportOnFailure: true,
      thresholds: { lines: 90, statements: 81, branches: 75, functions: 78 },
    },
  },
});
