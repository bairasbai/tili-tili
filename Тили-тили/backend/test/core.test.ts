import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { encodeCursor, decodeCursor, parsePageQuery, buildPage, MAX_LIMIT } from '../src/pagination.js'
import { AppError, toErrorBody } from '../src/errors.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp({ env: 'test', databaseUrl: null, redisUrl: null, corsOrigins: [] })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('health', () => {
  it('/health отвечает 200 даже без базы', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ok')
  })

  it('/health/ready отвечает 503 без базы и Redis', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'not_ready', db: 'down', redis: 'down' })
  })
})

describe('ошибки', () => {
  it('формат один и тот же', () => {
    expect(toErrorBody('x', 'y')).toEqual({ error: { code: 'x', message: 'y' } })
  })

  it('поля добавляются только когда они есть', () => {
    expect(toErrorBody('x', 'y', { a: 'b' })).toEqual({ error: { code: 'x', message: 'y', fields: { a: 'b' } } })
  })

  it('AppError несёт код и статус', () => {
    const e = new AppError(409, 'date_taken', 'Дата занята')
    expect(e.statusCode).toBe(409)
    expect(e.code).toBe('date_taken')
  })
})

describe('пагинация', () => {
  it('курсор переживает кодирование', () => {
    expect(decodeCursor(encodeCursor('2026-09-02T10:00:00Z', 'abc'))).toEqual({
      sort: '2026-09-02T10:00:00Z',
      id: 'abc',
    })
  })

  it('значение сортировки может содержать разделитель', () => {
    expect(decodeCursor(encodeCursor('a|b', 'id1'))).toEqual({ sort: 'a|b', id: 'id1' })
  })

  it('испорченный курсор — 400, а не падение', () => {
    expect(() => decodeCursor('!!!')).toThrow(AppError)
  })

  it('limit по умолчанию и потолок', () => {
    expect(parsePageQuery({}).limit).toBe(20)
    expect(parsePageQuery({ limit: '5000' }).limit).toBe(MAX_LIMIT)
  })

  it('нецелый limit отвергается', () => {
    expect(() => parsePageQuery({ limit: '0' })).toThrow(AppError)
    expect(() => parsePageQuery({ limit: 'два' })).toThrow(AppError)
  })

  it('лишняя строка не отдаётся, но даёт курсор', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const page = buildPage(rows, 2, (r) => r.id)
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBe('b')
  })

  it('последняя страница без курсора', () => {
    const page = buildPage([{ id: 'a' }], 2, (r) => r.id)
    expect(page.nextCursor).toBeNull()
  })
})
