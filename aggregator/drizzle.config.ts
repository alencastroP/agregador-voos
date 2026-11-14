import { defineConfig } from 'drizzle-kit';

/** `npm run db:generate` gera SQL versionado em ./drizzle a partir do schema TypeScript. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/persistence/schema.ts',
  out: './drizzle',
  strict: true,
});
