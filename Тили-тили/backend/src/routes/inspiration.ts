import type { FastifyInstance } from 'fastify'
import { AppError, quotaExceeded } from '../errors.js'

/**
 * Избранные истории «Вдохновения».
 *
 * Сами истории живут во фронте (`STORIES` в Discover.tsx) — сервер хранит
 * только их идентификаторы. Каталога реальных свадеб у бэкенда нет, и
 * заводить его здесь значило бы выдумать содержимое, которого нет ни в
 * контракте, ни в документах.
 *
 * Отметка личная, а не на свадьбу: «нравится» — вкус одного человека,
 * и общий список превратил бы его в спор. Обоим партнёрам сравнить свои
 * подборки ничто не мешает — они открывают один экран с разных аккаунтов.
 */
const MAX_LIKES = 500

export async function inspirationRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const storyParam = {
    params: {
      type: 'object',
      required: ['storyId'],
      properties: { storyId: { type: 'string', minLength: 1, maxLength: 40 } },
    },
  } as const

  app.get('/inspiration/likes', { preHandler: app.requireConsent }, async (request) => {
    const { rows } = await db().query<{ story_id: string }>(
      'select story_id from inspiration_likes where user_id = $1 order by created_at desc',
      [request.caller!.userId],
    )
    return { storyIds: rows.map((r) => r.story_id) }
  })

  app.put(
    '/inspiration/likes/:storyId',
    { preHandler: app.requireConsent, schema: storyParam },
    async (request, reply) => {
      const { storyId } = request.params as { storyId: string }
      const userId = request.caller!.userId

      const { rows } = await db().query<{ n: string }>(
        'select count(*)::text as n from inspiration_likes where user_id = $1',
        [userId],
      )
      // Лайк дешёвый, и это его свойство: без потолка список растёт
      // ровно столько, сколько у кого-то хватит терпения нажимать.
      if (Number(rows[0]!.n) >= MAX_LIKES) {
        throw quotaExceeded('likes_limit', `В избранном не больше ${MAX_LIKES} историй`)
      }
      // Повторное нажатие — то же самое состояние, а не ошибка.
      await db().query(
        'insert into inspiration_likes (user_id, story_id) values ($1,$2) on conflict do nothing',
        [userId, storyId],
      )
      return reply.code(204).send()
    },
  )

  app.delete(
    '/inspiration/likes/:storyId',
    { preHandler: app.requireConsent, schema: storyParam },
    async (request, reply) => {
      const { storyId } = request.params as { storyId: string }
      // Снятие несуществующего лайка — тоже «лайка нет»: 404 здесь
      // заставил бы клиент угадывать, что он не знает состояния.
      await db().query('delete from inspiration_likes where user_id = $1 and story_id = $2', [
        request.caller!.userId,
        storyId,
      ])
      return reply.code(204).send()
    },
  )
}
