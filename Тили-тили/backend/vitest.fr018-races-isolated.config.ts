import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Closed local native83 target only; no mocks, fallback, full-suite registry or skip.
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), test: {
  environment: 'node', globals: false, include: ['test-isolated/fr018NativeRaces.test.ts'],
  fileParallelism: false, testTimeout: 45_000, hookTimeout: 30_000,
} })
