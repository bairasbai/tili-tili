import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { criticalAssets } from './build/criticalAssets'
import { COMPILED_SHELL_MARKER, SHELL_ENTRY_MARKER, shellEntryAssets } from './build/shellEntryAssets'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: './',
  /* Плагин инспектора — только в разработке: в боевой сборке его атрибуты на
     каждом элементе — лишний вес и лишние сведения о структуре кода
     (аудит 2026-09-07, блок 9). */
  plugins: [mode === 'development' && inspectAttr(), react(), {
    name: 'shell-entry-assets',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.bundle) throw new Error('Shell entry actual bundle missing')
        return shellEntryAssets(html, context.bundle)
      },
    },
  } satisfies Plugin, {
    name: 'critical-offline-assets',
    apply: 'build',
    // Vite's build-html emits index.html before post plugins generateBundle.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = criticalAssets(bundle)
      const source = readFileSync(path.resolve(__dirname, 'public/sw.js'), 'utf8')
      if (source.split('const CRITICAL_ASSETS = []').length !== 2 || source.split("const CACHE_VERSION = 'v6'").length !== 2) throw new Error('Offline asset injection marker missing or duplicate')
      const index = bundle['index.html']
      if (index?.type !== 'asset' || typeof index.source !== 'string' || index.source.split(COMPILED_SHELL_MARKER).length !== 2 || index.source.includes(SHELL_ENTRY_MARKER)) throw new Error('Final compiled shell HTML missing')
      const version = createHash('sha256').update(source).update(JSON.stringify(assets)).update(index.source).digest('hex').slice(0, 16)
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
