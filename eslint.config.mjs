import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/storybook-static/**',
      '**/*.d.ts',
      '**/*.map',
    ],
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    plugins: {
      boundaries,
    },
    settings: {
      'boundaries/elements': [
        {
          type: 'module',
          pattern: ['apps/api/src/modules/*', 'src/modules/*'],
          mode: 'folder',
        },
        {
          type: 'infra',
          pattern: ['apps/api/src/infra/*', 'src/infra/*'],
          mode: 'folder',
        },
      ],
    },
    rules: {
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              target: ['module', 'infra'],
              allow: 'index.ts',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.controller.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*tenant-transaction.service*'],
              message:
                'Controllers must not manage database transactions directly. Use domain/application services instead.',
            },
          ],
        },
      ],
    },
  },
);
