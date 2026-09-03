import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Sentry from '@sentry/node'
import { buildApp } from '../src/app.js'
import { maskUrl } from '../src/redact.js'

/* Подменяется весь модуль: в ESM пространство имён неизменяемо, и
 * шпионить за отдельным экспортом нельзя. */
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  flush: vi.fn(async () => true),
  captureException: vi.fn(() => 'id'),
  withScope: vi.fn((fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => undefined })),
}))

/**
 * Отправка ошибок наружу.
 *
 * Sentry — чужой сервис, и в него уезжают адреса запросов. Гостевой токен
 * стоит в пути, токен живого канала — в строке запроса: то, что маскируется
 * в логе (ERR-0050), обязано маскироваться и здесь.
 */
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const base = {
  env: 'test' as const,
  databaseUrl: null,
  redisUrl: null,
  corsOrigins: [],
  jwtAccessSecret: SECRET_A,
  jwtRefreshSecret: SECRET_R,
  policyVersion: '2026-09-02',
}

describe('отправка ошибок', () => {
  const sent = () => vi.mocked(Sentry.captureException).mock.calls.map((c) => c[0])

  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear()
  })

  it('без DSN не отправляется ничего', async () => {
    const app = await buildApp({ ...base, sentryDsn: null }, [
      async (instance) => {
        instance.get('/падение', async () => {
          throw new Error('внутренняя поломка')
        })
      },
    ])
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/падение' })
      expect(res.statusCode).toBe(500)
      // Молчаливо «включённый» сбор ошибок хуже выключенного: на него надеются.
      expect(sent()).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  it('с DSN уходит только неожиданная ошибка, а не ответ приложения', async () => {
    const app = await buildApp({ ...base, sentryDsn: 'https://key@sentry.example/1' }, [
      async (instance) => {
        instance.get('/падение', async () => {
          throw new Error('внутренняя поломка')
        })
      },
    ])
    await app.ready()
    try {
      // 404 — это ответ приложения. Если слать такие, в панели будут
      // опечатки пользователей, и настоящее падение в них потеряется.
      await app.inject({ method: 'GET', url: '/нет-такого-адреса' })
      expect(sent()).toHaveLength(0)

      const res = await app.inject({ method: 'GET', url: '/падение' })
      expect(res.statusCode).toBe(500)
      expect(sent()).toHaveLength(1)
      expect((sent()[0] as Error).message).toBe('внутренняя поломка')

      // Тело ответа несёт идентификатор запроса — тот же, что в отчёте
      // и в логе: жалоба пользователя находится за один поиск.
      expect(res.json().error.message).toContain('Идентификатор запроса')
    } finally {
      await app.close()
    }
  })

  it('адрес в отчёте маскируется так же, как в логе', () => {
    // Проверяется та же функция, что стоит в beforeSend: две разные
    // маскировки разошлись бы на первой правке.
    expect(maskUrl('/gifts/AbCd-1234/g1/reserve')).toBe('/gifts/***/g1/reserve')
    expect(maskUrl('/chats/c1/ws?token=eyJhbGciOi')).toBe('/chats/c1/ws?token=***')
  })
})
