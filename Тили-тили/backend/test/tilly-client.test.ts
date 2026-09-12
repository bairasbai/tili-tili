/*
 * Фича 010 — клиент OpenAI-совместимого протокола за Тилем (`tilly/model.ts`).
 *
 * Провайдера в тесте нет — вместо OpenRouter и Ollama отвечает локальный
 * HTTP-сервер, который записывает, что ему прислали. Это и есть проверка
 * совместимости: форма запроса (`model`, `messages` с системной подсказкой
 * первой, `max_tokens`, `temperature`, `models[]` и заголовки OpenRouter),
 * чтение ответа (`choices[0].message.content`, `usage`), один повтор при
 * 429/5xx, отказ на пустой ответ и на `error` в теле 200, таймаут.
 * Базы не нужно — набор идёт и без TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAiCompatibleModel, TillyProviderError, createTillyModel, DEFAULT_MODEL } from '../src/tilly/model.js'

interface Seen {
  url: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

describe('фича 010: клиент OpenAI-совместимого протокола (OpenRouter / Ollama)', () => {
  let server: http.Server
  let baseUrl: string
  const seen: Seen[] = []
  /** Очередь ответов сервера: статус, тело, задержка. Пусто — обычный ответ. */
  const queue: { status: number; body: unknown; delayMs?: number }[] = []

  const okBody = (text: string) => ({
    id: 'gen-1',
    model: 'google/gemma-4-31b-it:free',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 321, completion_tokens: 45 },
  })

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} })
        const next = queue.shift() ?? { status: 200, body: okBody('Не забронированы: DJ и транспорт.') }
        const send = () => {
          res.writeHead(next.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(next.body))
        }
        if (next.delayMs) setTimeout(send, next.delayMs)
        else send()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const request = (overrides: Partial<Parameters<OpenAiCompatibleModel['complete']>[0]> = {}) => ({
    system: 'Ты — Тиль.',
    messages: [{ role: 'user' as const, content: 'Что мы забыли?' }],
    maxTokens: 1500,
    temperature: 0.4,
    ...overrides,
  })

  it('OpenRouter: тело и заголовки по протоколу, запасные модели в models[], ответ разобран', async () => {
    seen.length = 0
    const model = new OpenAiCompatibleModel({
      provider: 'openrouter',
      baseUrl,
      apiKey: 'sk-or-test',
      models: ['openrouter/free', 'google/gemma-4-31b-it:free'],
      timeoutMs: 5_000,
      retryDelayMs: 0,
    })
    const reply = await model.complete(request())
    expect(reply.text).toBe('Не забронированы: DJ и транспорт.')
    expect(reply.usage).toEqual({ inputTokens: 321, outputTokens: 45 })
    expect(reply.finish).toBe('stop')
    expect(reply.model, 'какая модель ответила — из ответа, не из настройки').toBe('google/gemma-4-31b-it:free')

    expect(seen).toHaveLength(1)
    const [call] = seen
    expect(call!.url).toBe('/v1/chat/completions')
    expect(call!.headers['authorization']).toBe('Bearer sk-or-test')
    expect(call!.headers['content-type']).toBe('application/json')
    expect(call!.headers['http-referer']).toBe('https://tili-tili.ru')
    expect(call!.headers['x-title']).toBe('Tili-tili')
    expect(call!.body['model']).toBe('openrouter/free')
    expect(call!.body['models']).toEqual(['openrouter/free', 'google/gemma-4-31b-it:free'])
    expect(call!.body['max_tokens']).toBe(1500)
    expect(call!.body['temperature']).toBe(0.4)
    expect(call!.body['stream']).toBe(false)
    expect(call!.body['messages']).toEqual([
      { role: 'system', content: 'Ты — Тиль.' },
      { role: 'user', content: 'Что мы забыли?' },
    ])
  })

  it('Ollama: без ключа — без Authorization, без models[] и без заголовков OpenRouter; адрес со слешем на конце не удваивается', async () => {
    seen.length = 0
    const model = new OpenAiCompatibleModel({ provider: 'ollama', baseUrl: `${baseUrl}/`, apiKey: null, models: ['hermes3'], timeoutMs: 5_000, retryDelayMs: 0 })
    await model.complete(request())
    const [call] = seen
    expect(call!.url).toBe('/v1/chat/completions')
    expect(call!.headers['authorization']).toBeUndefined()
    expect(call!.headers['http-referer']).toBeUndefined()
    expect(call!.body['model']).toBe('hermes3')
    expect(call!.body).not.toHaveProperty('models')
  })

  it('429 от провайдера — один повтор; второй 429 — TillyProviderError со статусом, третьего запроса нет', async () => {
    seen.length = 0
    queue.push({ status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-min' } } })
    const model = new OpenAiCompatibleModel({ provider: 'openrouter', baseUrl, apiKey: 'k', models: ['openrouter/free'], timeoutMs: 5_000, retryDelayMs: 0 })
    const reply = await model.complete(request())
    expect(reply.text).toBe('Не забронированы: DJ и транспорт.')
    expect(seen, 'после 429 должен быть ровно один повтор').toHaveLength(2)

    seen.length = 0
    queue.push({ status: 429, body: { error: { message: 'limit' } } }, { status: 429, body: { error: { message: 'limit again' } } })
    await expect(model.complete(request())).rejects.toMatchObject({ name: 'TillyProviderError', status: 429, message: 'limit again' })
    expect(seen).toHaveLength(2)
  })

  it('400 — без повтора; пустой content и error в теле 200 — отказ 502 словами', async () => {
    seen.length = 0
    const model = new OpenAiCompatibleModel({ provider: 'openai', baseUrl, apiKey: 'k', models: ['local'], timeoutMs: 5_000, retryDelayMs: 0 })
    queue.push({ status: 400, body: { error: { message: 'model not found' } } })
    await expect(model.complete(request())).rejects.toMatchObject({ status: 400, message: 'model not found' })
    expect(seen, '400 не повторяется').toHaveLength(1)

    /* Пустой ответ и error в теле 200 — 502: как и настоящий 5xx, повторяется один раз, потому в очереди по два. */
    const empty = { status: 200, body: { choices: [{ message: { content: '   ' } }] } }
    queue.push(empty, empty)
    await expect(model.complete(request())).rejects.toBeInstanceOf(TillyProviderError)

    const inBody = { status: 200, body: { error: { message: 'Provider returned error', code: 502 } } }
    queue.push(inBody, inBody)
    await expect(model.complete(request())).rejects.toMatchObject({ status: 502, message: 'Provider returned error' })
  })

  it('провайдер молчит дольше таймаута — отказ, а не вечное «печатает»', async () => {
    seen.length = 0
    queue.push({ status: 200, body: okBody('поздно'), delayMs: 700 }, { status: 200, body: okBody('поздно'), delayMs: 700 })
    const model = new OpenAiCompatibleModel({ provider: 'openai', baseUrl, apiKey: null, models: ['local'], timeoutMs: 150, retryDelayMs: 0 })
    const started = Date.now()
    await expect(model.complete(request())).rejects.toBeTruthy()
    expect(Date.now() - started, 'две попытки по 150 мс, не 1400').toBeLessThan(1_200)
  })

  it('createTillyModel: без провайдера — null; OpenRouter без модели — openrouter/free; Ollama — hermes3; openai без адреса — ошибка', () => {
    const base = { apiKey: 'k', dailyLimit: 50, timeoutMs: 60_000, maxTokens: 1500, temperature: 0.4 }
    expect(createTillyModel({ ...base, provider: null, baseUrl: null, models: [] })).toBeNull()
    const router = createTillyModel({ ...base, provider: 'openrouter', baseUrl: null, models: [] })
    expect(router?.provider).toBe('openrouter')
    expect(router?.model).toBe(DEFAULT_MODEL.openrouter)
    expect(createTillyModel({ ...base, provider: 'ollama', baseUrl: null, models: [] })?.model).toBe('hermes3')
    expect(() => createTillyModel({ ...base, provider: 'openai', baseUrl: null, models: ['x'] })).toThrow(/TILLY_BASE_URL/)
  })
})
