import { api, url } from './client'
import type { paths } from './schema'

/*
 * Заметки команды свадьбы (фича 014, блокер №7).
 *
 * До этого заметки жили в `localStorage` одного телефона, и экран честно
 * писал «хранятся только на этом устройстве». Настройка живёт там, где живёт
 * действие (R-173): идея про торт нужна обоим партнёрам — значит, хранится у
 * свадьбы. Читает и пишет вся команда; свежие первыми — так отдаёт сервер.
 */
export type Note = NonNullable<
  paths['/weddings/{weddingId}/notes']['get']['responses'][200]['content']['application/json']
>[number]

export const getNotes = (weddingId: string) => api.get(url('/weddings/{weddingId}/notes', { weddingId }))

export const createNote = (weddingId: string, text: string) =>
  api.post(url('/weddings/{weddingId}/notes', { weddingId }), { text })

export const deleteNote = (weddingId: string, noteId: string) =>
  api.delete(url('/weddings/{weddingId}/notes/{noteId}', { weddingId, noteId }))

/** Ключ прежнего хранилища заметок на устройстве — читается один раз, ради переноса. */
export const LEGACY_NOTES_KEY = 'tt_notes'

/**
 * Заметки прежней версии с этого устройства: только текст, остальное
 * (значок, плитка) было украшением экрана. Мусор в хранилище — пустой список.
 */
export function readLegacyNotes(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LEGACY_NOTES_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((n) => (n && typeof n === 'object' && typeof (n as { text?: unknown }).text === 'string' ? (n as { text: string }).text.trim() : ''))
      .filter((s) => s.length > 0)
  } catch {
    return []
  }
}
