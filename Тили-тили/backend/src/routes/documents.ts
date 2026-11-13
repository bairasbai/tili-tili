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
const agreementPath = '/deals/:dealId/documents/:documentId/agreement'
type ContractSide = 'couple' | 'vendor'
type AgreementRow = {
  proposed_side: ContractSide | null
  proposed_at: Date | null
  couple_at: Date | null
  vendor_at: Date | null
}

function agreementDto(row: AgreementRow) {
  return { proposedSide: row.proposed_side, proposedAt: row.proposed_at?.toISOString() ?? null,
    coupleAt: row.couple_at?.toISOString() ?? null, vendorAt: row.vendor_at?.toISOString() ?? null }
}

function contractTerms(fields: Record<string, unknown>, discloseNames: boolean) {
  const string = (value: unknown) => typeof value === 'string' ? value : null
  const amount = typeof fields.amount === 'number' && Number.isSafeInteger(fields.amount) && fields.amount >= 0 ? fields.amount : null
  return { city: string(fields.city), date: string(fields.weddingDate),
    customerName: discloseNames ? string(fields.customerFullName) : null,
    performerName: discloseNames ? string(fields.performerFullName) : null,
    price: amount !== null && fields.currency === 'RUB' ? { amount, currency: 'RUB' as const } : null }
}

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
      state: string; price: string | null; currency: string; vendor_id: string | null; external_name: string | null; archived: boolean
      wedding_title: string; wedding_date: string | null; city: string | null
    }>(`select d.state,d.price::text as price,d.currency,d.vendor_id,d.external_name,w.title as wedding_title,
        w.archived_at is not null as archived,
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

  const assertContractWritable = (archived: boolean) => {
    if (archived) throw conflict('contract_archived', 'Договор в архиве доступен только для просмотра')
  }

  const mediaScope = (request: FastifyRequest): ContractMediaScope => {
    const { dealId, documentId } = request.params as { dealId: string; documentId: string }
    return { dealId, documentId, actorId: request.caller!.userId,
      lockAccess: async (q, write) => {
        const deal = await lockContractAccess(q, request, dealId, write)
        if (write) assertContractWritable(deal.archived)
        return deal.side
      },
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
          assertContractWritable(deal.archived)
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

  app.get('/users/me/archived-contracts', { preHandler: app.requireConsent, schema: {
    querystring: { type: 'object', additionalProperties: false, required: ['side'],
      properties: { side: { type: 'string', enum: ['couple', 'vendor'] }, before: uuid } },
  } }, async (request, reply) => {
    const { side, before } = request.query as { side: ContractSide; before?: string }
    const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
    reply.header('Cache-Control', 'no-store')
    return db().tx(async client => {
      await lockOrderPrincipal(client, actor)
      // Membership, ownership and archive state are read in the same statement.
      const { rows } = await client.query<{
        deal_id: string; wedding_title: string; archived_at: Date; performer_name: string | null
      }>(`select d.id as deal_id,w.title as wedding_title,w.archived_at,
          case when $2='couple' then coalesce(v.name,d.external_name) end as performer_name
        from deals d join weddings w on w.id=d.wedding_id
        left join vendors v on v.id=d.vendor_id
        where w.archived_at is not null and ($3::uuid is null or d.id<$3::uuid)
          and exists(select 1 from documents doc where doc.deal_id=d.id)
          and (($2='couple' and exists(select 1 from wedding_members m
            where m.wedding_id=w.id and m.user_id=$1 and m.role='couple'))
            or ($2='vendor' and v.user_id=$1))
        order by d.id desc limit 51`, [actor.userId, side, before ?? null])
      await assertSeatingToken(request)
      const items = rows.slice(0, 50).map(row => ({ dealId: row.deal_id, weddingTitle: row.wedding_title,
        archivedAt: row.archived_at.toISOString(), performerName: row.performer_name }))
      return { items, nextCursor: rows.length > items.length ? items.at(-1)!.dealId : null }
    })
  })

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
      const deal = await lockContractAccess(q, request, dealId, false)
      const { side } = deal
      const { rows } = await q.query<AgreementRow & {
        id: string; version: number; template_code: string; upload_id: string | null; ready_at: Date | null
        author_side: 'couple' | 'vendor' | null; author_name: string | null; mine: boolean | null
        pending_upload_id: string | null; upload_in_progress: boolean; fields: Record<string, unknown>
      }>(`select d.id,d.version,d.template_code,a.id as upload_id,a.ready_at,a.document_author_side as author_side,
          u.name as author_name,(a.document_author_id=$2 and a.document_author_side=$3) as mine,
          case when pending.document_author_id=$2 and pending.document_author_side=$3 then pending.id end as pending_upload_id,
          pending.id is not null as upload_in_progress,d.fields,g.proposed_side,g.proposed_at,g.couple_at,g.vendor_at
        from documents d left join media_uploads a on a.document_id=d.id and a.state='ready'
        left join contract_agreements g on g.document_id=d.id
        left join lateral (select id,document_author_id,document_author_side from media_uploads where document_id=d.id
            and state in ('pending','processing','failed') and expires_at>clock_timestamp()
            order by created_at desc,id desc limit 1) pending on true
        left join users u on u.id=a.document_author_id and u.deleted_at is null
        where d.deal_id=$1 order by d.version desc,d.id desc`, [dealId, actorId, side])
      await assertSeatingToken(request)
      return { archived: deal.archived, uploadEnabled: !deal.archived && media().canUploadContract(app.appConfig.env), versions: rows.map((r, index) => {
        const active = index === 0 && !deal.archived && deal.vendor_id !== null && COMMITTED.includes(deal.state as never)
        const proposed = r.proposed_at !== null
        return {
          id: r.id, version: r.version, templateCode: r.template_code, pendingUploadId: deal.archived ? null : r.pending_upload_id,
          uploadInProgress: !deal.archived && r.upload_in_progress,
          attachment: r.upload_id ? { uploadId: r.upload_id, attachedAt: r.ready_at!.toISOString(),
            authorSide: r.author_side!, authorName: r.author_name, canRemove: !deal.archived && !proposed && r.mine === true } : null,
          agreement: { ...agreementDto(r), canPropose: side === 'couple' && active && !proposed && !r.upload_in_progress,
            canAgree: active && proposed && (side === 'couple' ? r.couple_at : r.vendor_at) === null,
            terms: contractTerms(r.fields, side === 'couple' || proposed) },
        }
      }) }
    }))

  app.post(agreementPath, { preHandler: app.requireConsent, schema: { params: documentParams, body: {
    type: 'object', additionalProperties: false, required: ['action', 'attachmentId'],
    properties: { action: { type: 'string', enum: ['propose', 'agree'] }, attachmentId: { anyOf: [uuid, { type: 'null' }] } },
  } } }, request => db().tx(async q => {
    const { dealId, documentId } = request.params as { dealId: string; documentId: string }
    const { action, attachmentId } = request.body as { action: 'propose' | 'agree'; attachmentId: string | null }
    const actorId = request.caller!.userId
    const deal = await lockContractAccess(q, request, dealId, true)
    if (action === 'propose' && deal.side !== 'couple') {
      throw new AppError(403, 'forbidden', 'Редакцию с данными договора предлагает пара')
    }
    const { rows: [doc] } = await q.query<{ id: string }>(
      'select id from documents where id=$1 and deal_id=$2 for update', [documentId, dealId])
    if (!doc) throw notFound('Версия договора не найдена')
    const { rows: [existing] } = await q.query<AgreementRow & { attachment_id: string | null; couple_by: string | null; vendor_by: string | null }>(
      'select * from contract_agreements where document_id=$1', [documentId])
    if (existing && existing.attachment_id !== attachmentId) throw conflict('contract_attachment_changed', 'Вложение изменилось. Откройте редакцию снова')
    const ownAt = deal.side === 'couple' ? existing?.couple_at : existing?.vendor_at
    if (existing && (action === 'propose' || ownAt)) {
      await assertSeatingToken(request)
      return agreementDto(existing)
    }
    const latest = await q.query<{ id: string }>('select id from documents where deal_id=$1 order by version desc,id desc limit 1', [dealId])
    if (latest.rows[0]?.id !== documentId || deal.archived || !deal.vendor_id || !COMMITTED.includes(deal.state as never)) {
      throw conflict('contract_version_changed', 'Для согласования откройте текущую редакцию активной сделки')
    }
    let saved: AgreementRow
    if (action === 'propose') {
      const { rows: [upload] } = await q.query<{ id: string; state: string }>(`select id,state from media_uploads
        where document_id=$1 and (state='ready' or (state in ('pending','processing','failed') and expires_at>clock_timestamp()))`, [documentId])
      if ((upload?.id ?? null) !== attachmentId || (upload && upload.state !== 'ready')) {
        throw conflict('contract_attachment_changed', 'Дождитесь проверки вложения и откройте редакцию снова')
      }
      saved = (await q.query<AgreementRow>(`insert into contract_agreements(document_id,attachment_id,proposed_side,proposed_by)
        values($1,$2,$3,$4) returning proposed_side,proposed_at,couple_at,vendor_at`, [documentId, attachmentId, deal.side, actorId])).rows[0]!
    } else {
      if (!existing) throw conflict('contract_not_proposed', 'Сначала предложите редакцию для согласования')
      if (actorId === (deal.side === 'couple' ? existing.vendor_by : existing.couple_by)) {
        throw conflict('contract_same_actor', 'Редакцию должны согласовать разные стороны сделки')
      }
      const side = deal.side
      saved = (await q.query<AgreementRow>(`update contract_agreements set ${side}_by=$2,${side}_at=clock_timestamp()
        where document_id=$1 returning proposed_side,proposed_at,couple_at,vendor_at`, [documentId, actorId])).rows[0]!
    }
    await q.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,'document',$3,$4)",
      [actorId, action === 'propose' ? 'contract.proposed' : 'contract.agreed', documentId, JSON.stringify({ side: deal.side })])
    await assertSeatingToken(request)
    return agreementDto(saved)
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
