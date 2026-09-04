import { api, isAuthorized } from './client'

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
  style?: string
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

/** Создать свадьбу. Возвращает её идентификатор. */
export async function createWedding(draft: WeddingDraft): Promise<string> {
  const created = await api.post('/weddings', {
    partnerName: draft.partnerName,
    city: draft.city,
    ...(draft.date ? { date: draft.date } : {}),
    ...(draft.guestsPlanned !== undefined ? { guestsPlanned: draft.guestsPlanned } : {}),
    ...(draft.style ? { style: draft.style } : {}),
    ...(draft.quizAnswers ? { quizAnswers: draft.quizAnswers } : {}),
  })
  const id = created?.id
  if (!id) throw new Error('сервер не вернул идентификатор свадьбы')
  return id
}

/**
 * Найти свою свадьбу, когда идентификатор на устройстве потерян.
 *
 * Берём первую, где роль `couple`: свадьба, которую человек ведёт, важнее
 * той, куда его позвали помощником. Если своей нет — первую из списка,
 * чтобы приглашённый координатор тоже попал внутрь.
 */
export async function findMyWedding(): Promise<string | null> {
  if (!isAuthorized()) return null
  const list = await api.get('/weddings')
  if (!list?.length) return null
  const own = list.find(w => w.role === 'couple')
  return (own ?? list[0])?.id ?? null
}
