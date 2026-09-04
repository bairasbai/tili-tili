import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
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
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
