import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { uuidv7, isUuid } from '../ids.js'
import { readKeyHeader, withIdempotency } from '../deals/idempotency.js'
import { COMMITTED } from '../deals/state.js'
import { assertSeatingToken, lockGuestReadAccess } from '../wedding/access.js'
import { lockOrderPrincipal } from '../orders/context.js'
import type { Queryable } from '../plugins/db.js'
import { sendManagedFile } from '../media/routes.js'
import { PDF_MAX_BYTES } from '../media/storage.js'
import type { ContractMediaScope } from '../media/service.js'

const uuid = { type: 'string', format: 'uuid' } as const
const dealParams = { type: 'object', required: ['dealId'], properties: { dealId: uuid } } as const
const documentParams = { type: 'object', required: ['dealId', 'documentId'], properties: { dealId: uuid, documentId: uuid } } as const
const attachmentParams = { type: 'object', required: ['dealId', 'documentId', 'uploadId'],
  properties: { dealId: uuid, documentId: uuid, uploadId: uuid } } as const
const attachmentsPath = '/deals/:dealId/documents/:documentId/attachments'

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

  const assertContractSide = (role: string | null | undefined, mine: boolean | null | undefined) => {
    if (role === 'couple') return 'couple' as const
    if (mine) return 'vendor' as const
    if (role) throw new AppError(403, 'forbidden', 'Договор оформляют пара и подрядчик, а не команда свадьбы')
    throw notFound('Сделка не найдена')
  }

  /** The same live authority protects new documents and saved private replies. */
  const lockContractAccess = async (client: Queryable, request: FastifyRequest, dealId: string, write: boolean) => {
    const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
    // Opaque plain admission precedes every foreign business lock. Repeat it
    // under the authority pins below: admission may change while waiting.
    const root = await client.query<{ wedding_id: string; role: string | null; mine: boolean | null }>(
      `select d.wedding_id,m.role,(v.user_id=$2) as mine from deals d
        left join wedding_members m on m.wedding_id=d.wedding_id and m.user_id=$2
        left join vendors v on v.id=d.vendor_id where d.id=$1`, [dealId, actor.userId],
    )
    if (!root.rows[0]) throw notFound('Сделка не найдена')
    assertContractSide(root.rows[0].role, root.rows[0].mine)
    const weddingId = root.rows[0].wedding_id
    await client.query('select id from weddings where id=$1 for share', [weddingId])
    await lockOrderPrincipal(client, actor)
    const member = await client.query<{ role: string }>(
      'select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [weddingId, actor.userId],
    )
    const { rows } = await client.query<{
      state: string; price: string | null; currency: string; vendor_id: string | null; external_name: string | null
      wedding_title: string; wedding_date: string | null; city: string | null
    }>(`select d.state,d.price::text as price,d.currency,d.vendor_id,d.external_name,w.title as wedding_title,
        (case when s.program_event_id is null then w.date else programme.date end)::text as wedding_date,c.name as city
      from deals d join weddings w on w.id=d.wedding_id
      join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
      left join wedding_events programme on programme.id=s.program_event_id and programme.wedding_id=d.wedding_id
      left join cities c on c.id=w.city_id
      where d.id=$1 and d.wedding_id=$2 for ${write ? 'update' : 'share'} of d,s`, [dealId, weddingId])
    const deal = rows[0]
    if (!deal) throw notFound('Сделка не найдена')
    const vendor = deal.vendor_id ? (await client.query<{ user_id: string; name: string }>(
      'select user_id,name from vendors where id=$1 for share', [deal.vendor_id],
    )).rows[0] : undefined
    const side = assertContractSide(member.rows[0]?.role, vendor?.user_id === actor.userId)
    await assertSeatingToken(request)
    return { ...deal, side, performer: vendor?.name ?? deal.external_name }
  }

  const media = () => {
    if (!app.managedMedia) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.managedMedia
  }

  const mediaScope = (request: FastifyRequest): ContractMediaScope => {
    const { dealId, documentId } = request.params as { dealId: string; documentId: string }
    return { dealId, documentId, actorId: request.caller!.userId,
      lockAccess: async (q, write) => (await lockContractAccess(q, request, dealId, write)).side,
      assertCurrent: () => assertSeatingToken(request) }
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
      if (!isUuid(dealId)) throw notFound('Сделка не найдена')

      // Контракт заголовка не требует — не требуем и мы. С ключом повтор
      // вернёт тот же документ, без ключа переоформление даст новую версию.
      return withIdempotency(
        db(),
        request,
        reply,
        'deals.contract',
        tx => tx(async client => {
          const deal = await lockContractAccess(client, request, dealId, true)
          if (!COMMITTED.includes(deal.state as never)) {
            throw conflict('not_booked', 'Договор оформляется по забронированной сделке')
          }

          const template = TEMPLATES[body.templateCode]!
          const missing = template.requires.filter((f) => !body.fields?.[f])
          if (missing.length > 0) {
            throw new AppError(422, 'fields_missing', `Не заполнены поля договора: ${missing.join(', ')}`)
          }

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

          /* Access pins precede the deal lock; that lock serializes version
           * allocation. Document and idempotent receipt commit together. */
          const id = uuidv7()
          const { rows: prev } = await client.query<{ version: number }>(
            'select coalesce(max(version), 0) as version from documents where deal_id = $1',
            [dealId],
          )
          await client.query(
            `insert into documents (id, deal_id, template_code, version, fields, status)
             values ($1, $2, $3, $4, $5, 'draft')`,
            [id, dealId, body.templateCode, prev[0]!.version + 1, JSON.stringify(fields)],
          )
          const { rows: saved } = await client.query('select * from documents where id = $1', [id])
          await assertSeatingToken(request)
          return { status: 201, body: toDocument(saved[0] as never) }
        }),
        false,
        async client => { await lockContractAccess(client, request, dealId, false) },
      )
    },
  )

  app.get('/weddings/:weddingId/documents', async (request) => db().tx(async client => {
    await lockGuestReadAccess(client, request)
    const { rows } = await client.query(
      `select doc.* from documents doc
         join deals d on d.id = doc.deal_id
        where d.wedding_id = $1
        order by doc.created_at desc`,
      [request.member!.weddingId],
    )
    await assertSeatingToken(request)
    return rows.map((r) => toDocument(r as never))
  }))

  app.get('/deals/:dealId/documents', { preHandler: app.requireConsent, schema: { params: dealParams } },
    request => db().tx(async q => {
      const { dealId } = request.params as { dealId: string }
      const actorId = request.caller!.userId
      const { side } = await lockContractAccess(q, request, dealId, false)
      // Both sides see the version headers. Template fields retain their existing access path.
      const { rows } = await q.query<{
        id: string; version: number; template_code: string; upload_id: string | null; ready_at: Date | null
        author_side: 'couple' | 'vendor' | null; author_name: string | null; mine: boolean | null
        pending_upload_id: string | null; upload_in_progress: boolean
      }>(`select d.id,d.version,d.template_code,a.id as upload_id,a.ready_at,a.document_author_side as author_side,
          u.name as author_name,(a.document_author_id=$2 and a.document_author_side=$3) as mine,
          case when pending.document_author_id=$2 and pending.document_author_side=$3 then pending.id end as pending_upload_id,
          pending.id is not null as upload_in_progress
        from documents d left join media_uploads a on a.document_id=d.id and a.state='ready'
        left join lateral (select id,document_author_id,document_author_side from media_uploads where document_id=d.id
            and state in ('pending','processing','failed') and expires_at>clock_timestamp()
            order by created_at desc,id desc limit 1) pending on true
        left join users u on u.id=a.document_author_id and u.deleted_at is null
        where d.deal_id=$1 order by d.version desc,d.id`, [dealId, actorId, side])
      await assertSeatingToken(request)
      return { uploadEnabled: media().canUploadContract(app.appConfig.env), versions: rows.map(r => ({
        id: r.id, version: r.version, templateCode: r.template_code, pendingUploadId: r.pending_upload_id,
        uploadInProgress: r.upload_in_progress,
        attachment: r.upload_id ? { uploadId: r.upload_id, attachedAt: r.ready_at!.toISOString(),
          authorSide: r.author_side!, authorName: r.author_name, canRemove: r.mine === true } : null,
      })) }
    }))

  app.post('/deals/:dealId/documents/:documentId/attachments', { preHandler: app.requireConsent, schema: { params: documentParams,
    body: { type: 'object', required: ['sizeBytes'], additionalProperties: false,
      properties: { sizeBytes: { type: 'integer', minimum: 1, maximum: PDF_MAX_BYTES } } } } }, async (request, reply) => {
    const { sizeBytes } = request.body as { sizeBytes: number }
    return reply.code(201).send(await media().issueContract(mediaScope(request), sizeBytes, readKeyHeader(request, true)!, app.appConfig.env))
  })
  app.get(`${attachmentsPath}/:uploadId`, { preHandler: app.requireConsent, schema: { params: attachmentParams } }, request =>
    media().contractStatus(mediaScope(request), (request.params as { uploadId: string }).uploadId))
  app.post(`${attachmentsPath}/:uploadId/complete`, { preHandler: app.requireConsent, schema: { params: attachmentParams } }, async (request, reply) => {
    const result = await media().completeContract(mediaScope(request), (request.params as { uploadId: string }).uploadId)
    return reply.code(result.state === 'processing' ? 202 : 200).send(result)
  })
  app.delete(`${attachmentsPath}/:uploadId`, { preHandler: app.requireConsent, schema: { params: attachmentParams } }, request =>
    media().removeContract(mediaScope(request), (request.params as { uploadId: string }).uploadId))
  app.get(`${attachmentsPath}/:uploadId/content`, { preHandler: app.requireConsent, schema: { params: attachmentParams } }, async (request, reply) =>
    sendManagedFile(request, reply, await media().deliverContract(mediaScope(request), (request.params as { uploadId: string }).uploadId), 'contract.pdf'))
}
