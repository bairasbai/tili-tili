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

export const notImplemented = (operation: string) =>
  new AppError(501, 'not_implemented', `Эндпоинт описан в контракте, но ещё не реализован: ${operation}`)

export function toErrorBody(code: string, message: string, fields?: Record<string, string>): ApiErrorBody {
  return fields ? { error: { code, message, fields } } : { error: { code, message } }
}
