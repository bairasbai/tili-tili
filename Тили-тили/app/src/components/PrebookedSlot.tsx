import { createElement, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Slot } from '@/lib/types'
import { useStore } from '@/lib/store'
import { explainError } from '@/lib/api/useApi'
import { catIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/**
 * Слот «Уже забронировано вне приложения» (фича 018) — одна карточка на главную
 * и на мозаику «Наш день».
 *
 * Пара ответила в квизе, что подрядчик уже найден. Плитка не пустая и не бронь
 * из приложения, поэтому у неё два действия, и за каждым — запрос (R-176):
 * «Добавить подрядчика» ведёт в форму своего подрядчика этого слота (её кнопка
 * шлёт `POST …/external`, и бронь снимает отметку), «Нет, ещё ищем» шлёт
 * `DELETE …/prebooked`. Оба — только паре: у помощника и координатора их исход
 * один — 403 (R-270), им отметка показывается без кнопок. `canAct === null` —
 * роль ещё не известна: кнопок нет, пока не знаем, чьи они.
 */
export function PrebookedSlotCard({ slot, canAct, className }: { slot: Slot; canAct: boolean | null; className?: string }) {
  const nav = useNavigate()
  const { unmarkPrebooked } = useStore()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /* Пока запрос в пути, второго нет: двойной тап на медленной сети не должен
     слать два DELETE и рисовать ошибку под уже снятой отметкой. */
  const stillLooking = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try { await unmarkPrebooked(slot.id) } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  }

  return (
    <div data-testid="prebooked-slot" className={cn('card-s p-3.5 fade-up', className)}>
      <div className="flex items-center gap-3">
        <span className={cn('w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0', slot.tile)}>
          {createElement(catIcon(slot.categoryId), { size: 18, className: 'text-[var(--ink2)]' })}
        </span>
        <div className="flex-1 min-w-0">
          <b className="text-[13.5px] block truncate">{t(slot.label)}</b>
          <span className="text-[10.5px] text-[var(--soft)]">{t('Вне приложения — по вашему ответу в квизе')}</span>
        </div>
        <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] shrink-0">{t('Уже забронировано')}</span>
      </div>
      {canAct === true && (
        <div className="grid grid-cols-2 gap-2 mt-3">
          <button onClick={() => nav(`/wedding/slot/${slot.id}`, { state: { own: true } })} className="press card-s py-2.5 text-[12px] font-semibold">
            {t('Добавить подрядчика')}
          </button>
          <button disabled={busy} onClick={() => void stillLooking()} className="press card-s py-2.5 text-[12px] font-semibold text-[var(--rose-deep)] disabled:opacity-50">
            {busy ? t('Снимаем отметку…') : t('Нет, ещё ищем')}
          </button>
        </div>
      )}
      {canAct === false && <p className="text-[10.5px] text-[var(--soft)] mt-2">{t('Отметку ведёт пара')}</p>}
      {err && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-2">{err}</p>}
    </div>
  )
}
