import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { VENDOR_COLUMNS, toVendor, type VendorRow } from '../catalog/vendors.js'
import { recomputeRating } from '../reviews/rating.js'
import { notify } from '../notify/notify.js'
import { ref } from '../contract/schemas.generated.js'
import type { Queryable } from '../plugins/db.js'

/**
 * Какая санкция к какой цели применима (План §18.2).
 *
 * Правило живёт в обработчике, а не в `CHECK` на `complaints.resolution`:
 * это была бы миграция, а схема БД в этой фазе не меняется. Хвост владельцу
 * записан в плане фичи («Ворота инвариантов»).
 */
const APPLICABLE_ACTIONS: Record<string, readonly string[]> = {
  vendor: ['dismiss', 'warn', 'downrank', 'block'],
  // Понизить в выдаче можно анкету, а не отзыв: «скрыть отзыв» — это `block`.
  review: ['dismiss', 'warn', 'block'],
  // Ни сообщение, ни сделку сервер не понижает и не блокирует — обещать
  // такую кнопку было бы ложью на кнопке (R-176).
  message: ['dismiss', 'warn'],
  deal: ['dismiss', 'warn'],
}

/**
 * Очередь пост-модерации — ОДНО условие на список и на счётчик дашборда.
 *
 * Оно жило в двух местах и разошлось: очередь показывала непроверенные
 * анкеты живых пользователей, а счётчик считал ещё и заблокированных по
 * жалобе, и анкеты ушедших. Дашборд обещал модератору работу, которой
 * в очереди нет, — и объяснить расхождение было нечем.
 *
 * `left join cities` здесь же: список берёт из него название города,
 * счётчику он безразличен, а условие от этого не меняется.
 */
const MODERATION_QUEUE_FROM = `from vendors v
         join users u on u.id = v.user_id and u.deleted_at is null
         left join cities c on c.id = v.city_id
        where v.moderated_at is null and v.published_at is not null and v.blocked_at is null`

/**
 * Очередь заявок на верификацию — ОДНО условие на список и на счётчик.
 *
 * Та же причина, что и у очереди анкет (R-212): два одинаковых на вид
 * условия расходятся при первой же правке, и дашборд начинает обещать
 * работу, которой в очереди нет.
 *
 * Публикация анкеты в условие не входит намеренно: документы сверяются
 * независимо от того, в каталоге анкета или снята. Живой пользователь —
 * входит: заявку ушедшего разбирать некому и незачем.
 */
const VERIFICATION_QUEUE_FROM = `from vendor_verifications r
         join vendors v on v.id = r.vendor_id
         join users u on u.id = v.user_id and u.deleted_at is null
        where r.status = 'pending'`

/**
 * Почему по этой анкете решения нет.
 *
 * Формулировка по случаю: заблокированную по жалобе модерация не возвращает
 * (решение уже принято, и принимают его в разделе жалоб); у снятой анкеты
 * одобрять нечего — в каталоге её нет; повторное снятие означает, что
 * второй модератор опоздал.
 */
function notLiveMessage(action: 'approve' | 'reject' | 'verify', blocked: boolean): string {
  if (blocked) return 'Анкета заблокирована по жалобе — решения по ней не принимаются'
  return action === 'reject' ? 'Анкета уже снята с публикации' : 'Анкета не опубликована — одобрять нечего'
}

/** Повод жалобы словами: он уходит подрядчику в уведомлении. */
const COMPLAINT_REASON: Record<string, string> = {
  fraud: 'мошенничество',
  content: 'недопустимое содержание',
  no_show: 'неявка',
  spam: 'спам',
}

/**
 * Что подрядчик читает о санкции.
 *
 * Заметки модератора здесь нет и быть не может: она пишется для журнала
 * и для следующего сотрудника, а не для того, на кого пожаловались (FR-006).
 */
const SANCTION_TEXT = {
  warn: {
    title: 'Предупреждение от модерации',
    body: 'Анкета остаётся в каталоге. Повторное нарушение — понижение в выдаче или блокировка.',
  },
  downrank: {
    title: 'Анкета понижена в выдаче',
    body: 'Анкета остаётся в каталоге, но показывается ниже других.',
  },
  block: {
    title: 'Анкета заблокирована',
    body: 'Анкета убрана из каталога.',
  },
} as const

/**
 * Ключ advisory-блокировки справочника категорий.
 *
 * Константа, а не `hashtext` от строки: ключ такой блокировки глобален на
 * весь кластер, а кластер здесь один — его делят тесты, dev-сервер и прод.
 * Вычисляемый ключ пришлось бы искать по логам, чтобы понять, кто с кем
 * столкнулся; названный — виден и здесь, и в плане фичи 004.
 *
 * Advisory-блокировок в проекте до этого не было: инварианты данных держат
 * `PK`/`UNIQUE`/`CHECK` (§5.11). Здесь блокируется не строка, а решение
 * «сравнить отпечаток и записать» целиком — иначе два сохранения с одной
 * версией оба увидели бы её текущей и оба прошли бы.
 */
const CATEGORIES_LOCK = 4_210_001

/**
 * Отпечаток содержимого справочника — версия из FR-001.
 *
 * Считается по самим строкам, поэтому меняется от ЛЮБОЙ правки, в том числе
 * сделанной мимо панели: `updated_at` или счётчик сохранений такую правку
 * не заметили бы, а сотрудник затёр бы её, не узнав об этом.
 *
 * Порядок — по `id` и `word`, а не как в `GET` (`sort, name`): отпечатку
 * нужна детерминированность, а не порядок показа. Перестановка плиток меняет
 * `sort`, а значит и отпечаток, — это правка, и её видно.
 *
 * Клиент передаётся снаружи: `GET` считает версию тем же клиентом, что читает
 * данные, а `PUT` — под блокировкой в своей транзакции. Иначе версия была бы
 * из другого момента, чем то, к чему она относится.
 */
async function categoriesVersion(client: Queryable): Promise<string> {
  const { rows: categories } = await client.query<{
    id: string
    name: string
    icon: string | null
    sort: number
  }>('select id, name, icon, sort from categories order by id')
  const { rows: synonyms } = await client.query<{ word: string; category_id: string }>(
    'select word, category_id from category_synonyms order by word',
  )
  const canonical = JSON.stringify([
    categories.map((c) => [c.id, c.name, c.icon, c.sort]),
    synonyms.map((s) => [s.word, s.category_id]),
  ])
  // Шестнадцать знаков из шестидесяти четырёх: столько объявляет контракт.
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * Админка платформы.
 *
 * Сотрудник — признак `users.is_staff`, и пути, который его выдаёт, нет:
 * «сделай меня админом» — это повышение прав в один запрос, сколько его
 * ни защищай. Признак ставится руками в базе при найме.
 *
 * Каждое обращение к чужому проекту пишется в журнал аудита вместе
 * с причиной (План §19.10 п. 5): поддержка смотрит по обращению пары,
 * а не из любопытства, и это должно быть проверяемо.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  async function requireStaff(request: FastifyRequest): Promise<string> {
    const userId = request.caller!.userId
    const { rows } = await db().query<{ is_staff: boolean }>(
      'select is_staff from users where id = $1 and deleted_at is null',
      [userId],
    )
    // 404 сказал бы, что пути нет, и это была бы неправда; 403 честно
    // говорит «есть, но не для вас» — админка не секрет, доступ к ней секрет.
    if (!rows[0]?.is_staff) throw forbidden('Раздел для сотрудников платформы')
    return userId
  }

  async function audit(actorId: string, action: string, entity: string, entityId: string, diff: unknown, client: Queryable = db()) {
    await client.query('insert into audit_log (actor_id, action, entity, entity_id, diff) values ($1,$2,$3,$4,$5)', [
      actorId,
      action,
      entity,
      entityId,
      JSON.stringify(diff),
    ])
  }

  /* ── очередь анкет ────────────────────────────────────────────────── */
  app.get('/admin/moderation/vendors', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    /* Анкеты публикуются сразу, модератор смотрит их потом (§19.2).
     * Очередь — непроверенные, старейшие сверху: SLA считается от подачи.
     *
     * Заблокированных по жалобе здесь нет: решение по ним уже принято, и
     * второй раз его не принимают. Без этого условия модератор видел бы
     * в очереди анкету, которой в каталоге давно нет, и «одобрял» бы её.
     *
     * `published_at` выбирается отдельно от `VENDOR_COLUMNS`: очередь
     * показывает дату публикации, а не заведения — у анкеты, пролежавшей
     * месяц в черновике, это разные дни, и срок проверки идёт от первой. */
    const { rows } = await db().query<VendorRow & { created_at: Date; published_at: Date }>(
      `select ${VENDOR_COLUMNS}, v.published_at
         ${MODERATION_QUEUE_FROM}
          and ($1::text is null or (v.created_at, v.id) > ($1::timestamptz, $2::uuid))
        order by v.created_at asc, v.id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    return buildPage(
      rows.map((r) => ({
        ...toVendor(r),
        createdAt: r.created_at.toISOString(),
        publishedAt: r.published_at.toISOString(),
      })),
      page.limit,
      (v) => encodeCursor(v.createdAt, v.id),
    )
  })

  app.post(
    '/admin/moderation/vendors/:vendorId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['approve', 'reject', 'verify'] },
            reason: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { vendorId } = request.params as { vendorId: string }
      if (!/^[0-9a-f-]{36}$/i.test(vendorId)) throw notFound('Анкета не найдена')
      const body = request.body as { action: 'approve' | 'reject' | 'verify'; reason?: string }

      /* Снятие с публикации без причины подрядчику нечем исправить: в
       * уведомление уходит «Решение модератора», то есть ничего. Схемой это
       * не выразить — причина обязательна только при `reject`, — а форма
       * ответа та же, что у отказа схемы: поле `reason` она подсветит сама. */
      if (body.action === 'reject' && (body.reason ?? '').trim() === '') {
        throw validationFailed({ reason: 'обязательна при action=reject' })
      }

      const sets = {
        // Проверена и остаётся в выдаче.
        approve: 'moderated_at = now()',
        // Снята с публикации: анкета не удаляется — мастер её поправит.
        reject: 'moderated_at = now(), published_at = null',
        // Галочка «проверен». Документы при этом наружу не выходят.
        verify: 'moderated_at = now(), verified_at = now()',
      }[body.action]

      /* Решение по анкете, статус заявки на проверку и запись в журнал —
       * одна транзакция (R-122): галочка «проверен» без закрытой заявки
       * оставляла бы её «на проверке» в кабинете навсегда. */
      await db().tx(async (client) => {
        /* Решение принимается только по ЖИВОЙ анкете — той, что сейчас
         * в каталоге: `published_at is not null and blocked_at is null`,
         * ровно условие `VENDOR_LIVE_JOIN`.
         *
         * Без этого `approve` по снятой анкете писал «проверена», публикацию
         * не возвращал и слал подрядчику новость об успешной проверке анкеты,
         * которой в каталоге нет; второй `reject` подряд слал вторую новость
         * о том же снятии. Проверка ПОД БЛОКИРОВКОЙ строки и в той же
         * транзакции, что решение: двое модераторов, нажавших одновременно,
         * иначе оба увидели бы живую анкету и оба отправили бы новость.
         *
         * `moderated_at` в условие не входит: одобрить уже проверенную живую
         * анкету — то же самое решение, и второй модератор вправе его
         * подтвердить. */
        const { rows: state } = await client.query<{ published_at: Date | null; blocked_at: Date | null }>(
          'select published_at, blocked_at from vendors where id = $1 for update',
          [vendorId],
        )
        if (state.length === 0) throw notFound('Анкета не найдена')
        const current = state[0]!
        if (current.blocked_at !== null || current.published_at === null) {
          throw conflict('vendor_not_live', notLiveMessage(body.action, current.blocked_at !== null))
        }

        const res = await client.query(`update vendors set ${sets} where id = $1`, [vendorId])
        if (res.rowCount === 0) throw notFound('Анкета не найдена')

        /* Заявку на верификацию закрывает только `verify`: документы сверены,
         * заявке больше нечего ждать.
         *
         * `reject` анкеты её НЕ трогает. Раньше трогал — и очередь верификации
         * теряла заявку при каждом снятии анкеты с публикации: документы никто
         * не смотрел, а подрядчик получал «отклонено» за фотографии в анкете.
         * Документы и публикация — разные решения, и принимаются они на разных
         * путях (фича 002, FR-009). */
        if (body.action === 'verify') {
          await client.query(
            "update vendor_verifications set status = 'approved', checked_at = now() where vendor_id = $1 and status = 'pending'",
            [vendorId],
          )
        }

        await audit(staffId, `vendor.${body.action}`, 'vendor', vendorId, { reason: body.reason ?? null }, client)
      })

      const { rows: owner } = await db().query<{ user_id: string }>('select user_id from vendors where id = $1', [
        vendorId,
      ])
      if (owner[0]) {
        /* Новость — следствие решения, а не его часть: решение уже записано
         * и откату не подлежит. 500 из-за упавшего уведомления сказал бы
         * модератору «не принято», и он принял бы то же решение второй раз —
         * теперь уже по анкете, состояние которой изменилось. */
        try {
          await notify(db(), {
            userId: owner[0].user_id,
            kind: 'system',
            title: { approve: 'Анкета проверена', reject: 'Анкета снята с публикации', verify: 'Вы проверены' }[
              body.action
            ],
            body: body.reason ?? 'Решение модератора',
            link: '/vendor-app',
            // Снятие с публикации — потеря дохода: ждать утра тут нельзя.
            critical: body.action === 'reject',
          })
        } catch (err) {
          request.log.warn({ err, vendorId, action: body.action }, 'решение по анкете принято, уведомление не ушло')
        }
      }
      return { vendorId, action: body.action }
    },
  )

  /* ── очередь заявок на верификацию ────────────────────────────────── */
  app.get('/admin/verifications', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    /* Старейшие сверху: срок разбора считается от подачи, как и у жалоб.
     *
     * Ни `file_url`, ни `inn` здесь не выбираются. Не «не отдаются в ответе»,
     * а не выбираются вовсе: список раздавал бы документы страницами, и
     * обещание «документы уходят только модератору» держалось бы на том,
     * что кто-то не забыл убрать поле из `map`. */
    const { rows } = await db().query<{
      id: string
      vendor_id: string
      vendor_name: string
      kind: string
      has_file: boolean
      created_at: Date
    }>(
      `select r.id, r.vendor_id, v.name as vendor_name, r.kind, r.created_at,
              (r.file_url is not null and r.file_url <> '') as has_file
         ${VERIFICATION_QUEUE_FROM}
          and ($1::text is null or (r.created_at, r.id) > ($1::timestamptz, $2::uuid))
        order by r.created_at asc, r.id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    return buildPage(
      rows.map((r) => ({
        id: r.id,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name,
        kind: r.kind,
        hasFile: r.has_file,
        createdAt: r.created_at.toISOString(),
      })),
      page.limit,
      (v) => encodeCursor(v.createdAt, v.id),
    )
  })

  app.get('/admin/verifications/:requestId', { preHandler: app.requireConsent }, async (request) => {
    const staffId = await requireStaff(request)
    const { requestId } = request.params as { requestId: string }
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw notFound('Заявка не найдена')

    /* Та же выборка, что у очереди, но по одной заявке и без условия на
     * состояние: карточка показывает и разобранную — с датой решения.
     *
     * `vendorPublished` считается здесь, а не выводится из чего-то на экране:
     * карточка не должна вести на анкету, которой в каталоге нет. Решение по
     * документам это не задерживает — галочка покажется вместе с анкетой. */
    const { rows } = await db().query<{
      id: string
      vendor_id: string
      vendor_name: string
      vendor_published: boolean
      kind: string
      file_url: string | null
      inn: string | null
      status: string
      created_at: Date
      checked_at: Date | null
    }>(
      `select r.id, r.vendor_id, v.name as vendor_name, r.kind, r.file_url, r.inn,
              r.status, r.created_at, r.checked_at,
              (v.published_at is not null and v.blocked_at is null) as vendor_published
         from vendor_verifications r
         join vendors v on v.id = r.vendor_id
         join users u on u.id = v.user_id and u.deleted_at is null
        where r.id = $1`,
      [requestId],
    )
    if (rows.length === 0) throw notFound('Заявка не найдена')

    // Запись в журнал ДО ответа — как у просмотра проекта поддержкой:
    // просмотр, оборвавшийся на отдаче, иначе остался бы незамеченным.
    // Документы наружу выходят только здесь, и «кто смотрел» должно
    // оставаться проверяемым (FR-003).
    await audit(staffId, 'verification.view', 'verification', requestId, {})

    const r = rows[0]!
    return {
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      vendorPublished: r.vendor_published,
      kind: r.kind,
      fileUrl: r.file_url,
      inn: r.inn,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      checkedAt: r.checked_at?.toISOString() ?? null,
    }
  })

  app.post(
    '/admin/verifications/:requestId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['approve', 'reject'] },
            reason: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { requestId } = request.params as { requestId: string }
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw notFound('Заявка не найдена')
      const body = request.body as { action: 'approve' | 'reject'; reason?: string }

      /* Отказ без причины подрядчику нечем исправить: в уведомление ушло бы
       * «Документы не подтверждены» и больше ничего. Схемой это не выразить —
       * причина обязательна только при `reject`, — а форма ответа та же, что
       * у отказа схемы: поле `reason` она подсветит сама. */
      if (body.action === 'reject' && (body.reason ?? '').trim() === '') {
        throw validationFailed({ reason: 'обязательна при action=reject' })
      }

      /* Решение, галочка и запись в журнал — одна транзакция (R-122):
       * закрытая заявка без галочки оставила бы подрядчика проверенным
       * только на словах. */
      const decided = await db().tx(async (client) => {
        // Подрядчик у заявки не меняется никогда, поэтому его можно узнать
        // до блокировок — а блокировки взять в том же порядке, что и решение
        // по анкете: сперва анкета, потом заявка. Обратный порядок дал бы
        // взаимную блокировку с `verify` из очереди модерации.
        const { rows: found } = await client.query<{ vendor_id: string }>(
          'select vendor_id from vendor_verifications where id = $1',
          [requestId],
        )
        if (found.length === 0) throw notFound('Заявка не найдена')
        const vendorId = found[0]!.vendor_id

        const { rows: vendor } = await client.query<{ user_id: string; verified_at: Date | null }>(
          'select user_id, verified_at from vendors where id = $1 for update',
          [vendorId],
        )
        const owner = vendor[0]!

        /* Состояние заявки — ПОД БЛОКИРОВКОЙ строки и в той же транзакции,
         * что решение: двое сотрудников, нажавших одновременно, иначе оба
         * увидели бы `pending`, и подрядчик получил бы две новости об одном. */
        const { rows: state } = await client.query<{ status: string }>(
          'select status from vendor_verifications where id = $1 for update',
          [requestId],
        )
        if (state[0]!.status !== 'pending') {
          throw conflict('verification_not_pending', 'Заявка уже разобрана')
        }

        await client.query('update vendor_verifications set status = $2, checked_at = now() where id = $1', [
          requestId,
          body.action === 'approve' ? 'approved' : 'rejected',
        ])

        /* Галочка ставится и по неопубликованной анкете: документы от
         * публикации не зависят. `coalesce` — чтобы дата первой проверки
         * не переписывалась второй заявкой. */
        if (body.action === 'approve') {
          await client.query('update vendors set verified_at = coalesce(verified_at, now()) where id = $1', [vendorId])
        }

        await audit(staffId, `verification.${body.action}`, 'verification', requestId, {
          vendorId,
          reason: body.reason ?? null,
        }, client)

        return { userId: owner.user_id, wasVerified: owner.verified_at !== null }
      })

      /* Новость — следствие решения, а не его часть: решение уже записано и
       * откату не подлежит. 500 из-за упавшего уведомления сказал бы
       * сотруднику «не принято», и он решил бы второй раз — а заявка к тому
       * моменту закрыта, и он получил бы 409 на собственное решение (A-14). */
      const already = body.action === 'approve' && decided.wasVerified
      if (!already) {
        try {
          await notify(db(), {
            userId: decided.userId,
            kind: 'system',
            title: body.action === 'approve' ? 'Вы проверены' : 'Документы не подтверждены',
            body:
              body.action === 'approve'
                ? 'Галочка «Проверен» видна парам в каталоге'
                : (body.reason ?? 'Документы не подтверждены'),
            link: '/vendor-app/verification',
            // Ни то, ни другое не срочно: тихие часы соблюдаются (A6).
            critical: false,
          })
        } catch (err) {
          request.log.warn({ err, requestId, action: body.action }, 'решение по заявке принято, уведомление не ушло')
        }
      }
      return { requestId, action: body.action }
    },
  )

  /* ── очередь жалоб ────────────────────────────────────────────────── */
  app.get('/admin/complaints', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    const { rows } = await db().query<{
      id: string
      target_kind: string
      target_id: string
      category: string
      text: string | null
      status: string
      created_at: Date
    }>(
      `select id, target_kind, target_id, category, text, status, created_at
         from complaints
        where status = 'new'
          and ($1::text is null or (created_at, id) > ($1::timestamptz, $2::uuid))
        order by created_at asc, id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    return buildPage(
      rows.map((r) => ({
        id: r.id,
        targetKind: r.target_kind,
        targetId: r.target_id,
        category: r.category,
        text: r.text ?? '',
        status: r.status,
        createdAt: r.created_at.toISOString(),
      })),
      page.limit,
      (c) => encodeCursor(c.createdAt, c.id),
    )
  })

  app.post(
    '/admin/complaints/:complaintId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['dismiss', 'warn', 'downrank', 'block'] },
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { complaintId } = request.params as { complaintId: string }
      if (!/^[0-9a-f-]{36}$/i.test(complaintId)) throw notFound('Жалоба не найдена')
      const body = request.body as { action: 'dismiss' | 'warn' | 'downrank' | 'block'; note?: string }

      /* Применимость санкции к цели — ДО транзакции. Иначе «заблокировать»
       * сообщение закрывало бы жалобу вообще без санкции: строка
       * `resolution` есть, а не сделано ничего. Жалоба обязана остаться
       * нерассмотренной, чтобы её разобрал следующий. */
      const { rows: pending } = await db().query<{ target_kind: string }>(
        "select target_kind from complaints where id = $1 and status = 'new'",
        [complaintId],
      )
      const kind = pending[0]?.target_kind
      // Строки нет — 404 отдаст транзакция ниже: там же ловится и гонка
      // двух модераторов, и ответ у обоих случаев должен быть один.
      if (kind !== undefined && !APPLICABLE_ACTIONS[kind]?.includes(body.action)) {
        throw validationFailed({ action: `не применяется к цели ${kind}` })
      }

      /* Жалоба разобрана и санкция наложена — одна транзакция (R-122):
       * «разобрана» без санкции — это жалоба, которую больше никто не
       * откроет, и подрядчик, которого никто не наказал. */
      const target = await db().tx(async (client) => {
        const { rows } = await client.query<{ target_kind: string; target_id: string; category: string }>(
          `update complaints set status = 'resolved', resolution = $2, note = $3, resolved_at = now()
            where id = $1 and status = 'new'
            returning target_kind, target_id, category`,
          [complaintId, body.action, body.note ?? null],
        )
        // Повторное решение по разобранной жалобе — не ошибка данных,
        // а гонка двух модераторов: второй должен увидеть, что уже поздно.
        if (rows.length === 0) throw notFound('Жалоба не найдена или уже разобрана')
        const target = rows[0]!

        /* Санкции по возрастанию (§18.2). Предупреждение остаётся в журнале:
         * оно ничего не меняет в выдаче, но следующая жалоба приходит уже
         * не на чистого подрядчика. */
        if (target.target_kind === 'vendor' && body.action === 'downrank') {
          await client.query('update vendors set downranked_at = now() where id = $1', [target.target_id])
        }
        if (target.target_kind === 'vendor' && body.action === 'block') {
          await client.query('update vendors set blocked_at = now() where id = $1', [target.target_id])
        }
        if (target.target_kind === 'review' && body.action === 'block') {
          // Скрытый отзыв уходит и из показа, и из рейтинга: наказывать
          // подрядчика звёздами за текст, признанный недопустимым, нельзя.
          // `downrank` сюда больше не доходит: отзыв не понижают в выдаче,
          // его либо оставляют, либо скрывают.
          const { rows: hidden } = await client.query<{ vendor_id: string }>(
            'update reviews set hidden_at = now(), moderated_at = now() where id = $1 returning vendor_id',
            [target.target_id],
          )
          if (hidden[0]) await recomputeRating(client, hidden[0].vendor_id)
        }

        await audit(staffId, `complaint.${body.action}`, target.target_kind, target.target_id, {
          complaintId,
          note: body.note ?? null,
        }, client)
        return target
      })

      /* Санкция без адресата — «только экран» с записью в базе (R-176):
       * подрядчик исчезает из выдачи и не знает почему. Уведомление после
       * транзакции, как у решения по анкете: сперва запись, потом новость. */
      if (target.target_kind === 'vendor' && body.action !== 'dismiss') {
        const { rows: owner } = await db().query<{ user_id: string }>('select user_id from vendors where id = $1', [
          target.target_id,
        ])
        if (owner[0]) {
          const text = SANCTION_TEXT[body.action]
          /* Санкция уже наложена и жалоба уже разобрана: падение на новости
           * не отменяет ни того, ни другого. 500 отправил бы модератора
           * накладывать её второй раз, а жалоба к тому моменту закрыта —
           * и он получил бы 404 на собственное решение. */
          try {
            await notify(db(), {
              userId: owner[0].user_id,
              kind: 'system',
              title: text.title,
              body: `Повод жалобы: ${COMPLAINT_REASON[target.category] ?? 'нарушение правил'}. ${text.body}`,
              link: '/vendor-app',
              // Блокировка — потеря дохода: ждать утра тут нельзя.
              critical: body.action === 'block',
            })
          } catch (err) {
            request.log.warn(
              { err, complaintId, action: body.action },
              'санкция наложена, уведомление не ушло',
            )
          }
        }
      }
      return { complaintId, action: body.action }
    },
  )

  /* ── категории и синонимы ─────────────────────────────────────────── */
  /*
   * Чтение того, что заменяет PUT.
   *
   * Словарь синонимов заменяется целиком, а прочитать его было неоткуда:
   * `GET /catalog/categories` его не отдаёт и не должен — паре он не нужен.
   * Панель без этого пути правила бы словарь вслепую и стирала бы строки,
   * которых сотрудник ни разу не видел.
   */
  app.get('/admin/categories', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    /* Одна транзакция на данные и версию: справочник и его отпечаток должны
     * быть из одного момента. Разными запросами из пула панель получила бы
     * версию от состояния, которого не видела, — и первое же сохранение
     * упиралось бы в 409 без всякой чужой правки. */
    return db().tx(async (client) => {
      const { rows: categories } = await client.query<{
        id: string
        name: string
        icon: string | null
        sort: number
      }>('select id, name, icon, sort from categories order by sort, name')
      const { rows: synonyms } = await client.query<{ word: string; category_id: string }>(
        'select word, category_id from category_synonyms order by word',
      )
      return {
        // `name` в базе, `title` в контракте — как в каталоге.
        categories: categories.map((c) => ({ id: c.id, title: c.name, icon: c.icon, sort: c.sort })),
        synonyms: Object.fromEntries(synonyms.map((s) => [s.word, s.category_id])),
        version: await categoriesVersion(client),
      }
    })
  })

  app.put(
    '/admin/categories',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            /* Схема — из контракта, а не вторая копия правил рядом.
             * Ручная копия уже разошлась с ним: она объявляла `icon`
             * строкой, контракт — `nullable`. Панель, честно приславшая
             * `icon: null` («значок не трогать»), отказа не получала: AJV
             * с `coerceTypes` превращал `null` в пустую строку, `coalesce`
             * видел не NULL — и значок молча СТИРАЛСЯ. */
            categories: { type: 'array', maxItems: 100, items: ref('AdminCategory') },
            synonyms: { type: 'object', additionalProperties: { type: 'string' } },
            /* Без этого поля в схеме панель получала бы 422 на собственную
             * версию: `additionalProperties: false` отвергает всё, чего в
             * схеме нет, — и защита от затирания не доехала бы до кода. */
            version: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const body = request.body as {
        categories?: { id: string; title: string; icon?: string | null; sort?: number }[]
        synonyms?: Record<string, string>
        version?: string
      }

      const version = await db().tx(async (client) => {
        /* Первым запросом транзакции — блокировка (FR-002).
         * Два сохранения с одной версией без неё оба прочитали бы её как
         * текущую и оба записали бы: проверка отпечатка сама по себе гонку
         * не закрывает, она лишь читает состояние. */
        await client.query('select pg_advisory_xact_lock($1::bigint)', [CATEGORIES_LOCK])

        /* Версии нет — проверки нет (FR-006): сохранение не из панели о
         * правиле не знает, и ломать его нечестно. Панель шлёт версию всегда. */
        if (body.version !== undefined && (await categoriesVersion(client)) !== body.version) {
          throw conflict(
            'categories_stale',
            'Справочник изменили, пока вы его правили — перечитайте и повторите',
          )
        }

        for (const c of body.categories ?? []) {
          /* Категории правятся, но не удаляются: на них ссылаются анкеты
           * и слоты. Исчезнувшая категория — это осиротевшая мозаика. */
          await client.query(
            // В базе колонка называется `name`, в контракте — `title`.
            // Переименовывать нечего: справочник читают миграции и фронт.
            /* Пропущенный `sort` — «не менять», а не «наверх». Раньше в базу
             * уходил `c.sort ?? 0`, и `coalesce(0, старое)` — это 0: правка
             * одного названия поднимала категорию на первое место мозаики.
             * Колонка `not null default 0`, поэтому для новой строки ноль
             * подставляется явно, а для существующей смотрится сам параметр. */
            `insert into categories (id, name, icon, sort) values ($1,$2,$3,coalesce($4::int, 0))
             on conflict (id) do update set name = excluded.name,
                                            icon = coalesce(excluded.icon, categories.icon),
                                            sort = case when $4::int is null then categories.sort else excluded.sort end`,
            [c.id, c.title, c.icon ?? null, c.sort ?? null],
          )
        }
        if (body.synonyms) {
          /* Слово хранится в нижнем регистре, поэтому «Тамада» и «тамада» —
           * одна строка словаря, а в теле их две. Раньше вторая вставка
           * падала на первичном ключе: 500 «внутренняя ошибка» вместо ошибки
           * проверки, и словарь к этому моменту уже стёрт целиком — спасал
           * только откат транзакции.
           *
           * Считается ДО `delete`, как и проверка категорий, и называет ОБА
           * слова: форма подсветит обе строки, а какая из них лишняя —
           * решает сотрудник, а не сервер. */
          const byLowercase = new Map<string, string[]>()
          for (const word of Object.keys(body.synonyms)) {
            const key = word.toLowerCase()
            byLowercase.set(key, [...(byLowercase.get(key) ?? []), word])
          }
          const repeated: Record<string, string> = {}
          for (const words of byLowercase.values()) {
            if (words.length > 1) for (const word of words) repeated[`synonyms.${word}`] = 'повторяется'
          }
          if (Object.keys(repeated).length > 0) throw validationFailed(repeated)

          /* Слово, ведущее на несуществующую категорию, — это поиск, который
           * молча ничего не находит. Раньше сюда доходил `insert` и падал
           * на внешнем ключе: 500 вместо ошибки проверки, и словарь к этому
           * моменту уже стёрт целиком.
           *
           * Проверка ДО `delete`, и категории проверяются уже поверх
           * вставленных выше: слово может вести на категорию, которую
           * заводят этим же запросом. */
          const wanted = [...new Set(Object.values(body.synonyms))]
          if (wanted.length > 0) {
            const { rows: known } = await client.query<{ id: string }>(
              'select id from categories where id = any($1)',
              [wanted],
            )
            const ids = new Set(known.map((r) => r.id))
            const bad: Record<string, string> = {}
            for (const [word, categoryId] of Object.entries(body.synonyms)) {
              if (!ids.has(categoryId)) bad[`synonyms.${word}`] = `неизвестная категория: ${categoryId}`
            }
            if (Object.keys(bad).length > 0) throw validationFailed(bad)
          }
          await client.query('delete from category_synonyms')
          for (const [word, categoryId] of Object.entries(body.synonyms)) {
            await client.query('insert into category_synonyms (word, category_id) values ($1,$2)', [
              word.toLowerCase(),
              categoryId,
            ])
          }
        }

        /* Журнал — внутри транзакции (FR-014): запись «справочник изменён»
         * рядом с откатившимся изменением была бы неправдой, а удалять из
         * журнала нельзя ничего. */
        await audit(staffId, 'categories.update', 'categories', '00000000-0000-0000-0000-000000000000', {
          categories: body.categories?.length ?? 0,
          synonyms: Object.keys(body.synonyms ?? {}).length,
        }, client)

        /* Новая версия — тем же клиентом и под той же блокировкой: с ней
         * панель продолжает правку, не перечитывая справочник (FR-004).
         * Посчитанная после `commit` она была бы уже чужой. */
        return categoriesVersion(client)
      })
      return {
        categories: body.categories?.length ?? 0,
        synonyms: Object.keys(body.synonyms ?? {}).length,
        version,
      }
    },
  )

  /* ── метрики платформы ────────────────────────────────────────────── */
  app.get('/admin/metrics', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    const { rows } = await db().query<Record<string, string>>(
      `select
         (select count(*) from users where deleted_at is null)::text as users,
         (select count(*) from weddings where archived_at is null)::text as weddings,
         (select count(*) from vendors v join users u on u.id = v.user_id and u.deleted_at is null
           where v.published_at is not null and v.blocked_at is null)::text as vendors_published,
         (select count(*) ${MODERATION_QUEUE_FROM})::text as moderation_queue,
         (select count(*) ${VERIFICATION_QUEUE_FROM})::text as verification_queue,
         (select count(*) from complaints where status = 'new')::text as complaints_open,
         (select count(*) from complaints
           where status = 'new' and created_at < now() - interval '24 hours')::text as complaints_overdue,
         (select count(*) from deals where state in ('booked','paid_deposit','done'))::text as deals,
         (select coalesce(sum(price), 0) from deals where state in ('booked','paid_deposit','done'))::text as gmv`,
    )
    const m = rows[0]!

    /* Готовность города к запуску: план считает город готовым от 50 анкет.
     * Список выводится сразу с числом — «готов» без числа нечем оспорить. */
    const { rows: cities } = await db().query<{ city: string; vendors: string }>(
      `select c.name as city, count(*)::text as vendors
         from vendors v join users u on u.id = v.user_id and u.deleted_at is null
         join cities c on c.id = v.city_id
        where v.published_at is not null and v.blocked_at is null
        group by c.name order by count(*) desc limit 20`,
    )

    return {
      users: Number(m.users),
      weddings: Number(m.weddings),
      vendorsPublished: Number(m.vendors_published),
      moderationQueue: Number(m.moderation_queue),
      // Тем же условием, что и сама очередь: показатель на дашборде и длина
      // списка обязаны совпадать, иначе панель обещает работу, которой нет.
      verificationQueue: Number(m.verification_queue),
      complaintsOpen: Number(m.complaints_open),
      // SLA модерации — 24 часа (§18.2). Без счётчика просроченных срок
      // существует только на бумаге: нарушение ничем не видно.
      complaintsOverdue: Number(m.complaints_overdue),
      deals: Number(m.deals),
      gmv: { amount: Number(m.gmv), currency: 'RUB' },
      cities: cities.map((c) => ({ city: c.city, vendors: Number(c.vendors), launchReady: Number(c.vendors) >= 50 })),
    }
  })

  /* ── просмотр проекта поддержкой ──────────────────────────────────── */
  app.get(
    '/admin/weddings/:weddingId',
    {
      preHandler: app.requireConsent,
      schema: {
        querystring: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          // Причина обязательна и непустая: «смотрел по обращению» должно
          // быть проверяемо, а пустая строка ничего не подтверждает.
          properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { weddingId } = request.params as { weddingId: string }
      if (!/^[0-9a-f-]{36}$/i.test(weddingId)) throw notFound('Свадьба не найдена')
      const { reason } = request.query as { reason: string }

      const { rows } = await db().query<{
        id: string
        title: string
        date: string | null
        city: string | null
        style: string | null
        guests_planned: number | null
        created_at: Date
      }>(
        `select w.id, w.title, w.date::text as date, c.name as city, w.style, w.guests_planned, w.created_at
           from weddings w left join cities c on c.id = w.city_id where w.id = $1`,
        [weddingId],
      )
      if (rows.length === 0) throw notFound('Свадьба не найдена')

      // Запись в журнал ДО ответа: иначе просмотр, оборвавшийся на отдаче,
      // остался бы незамеченным.
      await audit(staffId, 'wedding.view', 'wedding', weddingId, { reason })

      /* Только чтение и только карточка. Ни гостей, ни переписки, ни сумм:
       * поддержке для разбора обращения этого достаточно, а лишнее здесь —
       * это чужая свадьба целиком. */
      const w = rows[0]!
      return {
        id: w.id,
        title: w.title,
        date: w.date,
        city: w.city,
        style: w.style,
        guestsPlanned: w.guests_planned,
        createdAt: w.created_at.toISOString(),
      }
    },
  )
}
