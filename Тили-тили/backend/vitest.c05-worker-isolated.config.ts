import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Intended backend-root placement. Exclusive disposable native worker lane, separate from ordinary full/CI.
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), test: {
  environment: 'node', globals: false, include: ['test-isolated/c05WorkerFinalBatch.test.ts'],
  fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000,
} })
