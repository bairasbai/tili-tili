import { describe, it, expect, afterEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { newShareCode } from '../src/guests/access.js'

/**
 * Регрессии по аудиту 2026-09-03.
 *
 * Каждый набор здесь падал бы до своего исправления — в этом весь смысл:
 * тест, который проходит и на сломанном коде, ничего не сторожит.
 *
 * Живая база не нужна: обе проверки работают на уровне чистой функции и
 * маршрутизатора, поэтому они идут в общем прогоне, а не под skipIf.
 */
const TEST_CONFIG = { env: 'test' as const, databaseUrl: null, redisUrl: null, corsOrigins: [] }

describe('код ссылки-приглашения гостя (ERR: Math.random в секрете доступа)', () => {
  const realRandom = Math.random
  afterEach(() => {
    Math.random = realRandom
  })

  it('не зависит от Math.random: с замороженным Math.random коды всё равно разные', () => {
    // Math.random в V8 — не криптостойкий генератор с общим состоянием на
    // процесс: пара, выпускающая ссылки на своей свадьбе, набирает выборку
    // и предсказывает коды чужих гостей. Замораживаем его — если код
    // построен на нём, все значения совпадут.
    Math.random = () => 0.5

    const codes = new Set(Array.from({ length: 200 }, () => newShareCode()))

    // До фикса здесь была бы ровно одна строка на 200 вызовов.
    expect(codes.size).toBeGreaterThan(150)
  })

  it('сохраняет формат XXXX-XXXX из читаемого алфавита', () => {
    // Алфавит без похожих знаков: код диктуют вслух. Смена генератора
    // не должна была затронуть форму.
    for (let i = 0; i < 50; i++) {
      expect(newShareCode()).toMatch(/^[ACDEFGHJKMNPQRTUVWXYZ234679]{4}-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/)
    }
  })
})

describe('идентификаторы подарков в адресе (ERR: 500 от драйвера базы)', () => {
  /*
   * До фикса строка из адреса уходила прямо в запрос по колонке uuid: драйвер
   * отвечал `invalid input syntax for type uuid`, обработчик переводил это
   * в 500 и писал в лог как о падении сервера.
   *
   * Ответ — 422 «не прошло проверку», а НЕ 404: путь контракта не должен
   * отвечать 404 ни при каких параметрах (инвариант 10). Проверка идёт схемой,
   * то есть до обработчика, поэтому ответ одинаков с базой и без неё.
   */
  it('не-UUID в пути резерва даёт 422, а не ошибку драйвера базы', async () => {
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/gifts/some-guest-token/not-a-uuid/reserve',
        headers: { 'idempotency-key': 'regression-1' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('validation_failed')
    } finally {
      await app.close()
    }
  })

  it('не-UUID в пути снятия резерва тоже даёт 422', async () => {
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({ method: 'DELETE', url: '/gifts/some-guest-token/12345/reserve' })
      expect(res.statusCode).toBe(422)
    } finally {
      await app.close()
    }
  })

  it('корректный UUID проходит проверку и доходит до обработчика', async () => {
    // Иначе схема могла бы отсекать всё подряд, и тесты выше проходили бы
    // по неверной причине. Без базы обработчик отвечает 503 — это и значит
    // «до него дошло».
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/gifts/some-guest-token/0192f3a4-5b6c-7d8e-9f01-234567890abc/reserve',
      })
      expect(res.statusCode).not.toBe(422)
    } finally {
      await app.close()
    }
  })
})
