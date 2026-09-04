import { api, url } from './client'

/*
 * Чтение свадьбы: мозаика слотов, бюджет, чек-лист, гости, тайминг,
 * документы, план Б.
 *
 * Все пути ведут через `/weddings/{weddingId}/…`, и все они закрыты матрицей
 * доступа: помощник не увидит бюджет и документы, координатор — оплаты.
 * Поэтому 403 здесь не поломка, а штатный ответ, и экраны обязаны показывать
 * его словами «этот раздел ведёт пара», а не сообщением об ошибке.
 */

export const getSlots = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/slots', { weddingId }))

export const getBudget = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/budget', { weddingId }))

export const getTasks = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/tasks', { weddingId }))

export const getGuests = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/guests', { weddingId }))

export const getTimeline = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/timeline', { weddingId }))

export const getDocuments = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/documents', { weddingId }))

export const getPlanB = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/planb', { weddingId }))

export const getWedding = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}', { weddingId }))
