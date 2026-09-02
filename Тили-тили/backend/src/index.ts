import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
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
