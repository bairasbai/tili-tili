import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { uuidv7, isUuid } from '../ids.js'
import { expireHolds } from '../deals/repo.js'
import { COMMITTED_WITH_HOLD } from '../deals/state.js'
import {
  BUDGET_BY_VENDOR_CATEGORY,
  BUDGET_CATEGORIES,
  BUDGET_FALLBACK,
} from '../wedding/templates.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER
const rub = (amount: number) => ({ amount, currency: 'RUB' })

/**
 * Резерв на непредвиденное (План ч. 283).
 *
 * Отдельной строкой, а не категорией: категории делят сто процентов между
 * собой, и резерв внутри них означал бы, что часть сметы просто уменьшили.
 * Доля считается на сервере — иначе два экрана посчитают её по-разному.
 */
const RESERVE_SHARE = 0.1

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
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

    const { rows: wedding } = await db().query<{ budget_total: string | null; currency: string }>(
      'select budget_total::text as budget_total, currency from weddings where id = $1',
      [weddingId],
    )
    const total = Number(wedding[0]?.budget_total ?? 0)

    // Мягкая бронь входит в обязательства: пара назвала сумму и держит дату.
    const { rows: deals } = await db().query<{ category_id: string; amount: string; vendor: string }>(
      `select s.category_id, sum(d.price)::text as amount,
              string_agg(coalesce(ven.name, d.external_name), ' · ') as vendor
         from deals d
         join slots s on s.id = d.slot_id
         left join vendors ven on ven.id = d.vendor_id
        where d.wedding_id = $1 and d.state = any($2) and d.price is not null
        group by s.category_id`,
      [weddingId, COMMITTED_WITH_HOLD],
    )

    const { rows: items } = await db().query<{
      id: string
      title: string
      category_id: string
      amount: string
      currency: string
    }>(
      'select id, title, category_id, amount::text as amount, currency from budget_items where wedding_id = $1 order by created_at',
      [weddingId],
    )

    const fromSlots = new Map<string, number>()
    const liveNames = new Map<string, string[]>()
    for (const row of deals) {
      const budgetId = BUDGET_BY_VENDOR_CATEGORY[row.category_id] ?? BUDGET_FALLBACK
      fromSlots.set(budgetId, (fromSlots.get(budgetId) ?? 0) + Number(row.amount))
      if (row.vendor) liveNames.set(budgetId, [...(liveNames.get(budgetId) ?? []), row.vendor])
    }

    const categories = BUDGET_CATEGORIES.map((c) => {
      const mine = items.filter((i) => i.category_id === c.id)
      const auto = fromSlots.get(c.id) ?? 0
      return {
        id: c.id,
        title: c.title,
        color: c.color,
        // План — доля от общего бюджета пары: лимиты мока заданы под свадьбу
        // за 1,5 млн, а у каждой пары бюджет свой.
        planned: rub(Math.round(total * c.share)),
        fromSlots: auto,
        live: liveNames.get(c.id)?.join(' · ') ?? null,
        items: mine.map((i) => ({
          id: i.id,
          title: i.title,
          amount: rub(Number(i.amount)),
          categoryId: i.category_id,
          custom: true,
        })),
      }
    })

    const spent =
      [...fromSlots.values()].reduce((a, b) => a + b, 0) + items.reduce((a, i) => a + Number(i.amount), 0)

    return { total: rub(total), spent: rub(spent), reserve: rub(Math.round(total * RESERVE_SHARE)), categories }
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
