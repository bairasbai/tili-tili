import { useApi } from './api/useApi'
import { listMyWeddings } from './api/wedding'
import { useStore } from './store'

/**
 * Пара ли я в текущей свадьбе — для кнопок, чей исход у помощника и
 * координатора только 403 (R-270): такую кнопку им не показывают вовсе.
 *
 * Роль — из `GET /weddings`, как у экранов «Команда» и «Гости» (D1-25).
 * `ask === false` — на экране таких кнопок нет, спрашивать незачем: запроса
 * нет, ответ `null`. `null` — роль не известна (едет или не пришла): кнопок
 * нет, как при чужой роли, — обещать право, которого не знаем, нельзя (RF-03).
 */
export function useIsCouple(ask: boolean): boolean | null {
  const { weddingId } = useStore()
  const q = useApi(() => (ask && weddingId ? listMyWeddings() : Promise.resolve(null)), [ask, weddingId])
  if (!q.data) return null
  return q.data.find(w => w.id === weddingId)?.role === 'couple'
}
