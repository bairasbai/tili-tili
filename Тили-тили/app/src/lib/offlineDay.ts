import { safeGet, safeSet } from './usePersist'
import type { Slot } from './types'

/*
 * Офлайн-копия дня X (План §3.1, §12: «тайминг и контакты доступны без сети»).
 *
 * Сервисный воркер API нарочно не кэширует (`public/sw.js`, `sw.test.ts`):
 * ответы живут секунды, и cache-first отдавал бы вчерашние часы как сегодняшние.
 * Поэтому копия — одна, явная и только для этого экрана: последний ответ по
 * таймингу, плану Б и команде с меткой времени. Показывается лишь когда сервер
 * не ответил, и всегда с подписью «на HH:MM»: человек видит, чему верит.
 *
 * Это единственное личное содержимое свадьбы на устройстве (R-173 пропускает
 * только свойства устройства) — исключение ради дня, когда сеть на площадке
 * может пропасть. Живёт под одним ключом; выход (`forgetLocally`) и смерть
 * сессии (`SESSION_KEYS` стора) стирают его вместе с остальным.
 */
export const OFFLINE_DAY_KEY = 'tt_dayx_offline'

export interface OfflineDay {
  weddingId: string
  /** ISO-момент, когда копия снята с ответа сервера. */
  savedAt: string
  timeline: { id?: string; name?: string; startsAt?: string | null; location?: string | null }[]
  planBActivatedAt: string | null
  team: Pick<Slot, 'id' | 'label' | 'vendor' | 'vendorId' | 'phone'>[]
}

export function rememberDay(snapshot: OfflineDay): void {
  safeSet(OFFLINE_DAY_KEY, JSON.stringify(snapshot))
}

/** Копия этой свадьбы или ничего: чужая (после смены аккаунта без выхода) не годится. */
export function recallDay(weddingId: string | null): OfflineDay | null {
  if (!weddingId) return null
  try {
    const raw = safeGet(OFFLINE_DAY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<OfflineDay>
    if (parsed.weddingId !== weddingId || !Array.isArray(parsed.timeline) || typeof parsed.savedAt !== 'string') return null
    return {
      weddingId,
      savedAt: parsed.savedAt,
      timeline: parsed.timeline,
      planBActivatedAt: typeof parsed.planBActivatedAt === 'string' ? parsed.planBActivatedAt : null,
      team: Array.isArray(parsed.team) ? parsed.team : [],
    }
  } catch {
    return null
  }
}
