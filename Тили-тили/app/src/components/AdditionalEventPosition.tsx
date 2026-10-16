import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, beginLocalSessionAction, isAuthorized, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { getCategories } from '@/lib/api/catalog'
import { createAdditionalSlot, type AdditionalSlotCreate, type AdditionalSlotDto } from '@/lib/api/orders'
import { explainError } from '@/lib/api/useApi'
import { listMyWeddings } from '@/lib/api/wedding'
import { getWeddingEvents } from '@/lib/api/weddingData'
import { t } from '@/lib/i18n'
import { useStore } from '@/lib/store'

type Sources = { categories: Awaited<ReturnType<typeof getCategories>>; events: Awaited<ReturnType<typeof getWeddingEvents>>; couple: boolean }
type Command = { body: AdditionalSlotCreate; key: string; dispatched: boolean; created?: AdditionalSlotDto }
class PositionReviewRequired extends Error {}
const control = 'w-full rounded-xl border border-[var(--line)] bg-[var(--card)] p-3 text-[13px] disabled:opacity-50'
const button = 'press rounded-full grad px-4 py-3 text-[12px] font-semibold text-[var(--on-grad)] disabled:opacity-50'

async function readSources(weddingId: string, assertCurrent: () => void): Promise<Sources> {
  const [weddings, categories, events] = await Promise.all([listMyWeddings({ assertCurrent }), getCategories(undefined, { assertCurrent }), getWeddingEvents(weddingId, { assertCurrent })])
  return { categories, events, couple: weddings.find(w => w.id === weddingId)?.role === 'couple' }
}

export function AdditionalEventPosition() {
  const { weddingId } = useStore()
  const [session, setSession] = useState(0)
  useEffect(() => {
    const reset = () => setSession(n => n + 1), changed = onSessionChanged(reset), expired = onSessionExpired(reset)
    return () => { changed(); expired() }
  }, [])
  return weddingId ? <PositionForm key={`${weddingId}:${session}`} weddingId={weddingId} /> : null
}

function PositionForm({ weddingId }: { weddingId: string }) {
  const { refreshSlots } = useStore(), nav = useNavigate()
  const [sources, setSources] = useState<Sources | null>(null)
  const [categoryId, setCategory] = useState(''), [programEventId, setEvent] = useState(''), [label, setLabel] = useState('')
  const [busy, setBusy] = useState(true), [message, setMessage] = useState<string | null>(null), [pending, setPending] = useState<Command | null>(null)
  const alive = useRef(false), generation = useRef(0), flight = useRef(false)
  const assertSelected = () => {
    // Device selection is only a privacy fence; server reads grant permission.
    if (!isAuthorized()) throw new ApiError('http', 401, 'unauthorized', t('Войдите, чтобы добавить позицию мероприятия'))
    if (JSON.parse(localStorage.getItem('tt_wedding_id') ?? 'null') !== weddingId) throw new Error('scope_changed')
  }
  useEffect(() => {
    alive.current = true
    const gen = ++generation.current, session = beginLocalSessionAction()
    const current = () => alive.current && generation.current === gen
    const check = () => { session.assertCurrent(); assertSelected(); if (!current()) throw new Error('scope_changed') }
    const invalidate = () => { generation.current++; setSources(null); setPending(null); setMessage(t('Аккаунт или свадьба изменились. Откройте команду заново.')) }
    const changed = onSessionChanged(invalidate), expired = onSessionExpired(invalidate)
    void (async () => {
      try {
        check()
        const next = await readSources(weddingId, check)
        check()
        if (current()) setSources(next)
      } catch (error) { if (current()) setMessage(explainError(error)) }
      finally { session.close(); if (current()) setBusy(false) }
    })()
    return () => { alive.current = false; generation.current = gen + 1; session.close(); changed(); expired() }
    // A new wedding/session mounts a separate reader; old replies never grant access.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId])

  const execute = async (command?: Command) => {
    if (flight.current) return
    const body = { categoryId, programEventId, label: label.trim() }
    if (!command && (!sources?.couple || !body.label || body.label.length > 200 || !sources.categories.some(c => c.id === body.categoryId) || !sources.events.some(e => e.id === body.programEventId))) return
    const attempt: Command = command ?? { body: Object.freeze(body), key: newIdempotencyKey(), dispatched: false }
    flight.current = true; setBusy(true); setMessage(null); setSources(null)
    const gen = generation.current, session = beginLocalSessionAction()
    const current = () => alive.current && generation.current === gen
    const check = () => { session.assertCurrent(); assertSelected(); if (!current()) throw new Error('scope_changed') }
    let posting = false
    try {
      check()
      const fresh = await readSources(weddingId, check)
      check(); setSources(fresh)
      if (!fresh.couple) throw new ApiError('http', 403, 'couple_required', t('Добавлять позиции мероприятия может только пара'))
      if (!attempt.created && (!fresh.categories.some(c => c.id === attempt.body.categoryId) || !fresh.events.some(e => e.id === attempt.body.programEventId))) throw new PositionReviewRequired(t('Категории или мероприятия изменились. Обновите форму.'))
      if (!attempt.created) {
        attempt.dispatched = true; posting = true; setPending(attempt)
        const result = await createAdditionalSlot(weddingId, attempt.body, attempt.key, { assertCurrent: check })
        posting = false; check()
        if (!result?.id || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(result.id) || result.categoryId !== attempt.body.categoryId || result.programEventId !== attempt.body.programEventId || result.label !== attempt.body.label) throw new Error(t('Результат создания пока не подтверждён'))
        attempt.created = result; setPending({ ...attempt })
      }
      const latest = await listMyWeddings({ assertCurrent: check })
      check()
      if (latest.find(w => w.id === weddingId)?.role !== 'couple') throw new ApiError('http', 403, 'couple_required', t('Добавлять позиции мероприятия может только пара'))
      refreshSlots(); check()
      nav(`/wedding/slot/${attempt.created!.id}`)
    } catch (error) {
      if (!current()) return
      try { check() } catch { setSources(null); setPending(null); return }
      const definite = posting && error instanceof ApiError && error.kind === 'http' && [400, 401, 403, 404, 409, 410, 422, 429].includes(error.status) && error.code !== 'idempotency_in_progress'
      if (!attempt.dispatched || definite) setPending(null)
      else setPending({ ...attempt })
      if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) setSources(null)
      setMessage(attempt.created ? t('Позиция создана. Обновите доступ и откройте её.') : attempt.dispatched && !definite ? t('Ответ не получен. Повторите тот же запрос, не меняя данные.') : error instanceof PositionReviewRequired ? error.message : explainError(error))
    } finally { session.close(); flight.current = false; if (current()) setBusy(false) }
  }
  const reload = async () => {
    if (flight.current || pending) return
    flight.current = true; setBusy(true); setSources(null); setMessage(null)
    const gen = generation.current, session = beginLocalSessionAction()
    const check = () => { session.assertCurrent(); assertSelected(); if (!alive.current || generation.current !== gen) throw new Error('scope_changed') }
    try { check(); const next = await readSources(weddingId, check); check(); setSources(next) }
    catch (error) { if (alive.current && generation.current === gen) setMessage(explainError(error)) }
    finally { session.close(); flight.current = false; if (alive.current && generation.current === gen) setBusy(false) }
  }
  const valid = sources?.couple && sources.categories.some(c => c.id === categoryId) && sources.events.some(e => e.id === programEventId) && label.trim().length > 0 && label.trim().length <= 200
  return <section aria-label={t('Позиция мероприятия')} className="card p-4 space-y-3">
    <h2 className="font-serif-d text-[19px]">{t('Добавить позицию мероприятия')}</h2>
    {busy && <p role="status" className="text-[12px] text-[var(--soft)]">{t('Проверяем доступ…')}</p>}
    {message && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{message}</p>}
    {sources && !sources.couple && <p role="status" className="text-[12px] text-[var(--soft)]">{t('Добавлять позиции мероприятия может только пара')}</p>}
    {sources?.couple && (!sources.categories.some(c => c.id) || !sources.events.length) && <p role="status" className="text-[12px] text-[var(--soft)]">{t('Для новой позиции нужны категория и мероприятие. Добавьте мероприятие в программу и обновите форму.')}</p>}
    {sources?.couple && <form className="space-y-3" onSubmit={e => { e.preventDefault(); void execute() }}>
      <label className="block text-[12px]">{t('Категория позиции')}<select className={control} aria-label={t('Категория позиции')} value={categoryId} disabled={busy || !!pending} onChange={e => setCategory(e.target.value)} required><option value="">{t('Выберите категорию')}</option>{sources.categories.filter(c => c.id).map(c => <option key={c.id} value={c.id}>{t(c.title ?? c.id!)}</option>)}</select></label>
      <label className="block text-[12px]">{t('Мероприятие позиции')}<select className={control} aria-label={t('Мероприятие позиции')} value={programEventId} disabled={busy || !!pending} onChange={e => setEvent(e.target.value)} required><option value="">{t('Выберите мероприятие')}</option>{sources.events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <label className="block text-[12px]">{t('Название позиции')}<input className={control} value={label} disabled={busy || !!pending} maxLength={200} required onChange={e => setLabel(e.target.value)} /></label>
      {!pending && <button className={button} disabled={busy || !valid}>{t('Создать позицию')}</button>}
    </form>}
    {pending && <button type="button" className={button} disabled={busy} onClick={() => void execute(pending)}>{pending.created ? t('Обновить доступ и открыть позицию') : t('Повторить тот же запрос')}</button>}
    {!pending && <button type="button" className="press text-[12px] underline text-[var(--soft)]" disabled={busy} onClick={() => void reload()}>{t('Обновить форму')}</button>}
  </section>
}
