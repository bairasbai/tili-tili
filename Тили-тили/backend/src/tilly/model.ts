import type { FastifyBaseLogger } from 'fastify'

/*
 * Языковая модель за Тилем (фича 010).
 *
 * За интерфейсом — один протокол на всех: OpenAI-совместимые chat completions.
 * Его говорят OpenRouter (много моделей и ключей, в том числе бесплатные —
 * решение владельца В1), Ollama на своём сервере (`/v1`, модели вроде
 * `hermes3`), vLLM, llama.cpp, LM Studio. Поэтому своей зависимости нет —
 * `fetch`, как у отправителя SMS: провайдер меняется переменными окружения,
 * а не кодом. Anthropic и OpenAI напрямую сюда не подключаются — их модели
 * доступны через OpenRouter тем же протоколом (`anthropic/claude-…`).
 *
 * В тестах модель подменяется реализацией этого же интерфейса через
 * `buildApp` — это подмена внешней службы для проверки, как `ConsoleSender`
 * у SMS, а не мок продукта: путь от реплики пары до реплики Тиля проходит
 * целиком.
 */

export type TillyProvider = 'openrouter' | 'ollama' | 'openai'

export interface TillyConfig {
  /** Пусто — модели нет, Тиль отвечает честной заглушкой. */
  provider: TillyProvider | null
  baseUrl: string | null
  apiKey: string | null
  /** Первая — основная; остальные — запасные (OpenRouter принимает `models[]`). */
  models: string[]
  dailyLimit: number
  timeoutMs: number
  maxTokens: number
  temperature: number
}

export interface TillyMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface TillyRequest {
  system: string
  messages: TillyMessage[]
  maxTokens: number
  temperature: number
  signal?: AbortSignal
}

export interface TillyReply {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  /** `stop`, `length`, … — как назвал провайдер; пусто, если не назвал. */
  finish: string | null
  /** Какая модель ответила на самом деле (маршрутизатор может выбрать другую). */
  model: string
}

export interface TillyModel {
  readonly provider: string
  readonly model: string
  complete(request: TillyRequest): Promise<TillyReply>
}

/** Отказ провайдера: статус и его слова — в лог, паре уходит честное «временно без ИИ». */
export class TillyProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TillyProviderError'
  }
}

export const DEFAULT_BASE_URL: Record<TillyProvider, string | null> = {
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  openai: null,
}

/** Маршрутизатор бесплатных моделей OpenRouter — умолчание владельца (В2); Ollama — Hermes 3. */
export const DEFAULT_MODEL: Record<TillyProvider, string | null> = {
  openrouter: 'openrouter/free',
  ollama: 'hermes3',
  openai: null,
}

/** Что OpenRouter и Ollama отдают на `POST /chat/completions` — ровно то, что мы читаем. */
interface CompletionResponse {
  model?: string
  choices?: {
    message?: { content?: string | { type?: string; text?: string }[] | null }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; code?: number | string }
}

export interface OpenAiCompatibleOptions {
  provider: TillyProvider
  baseUrl: string
  apiKey: string | null
  models: string[]
  timeoutMs: number
  /** Пауза перед единственным повтором при 429/5xx; в тестах — ноль. */
  retryDelayMs?: number
  fetchImpl?: typeof fetch
  log?: FastifyBaseLogger
}

const RETRYABLE = (status: number) => status === 429 || status >= 500

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Клиент OpenAI-совместимого протокола.
 *
 * Тело — `model`, `messages` (системная подсказка первой), `max_tokens`,
 * `temperature`, `stream: false`; для OpenRouter — ещё `models[]` (запасные
 * модели, если их больше одной) и заголовки `HTTP-Referer`/`X-Title`, по
 * которым он показывает приложение в своей статистике. Ответ — текст первого
 * варианта и счётчики токенов. Один повтор при 429/5xx и обрыве сети: у
 * бесплатного маршрутизатора OpenRouter предел ~20 запросов в минуту, и
 * второй попытки через две секунды обычно хватает; больше — уже очередь.
 */
export class OpenAiCompatibleModel implements TillyModel {
  readonly provider: string
  readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly retryDelayMs: number

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.provider = options.provider
    this.model = options.models[0]!
    this.fetchImpl = options.fetchImpl ?? fetch
    this.retryDelayMs = options.retryDelayMs ?? 2_000
  }

  async complete(request: TillyRequest): Promise<TillyReply> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: false,
    }
    if (this.options.provider === 'openrouter' && this.options.models.length > 1) body['models'] = this.options.models

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.options.apiKey) headers['authorization'] = `Bearer ${this.options.apiKey}`
    if (this.options.provider === 'openrouter') {
      headers['http-referer'] = 'https://tili-tili.ru'
      headers['x-title'] = 'Tili-tili'
    }

    let attempt = 0
    for (;;) {
      attempt++
      try {
        return await this.once(body, headers, request.signal)
      } catch (error) {
        const retryable =
          attempt === 1 &&
          !request.signal?.aborted &&
          (error instanceof TillyProviderError ? RETRYABLE(error.status) : !(error instanceof Error && error.name === 'AbortError'))
        if (!retryable) throw error
        this.options.log?.warn({ err: error, provider: this.provider, model: this.model }, 'Тиль: провайдер не ответил, повтор')
        await delay(this.retryDelayMs)
      }
    }
  }

  private async once(body: Record<string, unknown>, headers: Record<string, string>, signal?: AbortSignal): Promise<TillyReply> {
    /* Таймаут — свой на каждую попытку: внешний сигнал ограничивает весь ответ. */
    const perTry = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, perTry]) : perTry
    const res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
    })
    const text = await res.text()
    let json: CompletionResponse | null = null
    try {
      json = JSON.parse(text) as CompletionResponse
    } catch {
      json = null
    }
    if (!res.ok) {
      throw new TillyProviderError(res.status, json?.error?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    /* Тело 200 с полем error — так OpenRouter сообщает об отказе модели за маршрутизатором. */
    if (json?.error) throw new TillyProviderError(502, json.error.message ?? 'провайдер вернул ошибку в теле 200')
    const choice = json?.choices?.[0]
    const content = choice?.message?.content
    const answer = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part.type === 'text' || part.type === undefined ? part.text ?? '' : '')).join('')
        : ''
    if (!answer.trim()) throw new TillyProviderError(502, 'провайдер вернул пустой ответ')
    return {
      text: answer.trim(),
      usage: {
        inputTokens: Number(json?.usage?.prompt_tokens ?? 0) || 0,
        outputTokens: Number(json?.usage?.completion_tokens ?? 0) || 0,
      },
      finish: choice?.finish_reason ?? null,
      model: json?.model ?? this.model,
    }
  }
}

/**
 * Модель из конфигурации или `null` — тогда Тиль отвечает заглушкой.
 * Неполная настройка (провайдер назван, а ключа или адреса нет) — ошибка
 * конфигурации на старте, не молчание в проде: её ловит `loadConfig`.
 */
export function createTillyModel(config: TillyConfig, log?: FastifyBaseLogger): TillyModel | null {
  if (!config.provider) return null
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL[config.provider]
  const models = config.models.length ? config.models : [DEFAULT_MODEL[config.provider] ?? '']
  if (!baseUrl || !models[0]) throw new Error(`Тиль: для провайдера ${config.provider} нужны TILLY_BASE_URL и TILLY_MODEL`)
  return new OpenAiCompatibleModel({
    provider: config.provider,
    baseUrl,
    apiKey: config.apiKey,
    models,
    timeoutMs: config.timeoutMs,
    ...(log ? { log } : {}),
  })
}
