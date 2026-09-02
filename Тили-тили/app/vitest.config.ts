import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Тестовая конфигурация вынесена отдельно, чтобы не трогать сборку.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
}))
