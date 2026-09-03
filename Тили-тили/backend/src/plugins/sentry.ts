import * as Sentry from '@sentry/node'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import { AppError } from '../errors.js'
import { maskUrl } from '../redact.js'

/**
 * Отправка ошибок в Sentry.
 *
 * Без `SENTRY_DSN` не отправляется ничего и об этом сказано в логе — как
 * с push и очередью. Молчаливо «включённый» сбор ошибок хуже выключенного:
 * на него надеются.
 *
 * Уходят только НЕОЖИДАННЫЕ ошибки. `AppError` — это ответ приложения
 * (404, 409, 422), а не поломка: если слать их, панель заполнится
 * опечатками пользователей, и в этом шуме настоящее падение не найти.
 */
export function registerSentry(app: FastifyInstance, config: Config): void {
  if (!config.sentryDsn) {
    app.log.warn('SENTRY_DSN не задан — ошибки видны только в логах процесса')
    return
  }

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.env,
    // Трассировку не включаем: она стоит денег и объёма, а для разбора
    // падений хватает самой ошибки с идентификатором запроса.
    tracesSampleRate: 0,
    /* Секреты не должны уехать в чужой сервис вместе с отчётом. Адрес
     * маскируется тем же кодом, что и в логе (ERR-0050): гостевой токен
     * стоит в пути, а токен живого канала — в строке запроса. */
    beforeSend(event) {
      if (event.request?.url) event.request.url = maskUrl(event.request.url)
      if (event.request?.headers) {
        delete event.request.headers.authorization
        delete event.request.headers.cookie
      }
      if (event.request?.query_string) event.request.query_string = '***'
      return event
    },
  })

  app.addHook('onError', async (request, _reply, error) => {
    // Ответ приложения — не инцидент. 500 и выше — инцидент всегда.
    const status = error instanceof AppError ? error.statusCode : (error.statusCode ?? 500)
    if (status < 500) return
    Sentry.withScope((scope) => {
      // Идентификатор запроса тот же, что в теле ответа 500 и в логе:
      // по нему жалоба пользователя находится за один поиск.
      scope.setTag('request_id', String(request.id))
      scope.setTag('route', request.routeOptions?.url ?? 'unknown')
      Sentry.captureException(error)
    })
  })

  app.addHook('onClose', async () => {
    // Даём отчётам уйти: процесс, убитый сразу после падения, уносит
    // с собой именно ту ошибку, ради которой всё и делалось.
    await Sentry.flush(2000)
  })

  app.log.info('Sentry подключён')
}

/** Падение фоновой задачи — тоже инцидент: её никто не видит. */
export function reportJobFailure(name: string, error: unknown): void {
  Sentry.withScope((scope) => {
    scope.setTag('job', name)
    Sentry.captureException(error)
  })
}
