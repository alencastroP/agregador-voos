import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text', 'html', 'lcov'],
      // A meta de 85% vale para o núcleo (domain/application); infra não persegue 100%.
      thresholds: {
        'src/domain/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'src/application/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
      },
    },
  },
});
