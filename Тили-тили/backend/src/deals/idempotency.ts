import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db, Queryable } from '../plugins/db.js'
import { AppError } from '../errors.js'

/**
 * Повтор запроса не должен повторять действие.
 *
 * Кнопка «Оплатить» на плохой связи нажимается дважды, мобильный клиент
 * повторяет запрос при обрыве. Без ключа это вторая запись об оплате и
 * вторая сделка — то есть реальные деньги и занятая дата.
 *
 * Ключ хранится вместе с ответом: повтор возвращает ТОТ ЖЕ ответ, а не
 * «уже сделано». Клиенту незачем знать, какой из его запросов дошёл первым.
 */
export interface Replay {
  status: number
  body: unknown
}

/** Ключ привязан к пользователю и маршруту: чужой ключ не сработает. */
function scopedKey(userId: string, route: string, clientKey: string): string {
  return `${userId}:${route}:${clientKey}`
}

/**
 * Отпечаток запроса — адрес вместе с телом (фича 014, D2-13).
 *
 * Один ключ, одинаковое тело и РАЗНЫЕ слоты в адресе — `POST …/slots/A/pay`
 * и `…/slots/B/pay` с пустым телом — по одному отпечатку тела считались
 * повтором: второй получал ответ первого, и оплата слота B не записывалась
 * молча. Адрес — часть запроса, значит и часть отпечатка.
 */
function hashRequest(url: string, body: unknown): string {
  return createHash('sha256').update(`${url}\n${JSON.stringify(body ?? null)}`).digest('hex')
}

export function readKeyHeader(request: FastifyRequest, required: boolean): string | null {
  const raw = request.headers['idempotency-key']
  const key = Array.isArray(raw) ? raw[0] : raw
  if (!key) {
    if (!required) return null
    throw new AppError(
      400,
      'idempotency_key_required',
      'Нужен заголовок Idempotency-Key: без него повтор запроса создаёт вторую запись',
    )
  }
  if (key.length > 200) throw new AppError(400, 'idempotency_key_too_long', 'Idempotency-Key длиннее 200 символов')
  return key
}

/**
 * Возвращает сохранённый ответ, если этот ключ уже отработал.
 *
 * Тот же ключ с ДРУГИМ запросом (адрес или тело) — ошибка клиента: он
 * переиспользовал ключ. Молча вернуть старый ответ значило бы потерять
 * второе действие, поэтому 409.
 */
export async function replayOrClaim(
  db: Db,
  userId: string,
  route: string,
  clientKey: string,
  url: string,
  body: unknown,
): Promise<Replay | null> {
  const key = scopedKey(userId, route, clientKey)
  const hash = hashRequest(url, body)

  // Ключи старше суток не нужны: клиент столько не повторяет. Уборка здесь,
  // а не в кроне — таблица растёт только от этого кода, значит и подметает
  // его же. Индекс по created_at делает удаление дешёвым.
  await db.query("delete from idempotency_keys where created_at < now() - interval '1 day'")

  /* Захват и чтение — в цикле: между «вставка не прошла» и «читаем чужую
   * строку» первый запрос мог упасть и освободить ключ (`releaseKey`).
   * Раньше пустое чтение возвращало `null` — «выполняем», но БЕЗ строки
   * ключа: ответ записывать было некуда, и следующий повтор выполнял
   * действие ещё раз (ревью 015, D4). Теперь пустое чтение — новая попытка
   * захвата; три подряд не сходятся только при чужой гонке на том же ключе. */
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimed = await db.query<{ status: number | null; body: unknown; request_hash: string }>(
      `insert into idempotency_keys (key, user_id, route, request_hash)
       values ($1, $2, $3, $4)
       on conflict (key) do nothing
       returning status, body, request_hash`,
      [key, userId, route, hash],
    )
    if (claimed.rowCount === 1) return null // ключ наш, действие выполняем

    const { rows } = await db.query<{ status: number | null; body: unknown; request_hash: string }>(
      'select status, body, request_hash from idempotency_keys where key = $1',
      [key],
    )
    const seen = rows[0]
    if (!seen) continue

    if (seen.request_hash !== hash) {
      throw new AppError(409, 'idempotency_key_reused', 'Этот Idempotency-Key уже использован для другого запроса')
    }
    if (seen.status === null) {
      // Первый запрос ещё выполняется. Повтор в этот момент — не отказ, а
      // «подожди»: два одновременных исполнения одного действия хуже задержки.
      throw new AppError(409, 'idempotency_in_progress', 'Запрос с этим ключом ещё выполняется — повторите через секунду')
    }
    return { status: seen.status, body: seen.body }
  }
  throw new AppError(409, 'idempotency_in_progress', 'Запрос с этим ключом ещё выполняется — повторите через секунду')
}

export async function saveResult(
  db: Queryable,
  userId: string,
  route: string,
  clientKey: string,
  status: number,
  body: unknown,
): Promise<void> {
  await db.query('update idempotency_keys set status = $2, body = $3 where key = $1', [
    scopedKey(userId, route, clientKey),
    status,
    JSON.stringify(body ?? null),
  ])
}

/** Ключ, по которому действие не выполнилось, освобождается: повтор должен пройти. */
export async function releaseKey(db: Queryable, userId: string, route: string, clientKey: string): Promise<void> {
  await db.query('delete from idempotency_keys where key = $1 and status is null', [
    scopedKey(userId, route, clientKey),
  ])
}

export interface IdempotentResult<T> {
  status: number
  body: T
}

/**
 * Транзакция действия, в которой сохраняется и ответ (фича 014, D2-13).
 *
 * Раньше ответ записывался ПОСЛЕ транзакции действия, отдельным запросом:
 * обрыв между ними оставлял ключ «в работе» — действие сделано, деньги
 * записаны, а каждый повтор до суточной уборки получал 409 «ещё
 * выполняется», и клиент не узнавал результат никогда. Действие возвращает
 * ответ ИЗ транзакции — и ответ ложится в ту же транзакцию: либо есть и
 * действие, и ответ, либо ни того, ни другого.
 */
export type IdempotentTx = <T>(
  action: (client: Queryable) => Promise<IdempotentResult<T>>,
) => Promise<IdempotentResult<T>>

/**
 * Обёртка вокруг действия: разбирает заголовок, отдаёт сохранённый ответ или
 * выполняет и запоминает успех (`status < 400`). Возвращённый отказ ключ не
 * занимает: состояние может измениться, и та же попытка должна выполниться снова
 * (R-312), а не replay-ить устаревший 4xx. Действие получает `tx`: в ней ответ либо
 * сохраняется, либо claim атомарно освобождается. Действию без транзакции обёртка
 * завершает claim после его ответа.
 */
export async function withIdempotency<T>(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  action: (tx: IdempotentTx) => Promise<IdempotentResult<T>>,
  /**
   * Требовать ли заголовок. Обязателен там, где его объявляет контракт;
   * на остальных путях — необязателен: клиент, написанный строго
   * по контракту, не должен получать 400 за то, чего мы не обещали.
   */
  required = true,
): Promise<unknown> {
  const userId = request.caller!.userId
  const clientKey = readKeyHeader(request, required)
  if (!clientKey) {
    const result = await action((fn) => db.tx(fn))
    return reply.code(result.status).send(result.body)
  }
  const replayed = await replayOrClaim(db, userId, route, clientKey, request.url, request.body)
  if (replayed) {
    reply.header('idempotent-replay', 'true')
    return reply.code(replayed.status).send(replayed.body)
  }

  let claimFinalized = false
  const finalizeClaim = async (target: Queryable, result: IdempotentResult<unknown>): Promise<void> => {
    if (result.status < 400) {
      await saveResult(target, userId, route, clientKey, result.status, result.body)
    } else {
      await releaseKey(target, userId, route, clientKey)
    }
    claimFinalized = true
  }
  const tx: IdempotentTx = (fn) =>
    db.tx(async (client) => {
      const result = await fn(client)
      await finalizeClaim(client, result)
      return result
    })
  try {
    const result = await action(tx)
    if (!claimFinalized) await finalizeClaim(db, result)
    return reply.code(result.status).send(result.body)
  } catch (error) {
    await releaseKey(db, userId, route, clientKey)
    throw error
  }
}
