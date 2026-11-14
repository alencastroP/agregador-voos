// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const FRAMEWORKS = ['fastify', 'ioredis', 'pino', 'drizzle-orm', 'pg', '@opentelemetry/*'];

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Arquitetura hexagonal garantida pelo lint, não só por convenção:
    // domain/ não depende de nada externo nem de framework.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/application/**',
                '**/infrastructure/**',
                '**/interfaces/**',
                '**/config/**',
              ],
              message: 'domain/ não depende de camadas externas (arquitetura hexagonal).',
            },
            { group: FRAMEWORKS, message: 'domain/ é livre de framework.' },
          ],
        },
      ],
    },
  },
  {
    // application/ fala com o mundo só através de ports.
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '**/interfaces/**'],
              message: 'application/ conversa com infraestrutura só via ports.',
            },
            { group: FRAMEWORKS, message: 'application/ é livre de framework.' },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
