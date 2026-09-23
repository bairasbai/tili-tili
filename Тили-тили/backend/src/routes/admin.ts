import { PAID_SUM } from '../deals/repo.js'
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { buildPage, encodeCursor, parsePageQuery, timestampKey } from '../pagination.js'
import { VENDOR_COLUMNS, toVendor, type VendorRow } from '../catalog/vendors.js'
import { recomputeRating } from '../reviews/rating.js'
import { notify } from '../notify/notify.js'
import { ref } from '../contract/schemas.generated.js'
import type { Queryable } from '../plugins/db.js'
import { isUuid } from '../ids.js'

/**
 * Какая санкция к какой цели применима (План §18.2).
 *
 * Правило держит база — `CHECK complaints_resolution_by_target` (фича 005,
 * миграция 17596…): обход обработчика прямым SQL получает `23514`. Та же
 * таблица здесь — чтобы ответить 422 с именем поля ДО транзакции: отказ
 * базы пришёл бы как 500 без объяснения, что именно не так.
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

  /** `entityId` пуст у действий над списком (чтение очереди): колонка — uuid, строки-имени в неё не положить. */
  async function audit(actorId: string, action: string, entity: string, entityId: string | null, diff: unknown, client: Queryable = db()) {
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
     * месяц в черновике, это разные дни, и срок проверки идёт от первой.
     * По ней же очередь и упорядочена: до ревью 015 сортировка шла по дате
     * заведения, и черновик, опубликованный сегодня, вставал впереди анкеты,
     * ждущей проверки неделю. Ключ курсора — с микросекундами (`timestampKey`). */
    const { rows } = await db().query<VendorRow & { created_at: Date; published_at: Date; key: string }>(
      `select ${VENDOR_COLUMNS}, v.published_at, ${timestampKey('v.published_at')} as key
         ${MODERATION_QUEUE_FROM}
          and ($1::text is null or (v.published_at, v.id) > ($1::timestamptz, $2::uuid))
        order by v.published_at asc, v.id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    const paged = buildPage(rows, page.limit, (r) => encodeCursor(r.key, r.id))
    return {
      items: paged.items.map((r) => ({
        ...toVendor(r),
        createdAt: r.created_at.toISOString(),
        publishedAt: r.published_at.toISOString(),
      })),
      nextCursor: paged.nextCursor,
    }
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
      if (!isUuid(vendorId)) throw notFound('Анкета не найдена')
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
        /* Галочка «проверен». Документы при этом наружу не выходят. `coalesce`
         * — как у решения по заявке (`POST /admin/verifications/{id}`): дата
         * первой проверки не переписывается повторным `verify` (ревью 015). */
        verify: 'moderated_at = now(), verified_at = coalesce(verified_at, now())',
      }[body.action]

      /* Решение по анкете, статус заявки на проверку и запись в журнал —
       * одна транзакция (R-122): галочка «проверен» без закрытой заявки
       * оставляла бы её «на проверке» в кабинете навсегда. */
      const { wasVerified, wasModerated } = await db().tx(async (client) => {
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
        const { rows: state } = await client.query<{
          published_at: Date | null
          blocked_at: Date | null
          verified_at: Date | null
          moderated_at: Date | null
        }>(
          'select published_at, blocked_at, verified_at, moderated_at from vendors where id = $1 for update',
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
        return { wasVerified: current.verified_at !== null, wasModerated: current.moderated_at !== null }
      })

      const { rows: owner } = await db().query<{ user_id: string }>('select user_id from vendors where id = $1', [
        vendorId,
      ])
      /* Второй `verify` по уже проверенной анкете — то же решение, а не новость:
       * «Вы проверены» второй раз читалось бы как сбой (ревью 015; так же
       * молчит повторное одобрение заявки ниже). Второй `approve` живой
       * анкеты — то же самое: `moderated_at` уже стоял до этого решения,
       * значит «Анкета проверена» подрядчик уже получил, и вторая такая же
       * новость читалась бы как сбой точно так же (ревью 016, F-RL7-03,
       * R-282). */
      if (owner[0] && !(body.action === 'verify' && wasVerified) && !(body.action === 'approve' && wasModerated)) {
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
      key: string
    }>(
      `select r.id, r.vendor_id, v.name as vendor_name, r.kind, r.created_at,
              (r.file_url is not null and r.file_url <> '') as has_file,
              ${timestampKey('r.created_at')} as key
         ${VERIFICATION_QUEUE_FROM}
          and ($1::text is null or (r.created_at, r.id) > ($1::timestamptz, $2::uuid))
        order by r.created_at asc, r.id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    // Ключ курсора — с микросекундами (`timestampKey`, ревью 015): усечённый пропускал заявки той же миллисекунды.
    const paged = buildPage(rows, page.limit, (r) => encodeCursor(r.key, r.id))
    return {
      items: paged.items.map((r) => ({
        id: r.id,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name,
        kind: r.kind,
        hasFile: r.has_file,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: paged.nextCursor,
    }
  })

  app.get('/admin/verifications/:requestId', { preHandler: app.requireConsent }, async (request) => {
    const staffId = await requireStaff(request)
    const { requestId } = request.params as { requestId: string }
    if (!isUuid(requestId)) throw notFound('Заявка не найдена')

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
      if (!isUuid(requestId)) throw notFound('Заявка не найдена')
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
        /* Ушедший владелец отсекается ЗДЕСЬ же, а не только в очереди и
         * карточке: без этого условия заявка, пропавшая из очереди вместе с
         * мягко удалённым аккаунтом, всё равно разбиралась по прямой ссылке
         * — сотрудник ставил галочку человеку, которого на платформе больше
         * нет. Условие одно на все три пути, слово в слово. */
        const { rows: found } = await client.query<{ vendor_id: string }>(
          `select r.vendor_id from vendor_verifications r
             join vendors v on v.id = r.vendor_id
             join users u on u.id = v.user_id and u.deleted_at is null
            where r.id = $1`,
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
      key: string
    }>(
      `select id, target_kind, target_id, category, text, status, created_at, ${timestampKey('created_at')} as key
         from complaints
        where status = 'new'
          and ($1::text is null or (created_at, id) > ($1::timestamptz, $2::uuid))
        order by created_at asc, id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    // Ключ курсора — с микросекундами (`timestampKey`, ревью 015).
    const paged = buildPage(rows, page.limit, (r) => encodeCursor(r.key, r.id))
    return {
      items: paged.items.map((r) => ({
        id: r.id,
        targetKind: r.target_kind,
        targetId: r.target_id,
        category: r.category,
        text: r.text ?? '',
        status: r.status,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: paged.nextCursor,
    }
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
      if (!isUuid(complaintId)) throw notFound('Жалоба не найдена')
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

  /* ── очередь заявок консьержу (ревью 015, V5) ─────────────────────── */
  /*
   * Заявки «подобрать вручную» (`POST /catalog/concierge`, План §18.12)
   * копились в базе со статусом `new`, и разобрать их было неоткуда: ни
   * очереди, ни решения. Открытые (`new`, `in_progress`), старейшие сверху —
   * обещание «свяжемся в течение суток» считается от подачи.
   *
   * Телефон пары — в строке: она сама попросила связаться, и сотрудник
   * звонит по нему. Чтение очереди — в журнал действий, как открытие
   * документов верификации: телефоны раздаются страницами, и «кто смотрел»
   * должно оставаться проверяемым.
   */
  app.get('/admin/concierge', { preHandler: app.requireConsent }, async (request) => {
    const staffId = await requireStaff(request)
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    const { rows } = await db().query<{
      id: string
      status: string
      category_id: string
      category_name: string
      city: string | null
      budget: string | null
      currency: string
      comment: string | null
      phone: string
      name: string | null
      created_at: Date
      key: string
    }>(
      `select r.id, r.status, r.category_id, cat.name as category_name, c.name as city,
              r.budget::text as budget, r.currency, r.comment, u.phone, u.name, r.created_at,
              ${timestampKey('r.created_at')} as key
         from concierge_requests r
         join users u on u.id = r.user_id and u.deleted_at is null
         join categories cat on cat.id = r.category_id
         left join cities c on c.id = r.city_id
        where r.status in ('new', 'in_progress')
          and ($1::text is null or (r.created_at, r.id) > ($1::timestamptz, $2::uuid))
        order by r.created_at asc, r.id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    await audit(staffId, 'concierge.queue.view', 'concierge', null, { cursor: page.cursor?.id ?? null, rows: rows.length })
    const paged = buildPage(rows, page.limit, (r) => encodeCursor(r.key, r.id))
    return {
      items: paged.items.map((r) => ({
        id: r.id,
        status: r.status,
        categoryId: r.category_id,
        categoryName: r.category_name,
        city: r.city,
        budget: r.budget === null ? null : { amount: Number(r.budget), currency: r.currency.trim() },
        comment: r.comment,
        phone: r.phone,
        name: r.name,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: paged.nextCursor,
    }
  })

  app.post(
    '/admin/concierge/:requestId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['in_progress', 'done', 'cancelled'] } },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { requestId } = request.params as { requestId: string }
      if (!isUuid(requestId)) throw notFound('Заявка не найдена')
      const { status } = request.body as { status: 'in_progress' | 'done' | 'cancelled' }

      /* Состояние — под замком строки и в одной транзакции с журналом:
       * двое сотрудников, закрывающих одну заявку, иначе оба слали бы паре
       * «подобрали» (тот же класс, что у решений по анкете и заявке). Закрытую
       * заново не открывают — 409: новая просьба пары — новая заявка. */
      const decided = await db().tx(async (client) => {
        const { rows } = await client.query<{ status: string; user_id: string; category_name: string }>(
          `select r.status, r.user_id, cat.name as category_name
             from concierge_requests r join categories cat on cat.id = r.category_id
            where r.id = $1 for update of r`,
          [requestId],
        )
        if (rows.length === 0) throw notFound('Заявка не найдена')
        const current = rows[0]!
        if (current.status === 'done' || current.status === 'cancelled') {
          throw conflict('concierge_closed', 'Заявка уже закрыта — новая просьба пары придёт новой заявкой')
        }
        await client.query('update concierge_requests set status = $2 where id = $1', [requestId, status])
        await audit(staffId, `concierge.${status}`, 'concierge', requestId, { from: current.status }, client)
        return { userId: current.user_id, categoryName: current.category_name, was: current.status }
      })

      /* Новость паре — следствие решения, а не его часть (как у анкеты):
       * решение записано, и упавшее уведомление его не откатывает. Только
       * по `done`: «взята в работу» — внутренняя кухня, паре обещаны сутки. */
      if (status === 'done') {
        try {
          await notify(db(), {
            userId: decided.userId,
            kind: 'system',
            title: 'Консьерж подобрал варианты',
            body: `Категория «${decided.categoryName}»: мы связались с вами или свяжемся в ближайшее время`,
            link: '/search',
            critical: false,
          })
        } catch (err) {
          request.log.warn({ err, requestId }, 'заявка консьержу закрыта, уведомление не ушло')
        }
      }
      return { requestId, status }
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
      /* Та же блокировка, что у `PUT`, и тоже первым запросом транзакции.
       * Уровень изоляции здесь READ COMMITTED: каждый запрос видит свой
       * снимок, и чужое сохранение, успевшее между чтением строк и подсчётом
       * отпечатка, отдавало панели данные ДО правки вместе с версией ПОСЛЕ
       * неё. Сохранение с такой версией проверку проходило — и молча
       * затирало чужую работу, ради чего фича 004 и заведена. */
      await client.query('select pg_advisory_xact_lock($1::bigint)', [CATEGORIES_LOCK])
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
        /* Тело — схема контракта целиком (`AdminCategoriesUpdate`, фича 014),
         * а не копия правил рядом. Копия уже расходилась с ним дважды: `icon`
         * строкой против `nullable` (AJV с `coerceTypes` превращал `null` в
         * пустую строку, и значок молча стирался), `version` с `maxLength: 64`
         * против шестнадцати шестнадцатеричных знаков (409 вместо 422). Одна
         * схема — одно место правды; предел 200 категорий — там же. */
        body: ref('AdminCategoriesUpdate'),
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
             * подставляется явно, а для существующей смотрится сам параметр.
             *
             * Значок — по тому же правилу (R-17, фича 014): поля нет — прежний,
             * `null` — стереть. Раньше стояло `coalesce(excluded.icon, …)`, и
             * стереть значок было нельзя ничем — `null` подставлял старый. */
            `insert into categories (id, name, icon, sort) values ($1,$2,$3,coalesce($4::int, 0))
             on conflict (id) do update set name = excluded.name,
                                            icon = case when $5 then excluded.icon else categories.icon end,
                                            sort = case when $4::int is null then categories.sort else excluded.sort end`,
            [c.id, c.title, c.icon ?? null, c.sort ?? null, Object.prototype.hasOwnProperty.call(c, 'icon')],
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
    /* Все показатели — одним снимком (REPEATABLE READ): четыре запроса подряд
     * под живой нагрузкой видели разные состояния, и `vendorsPublished`
     * расходился с `profiles.published` на две анкеты, опубликованные между
     * ними (фича 012). Дашборд обещает одно «сейчас» — пусть оно и будет одно. */
    return db().tx(async (snap) => {
    await snap.query('set transaction isolation level repeatable read')
    const { rows } = await snap.query<Record<string, string>>(
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
    const { rows: cities } = await snap.query<{ city: string; vendors: string }>(
      `select c.name as city, count(*)::text as vendors
         from vendors v join users u on u.id = v.user_id and u.deleted_at is null
         join cities c on c.id = v.city_id
        where v.published_at is not null and v.blocked_at is null
        group by c.name order by count(*) desc limit 20`,
    )

    /* Заполненность живых опубликованных анкет (фича 012, План §19.10 п. 4):
     * доля заполненных из четырёх полей, которые подрядчик может заполнить
     * сам — описание, рабочий телефон, цена «от», хотя бы один пакет. Фото и
     * видео не считаются: загрузок нет до хранилища (№3), и метрика штрафовала
     * бы всех за инфраструктуру. Набор анкет — тот же, что у vendorsPublished. */
    const { rows: profiles } = await snap.query<{ published: string; complete: string; average_percent: string }>(
      `with filled as (
         select (case when coalesce(v.about, '') <> '' then 1 else 0 end
               + case when v.phone is not null then 1 else 0 end
               + case when v.price_from is not null then 1 else 0 end
               + case when exists (select 1 from vendor_packages p where p.vendor_id = v.id) then 1 else 0 end) as n
           from vendors v join users u on u.id = v.user_id and u.deleted_at is null
          where v.published_at is not null and v.blocked_at is null)
       select count(*)::text as published,
              count(*) filter (where n = 4)::text as complete,
              coalesce(round(100 * avg(n / 4.0)), 0)::text as average_percent
         from filled`,
    )

    /* Расход Тиля на модель за 30 дней (фича 010) — по строкам учёта, одна на
     * вызов. Стоимость в рублях не считается: цены у провайдеров и моделей
     * разные и меняются, а число вместо «не знаем» — обещание за код (R-174). */
    const { rows: llm } = await snap.query<{ since: Date; calls: string; answered: string; input_tokens: string; output_tokens: string }>(
      `select now() - interval '30 days' as since,
              count(*)::text as calls,
              count(*) filter (where outcome = 'answered')::text as answered,
              coalesce(sum(input_tokens) filter (where outcome = 'answered'), 0)::text as input_tokens,
              coalesce(sum(output_tokens) filter (where outcome = 'answered'), 0)::text as output_tokens
         from tilly_usage where created_at >= now() - interval '30 days'`,
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
      llm: {
        since: llm[0]!.since.toISOString(),
        calls: Number(llm[0]!.calls),
        answered: Number(llm[0]!.answered),
        inputTokens: Number(llm[0]!.input_tokens),
        outputTokens: Number(llm[0]!.output_tokens),
      },
      profiles: {
        published: Number(profiles[0]!.published),
        complete: Number(profiles[0]!.complete),
        averagePercent: Number(profiles[0]!.average_percent),
      },
    }
    })
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
      if (!isUuid(weddingId)) throw notFound('Свадьба не найдена')
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

  /* ── сделки свадьбы для поддержки (фича 013, решение владельца 2026-09-13) ── */
  /*
   * Разбор спора о деньгах по обращению пары: сделки — да, переписка — нет.
   * Те же правила, что у карточки: причина обязательна и уходит в журнал ДО
   * ответа; имена подрядчиков есть, телефонов нет (`external_phone` не
   * читается вовсе). Оплачено — той же формулой, что у пары и подрядчика
   * (`PAID_SUM`), иначе поддержка спорила бы с обеими сторонами о третьем числе.
   */
  app.get(
    '/admin/weddings/:weddingId/deals',
    {
      preHandler: app.requireConsent,
      schema: {
        querystring: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { weddingId } = request.params as { weddingId: string }
      if (!isUuid(weddingId)) throw notFound('Свадьба не найдена')
      const { reason } = request.query as { reason: string }
      const { rows: exists } = await db().query('select 1 from weddings where id = $1', [weddingId])
      if (exists.length === 0) throw notFound('Свадьба не найдена')

      await audit(staffId, 'wedding.deals.view', 'wedding', weddingId, { reason })

      const { rows } = await db().query<{
        id: string
        slot_label: string
        category_id: string
        vendor_name: string | null
        external_name: string | null
        state: string
        price: string | null
        currency: string
        paid: string
        booked_at: Date | null
        cancelled_at: Date | null
      }>(
        `select d.id, s.label as slot_label, s.category_id, ven.name as vendor_name, d.external_name, d.state,
                d.price::text as price, d.currency, ${PAID_SUM}::text as paid, d.booked_at, d.cancelled_at
           from deals d
           join slots s on s.id = d.slot_id
           left join vendors ven on ven.id = d.vendor_id
          where d.wedding_id = $1
          order by s.sort, d.created_at`,
        [weddingId],
      )
      const { rows: events } = await db().query<{
        deal_id: string
        at: Date
        by: string
        from_state: string | null
        to_state: string
        note: string | null
      }>(
        `select e.deal_id, e.at, e.from_state, e.to_state, e.note,
                case
                  when e.actor_id is null then 'system'
                  when exists(select 1 from vendors v where v.id = d.vendor_id and v.user_id = e.actor_id) then 'vendor'
                  else 'couple'
                end as by
           from deal_events e join deals d on d.id = e.deal_id
          where d.wedding_id = $1
          order by e.at`,
        [weddingId],
      )
      const byDeal = new Map<string, typeof events>()
      for (const e of events) byDeal.set(e.deal_id, [...(byDeal.get(e.deal_id) ?? []), e])
      return {
        items: rows.map((d) => ({
          id: d.id,
          slotLabel: d.slot_label,
          categoryId: d.category_id,
          vendorName: d.vendor_name,
          externalName: d.external_name,
          state: d.state,
          price: d.price === null ? null : { amount: Number(d.price), currency: d.currency },
          paid: { amount: Number(d.paid), currency: d.currency },
          bookedAt: d.booked_at?.toISOString() ?? null,
          cancelledAt: d.cancelled_at?.toISOString() ?? null,
          events: (byDeal.get(d.id) ?? []).map((e) => ({
            at: e.at.toISOString(),
            by: e.by,
            fromState: e.from_state,
            toState: e.to_state,
            note: e.note,
          })),
        })),
      }
    },
  )
}
