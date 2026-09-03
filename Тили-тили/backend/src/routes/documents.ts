import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { COMMITTED } from '../deals/state.js'

/**
 * Шаблоны договоров. Подстановка — интерполяция строк, никакого исполнения
 * кода из шаблона (инвариант 5 харнесса): в поля попадают паспортные данные,
 * и шаблон, умеющий что-то выполнять, — это чужой код на наших данных.
 */
const TEMPLATES: Record<string, { title: string; requires: string[] }> = {
  photographer: { title: 'Договор на фотосъёмку', requires: ['customerFullName', 'performerFullName'] },
  videographer: { title: 'Договор на видеосъёмку', requires: ['customerFullName', 'performerFullName'] },
  venue: { title: 'Договор аренды площадки', requires: ['customerFullName', 'performerFullName'] },
  host: { title: 'Договор на ведение мероприятия', requires: ['customerFullName', 'performerFullName'] },
  universal: { title: 'Универсальный договор оказания услуг', requires: ['customerFullName', 'performerFullName'] },
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const toDocument = (r: {
    id: string
    deal_id: string
    template_code: string
    version: number
    status: string
    file_url: string | null
    docx_url: string | null
    fields: Record<string, unknown>
    created_at: Date
  }) => ({
    id: r.id,
    dealId: r.deal_id,
    templateCode: r.template_code,
    version: r.version,
    status: r.status,
    // Файлы появятся вместе с объектным хранилищем. Ссылка в никуда хуже,
    // чем честный null: по ней человек кликает и получает ошибку.
    pdfUrl: r.file_url,
    docxUrl: r.docx_url,
    fields: r.fields,
    createdAt: r.created_at.toISOString(),
  })

  app.post(
    '/deals/:dealId/contract',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['templateCode'],
          additionalProperties: false,
          properties: {
            templateCode: { type: 'string', enum: Object.keys(TEMPLATES) },
            fields: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const { dealId } = request.params as { dealId: string }
      const body = request.body as { templateCode: string; fields?: Record<string, unknown> }
      const userId = request.caller!.userId
      if (!/^[0-9a-f-]{36}$/i.test(dealId)) throw notFound('Сделка не найдена')

      // Контракт заголовка не требует — не требуем и мы. С ключом повтор
      // вернёт тот же документ, без ключа переоформление даст новую версию.
      return withIdempotency(
        db(),
        request,
        reply,
        'deals.contract',
        async () => {
        const { rows } = await db().query<{
          state: string
          price: string | null
          currency: string
          wedding_title: string
          wedding_date: string | null
          city: string | null
          performer: string | null
          role: string
        }>(
          `select d.state, d.price::text as price, d.currency, w.title as wedding_title,
                  w.date::text as wedding_date, c.name as city,
                  coalesce(ven.name, d.external_name) as performer, m.role
             from deals d
             join weddings w on w.id = d.wedding_id
             join wedding_members m on m.wedding_id = d.wedding_id and m.user_id = $2
             left join cities c on c.id = w.city_id
             left join vendors ven on ven.id = d.vendor_id
            where d.id = $1`,
          [dealId, userId],
        )
        const deal = rows[0]
        if (!deal) throw notFound('Сделка не найдена')
        if (deal.role !== 'couple') throw new AppError(403, 'forbidden', 'Договор оформляет только пара')
        if (!COMMITTED.includes(deal.state as never)) {
          throw conflict('not_booked', 'Договор оформляется по забронированной сделке')
        }

        const template = TEMPLATES[body.templateCode]!
        const missing = template.requires.filter((f) => !body.fields?.[f])
        if (missing.length > 0) {
          throw new AppError(422, 'fields_missing', `Не заполнены поля договора: ${missing.join(', ')}`)
        }

        // Версия растёт: договор переоформляют, и старая редакция остаётся
        // в истории — по ней могли уже договориться.
        const { rows: prev } = await db().query<{ version: number }>(
          'select coalesce(max(version), 0) as version from documents where deal_id = $1',
          [dealId],
        )

        const fields = {
          ...(body.fields ?? {}),
          weddingTitle: deal.wedding_title,
          weddingDate: deal.wedding_date,
          city: deal.city,
          performerName: deal.performer,
          amount: deal.price === null ? null : Number(deal.price),
          currency: deal.currency,
          templateTitle: template.title,
          disclaimer:
            'Документ носит информационный характер и не является юридической консультацией. ' +
            'Перед подписанием проверьте условия с юристом.',
        }

        const id = uuidv7()
        await db().query(
          `insert into documents (id, deal_id, template_code, version, fields, status)
           values ($1, $2, $3, $4, $5, 'draft')`,
          [id, dealId, body.templateCode, prev[0]!.version + 1, JSON.stringify(fields)],
        )
        const { rows: saved } = await db().query('select * from documents where id = $1', [id])
          return { status: 201, body: toDocument(saved[0] as never) }
        },
        false,
      )
    },
  )

  app.get('/weddings/:weddingId/documents', async (request) => {
    const { rows } = await db().query(
      `select doc.* from documents doc
         join deals d on d.id = doc.deal_id
        where d.wedding_id = $1
        order by doc.created_at desc`,
      [request.member!.weddingId],
    )
    return rows.map((r) => toDocument(r as never))
  })
}
