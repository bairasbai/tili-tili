import { api, url } from './client'
import type { components } from './schema'

/*
 * Чтение свадьбы: мозаика слотов, бюджет, чек-лист, гости, тайминг,
 * документы, план Б.
 *
 * Все пути ведут через `/weddings/{weddingId}/…`, и все они закрыты матрицей
 * доступа: помощник не увидит бюджет и документы, координатор — оплаты.
 * Поэтому 403 здесь не поломка, а штатный ответ, и экраны обязаны показывать
 * его словами «этот раздел ведёт пара», а не сообщением об ошибке.
 */

export const getSlots = (weddingId: string, options?: { assertCurrent?: () => void }) =>
  api.get(url('/weddings/{weddingId}/slots', { weddingId }), options)

export const getBudget = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/budget', { weddingId }))

export type HomeTipDecision = components['schemas']['HomeTipDecision']

/** Подсказки Тиля по правилам §3.14. Главная запрашивает также решения пары. */
export function getTips(weddingId: string, options?: { view?: 'home'; assertCurrent?: () => void }) {
  const path = url('/weddings/{weddingId}/tips', { weddingId })
  return api.get(options?.view === 'home' ? `${path}?view=home` as typeof path : path, options)
}

export const setHomeTipDecision = (weddingId: string, tipId: string, decision: HomeTipDecision, assertCurrent: () => void) =>
  api.put(url('/weddings/{weddingId}/tips/{tipId}/decision', { weddingId, tipId }), decision, { assertCurrent })

export const getWeddingWeek = (weddingId: string, assertCurrent: () => void) =>
  api.get(url('/weddings/{weddingId}/week', { weddingId }), { assertCurrent })

export function getTasks(weddingId: string, includeExcluded = false) {
  const path = url('/weddings/{weddingId}/tasks', { weddingId })
  return api.get(includeExcluded ? `${path}?includeExcluded=true` as typeof path : path)
}

export const getMembers = (weddingId: string, options?: { assertCurrent?: () => void }) =>
  api.get(url('/weddings/{weddingId}/members', { weddingId }), options)

export const getGuests = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/guests', { weddingId }))

export const getTimeline = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/timeline', { weddingId }))

export const getTimelineSnapshot = (weddingId: string) =>
  api.getSnapshot(url('/weddings/{weddingId}/timeline', { weddingId }))

export const getTimelineAcknowledgments = (weddingId: string) =>
  api.getSnapshot(url('/weddings/{weddingId}/timeline/acknowledgments', { weddingId }))

export const getWeddingEvents = (weddingId: string, options?: { assertCurrent?: () => void }) =>
  api.get(url('/weddings/{weddingId}/events', { weddingId }), options)

export const getWeddingEventsSnapshot = (weddingId: string, options?: { assertCurrent?: () => void }) =>
  api.getSnapshot(url('/weddings/{weddingId}/events', { weddingId }), options)

export const getDocuments = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/documents', { weddingId }))

export const getPlanB = (weddingId: string, options?: { assertCurrent?: () => void }) =>
  api.get(url('/weddings/{weddingId}/planb', { weddingId }), options)

export const getWedding = (weddingId: string, options?: { assertCurrent?: () => void }) =>
  api.get(url('/weddings/{weddingId}', { weddingId }), options)

export const getWeddingCompletion = (weddingId: string, options?: { assertCurrent?: () => void }) =>
  api.get(url('/weddings/{weddingId}/completion', { weddingId }), options)

/*
 * Логистика и меню.
 *
 * Автобусы и отельные блоки читаются паре здесь, гостю — по его токену
 * (`lib/api/guest.ts`). `taken` и `booked` считает сервер атомарно при записи
 * гостя: клиенту их взять больше неоткуда, и считать самому нельзя — два
 * человека жмут «записаться» одновременно.
 */
export const getBuses = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/logistics/buses', { weddingId }))

export const getHotels = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/logistics/hotels', { weddingId }))

export const getMenuPoll = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/menu-poll', { weddingId }))
