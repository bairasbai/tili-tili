import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'

interface NoteRow {
  id: string
  text: string
  author_name: string | null
  created_at: Date
}

const toNote = (r: NoteRow) => ({
  id: r.id,
  text: r.text,
  authorName: r.author_name,
  createdAt: r.created_at.toISOString(),
})

/**
 * Заметки команды свадьбы (фича 014, блокер №7).
 *
 * До этого заметки жили в `localStorage` одного телефона, и экран честно
 * писал «хранятся только на этом устройстве». Настройка живёт там, где живёт
 * действие (R-173): идея про торт нужна обоим партнёрам и координатору —
 * значит, хранится у свадьбы. Кому видно и кто пишет — матрица доступа
 * (`wedding/access.ts`): вся команда, как чат команды.
 *
 * Имя автора — из профиля на момент чтения, а не копией при записи: смена
 * имени в настройках меняет подпись везде, стёртый аккаунт оставляет `null`
 * (`author_id` — `SET NULL`), и экран пишет «без имени», а не выдумывает.
 */
export async function noteRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.get('/weddings/:weddingId/notes', async (request) => {
    const { rows } = await db().query<NoteRow>(
      `select n.id, n.text, u.name as author_name, n.created_at
         from notes n left join users u on u.id = n.author_id
        where n.wedding_id = $1
        order by n.created_at desc, n.id desc`,
      [request.member!.weddingId],
    )
    return rows.map(toNote)
  })

  app.post(
    '/weddings/:weddingId/notes',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { text } = request.body as { text: string }
      const trimmed = text.trim()
      // Пробелы — не заметка: схема пропускает « », а CHECK в базе — нет; 422 честнее 500.
      if (!trimmed) throw new AppError(422, 'validation_failed', 'Заметка пустая', { text: 'нужен текст' })
      const id = uuidv7()
      await db().query('insert into notes (id, wedding_id, author_id, text) values ($1, $2, $3, $4)', [
        id,
        request.member!.weddingId,
        request.caller!.userId,
        trimmed,
      ])
      const { rows } = await db().query<NoteRow>(
        `select n.id, n.text, u.name as author_name, n.created_at
           from notes n left join users u on u.id = n.author_id
          where n.id = $1`,
        [id],
      )
      return reply.code(201).send(toNote(rows[0]!))
    },
  )

  app.delete('/weddings/:weddingId/notes/:noteId', async (request, reply) => {
    const { noteId } = request.params as { noteId: string }
    if (!isUuid(noteId)) throw notFound('Заметка не найдена')
    // Свадьба в условии обязательна: чужой идентификатор не должен удалять чужую заметку.
    const { rowCount } = await db().query('delete from notes where id = $1 and wedding_id = $2', [
      noteId,
      request.member!.weddingId,
    ])
    if (!rowCount) throw notFound('Заметка не найдена')
    return reply.code(204).send()
  })
}
