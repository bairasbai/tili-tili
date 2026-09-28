import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

function file(rel) {
  return path.join(root, rel)
}
function replaceOne(text, from, to, label) {
  const count = text.split(from).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`)
  return text.replace(from, to)
}
function edit(rel, fn) {
  const p = file(rel)
  const before = fs.readFileSync(p, 'utf8')
  const after = fn(before)
  if (after === before) throw new Error(`${rel}: no change`)
  fs.writeFileSync(p, after, 'utf8')
  console.log(`patched ${rel}`)
}

/* 152-ФЗ: owner export must include the new payment fields. Helpers/coordinators
 * still do not receive payments at all because the surrounding coupleIds scope is unchanged. */
edit('backend/src/routes/users.ts', (s) => replaceOne(
  s,
  `      \`select p.id, p.deal_id, p.kind, p.amount::text as amount, p.currency, p.status, p.installment_id, p.created_at
         from payments p join deals d on d.id = p.deal_id
        where d.wedding_id = any($1) order by p.created_at\`,
`,
  `      \`select p.id, p.deal_id, p.kind, p.amount::text as amount, p.currency, p.status, p.installment_id,
              p.payment_method, p.visibility, p.amount_known, p.paid_on::text as paid_on, p.created_at
         from payments p join deals d on d.id = p.deal_id
        where d.wedding_id = any($1) order by p.paid_on, p.created_at\`,
`,
  'user export payments',
))

/* Vendor privacy: never derive vendor totals from private/finance_members records.
 * Vendor-facing reads are scoped by BOTH current vendor and deal/payment id. */
edit('backend/src/routes/vendorCabinet.ts', (s0) => {
  let s = replaceOne(s0, "import { PAID_SUM } from '../deals/repo.js'\n", '', 'remove global paid sum')
  s = replaceOne(
    s,
    "import { isUniqueViolation } from '../plugins/db.js'\n",
    `import { isUniqueViolation } from '../plugins/db.js'

const VENDOR_PAID_SUM = \`(select coalesce(sum(case when p.kind='refund' then -p.amount else p.amount end),0)
  from payments p
  where p.deal_id=d.id and p.status<>'cancelled' and p.visibility='vendor' and p.amount_known)\`
`,
    'vendor visible paid sum',
  )
  s = replaceOne(s, "${PAID_SUM}::text as paid,", "${VENDOR_PAID_SUM}::text as paid,", 'vendor deals paid')
  s = replaceOne(
    s,
    `      paid: string
      hold_alive: boolean
`,
    `      paid: string
      unknown_payments: number
      hold_alive: boolean
`,
    'vendor row type',
  )
  s = replaceOne(
    s,
    `              \${VENDOR_PAID_SUM}::text as paid,
              (d.negotiating_until is not null and d.negotiating_until > now()) as hold_alive,
`,
    `              \${VENDOR_PAID_SUM}::text as paid,
              (select count(*)::int from payments vp
                where vp.deal_id=d.id and vp.status<>'cancelled'
                  and vp.visibility='vendor' and not vp.amount_known) as unknown_payments,
              (d.negotiating_until is not null and d.negotiating_until > now()) as hold_alive,
`,
    'vendor unknown count',
  )
  s = replaceOne(
    s,
    `      shortfall: { amount: shortfall, currency: 'RUB' },
      items: rows.map((r) => ({
`,
    `      shortfall: { amount: shortfall, currency: 'RUB' },
      amountIncomplete: rows.some((r) => r.unknown_payments > 0),
      items: rows.map((r) => ({
`,
    'vendor aggregate incomplete',
  )
  s = replaceOne(
    s,
    `        paid: { amount: Number(r.paid), currency: r.currency },
        chatId: r.chat_id,
`,
    `        paid: { amount: Number(r.paid), currency: r.currency },
        unknownAmountPayments: r.unknown_payments,
        chatId: r.chat_id,
`,
    'vendor item incomplete',
  )
  s = replaceOne(
    s,
    `      const PAYMENTS_SUM = \`select coalesce(sum(case when p.kind = 'refund' then -p.amount else p.amount end), 0)
             from payments p join deals d on d.id = p.deal_id
            where d.vendor_id = $1 and p.status <> 'cancelled'\`
`,
    `      const PAYMENTS_SUM = \`select coalesce(sum(case when p.kind = 'refund' then -p.amount else p.amount end), 0)
             from payments p join deals d on d.id = p.deal_id
            where d.vendor_id = $1 and p.status <> 'cancelled'
              and p.visibility = 'vendor' and p.amount_known\`
`,
    'vendor analytics paid sum',
  )
  s = replaceOne(
    s,
    `        prev_revenue: string
      }>(
`,
    `        prev_revenue: string
        unknown_payments: string
      }>(
`,
    'vendor analytics row type',
  )
  s = replaceOne(
    s,
    `           (\${PAYMENTS_SUM}
             and p.created_at between now() - make_interval(days => $2 * 2) and now() - make_interval(days => $2))::text
             as prev_revenue\`,
`,
    `           (\${PAYMENTS_SUM}
             and p.paid_on between (now() - make_interval(days => $2 * 2))::date and (now() - make_interval(days => $2))::date)::text
             as prev_revenue,
           (select count(*) from payments p join deals d on d.id=p.deal_id
             where d.vendor_id=$1 and p.status<>'cancelled' and p.visibility='vendor' and not p.amount_known
               and p.paid_on > (now() - make_interval(days => $2))::date)::text as unknown_payments\`,
`,
    'vendor analytics unknown',
  )
  s = replaceOne(
    s,
    `           (\${PAYMENTS_SUM} and p.created_at > now() - make_interval(days => $2))::text as revenue,
`,
    `           (\${PAYMENTS_SUM} and p.paid_on > (now() - make_interval(days => $2))::date)::text as revenue,
`,
    'vendor analytics paid date',
  )
  s = replaceOne(
    s,
    `        revenue: { amount: revenue, currency: 'RUB' },
        // Прирост считается от прошлого такого же периода. Делить на ноль
`,
    `        revenue: { amount: revenue, currency: 'RUB' },
        revenueIncomplete: Number(row.unknown_payments) > 0,
        // Прирост считается от прошлого такого же периода. Делить на ноль
`,
    'vendor analytics result incomplete',
  )

  const marker = `  /* ── отзывы на меня ───────────────────────────────────────────────── */`
  const vendorPayments = `  /* ── видимые подрядчику оплаты его собственной сделки (021) ───── */
  app.get('/vendor/deals/:dealId/payments', {
    preHandler: app.requireConsent,
    schema: { params: { type: 'object', required: ['dealId'], properties: { dealId: UUID_ID } } },
  }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    const { dealId } = request.params as { dealId: string }
    const own = await db().query('select 1 from deals where id=$1 and vendor_id=$2', [dealId, vendorId])
    if (!own.rows[0]) throw notFound('Сделка не найдена')
    const { rows } = await db().query<{
      id:string; kind:string; amount:string|null; status:string; installment_id:string|null; plan_version:number
      payment_method:string; amount_known:boolean; paid_on:string; created_at:Date
      receipts:Array<{id:string;filename:string;mimeType:string;sizeBytes:number;createdAt:string}>
    }>(\`select p.id,p.kind,p.amount::text as amount,p.status,p.installment_id,p.plan_version,
          p.payment_method,p.amount_known,p.paid_on::text as paid_on,p.created_at,
          coalesce((select json_agg(json_build_object(
            'id',r.id,'filename',r.filename,'mimeType',r.mime_type,'sizeBytes',r.size_bytes,'createdAt',r.created_at)
            order by r.created_at,r.id) from payment_receipts r where r.payment_id=p.id),'[]'::json) as receipts
        from payments p
        where p.deal_id=$1 and p.visibility='vendor'
        order by p.paid_on desc,p.created_at desc,p.id desc\`, [dealId])
    return rows.map(p => ({
      id:p.id,dealId,kind:p.kind,amountKnown:p.amount_known,
      amount:p.amount_known && p.amount!==null ? {amount:Number(p.amount),currency:'RUB'} : null,
      paymentMethod:p.payment_method,visibility:'vendor' as const,paidOn:p.paid_on,status:p.status,
      createdAt:p.created_at.toISOString(),installmentId:p.installment_id,version:p.plan_version,
      receipts:p.receipts,
    }))
  })

  app.get('/vendor/deals/:dealId/payments/:paymentId/receipts/:receiptId/content', {
    preHandler: app.requireConsent,
    schema: { params: { type:'object', required:['dealId','paymentId','receiptId'], properties: {
      dealId:UUID_ID,paymentId:UUID_ID,receiptId:UUID_ID,
    } } },
  }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    const {dealId,paymentId,receiptId}=request.params as {dealId:string;paymentId:string;receiptId:string}
    const {rows}=await db().query<{filename:string;mime_type:string;content:Buffer}>(\`
      select r.filename,r.mime_type,r.content
        from payment_receipts r
        join payments p on p.id=r.payment_id
        join deals d on d.id=p.deal_id
       where d.id=$1 and d.vendor_id=$2 and p.id=$3 and p.visibility='vendor'
         and r.id=$4 and r.payment_id=p.id and r.wedding_id=d.wedding_id\`,
      [dealId,vendorId,paymentId,receiptId])
    const found=rows[0]
    if(!found)throw notFound('Файл не найден')
    return {filename:found.filename,mimeType:found.mime_type,contentBase64:found.content.toString('base64')}
  })

`
  if (!s.includes(marker)) throw new Error('vendor payments insertion marker missing')
  s = s.replace(marker, vendorPayments + marker)
  return s
})

function replaceBlock(text, startMarker, endMarker, replacement, label) {
  const from = text.indexOf(startMarker)
  const to = text.indexOf(endMarker, from + startMarker.length)
  if (from < 0 || to < 0) throw new Error(`${label}: schema boundaries not found`)
  return text.slice(0, from) + replacement + text.slice(to)
}

edit('Тили-тили_API_openapi.yaml', (s0) => {
  let s = replaceOne(s0, '  version: 0.51.0', '  version: 0.52.0', 'contract version')

  const vendorPathsMarker = '  /vendor/updates:\n'
  const vendorPaths = `  /vendor/deals/{dealId}/payments:
    get:
      tags: [vendor]
      summary: Оплаты своей сделки, раскрытые парой подрядчику
      description: |
        Возвращает только записи той сделки, которая принадлежит текущему vendor,
        и только с visibility=vendor. private/finance_members не участвуют даже в агрегатах.
      security: [bearerAuth: []]
      parameters:
      - {name: dealId, in: path, required: true, schema: {type: string, format: uuid}}
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: {$ref: '#/components/schemas/VendorPaymentRecord'}
        '404': {$ref: '#/components/responses/NotFound'}
  /vendor/deals/{dealId}/payments/{paymentId}/receipts/{receiptId}/content:
    get:
      tags: [vendor]
      summary: Подтверждение раскрытой оплаты своей сделки
      security: [bearerAuth: []]
      parameters:
      - {name: dealId, in: path, required: true, schema: {type: string, format: uuid}}
      - {name: paymentId, in: path, required: true, schema: {type: string, format: uuid}}
      - {name: receiptId, in: path, required: true, schema: {type: string, format: uuid}}
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [filename, mimeType, contentBase64]
                properties:
                  filename: {type: string}
                  mimeType: {type: string}
                  contentBase64: {type: string}
        '404': {$ref: '#/components/responses/NotFound'}

`
  if (!s.includes(vendorPathsMarker)) throw new Error('vendor OpenAPI insertion marker missing')
  s = s.replace(vendorPathsMarker, vendorPaths + vendorPathsMarker)

  const enums = `    PaymentMethod:
      type: string
      enum: [cash, bank_transfer, card, other]
    PaymentVisibility:
      type: string
      enum: [private, finance_members, vendor]
      description: |
        private и finance_members не расширяют текущую RBAC-модель: финансовые endpoints свадьбы
        по-прежнему доступны только роли couple. vendor раскрывает запись только vendor этой сделки.
`
  if (!s.includes('    PaymentSummary:\n')) throw new Error('PaymentSummary marker missing')
  s = s.replace('    PaymentSummary:\n', enums + '    PaymentSummary:\n')

  const summary = `    PaymentSummary:
      type: object
      required:
      - committed
      - recorded
      - remaining
      - unallocated
      - inactiveDealRecorded
      - unknownPrices
      - unknownAmountPayments
      - amountIncomplete
      properties:
        committed:
          $ref: '#/components/schemas/FinancialBalance'
        recorded:
          $ref: '#/components/schemas/FinancialBalance'
        remaining:
          $ref: '#/components/schemas/FinancialBalance'
        unallocated:
          $ref: '#/components/schemas/FinancialBalance'
        inactiveDealRecorded:
          $ref: '#/components/schemas/FinancialBalance'
        unknownPrices:
          type: integer
          minimum: 0
        unknownAmountPayments:
          type: integer
          minimum: 0
        amountIncomplete:
          type: boolean
          description: true, если есть факты оплаты без сохранённой суммы; recorded — только известная нижняя граница.
      description: |
        Только сделки, не ручные статьи. committed — активные обязательства; recorded — сумма
        известных отметок минус возвраты; remaining — положительный числовой остаток по каждой
        активной сделке. Неизвестная сумма не считается нулём и не уменьшает remaining.
`
  s = replaceBlock(s, '    PaymentSummary:\n', '    PaymentInstallment:\n', summary, 'PaymentSummary')

  const installment = `    PaymentInstallment:
      type: object
      required:
      - id
      - dealId
      - title
      - amount
      - paid
      - remaining
      - due
      - version
      - status
      - overdue
      - cancelReason
      - cancelledAt
      - allocated
      - unknownAmountPayments
      properties:
        cancelledAt: {type: string, format: date-time, nullable: true}
        id:
          type: string
          format: uuid
        dealId:
          type: string
          format: uuid
        title:
          type: string
        amount:
          $ref: '#/components/schemas/Money'
        paid:
          $ref: '#/components/schemas/FinancialBalance'
        allocated:
          allOf: [$ref: '#/components/schemas/Money']
          description: |
            Сколько на этап легло неразнесённых известных денег сделки. Только для показа —
            привязки не меняются.
        remaining:
          allOf: [$ref: '#/components/schemas/Money']
          description: Сколько осталось по этапу с учётом известных оплат; неизвестная сумма его не уменьшает.
        due:
          type: string
          format: date
          pattern: ^\\d{4}-\\d{2}-\\d{2}$
        version:
          type: integer
          minimum: 1
          maximum: 2147483647
        status: {$ref: '#/components/schemas/PaymentInstallmentStatus'}
        overdue:
          type: boolean
        cancelReason:
          type: string
          nullable: true
        unknownAmountPayments:
          type: integer
          minimum: 0
          description: Факты оплаты этого этапа без сохранённой суммы.
`
  s = replaceBlock(s, '    PaymentInstallment:\n', '    PaymentInstallmentStatus:\n', installment, 'PaymentInstallment')

  const record = `    PaymentRecord:
      type: object
      required:
      - id
      - dealId
      - kind
      - amount
      - amountKnown
      - paymentMethod
      - visibility
      - paidOn
      - status
      - createdAt
      - installmentId
      - version
      properties:
        id:
          type: string
          format: uuid
        dealId:
          type: string
          format: uuid
        kind:
          type: string
          enum: [deposit, balance, refund]
        amount:
          allOf: [{$ref: '#/components/schemas/Money'}]
          nullable: true
          description: null только когда amountKnown=false; неизвестная сумма никогда не кодируется нулём.
        amountKnown:
          type: boolean
        paymentMethod:
          $ref: '#/components/schemas/PaymentMethod'
        visibility:
          $ref: '#/components/schemas/PaymentVisibility'
        paidOn:
          type: string
          format: date
          pattern: ^\\d{4}-\\d{2}-\\d{2}$
        status:
          type: string
          enum: [recorded, confirmed, cancelled]
        createdAt:
          type: string
          format: date-time
        installmentId:
          type: string
          format: uuid
          nullable: true
        version:
          type: integer
          minimum: 1
          maximum: 2147483647
    VendorPaymentRecord:
      allOf:
      - $ref: '#/components/schemas/PaymentRecord'
      - type: object
        required: [receipts]
        properties:
          receipts:
            type: array
            items:
              $ref: '#/components/schemas/PaymentReceiptMeta'
`
  s = replaceBlock(s, '    PaymentRecord:\n', '    PaymentDeal:\n', record, 'PaymentRecord')

  const deal = `    PaymentDeal:
      type: object
      required:
      - id
      - slotId
      - name
      - state
      - price
      - recorded
      - remaining
      - planned
      - unallocated
      - needsReview
      - active
      - canPlan
      - unknownAmountPayments
      properties:
        id: {type: string, format: uuid}
        slotId: {type: string, format: uuid}
        name: {type: string}
        state:
          type: string
          enum: [candidate, contacted, negotiating, booked, paid_deposit, done, cancelled]
        price:
          $ref: '#/components/schemas/Money'
          nullable: true
        recorded:
          $ref: '#/components/schemas/FinancialBalance'
        remaining:
          $ref: '#/components/schemas/Money'
          nullable: true
        planned:
          $ref: '#/components/schemas/Money'
        unallocated:
          $ref: '#/components/schemas/FinancialBalance'
        needsReview: {type: boolean}
        active: {type: boolean}
        canPlan: {type: boolean}
        unknownAmountPayments:
          type: integer
          minimum: 0
`
  s = replaceBlock(s, '    PaymentDeal:\n', '    PaymentSchedule:\n', deal, 'PaymentDeal')

  const schedule = `    PaymentSchedule:
      type: object
      required: [range, readOnly, summary, dueInWindow, overdueRemaining, items, deals, payments, allInstallments]
      properties:
        range:
          type: object
          required: [from, to, today, timeZone, includeOverdue, includeCancelled]
          properties:
            from: {type: string, format: date, pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$'}
            to: {type: string, format: date, pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$'}
            today: {type: string, format: date, pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$'}
            timeZone: {type: string}
            includeOverdue: {type: boolean}
            includeCancelled: {type: boolean}
        readOnly: {type: boolean}
        summary:
          $ref: '#/components/schemas/PaymentSummary'
        dueInWindow:
          allOf: [$ref: '#/components/schemas/Money']
        overdueRemaining:
          allOf: [$ref: '#/components/schemas/Money']
        items:
          type: array
          items: {$ref: '#/components/schemas/PaymentInstallment'}
        deals:
          type: array
          items: {$ref: '#/components/schemas/PaymentDeal'}
        payments:
          type: array
          items: {$ref: '#/components/schemas/PaymentRecord'}
        allInstallments:
          type: array
          items:
            type: object
            required: [id, dealId, title, status, remaining, unknownAmountPayments]
            properties:
              id: {type: string, format: uuid}
              dealId: {type: string, format: uuid}
              title: {type: string}
              status: {$ref: '#/components/schemas/PaymentInstallmentStatus'}
              remaining: {$ref: '#/components/schemas/Money'}
              unknownAmountPayments: {type: integer, minimum: 0}
`
  s = replaceBlock(s, '    PaymentSchedule:\n', '    PaymentHistoryExport:\n', schedule, 'PaymentSchedule')

  const pay = `    PaymentInstallmentPay:
      type: object
      required: [version]
      properties:
        version:
          type: integer
          minimum: 1
          maximum: 2147483647
        amount:
          $ref: '#/components/schemas/PositivePaymentMoney'
        amountKnown:
          type: boolean
          default: true
          description: false фиксирует факт расчёта без суммы; amount при этом не передаётся.
        paymentMethod:
          allOf: [{$ref: '#/components/schemas/PaymentMethod'}]
          default: other
        visibility:
          allOf: [{$ref: '#/components/schemas/PaymentVisibility'}]
          default: private
        paidOn:
          type: string
          format: date
          pattern: ^\\d{4}-\\d{2}-\\d{2}$
      additionalProperties: false
      description: |
        Tili-tili фиксирует оплату вне приложения. Способ не влияет на арифметику.
        При amountKnown=false числовой долг не уменьшается и итог помечается неполным.
`
  s = replaceBlock(s, '    PaymentInstallmentPay:\n', '    PaymentPlanLink:\n', pay, 'PaymentInstallmentPay')
  return s
})

console.log('Feature 021 source patches applied')
