import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Explicit single-file native acceptance lane; no business mocks, env fallback or silent ordinary-full skip.
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), test: {
  environment: 'node', globals: false, include: ['test-isolated/fr018OfferInputRoutes.test.ts'],
  fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000,
} })
