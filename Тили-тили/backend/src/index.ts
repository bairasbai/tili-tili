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

if (config.env === 'production' && config.trustProxy === false) {
  // Не авария: приложение работает. Но за балансировщиком все запросы выглядят
  // приходящими с одного адреса, и ограничитель по адресу перестаёт различать
  // клиентов — про это надо знать, а не выяснять по счёту за SMS.
  app.log.warn('TRUST_PROXY не задан: адрес клиента будет адресом балансировщика')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'останов')
    /* Закрытие ждёт текущие запросы: обрыв на середине оплаты дороже
     * лишних двух секунд при выкате. Но не дольше двадцати секунд:
     * зависшее соединение с базой или живой канал чата иначе оставят
     * процесс висеть, и оркестратор убьёт его сам — грубее и без записи
     * в лог о том, что произошло. */
    const forced = setTimeout(() => {
      app.log.error('останов затянулся — выходим принудительно')
      process.exit(1)
    }, 20_000)
    forced.unref()
    /* У `close()` есть второй исход. Если Redis не отвечает или плагин падает
     * на закрытии, обещание отклоняется. `void` его не ловит: выходил
     * необработанный reject, Node ронял процесс сам — без строки в логе
     * о том, почему, и мимо всего аккуратного останова выше (F-RL-1-05,
     * ревью 016). Код выхода 1 — как у принудительного выхода по таймеру:
     * останов состоялся, но не чисто, и это должно быть видно. */
    void app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'останов завершился с ошибкой')
        process.exit(1)
      },
    )
  })
}

await app.listen({ port: config.port, host: config.host })
