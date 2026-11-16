import { defineConfig } from 'vitest/config';

/** E2E: só roda com a stack de pé (`make up`), por isso fica fora do `npm test` padrão. */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
