import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typedRules = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
};

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      '.remember/**',
      'coverage/**',
      'dist/**',
      'docs/superpowers/**',
      'node_modules/**',
      'playwright-report/**',
      'public/**',
      'test-results/**',
      'tmp/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          './tsconfig.json',
          './tsconfig.tests.json',
          './tsconfig.panel.json',
          './tsconfig.tools.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'fixtures/browser/**/*.{ts,tsx}'],
    rules: typedRules,
  },
  {
    files: ['src/configpanel/**/*.{ts,tsx}', 'fixtures/browser/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      'fixtures/browser/vite.config.ts',
      'playwright.config.ts',
      'tests/browser/**/*.{ts,tsx}',
      'vitest.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['tests/browser/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['scripts/**/*.mjs', '**/*.config.{js,cjs,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
