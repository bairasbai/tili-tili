import { accessTokenForWs, api, isAuthorized, newIdempotencyKey, url } from './client'
import { forgetOfflineDay, forgetOfflinePrograms, forgetOfflineSeating, offlineScope, sameOfflineScope } from '../offlineAccess'
import { reconcileOfflineSeating } from '../offlineSeating'
import type { components, paths } from './schema'

/*
 * Свадьба на сервере: создание из квиза и восстановление после переустановки.
 *
 * `weddingId` живёт на устройстве, но источником правды не является. С чистым
 * хранилищем — новый телефон, приватный режим, сброшенный кэш — взять его
 * больше неоткуда, кроме `GET /weddings`. Поэтому здесь два действия, а не
 * одно: создать и найти.
 */

/** Ответы квиза в том виде, в котором их принимает `POST /weddings`. */
export interface WeddingDraft {
  partnerName: string
  city: { name: string; region: string }
  date?: string | null
  guestsPlanned?: number
  /** Общий бюджет в копейках. */
  budgetTotal?: number
  style?: string
  /* Ответы квиза кодами (фича 018): по ним сервер собирает мозаику, тайминг и чек-лист. */
  format?: components['schemas']['WeddingFormat']
  planner?: components['schemas']['WeddingPlanner']
  /** Что уже забронировано вне приложения; пустой список — «Пока ничего». */
  prebooked?: components['schemas']['PrebookedCategory'][]
  quizAnswers?: Record<string, unknown>
}

/*
 * Квиз спрашивает диапазонами — «30–60», «100+», — а сервер принимает число.
 * Берём нижнюю границу: она не обещает больше, чем человек сказал. Подбор
 * залов по вместимости от заниженного числа даёт лишние варианты, от
 * завышенного — отсекает подходящие.
 */
export function guestsFromRange(answer: string | null): number | undefined {
  if (!answer) return undefined
  const digits = answer.match(/\d+/g)
  return digits?.length ? Number(digits[0]) : undefined
}

/*
 * Бюджет квиз тоже спрашивает диапазоном — «1–2 млн ₽», «До 500 тыс ₽».
 * Берём нижнюю границу по той же причине, что и с гостями: она не обещает
 * больше, чем человек сказал. «Пока не знаем» — не число, и подставлять
 * вместо него ноль нельзя: ноль на экране бюджета читается как «денег нет».
 */
export function budgetFromRange(answer: string | null): number | undefined {
  if (!answer) return undefined
  /* Берём ПЕРВУЮ пару «число + единица». Простой поиск «млн» по всей строке
     ошибается на «500 тыс — 1 млн ₽»: там он находит миллион и завышает
     нижнюю границу вдвое. Диапазон «1–2 млн» тоже отдаёт первое число. */
  const m = answer.match(/(\d+)(?:\s*[–—-]\s*\d+)?\s*(тыс|млн)/)
  if (!m) return undefined
  const rubles = Number(m[1]) * (m[2] === 'млн' ? 1_000_000 : 1_000)
  return rubles * 100
}

/** Создать свадьбу. Возвращает её идентификатор. */
export async function createWedding(draft: WeddingDraft): Promise<string> {
  const created = await api.post('/weddings', {
    partnerName: draft.partnerName,
    city: draft.city,
    ...(draft.date ? { date: draft.date } : {}),
    ...(draft.guestsPlanned !== undefined ? { guestsPlanned: draft.guestsPlanned } : {}),
    ...(draft.budgetTotal !== undefined ? { budgetTotal: { amount: draft.budgetTotal, currency: 'RUB' } } : {}),
    ...(draft.style ? { style: draft.style } : {}),
    ...(draft.format ? { format: draft.format } : {}),
    ...(draft.planner ? { planner: draft.planner } : {}),
    ...(draft.prebooked ? { prebooked: draft.prebooked } : {}),
    ...(draft.quizAnswers ? { quizAnswers: draft.quizAnswers } : {}),
  })
  const id = created?.id
  if (!id) throw new Error('сервер не вернул идентификатор свадьбы')
  return id
}

/** Свадьба из списка «мои»: та же схема плюс роль человека в ней. */
export type MyWedding = NonNullable<
  paths['/weddings']['get']['responses'][200]['content']['application/json']
>[number]

/**
 * Все свадьбы человека вместе с его ролью в каждой.
 *
 * Отдельно от `findMyWedding()`, потому что вопросов к этому списку два, а не
 * один: «какая свадьба моя, если идентификатор потерян» и «жива ли ещё та,
 * которую помнит телефон». Второй появился вместе с отменой: свадьбу мог
 * отменить партнёр с другого устройства, и тогда сохранённый идентификатор
 * указывает в пустоту, а каждый экран получает «не найдено».
 */
export async function listMyWeddings(): Promise<MyWedding[]> {
  if (!isAuthorized()) return []
  const scope = offlineScope(accessTokenForWs())
  const list = (await api.get('/weddings')) ?? []
  if (sameOfflineScope(scope, offlineScope(accessTokenForWs()))) reconcileOfflineSeating(list, scope)
  return list
}

/**
 * Найти свою свадьбу, когда идентификатор на устройстве потерян.
 *
 * Берём первую, где роль `couple`: свадьба, которую человек ведёт, важнее
 * той, куда его позвали помощником. Если своей нет — первую из списка,
 * чтобы приглашённый координатор тоже попал внутрь.
 */
export async function findMyWedding(): Promise<string | null> {
  return pickMyWedding(await listMyWeddings())
}

/** Та же выборка «своя, иначе первая» для уже полученного списка. */
export function pickMyWedding(list: MyWedding[]): string | null {
  if (!list.length) return null
  const own = list.find(w => w.role === 'couple')
  return (own ?? list[0])?.id ?? null
}

/**
 * Отменить свадьбу.
 *
 * Двухшаговая на сервере, а не здесь: первый вызов создаёт запрос
 * (`confirmation_required`), второй — от второго партнёра — исполняет отмену
 * (`cancelled`). Клиент не решает, какой из двух случаев наступил, — он
 * показывает то, что ответил сервер.
 */
export const cancelWedding = async (weddingId: string) => {
  const result = await api.post(url('/weddings/{weddingId}/cancel', { weddingId }), {})
  if (result.state === 'cancelled') {
    forgetOfflineDay(weddingId)
    forgetOfflineSeating(weddingId)
    forgetOfflinePrograms({ weddingId })
  }
  return result
}

/**
 * Перенос свадьбы на другую дату.
 *
 * Это не правка поля, а перенос: сервер проверяет, свободна ли новая дата у
 * забронированной команды (409 `team_busy` — и тогда не меняется ничего),
 * пересчитывает сроки задач, тайминг и время открытия чата дня X. Поэтому
 * дату нельзя держать только на устройстве — там она ничего из этого не
 * запускает, а у второго из пары остаётся старой.
 */
export const setWeddingDateOnServer = (weddingId: string, date: string) =>
  api.patch(url('/weddings/{weddingId}', { weddingId }), { date }, { idempotencyKey: newIdempotencyKey() })

/**
 * Задать общий бюджет свадьбы. Сумма — в копейках.
 *
 * До ревью D2-09 `budgetTotal` уходил только из квиза: пара, ответившая «пока
 * не знаем», задать его потом не могла нигде, а экран бюджета показывал
 * «из 0 ₽ запланировано · 0%» как факт. Тело — ровно одно поле: остальные
 * поля свадьбы `PATCH` трогать не должен.
 */
export const setBudgetTotal = (weddingId: string, amount: number) =>
  api.patch(url('/weddings/{weddingId}', { weddingId }), { budgetTotal: { amount, currency: 'RUB' } }, { idempotencyKey: newIdempotencyKey() })

/**
 * Оформление приглашения: обращение пары и сценарий.
 *
 * Хранится у свадьбы, а не в браузере пары: гость открывает приглашение со
 * своего устройства, и текст с темой должны приехать к нему с сервера. Пока
 * они лежали в localStorage, пара правила текст, которого гость не видел.
 */
export const saveInviteDesign = (
  weddingId: string,
  inviteText: string,
  inviteThemeId: number,
  dressCode?: string,
  dressNote?: string,
) =>
  api.patch(
    url('/weddings/{weddingId}', { weddingId }),
    {
      inviteText,
      inviteThemeId,
      ...(dressCode ? { dressCode } : {}),
      ...(dressNote ? { dressNote } : {}),
    },
    { idempotencyKey: newIdempotencyKey() },
  )
