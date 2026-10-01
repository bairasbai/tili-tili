import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { criticalAssets } from './build/criticalAssets'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: './',
  /* Плагин инспектора — только в разработке: в боевой сборке его атрибуты на
     каждом элементе — лишний вес и лишние сведения о структуре кода
     (аудит 2026-09-07, блок 9). */
  plugins: [mode === 'development' && inspectAttr(), react(), {
    name: 'critical-offline-assets',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = criticalAssets(bundle)
      const source = readFileSync(path.resolve(__dirname, 'public/sw.js'), 'utf8')
      if (!source.includes('const CRITICAL_ASSETS = []')) throw new Error('Offline asset injection marker missing')
      const version = createHash('sha256').update(source).update(JSON.stringify(assets)).digest('hex').slice(0, 16)
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: source
        .replace('const CRITICAL_ASSETS = []', 'const CRITICAL_ASSETS = ' + JSON.stringify(assets))
        .replace("const CACHE_VERSION = 'v6'", `const CACHE_VERSION = 'v6-${version}'`) })
    },
  } satisfies Plugin].filter(Boolean),
  build: {
    rollupOptions: {
      output: {
        /* React и роутер — отдельным чанком: он не меняется от выкладки к
           выкладке и остаётся в кэше, а главный чанк уходит из-под предела
           в 500 кБ, о котором Vite предупреждал на каждой сборке. */
        manualChunks: { react: ['react', 'react-dom', 'react-router'] },
      },
    },
  },
  server: {
    port: 3000,
    /* Запросы фронта идут на /api и уезжают на бэкенд. Через прокси, а не
       напрямую, по двум причинам: в разработке нет CORS-преграды, а в проде
       адрес задаётся VITE_API_URL и код запросов не меняется.
       Порт 3001, потому что 3000 занят этим самым сервером разработки. */
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        /* Живой канал чата ходит по тому же адресу с апгрейдом до WebSocket.
           Без `ws` прокси его не пропускает, и в разработке чат молча
           работает только опросом — то есть проверить живой канал нельзя. */
        ws: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
