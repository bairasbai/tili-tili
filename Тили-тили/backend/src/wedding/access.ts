import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError, forbidden, notFound, unauthorized } from '../errors.js'
import { consentState } from '../auth/consent.js'
import { verifyAccessToken } from '../auth/tokens.js'
import type { Queryable } from '../plugins/db.js'
import { GUEST_ACCESSIBLE_WEDDING_PATHS, guestByToken, readGuestToken } from '../guests/access.js'
import { isUuid } from '../ids.js'

export const ROLES = ['couple', 'helper', 'coordinator', 'vendor'] as const
export type Role = (typeof ROLES)[number]

const ALL_TEAM: Role[] = ['couple', 'helper', 'coordinator']
const ONLY_COUPLE: Role[] = ['couple']
const COUPLE_AND_HELPER: Role[] = ['couple', 'helper']
/** Днём X командует координатор — вместе с парой и без помощника (§2). */
const DAY_COMMAND: Role[] = ['couple', 'coordinator']

declare module 'fastify' {
  interface FastifyRequest {
    member?: { weddingId: string; role: Role }
  }
}

interface Rule {
  /** Путь в нотации Fastify, как он зарегистрирован. */
  readonly url: RegExp
  /** Метод → кому можно. Метод, которого нет в списке, запрещён всем. */
  readonly by: Partial<Record<string, Role[]>>
}

/**
 * Матрица доступа из раздела 6 плана. Один список на весь сервер, а не
 * проверка внутри каждого обработчика: забытая проверка в одном обработчике
 * из сорока — это утечка, которую не видно ни в тестах пути, ни на ревью.
 *
 * Правила проверяются ДО обработчика и до заглушки 501. Поэтому «helper видит
 * 403 на бюджете» верно уже сейчас, когда бюджета ещё нет: путь этапа 4
 * закрыт с этапа 2 и не откроется по недосмотру.
 *
 * Порядок важен: берётся первое подошедшее правило.
 */
const MATRIX: Rule[] = [
  { url: /^\/weddings\/:weddingId\/events(\/|$)/, by: { GET: ALL_TEAM, POST: ONLY_COUPLE, PATCH: ONLY_COUPLE, DELETE: ONLY_COUPLE } },
  { url: /^\/weddings\/:weddingId\/offers\/[^/]+\/accept$/, by: { POST: ONLY_COUPLE } },
  {
    url: /^\/weddings\/:weddingId\/slots\/[^/]+\/shortlist$/,
    by: { GET: ALL_TEAM },
  },
  {
    url: /^\/weddings\/:weddingId\/slots\/[^/]+\/shortlist\/[^/]+$/,
    by: { DELETE: COUPLE_AND_HELPER },
  },
  {
    url: /^\/weddings\/:weddingId\/slots\/[^/]+\/offer-requests$/,
    by: { POST: ONLY_COUPLE },
  },
  {
    url: /^\/weddings\/:weddingId\/shortlist\/[^/]+$/,
    by: { PUT: COUPLE_AND_HELPER },
  },
  // Деньги. helper и coordinator не видят их нигде — ни сумм, ни действий.
  /* PUT — пользовательский лимит категории (018-B): без него правило молча
   * запрещало метод всем, и пара получала 403 на собственный бюджет. */
  { url: /^\/weddings\/:weddingId\/budget/, by: { GET: ONLY_COUPLE, POST: ONLY_COUPLE, PUT: ONLY_COUPLE, PATCH: ONLY_COUPLE, DELETE: ONLY_COUPLE } },
  { url: /^\/weddings\/:weddingId\/slots\/[^/]+\//, by: { POST: ONLY_COUPLE, DELETE: ONLY_COUPLE, PATCH: ONLY_COUPLE } },
  /* График платежей и оплаты (018): явно, а не запретом по умолчанию — новое правило
   * ниже по списку не должно незаметно открыть их помощнику (ревью 018, P-05). */
  { url: /^\/weddings\/:weddingId\/(payment-schedule|payments)(\/|$)/, by: { GET: ONLY_COUPLE, POST: ONLY_COUPLE, PATCH: ONLY_COUPLE, DELETE: ONLY_COUPLE } },
  { url: /^\/weddings\/:weddingId\/wishlist/, by: { GET: ONLY_COUPLE, POST: ONLY_COUPLE, PUT: ONLY_COUPLE, PATCH: ONLY_COUPLE, DELETE: ONLY_COUPLE } },
  { url: /^\/weddings\/:weddingId\/(anti-gifts|funds)/, by: { GET: ONLY_COUPLE, POST: ONLY_COUPLE, PUT: ONLY_COUPLE, DELETE: ONLY_COUPLE } },

  // Карточка свадьбы: смотрят все свои, правит только пара.
  { url: /^\/weddings\/:weddingId$/, by: { GET: ALL_TEAM, PATCH: ONLY_COUPLE, DELETE: ONLY_COUPLE } },

  // Команда и приглашения: список видят все свои, меняет только пара.
  { url: /^\/weddings\/:weddingId\/members/, by: { GET: ALL_TEAM, PATCH: ONLY_COUPLE, DELETE: ONLY_COUPLE } },
  { url: /^\/weddings\/:weddingId\/invites/, by: { GET: ALL_TEAM, POST: ONLY_COUPLE } },

  /* Ссылка-приглашение — не строка списка, а удостоверение гостя.
   *
   * Кто её выдаёт, тот может обменять её сам и дальше действовать от имени
   * гостя: зарезервировать подарок, снять чужой резерв, залить кадр
   * в альбом. Для пары это неизбежно — она и есть отправитель. Для
   * помощника это лишние права, которых «ведёт список гостей» не требует
   * (решение владельца 2026-09-03; то же рассуждение, что в ERR-0047).
   *
   * Правило стоит ВЫШЕ общего правила по гостям: побеждает первое подошедшее.
   */
  { url: /^\/weddings\/:weddingId\/guests\/[^/]+\/invite-link$/, by: { POST: ONLY_COUPLE } },
  /* Напоминание гостям тратит SMS-лимит свадьбы и уходит чужим людям —
   * только паре (фича 005, В6). Обработчик держит ту же проверку страховкой. */
  { url: /^\/weddings\/:weddingId\/guests\/remind$/, by: { POST: ONLY_COUPLE } },

  // Организационная часть — общая работа команды.
  // Договоры содержат суммы сделок и паспортные данные сторон — только паре.
  { url: /^\/weddings\/:weddingId\/documents/, by: { GET: ONLY_COUPLE } },

  /* Сдвиг тайминга — команда днём X, а не правка расписания.
   *
   * Preview/confirm выбирает день или мероприятие и исключает fixed/прошедшие
   * блоки. Подтверждение пишет журнал и критические уведомления руководителям
   * и затронутым членам команды/подрядчикам. guestsAffected не означает доставку
   * гостям. Право командовать остаётся у пары и координатора (§2).
   *
   * Правило стоит ВЫШЕ общего по `timeline`: побеждает первое подошедшее.
   * Обычная правка расписания (`PUT /timeline`) остаётся всей команде. */
  { url: /^\/weddings\/:weddingId\/timeline\/shift(\/preview)?$/, by: { POST: DAY_COMMAND } },
  { url: /^\/weddings\/:weddingId\/timeline\/acknowledgments$/, by: { GET: ALL_TEAM } },

  {
    url: /^\/weddings\/:weddingId\/(guests|tables|tasks|logistics|menu-poll|timeline|album)/,
    by: { GET: ALL_TEAM, POST: ALL_TEAM, PUT: ALL_TEAM, PATCH: ALL_TEAM, DELETE: ALL_TEAM },
  },
  // Мозаику видит команда; состав слотов, как и бронь, решает пара (фича 014).
  { url: /^\/weddings\/:weddingId\/slots$/, by: { GET: ALL_TEAM, POST: ONLY_COUPLE } },
  // Заметки — общее поле идей команды, как чат команды (фича 014, блокер №7).
  { url: /^\/weddings\/:weddingId\/notes/, by: { GET: ALL_TEAM, POST: ALL_TEAM, DELETE: ALL_TEAM } },

  /* План Б. Чек-лист накануне сверяет вся команда — за то он и общий.
   * Объявляет запасной сценарий тот, кто днём X командует: пара и
   * координатор (Бизнес-логика §2). Помощнику этого не нужно: активация
   * рассылает уведомление всем и переписывает планы на день. */
  { url: /^\/weddings\/:weddingId\/planb/, by: { GET: ALL_TEAM, POST: DAY_COMMAND } },
]

/**
 * Всё, что не описано явно, доступно только паре.
 *
 * Запрет по умолчанию, а не разрешение: новый путь следующего этапа не должен
 * открываться помощнику просто потому, что про него забыли написать правило.
 * Ошибка в эту сторону видна сразу — тест этапа падает с 403; ошибка в другую
 * сторону не видна никогда.
 */
export function allowedRoles(url: string, method: string): Role[] {
  for (const rule of MATRIX) {
    if (rule.url.test(url)) return rule.by[method] ?? []
  }
  return ONLY_COUPLE
}

export function isWeddingScoped(url: string): boolean {
  return url.startsWith('/weddings/:weddingId')
}

export async function memberRole(
  app: FastifyInstance,
  weddingId: string,
  userId: string,
): Promise<Role | null> {
  const { rows } = await app.db!.query<{ role: Role }>(
    `select m.role from wedding_members m
       join weddings w on w.id = m.wedding_id
      where m.wedding_id = $1 and m.user_id = $2 and w.archived_at is null`,
    [weddingId, userId],
  )
  return rows[0]?.role ?? null
}

/**
 * Хук на каждый путь со свадьбой в адресе. Ставится один раз при сборке
 * приложения и покрывает в том числе пути, обработчиков у которых ещё нет.
 */
export function weddingAccessHook(app: FastifyInstance) {
  return async function checkWeddingAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const url = request.routeOptions?.url
    if (!url || !isWeddingScoped(url)) return
    /* Денежные маршруты 018 проверяют доступ раньше — на preValidation, чтобы
     * посторонний не узнал форму тела по 400 против 403. Второй проход того же
     * хука (глобальный preHandler) повторял бы сессию, согласие и членство
     * тремя запросами на каждый вызов (ревью 018, P-06). */
    if (request.member || request.guest) return

    // Гость приходит на свою свадьбу по токену и аккаунта не имеет.
    // Пускаем его только на явно перечисленные пути и только на свою свадьбу.
    const guestToken = GUEST_ACCESSIBLE_WEDDING_PATHS.has(`${request.method} ${url}`) ? readGuestToken(request) : null
    if (guestToken) {
      const guest = await guestByToken(app.db!, guestToken)
      const asked = (request.params as { weddingId?: string }).weddingId
      if (guest.weddingId !== asked) throw notFound('Свадьба не найдена')
      request.guest = guest
      return
    }

    await app.requireConsent(request, reply)

    const weddingId = (request.params as { weddingId?: string }).weddingId
    if (!weddingId) return
    if (!isUuid(weddingId)) throw notFound('Свадьба не найдена')

    const role = await memberRole(app, weddingId, request.caller!.userId)
    // Чужая свадьба — 404, а не 403: иначе по кодам ответа перебором
    // выясняется, какие идентификаторы существуют.
    if (!role) throw notFound('Свадьба не найдена')

    const allowed = allowedRoles(url, request.method)
    if (!allowed.includes(role)) {
      throw forbidden(`Роль «${role}» не имеет доступа к этому разделу`)
    }
    request.member = { weddingId, role }
  }
}

export function requireRole(request: FastifyRequest, ...roles: Role[]): void {
  const role = request.member?.role
  if (!role || !roles.includes(role)) {
    throw new AppError(403, 'forbidden', 'Недостаточно прав')
  }
}

/** Guest and seating writes pin current access before taking guest/party/table locks. */
export async function lockSeatingAccess(client: Queryable, request: FastifyRequest): Promise<Role> {
  return lockGuestTeamAccess(client, request, true)
}

/** Reads share the access lock, but cancellation does not erase team history. */
export async function lockGuestReadAccess(client: Queryable, request: FastifyRequest): Promise<Role> {
  return lockGuestTeamAccess(client, request, false)
}

async function lockGuestTeamAccess(client: Queryable, request: FastifyRequest, write: boolean): Promise<Role> {
  const weddingId = request.member!.weddingId
  const caller = request.caller!
  const wedding = await client.query<{ archived_at: Date | null; cancelled_at: Date | null }>(
    `select archived_at,cancelled_at from weddings where id=$1 for ${write ? 'update' : 'share'}`, [weddingId],
  )
  if (!wedding.rows[0] || wedding.rows[0].archived_at || (write && wedding.rows[0].cancelled_at)) throw notFound('Свадьба не найдена')
  const user = await client.query<{ deleted_at: Date | null }>('select deleted_at from users where id=$1 for share', [caller.userId])
  if (!user.rows[0] || user.rows[0].deleted_at) throw unauthorized('Аккаунт удалён')
  const session = await client.query('select id from sessions where id=$1 and user_id=$2 and revoked_at is null for share', [caller.sessionId, caller.userId])
  if (session.rowCount === 0) throw unauthorized('Сессия завершена')
  const member = await client.query<{ role: Role }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [weddingId, caller.userId])
  const role = member.rows[0]?.role
  if (!role) throw notFound('Свадьба не найдена')
  if (!allowedRoles(request.routeOptions.url!, request.method).includes(role)) throw forbidden('Недостаточно прав')
  const config = request.server.appConfig
  const state = await consentState(client, caller.userId, config.policyVersion, { lock: true })
  if (state === 'none') throw forbidden('Нужно согласие на обработку персональных данных')
  if (state === 'outdated') throw new AppError(403, 'consent_outdated', 'Мы обновили документы — подтвердите новую редакцию, чтобы продолжить')
  await assertSeatingToken(request)
  return role
}

/** Time can advance during a later resource wait even while access rows are pinned. */
export async function assertSeatingToken(request: FastifyRequest): Promise<void> {
  const config = request.server.appConfig
  const caller = request.caller!
  if (!config.jwtAccessSecret) throw unauthorized('Сервер не настроен для проверки токенов')
  const claims = await verifyAccessToken(config.jwtAccessSecret, request.headers.authorization!.slice('Bearer '.length).trim())
  if (claims.sub !== caller.userId || claims.sid !== caller.sessionId) throw unauthorized('Сессия завершена')
}
