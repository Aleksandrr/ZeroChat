// frontend/eslint.config.js
import js from '@eslint/js';
import tsEslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import importSortPlugin from 'eslint-plugin-simple-import-sort';
import prettierConfig from 'eslint-config-prettier';

export default tsEslint.config(
  // 1. Базовая конфигурация JS/TS
  js.configs.recommended,
  ...tsEslint.configs.recommended,
  ...tsEslint.configs.stylistic,

  // 2. React (используем встроенные flat configs)
  reactPlugin.configs.flat.recommended,
  reactPlugin.configs.flat['jsx-runtime'], // для React 17+

  // 3. React Hooks (вручную, т.к. нет flatConfigs)
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // 4. Accessibility (используем встроенный flat config)
  jsxA11yPlugin.flatConfigs.recommended,

  // 5. Настройки TypeScript для правил с типами
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // 6. Сортировка импортов
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      'simple-import-sort': importSortPlugin,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },

  // 7. Игнорируемые папки
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.config.js', '*.config.ts', 'src/routeTree.gen.ts', 'vite.config.ts'],
  },

  // 8. Prettier (всегда последним)
  prettierConfig,
);