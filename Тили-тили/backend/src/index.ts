import { buildApp } from './app.js'
import { loadConfig, ConfigError } from './config.js'

/**
 * Ошибка конфигурации — не поломка, а забытая переменная окружения.
 * Стектрейс здесь только мешает: в логах Timeweb должно быть видно, чего
 * не хватает, с первой строки.
 */
function fail(error: unknown): never {
  if (error instanceof ConfigError) {
    console.error(`Сервер не запущен: ${error.message}`)
    process.exit(1)
  }
  throw error
}

let config
try {
  config = loadConfig()
} catch (error) {
  fail(error)
}

const app = await buildApp()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'останов')
    // Закрытие ждёт текущие запросы: обрыв на середине оплаты дороже
    // лишних двух секунд при выкате.
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ port: config.port, host: config.host })
