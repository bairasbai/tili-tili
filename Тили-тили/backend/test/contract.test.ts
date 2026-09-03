import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { CONTRACT_OPERATIONS } from '../src/contract/paths.generated.js'

/**
 * Главный гейт этапа 0: каждый путь контракта должен быть узнан сервером.
 *
 * 404 здесь означает, что контракт вырос, а сервер об этом не знает — ровно тот
 * разрыв, из-за которого фронт неделю чинит несуществующую опечатку.
 */
let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp({ env: 'test', databaseUrl: null, redisUrl: null, corsOrigins: [] })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

/** :weddingId → тестовое значение, чтобы маршрут совпал. */
function fill(url: string): string {
  return url
    .split('/')
    .map((seg) => (seg.startsWith(':') ? 'test-id' : seg))
    .join('/')
}

describe('контракт', () => {
  it('в контракте есть операции', () => {
    expect(CONTRACT_OPERATIONS.length).toBeGreaterThan(0)
  })

  it('ни один путь контракта не отвечает 404', async () => {
    const missing: string[] = []
    for (const op of CONTRACT_OPERATIONS) {
      const res = await app.inject({ method: op.method as 'GET', url: fill(op.url) })
      if (res.statusCode === 404) missing.push(`${op.method} ${op.openapi}`)
    }
    expect(missing).toEqual([])
  })

  it('оставшиеся заглушки отвечают 501 с единым форматом ошибки', async () => {
    /* Путь ищется, а не берётся первым попавшимся: этапы закрываются,
     * и первый путь контракта давно реализован. Когда заглушек не останется
     * вовсе, проверять будет нечего — и это правильный конец теста,
     * а не его поломка. */
    for (const op of CONTRACT_OPERATIONS) {
      const res = await app.inject({ method: op.method as 'GET', url: fill(op.url) })
      if (res.statusCode !== 501) continue
      const body = res.json()
      // 501 бывает двух видов: «обработчика ещё нет» и «внешняя служба
      // не настроена» (OAuth, S3). Оба обязаны иметь код и текст.
      expect(typeof body.error.code).toBe('string')
      expect(typeof body.error.message).toBe('string')
    }
  })

  it('несуществующий адрес отвечает 404, а не 501', async () => {
    const res = await app.inject({ method: 'GET', url: '/такого-пути-нет' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('пути этапа 1 больше не заглушки', async () => {
    // Список ведётся руками намеренно: он показывает, что этап действительно
    // сдан, и падает, если регистрация маршрутов сломается при следующей правке.
    const done = [
      'POST /auth/otp',
      'POST /auth/otp/verify',
      'POST /auth/refresh',
      'GET /users/me',
      'PATCH /users/me',
      'DELETE /users/me',
      'POST /users/me/consent',
      'DELETE /users/me/consent',
      'GET /users/me/sessions',
      'DELETE /users/me/sessions',
      'DELETE /users/me/sessions/:sessionId',
      'GET /users/me/export',
      'GET /catalog/categories',
      'GET /catalog/vendors',
      'GET /catalog/vendors/:vendorId',
      'GET /catalog/vendors/:vendorId/availability',
      'POST /catalog/concierge',
      'GET /me/favorites',
      'PUT /me/favorites/:vendorId',
      'DELETE /me/favorites/:vendorId',
      'GET /vendor/profile',
      'PUT /vendor/profile',
      'POST /vendor/profile/publish',
      'GET /vendor/calendar',
      'POST /vendor/calendar/busy',
      'GET /geo/cities',
      'GET /geo/nearest',
      'GET /weddings',
      'POST /weddings',
      'GET /weddings/:weddingId',
      'PATCH /weddings/:weddingId',
      'GET /weddings/:weddingId/members',
      'PATCH /weddings/:weddingId/members/:userId',
      'DELETE /weddings/:weddingId/members/:userId',
      'GET /weddings/:weddingId/invites',
      'POST /weddings/:weddingId/invites',
      'GET /invites/:code',
      'DELETE /invites/:code',
      'POST /invites/:code/accept',
      'GET /users/me/referral',
      'POST /referral/:code/apply',
      'GET /weddings/:weddingId/slots',
      'POST /weddings/:weddingId/slots/:slotId/book',
      'POST /weddings/:weddingId/slots/:slotId/cancel',
      'POST /weddings/:weddingId/slots/:slotId/pay',
      'POST /weddings/:weddingId/slots/:slotId/external',
      'DELETE /weddings/:weddingId/slots/:slotId/external',
      'POST /weddings/:weddingId/slots/:slotId/external/invite',
      'GET /guest-vendor/:token',
      'PATCH /deals/:dealId',
      'POST /deals/:dealId/contract',
      'GET /weddings/:weddingId/documents',
      'POST /weddings/:weddingId/reschedule',
      'POST /weddings/:weddingId/cancel',
      'GET /weddings/:weddingId/budget',
      'POST /weddings/:weddingId/budget/items',
      'DELETE /weddings/:weddingId/budget/items/:itemId',
      'GET /weddings/:weddingId/guests',
      'POST /weddings/:weddingId/guests',
      'PATCH /weddings/:weddingId/guests/:guestId',
      'DELETE /weddings/:weddingId/guests/:guestId',
      'POST /weddings/:weddingId/guests/:guestId/invite-link',
      'GET /invite/:shareCode',
      'GET /rsvp/:guestToken',
      'POST /rsvp/:guestToken',
      'GET /weddings/:weddingId/tables',
      'POST /weddings/:weddingId/tables',
      'GET /weddings/:weddingId/tasks',
      'POST /weddings/:weddingId/tasks',
      'PATCH /weddings/:weddingId/tasks/:taskId',
      'DELETE /weddings/:weddingId/tasks/:taskId',
      'GET /weddings/:weddingId/timeline',
      'PUT /weddings/:weddingId/timeline',
      'POST /weddings/:weddingId/timeline/autogen',
      'GET /weddings/:weddingId/album',
      'POST /weddings/:weddingId/album',
      'PATCH /weddings/:weddingId/album/:photoId',
      'POST /weddings/:weddingId/logistics/buses',
      'DELETE /weddings/:weddingId/logistics/buses/:busId',
      'POST /weddings/:weddingId/logistics/hotels',
      'DELETE /weddings/:weddingId/logistics/hotels/:hotelId',
      'POST /weddings/:weddingId/logistics/notify-pickup',
      'POST /join/:guestToken/shuttle',
      'GET /join/:guestToken/hotels',
      'POST /join/:guestToken/hotels',
      'GET /weddings/:weddingId/menu-poll',
      'PUT /weddings/:weddingId/menu-poll',
      'POST /weddings/:weddingId/menu-poll/remind',
      'POST /join/:guestToken/menu-vote',
    ]
    const stillStub: string[] = []
    for (const key of done) {
      const [method, url] = key.split(' ') as [string, string]
      const res = await app.inject({ method: method as 'GET', url: fill(url) })
      if (res.statusCode === 501) stillStub.push(key)
    }
    expect(stillStub).toEqual([])
  })

  it('OAuth отложен явно: 501, но со своей причиной, а не общей заглушкой', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/oauth/vk' })
    expect(res.statusCode).toBe(501)
    // Не not_implemented: путь не «забыт», а ждёт приложений провайдеров.
    expect(res.json().error.code).toBe('oauth_not_configured')
  })

  it('загрузка файлов отложена явно: ждёт объектного хранилища', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/upload-url',
      payload: { kind: 'vendor_photo', contentType: 'image/jpeg', sizeBytes: 1 },
    })
    // Без токена — 401; сам код причины закреплён в наборе этапа 3.
    expect([401, 501]).toContain(res.statusCode)
  })

  it('заглушек остаётся ровно столько, сколько работы впереди', async () => {
    let stub = 0
    for (const op of CONTRACT_OPERATIONS) {
      const res = await app.inject({ method: op.method as 'GET', url: fill(op.url) })
      if (res.statusCode === 501 && res.json().error.code === 'not_implemented') stub++
    }
    // Число падает с каждым этапом. Если оно выросло — что-то отвалилось.
    expect(stub).toBeLessThanOrEqual(CONTRACT_OPERATIONS.length - 92)
  })

  it('в контракте нет дублей метод+путь', () => {
    const keys = CONTRACT_OPERATIONS.map((o) => `${o.method} ${o.url}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
