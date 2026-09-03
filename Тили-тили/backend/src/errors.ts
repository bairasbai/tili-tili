/**
 * Единый формат ошибки на весь API: { error: { code, message } }.
 * Фронт разбирает `code`, человеку показывается `message`.
 * Никаких стектрейсов и текстов драйвера наружу — они уходят в лог.
 */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    /** Только для 422: какие поля не прошли валидацию. */
    fields?: Record<string, string>
  }
}

export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly fields: Record<string, string> | undefined

  constructor(statusCode: number, code: string, message: string, fields?: Record<string, string>) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.fields = fields
  }
}

export const notFound = (message = 'Не найдено') => new AppError(404, 'not_found', message)
export const unauthorized = (message = 'Нужен вход') => new AppError(401, 'unauthorized', message)
export const forbidden = (message = 'Нет доступа') => new AppError(403, 'forbidden', message)
export const conflict = (code: string, message: string) => new AppError(409, code, message)
export const gone = (message = 'Ссылка больше не действует') => new AppError(410, 'gone', message)

/**
 * 429 бывает двух разных видов, и клиенту нужно их различать.
 *
 * `TooManyRequests` — временное: контракт обещает `Retry-After`, и он
 * говорит, когда повторить. `quotaExceeded` — постоянное: предел на гостя
 * исчерпан, повтор не поможет никогда, и заголовка нет.
 *
 * Класс живёт здесь, а не в модуле входа по SMS, где он появился. Оттуда
 * его не находили: альбом и взносы отвечали 429 обычной ошибкой и роняли
 * обещанный контрактом заголовок (ERR-0022 повторился дважды).
 */
export class TooManyRequests extends AppError {
  readonly retryAfter: number
  constructor(retryAfter: number, message: string, code = 'too_many_requests') {
    super(429, code, message)
    this.retryAfter = retryAfter
  }
}

export const quotaExceeded = (code: string, message: string) => new AppError(429, code, message)

export const notImplemented = (operation: string) =>
  new AppError(501, 'not_implemented', `Эндпоинт описан в контракте, но ещё не реализован: ${operation}`)

export function toErrorBody(code: string, message: string, fields?: Record<string, string>): ApiErrorBody {
  return fields ? { error: { code, message, fields } } : { error: { code, message } }
}
