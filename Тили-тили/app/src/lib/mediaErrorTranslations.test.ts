import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from './api/client'
import { explainError } from './api/useApi'
import { setI18nLang } from './i18n'

afterEach(() => setI18nLang('ru'))
describe('managed-photo server refusals in the English interface', () => {
  it.each([
    [422, 'media_invalid_photo', 'Нужна корректная фотография JPEG, PNG или WebP в пределах лимитов', 'Choose a valid JPEG, PNG or WebP photo within the limits'],
    [422, 'media_malware_detected', 'Файл не прошёл проверку безопасности', 'The file did not pass the security check'],
    [422, 'idempotency_key_required', 'Нужен Idempotency-Key длиной 1–128 символов', 'An upload retry key of 1–128 characters is required'],
    [501, 'storage_not_configured', 'Загрузка фотографий пока не подключена', 'Photo uploads are not connected yet'],
    [409, 'media_retry_limit', 'Попытки проверки исчерпаны — удалите загрузку и дождитесь очистки', 'No more check attempts — delete the upload and wait for cleanup'],
  ] as const)('translates actual %s/%s refusals through the shared UI error path', (status, code, message, english) => {
    setI18nLang('en')
    expect(explainError(new ApiError('http', status, code, message))).toBe(english)
    setI18nLang('ru')
    expect(explainError(new ApiError('http', status, code, message))).toBe(message)
  })
})
