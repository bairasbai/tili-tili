import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { uuidv7, isUuid } from '../ids.js'
import { expireHolds } from '../deals/repo.js'
import { computeTips } from '../wedding/tips.js'
import { BUDGET_CATEGORIES } from '../wedding/templates.js'
import { loadBudget } from '../wedding/budget.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER
const rub = (amount: number) => ({ amount, currency: 'RUB' })


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
