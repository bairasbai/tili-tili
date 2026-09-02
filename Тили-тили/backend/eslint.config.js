import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/contract/*.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // console.log в проде уходит мимо структурированного лога Fastify —
      // такие строки не найти по requestId. Ошибки при старте выводить можно.
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['migrations/**/*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.commonjs }, sourceType: 'commonjs' },
  },
  {
    files: ['scripts/**/*.mjs', 'migrations/**/*.cjs', '*.config.ts', '*.config.js'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' },
  },
)
