import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../plugins/db.js'
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

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex')
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
 * Тот же ключ с ДРУГИМ телом — ошибка клиента: он переиспользовал ключ для
 * другого запроса. Молча вернуть старый ответ значило бы потерять второе
 * действие, поэтому 409.
 */
export async function replayOrClaim(
  db: Db,
  userId: string,
  route: string,
  clientKey: string,
  body: unknown,
): Promise<Replay | null> {
  const key = scopedKey(userId, route, clientKey)
  const hash = hashBody(body)

  // Ключи старше суток не нужны: клиент столько не повторяет. Уборка здесь,
  // а не в кроне — таблица растёт только от этого кода, значит и подметает
  // его же. Индекс по created_at делает удаление дешёвым.
  await db.query("delete from idempotency_keys where created_at < now() - interval '1 day'")

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
  if (!seen) return null

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

export async function saveResult(
  db: Db,
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
export async function releaseKey(db: Db, userId: string, route: string, clientKey: string): Promise<void> {
  await db.query('delete from idempotency_keys where key = $1 and status is null', [
    scopedKey(userId, route, clientKey),
  ])
}

/**
 * Обёртка вокруг действия: разбирает заголовок, отдаёт сохранённый ответ или
 * выполняет и запоминает.
 */
export async function withIdempotency<T>(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  action: () => Promise<{ status: number; body: T }>,
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
    const result = await action()
    return reply.code(result.status).send(result.body)
  }
  const replayed = await replayOrClaim(db, userId, route, clientKey, request.body)
  if (replayed) {
    reply.header('idempotent-replay', 'true')
    return reply.code(replayed.status).send(replayed.body)
  }

  try {
    const result = await action()
    await saveResult(db, userId, route, clientKey, result.status, result.body)
    return reply.code(result.status).send(result.body)
  } catch (error) {
    await releaseKey(db, userId, route, clientKey)
    throw error
  }
}
