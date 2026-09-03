import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Тестовая конфигурация вынесена отдельно, чтобы не трогать сборку.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    /* Инструменты кладут рабочие копии репозитория в app/.claude/worktrees/.
       Без этого vitest подбирает тесты оттуда: бэкендовые падают на чужом
       окружении, а фронтовые читают исходники через projectFile() от текущего
       каталога, то есть чужие файлы. Прогон становится красным на ровном месте. */
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
}))
