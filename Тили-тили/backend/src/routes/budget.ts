import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { uuidv7, isUuid } from '../ids.js'
import { expireHolds } from '../deals/repo.js'
import { computeTips } from '../wedding/tips.js'
import { BUDGET_CATEGORIES } from '../wedding/templates.js'
import { loadBudget } from '../wedding/budget.js'
import { weddingAccessHook } from '../wedding/access.js'
import { lockFinanceAccess } from '../payments/model.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER
const rub = (amount: number) => ({ amount, currency: 'RUB' })
const staleLimit = () => conflict('stale_budget_limit', 'Лимит категории уже изменён на другом устройстве')
const unknownCategory = () => validationFailed({ categoryId: 'Неизвестная категория бюджета' })

/**
 * Запись настроек бюджета: свадьба — первой и эксклюзивно, права — после (ревью 018, BB-05).
 *
 * Эксклюзивная блокировка свадьбы сериализует первую запись строки, которой ещё нет
 * (версия 0 → 1). Проверка прав (`lockFinanceAccess`) повторяется под блокировками:
 * роль могли снять между проверкой в хуке и записью. Порядок важен: `lockFinanceAccess`
 * берёт свадьбу FOR SHARE, и две записи, взявшие сначала её, а потом FOR UPDATE,
 * ждали бы друг друга до срабатывания детектора взаимных блокировок.
 */
async function lockBudgetWrite(tx: Queryable, weddingId: string, userId: string) {
  await tx.query('select id from weddings where id=$1 for update', [weddingId])
  await lockFinanceAccess(tx, weddingId, userId)
}

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  // Financial routes authorize before schema validation so a restricted role cannot
  // use 400-vs-403 differences to probe the shape of private write APIs.
  app.addHook('preValidation', weddingAccessHook(app))
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /**
   * Бюджет считается на лету и нигде не хранится.
   *
   * Сохранённая сумма расходится с источником на первой же правке — ровно это
   * уже случилось во фронте, где три экрана показывали три разных «потрачено»
   * (ERR-0012). Здесь один расчёт: обязательства по сделкам плюс ручные статьи.
   */
  app.get('/weddings/:weddingId/budget', async (request) => {
    const weddingId = request.member!.weddingId
    await expireHolds(db(), weddingId)
    return loadBudget(db(), weddingId)
  })

  /* Подсказки Тиля по правилам §3.14 — дефицит категории, блокирующий слот,
   * лимит бюджета (`wedding/tips.ts`). Суммы внутри — только паре (матрица §6
   * по умолчанию). Пустой список — честный ответ «поводов нет», а не ошибка. */
  app.get('/weddings/:weddingId/tips', async (request) => {
    const weddingId = request.member!.weddingId
    await expireHolds(db(), weddingId)
    return { items: await computeTips(db(), weddingId) }
  })

  app.patch('/weddings/:weddingId/budget/settings', {
    schema: { body: { type: 'object', required: ['reserveBps', 'version'], additionalProperties: false, properties: {
      reserveBps: { type: 'integer', minimum: 0, maximum: 5000 }, version: { type: 'integer', minimum: 0 },
    } } },
  }, async request => db().tx(async tx => {
    const weddingId = request.member!.weddingId
    const body = request.body as { reserveBps: number; version: number }
    await lockBudgetWrite(tx, weddingId, request.caller!.userId)
    const { rows } = await tx.query<{ reserve_bps: number; version: number }>(
      'select reserve_bps,version from wedding_budget_settings where wedding_id=$1 for update', [weddingId])
    const current = rows[0]
    const currentVersion = current?.version ?? 0
    if (body.version !== currentVersion) throw conflict('stale_budget_settings', 'Настройки бюджета уже изменены на другом устройстве')
    const nextVersion = currentVersion + 1
    await tx.query(`insert into wedding_budget_settings(wedding_id,reserve_bps,version) values($1,$2,$3)
      on conflict(wedding_id) do update set reserve_bps=excluded.reserve_bps,version=excluded.version,updated_at=now()`,
      [weddingId, body.reserveBps, nextVersion])
    return { reserveBps: body.reserveBps, version: nextVersion }
  }))

  app.put('/weddings/:weddingId/budget/categories/:categoryId/limit', {
    schema: { body: { type: 'object', required: ['amount', 'version'], additionalProperties: false, properties: {
      amount: { type: 'object', required: ['amount','currency'], additionalProperties: false, properties: {
        amount: { type: 'integer', minimum: 0, maximum: MONEY_MAX }, currency: { type: 'string', enum: ['RUB'] },
      } }, version: { type: 'integer', minimum: 0 },
    } } },
  }, async request => db().tx(async tx => {
    const weddingId = request.member!.weddingId
    const { categoryId } = request.params as { categoryId: string }
    const body = request.body as { amount: { amount: number; currency: string }; version: number }
    if (!BUDGET_CATEGORIES.some(c => c.id === categoryId)) throw unknownCategory()
    await lockBudgetWrite(tx, weddingId, request.caller!.userId)
    const { rows } = await tx.query<{ version: number }>(
      'select version from budget_category_limits where wedding_id=$1 and category_id=$2 for update', [weddingId, categoryId])
    const currentVersion = rows[0]?.version ?? 0
    if (body.version !== currentVersion) throw staleLimit()
    const nextVersion = currentVersion + 1
    await tx.query(`insert into budget_category_limits(wedding_id,category_id,amount,currency,version) values($1,$2,$3,'RUB',$4)
      on conflict(wedding_id,category_id) do update set amount=excluded.amount,version=excluded.version,is_custom=true,updated_at=now()`,
      [weddingId, categoryId, body.amount.amount, nextVersion])
    return { categoryId, amount: rub(body.amount.amount), custom: true, version: nextVersion }
  }))

  app.patch('/weddings/:weddingId/budget/categories/:categoryId/limit', {
    schema: { body: { type: 'object', required: ['reset', 'version'], additionalProperties: false, properties: {
      reset: { type: 'boolean', const: true }, version: { type: 'integer', minimum: 1 },
    } } },
  }, async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { categoryId } = request.params as { categoryId: string }
    const body = request.body as { reset: true; version: number }
    // Как у PUT: неизвестная категория — 422 с полем, а не 404 (ревью 018, BB-12).
    if (!BUDGET_CATEGORIES.some(c => c.id === categoryId)) throw unknownCategory()
    await db().tx(async tx => {
      await lockBudgetWrite(tx, weddingId, request.caller!.userId)
      const { rows } = await tx.query<{ version: number }>(
        'select version from budget_category_limits where wedding_id=$1 and category_id=$2 for update', [weddingId, categoryId])
      // Версия ≥ 1 по схеме: строки нет — клиент прочёл то, чего уже нет.
      if (!rows[0] || rows[0].version !== body.version) throw staleLimit()
      // Do not delete the row: its incremented version is a tombstone preventing ABA writes
      // from clients that still hold version=0 from before a custom -> auto cycle.
      await tx.query('update budget_category_limits set is_custom=false,version=version+1,updated_at=now() where wedding_id=$1 and category_id=$2', [weddingId, categoryId])
    })
    // 204 — после коммита: ответ изнутри транзакции уходил клиенту раньше, чем она фиксировалась (ревью 018, BB-03).
    return reply.code(204).send()
  })



  app.post(
    '/weddings/:weddingId/budget/items',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'amount', 'categoryId'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            categoryId: { type: 'string', enum: BUDGET_CATEGORIES.map((c) => c.id) },
            amount: {
              type: 'object',
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
                currency: { type: 'string', enum: ['RUB'] },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const body = request.body as { title: string; categoryId: string; amount: { amount: number } }
      const id = uuidv7()
      await db().query(
        'insert into budget_items (id, wedding_id, title, category_id, amount, currency) values ($1,$2,$3,$4,$5,$6)',
        [id, weddingId, body.title, body.categoryId, body.amount.amount, 'RUB'],
      )
      return reply.code(201).send({
        id,
        title: body.title,
        amount: rub(body.amount.amount),
        categoryId: body.categoryId,
        custom: true,
      })
    },
  )

  app.delete('/weddings/:weddingId/budget/items/:itemId', async (request, reply) => {
    const { itemId } = request.params as { itemId: string }
    if (!isUuid(itemId)) throw notFound('Статья не найдена')
    // Условие по свадьбе обязательно: без него по чужому идентификатору
    // удаляется чужая статья расхода.
    const res = await db().query('delete from budget_items where id = $1 and wedding_id = $2', [
      itemId,
      request.member!.weddingId,
    ])
    if (res.rowCount === 0) throw notFound('Статья не найдена')
    return reply.code(204).send()
  })
}
