import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError, forbidden, notFound } from '../errors.js'
import { GUEST_ACCESSIBLE_WEDDING_PATHS, guestByToken, readGuestToken } from '../guests/access.js'

export const ROLES = ['couple', 'helper', 'coordinator', 'vendor'] as const
export type Role = (typeof ROLES)[number]

const ALL_TEAM: Role[] = ['couple', 'helper', 'coordinator']
const ONLY_COUPLE: Role[] = ['couple']
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
  // Деньги. helper и coordinator не видят их нигде — ни сумм, ни действий.
  { url: /^\/weddings\/:weddingId\/budget/, by: { GET: ONLY_COUPLE, POST: ONLY_COUPLE, PATCH: ONLY_COUPLE, DELETE: ONLY_COUPLE } },
  { url: /^\/weddings\/:weddingId\/slots\/[^/]+\//, by: { POST: ONLY_COUPLE, DELETE: ONLY_COUPLE, PATCH: ONLY_COUPLE } },
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

  // Организационная часть — общая работа команды.
  // Договоры содержат суммы сделок и паспортные данные сторон — только паре.
  { url: /^\/weddings\/:weddingId\/documents/, by: { GET: ONLY_COUPLE } },

  /* Сдвиг тайминга — команда днём X, а не правка расписания.
   *
   * Он двигает ВСЕ ещё не начавшиеся блоки, пишет в журнал рассылок и шлёт
   * КРИТИЧЕСКОЕ уведомление всем гостям и забронированным подрядчикам, то есть
   * мимо тихих часов. Рассуждение то же, что у плана Б строкой ниже, и оно
   * применимо дословно: командует тот, кто командует днём (решение владельца
   * 2026-09-04). Промах помощника по этой кнопке в час ночи будит полторы
   * сотни человек, и отменить это нечем.
   *
   * Правило стоит ВЫШЕ общего по `timeline`: побеждает первое подошедшее.
   * Обычная правка расписания (`PUT /timeline`) остаётся всей команде. */
  { url: /^\/weddings\/:weddingId\/timeline\/shift$/, by: { POST: DAY_COMMAND } },

  {
    url: /^\/weddings\/:weddingId\/(guests|tables|tasks|logistics|menu-poll|timeline|album)/,
    by: { GET: ALL_TEAM, POST: ALL_TEAM, PUT: ALL_TEAM, PATCH: ALL_TEAM, DELETE: ALL_TEAM },
  },
  { url: /^\/weddings\/:weddingId\/slots$/, by: { GET: ALL_TEAM } },

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
    if (!/^[0-9a-f-]{36}$/i.test(weddingId)) throw notFound('Свадьба не найдена')

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
