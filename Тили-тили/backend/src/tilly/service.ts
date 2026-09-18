import type { FastifyInstance } from 'fastify'
import type { Db, Queryable } from '../plugins/db.js'
import { uuidv7 } from '../ids.js'
import { weddingContext } from './context.js'
import { tillySystemPrompt } from './prompt.js'
import type { TillyConfig, TillyMessage, TillyModel } from './model.js'

/*
 * Тиль как служба (фича 010): квота, фоновый ответ, учёт.
 *
 * Реплика пары сохраняется и отвечается 201 сразу — модель отвечает секунды,
 * а `requestTimeout` сервера 30 с, и HTTP-запрос пары ждать её не должен.
 * Ответ Тиля приходит в чат отдельной репликой через живой канал и опрос,
 * как любое сообщение. Пока модель думает, в чат уходит «печатает» от
 * актора `tilly` — хаб не доставляет событие его автору, а `tilly` никто
 * не является, поэтому пара его видит.
 *
 * Честность (План §18): без провайдера — заглушка словами, отказ провайдера —
 * «временно без ИИ». Ни то ни другое не выдаётся за ответ модели, и оба
 * учитываются в `tilly_usage` своим исходом.
 */

/** Ответ Тиля, пока у него нет модели. Честно, а не «думаю…» в пустоту. */
export const TILLY_STUB =
  'Тиль пока без ИИ — подсказки готовятся. Напишите вопрос: он сохранится, и вы получите ответ, когда помощник заработает.'

/** Провайдер отказал или не ответил вовремя — говорим это словами, а не молчим (План §18 «Fallback LLM»). */
export const TILLY_OFFLINE =
  'Тиль временно без ИИ — модель не ответила. Загляните в чек-лист и бюджет, а поиск подрядчиков — во вкладке «Поиск»; ваш вопрос сохранён, спросите ещё раз чуть позже.'

/** Реплики Тиля, которые не считаются его ответами и в историю для модели не попадают. */
const NOT_AN_ANSWER = new Set([TILLY_STUB, TILLY_OFFLINE])

/** Сколько реплик переписки уходит модели вместе с вопросом. */
const HISTORY_LIMIT = 20
const TYPING_EVERY_MS = 3_000
/** Актор события «печатает» от Тиля: не пользователь — хаб доставит его паре. */
export const TILLY_ACTOR = 'tilly'

export type TillyOutcome = 'answered' | 'failed' | 'stub'

export interface TillyQuota {
  used: number
  limit: number
}

export interface AnswerInput {
  chatId: string
  weddingId: string
  /** Кто спросил — актор события `message` при публикации ответа. */
  userId: string
}

declare module 'fastify' {
  interface FastifyInstance {
    tilly: TillyService
  }
}

export class TillyService {
  private readonly pending = new Set<Promise<void>>()
  /** Отбой запросов к модели при остановке сервера — по одному на ответ в работе. */
  private readonly inflight = new Set<AbortController>()

  constructor(
    private readonly app: FastifyInstance,
    readonly model: TillyModel | null,
    private readonly config: TillyConfig,
  ) {}

  /** За Тилем стоит модель — экран говорит это словами по `Chat.tilly.live`. */
  get live(): boolean {
    return this.model !== null
  }

  get limitPerDay(): number {
    return this.config.dailyLimit
  }

  /**
   * Сколько реплик пара уже отправила Тилю за сутки по поясу свадьбы.
   *
   * Источник правды — сами реплики в `messages` (`sender_id` не пуст —
   * реплика человека, пустой — Тиля), не отдельный счётчик: счётчик
   * расходится с лентой на первой же уборке. Сутки — календарные по поясу
   * места, как окно чата дня; без пояса — Москва.
   *
   * Вопрос, на который модель не ответила (`tilly_usage.outcome = 'failed'`:
   * отказ провайдера, таймаут, остановка сервера), в счёт не идёт — пара
   * получила заглушку, а не ответ, и платить за это лимитом не должна
   * (ревью 015, C11). Заглушка без модели (`stub`) считается: вопросы
   * сохраняются и ждут ответа, и предел на них — тот же.
   */
  async quota(db: Queryable, chatId: string, weddingId: string): Promise<TillyQuota> {
    const { rows } = await db.query<{ used: string }>(
      `with day as (select coalesce((select tz from weddings where id = $2), 'Europe/Moscow') as tz)
       select greatest(0,
                (select count(*) from messages m, day
                  where m.chat_id = $1 and m.sender_id is not null
                    and (m.created_at at time zone day.tz)::date = (now() at time zone day.tz)::date)
              - (select count(*) from tilly_usage u, day
                  where u.chat_id = $1 and u.outcome = 'failed'
                    and (u.created_at at time zone day.tz)::date = (now() at time zone day.tz)::date))::text as used`,
      [chatId, weddingId],
    )
    return { used: Number(rows[0]?.used ?? 0), limit: this.config.dailyLimit }
  }

  /**
   * Ответить в фоне. Возвращает сразу; обещание ответа хранится в `pending`,
   * чтобы `settle()` (тесты, остановка сервера) дождался всех.
   */
  answer(input: AnswerInput): void {
    const run = this.respond(input).catch((err: unknown) => {
      this.app.log.error({ err, chatId: input.chatId }, 'Тиль: ответ не записан')
    })
    this.pending.add(run)
    void run.finally(() => this.pending.delete(run))
  }

  /**
   * Дождаться всех фоновых ответов — но не дольше `graceMs`.
   *
   * Сервер при остановке ждёт закрытия 20 с (`index.ts`), а модель может думать
   * минуту: раньше ответ терялся вместе с процессом — «печатает…» обрывалось,
   * вопрос оставался без ответа и без строки учёта навсегда (ревью 015).
   * Теперь по истечении срока запросы к модели отбиваются, и каждый ответ в
   * работе дописывается честной заглушкой «временно без ИИ» с исходом
   * `failed` — пара видит, что случилось, и спрашивает ещё раз.
   */
  async settle(graceMs = 8_000): Promise<void> {
    if (!this.pending.size) return
    let timer: NodeJS.Timeout | undefined
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs)
    })
    const outcome = await Promise.race([Promise.allSettled([...this.pending]).then(() => 'done' as const), grace])
    clearTimeout(timer)
    if (outcome === 'timeout') for (const controller of this.inflight) controller.abort()
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  private async respond(input: AnswerInput): Promise<void> {
    const db = this.app.db
    if (!db) return
    const started = Date.now()
    const typing = () =>
      this.app.realtime.publish({ chatId: input.chatId, type: 'typing', actorId: TILLY_ACTOR }).catch(() => undefined)
    await typing()
    const ticker = setInterval(() => void typing(), TYPING_EVERY_MS)
    try {
      if (!this.model) {
        await this.reply(db, input, TILLY_STUB, { outcome: 'stub', provider: 'none', model: 'none', input: 0, output: 0, started })
        return
      }
      const [context, history] = await Promise.all([weddingContext(db, input.weddingId), this.history(db, input.chatId)])
      let text = TILLY_OFFLINE
      let outcome: TillyOutcome = 'failed'
      let usage = { inputTokens: 0, outputTokens: 0 }
      let model = this.model.model
      const controller = new AbortController()
      this.inflight.add(controller)
      try {
        const answer = await this.model.complete({
          system: tillySystemPrompt(context.text),
          messages: history,
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
          /* Общий предел на ответ: попытки клиента внутри него; плюс отбой при остановке сервера. */
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.timeoutMs * 2 + 5_000)]),
        })
        text = answer.text
        outcome = 'answered'
        usage = answer.usage
        model = answer.model
      } catch (err) {
        /* Ключ и адрес провайдера в лог не попадают: тут только ошибка и модель. */
        this.app.log.error({ err, provider: this.model.provider, model: this.model.model }, 'Тиль: модель не ответила')
      } finally {
        this.inflight.delete(controller)
      }
      await this.reply(db, input, text, {
        outcome,
        provider: this.model.provider,
        model,
        input: usage.inputTokens,
        output: usage.outputTokens,
        started,
      })
    } finally {
      clearInterval(ticker)
    }
  }

  /** Хвост переписки для модели: реплики людей — `user`, ответы Тиля — `assistant`; заглушки и отказы не считаются. */
  private async history(db: Db, chatId: string): Promise<TillyMessage[]> {
    const { rows } = await db.query<{ sender_id: string | null; text: string }>(
      `select sender_id, text from messages where chat_id = $1 order by created_at desc, id desc limit $2`,
      [chatId, HISTORY_LIMIT],
    )
    const messages: TillyMessage[] = []
    for (const r of rows.reverse()) {
      if (r.sender_id === null && NOT_AN_ANSWER.has(r.text)) continue
      const role = r.sender_id === null ? 'assistant' : 'user'
      const last = messages[messages.length - 1]
      /* Две реплики одной роли подряд — в одну: провайдеры требуют чередования. */
      if (last && last.role === role) last.content = `${last.content}\n\n${r.text}`
      else messages.push({ role, content: r.text })
    }
    /* Диалог начинается с человека — открывающий «ответ» Тиля модель не поймёт. */
    while (messages.length && messages[0]!.role === 'assistant') messages.shift()
    return messages
  }

  /** Реплика Тиля в чат + строка учёта + событие живого канала. */
  private async reply(
    db: Db,
    input: AnswerInput,
    text: string,
    meta: { outcome: TillyOutcome; provider: string; model: string; input: number; output: number; started: number },
  ): Promise<void> {
    const id = uuidv7()
    const { rows } = await db.query<{ created_at: Date }>(
      'insert into messages (id, chat_id, sender_id, text) values ($1,$2,null,$3) returning created_at',
      [id, input.chatId, text],
    )
    await db.query(
      `insert into tilly_usage (id, wedding_id, chat_id, message_id, provider, model, input_tokens, output_tokens, latency_ms, outcome)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uuidv7(), input.weddingId, input.chatId, id, meta.provider, meta.model, meta.input, meta.output, Date.now() - meta.started, meta.outcome],
    )
    await this.app.realtime.publish({
      chatId: input.chatId,
      type: 'message',
      actorId: input.userId,
      payload: {
        message: {
          id,
          chatId: input.chatId,
          senderId: null,
          text,
          attachmentUrl: null,
          sentAt: rows[0]!.created_at.toISOString(),
          // Ответ Тиля — реплика помощника, не системная запись.
          system: false,
          guestName: null,
        },
      },
    })
  }
}
