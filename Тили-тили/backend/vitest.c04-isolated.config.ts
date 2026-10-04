import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Intended backend-root placement. Explicit isolated lane; ordinary full/CI never silently skips these gates.
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), test: {
  environment: 'node', globals: false, include: ['test-isolated/c04FanoutAdmission.test.ts'],
  fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000,
} })
