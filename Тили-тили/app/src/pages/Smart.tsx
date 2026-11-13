import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ChevronLeft, CloudRain, Zap, Heart, RefreshCw } from 'lucide-react'

import { useStore } from '@/lib/store'
import { TopBar, AiTip, Bar } from '@/components/chrome'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { AsyncState, num, ready } from '@/components/AsyncState'
import { GuestThanks } from '@/components/GuestThanks'
import { AccountDataExport } from '@/components/AccountDataExport'
import { getGuests, getPlanB, getSlots, getTimelineSnapshot, getWedding, getWeddingCompletion, getWeddingEvents, getWeddingEventsSnapshot } from '@/lib/api/weddingData'
import { instant, programTime, programZone, timelineNow } from '@/lib/timelineClock'
import { getAlbum } from '@/lib/api/gifts'
import { getGuestReviews, sendCoupleReview } from '@/lib/api/reviews'
import { activatePlanB, previewPlanB, setPlanBGuestAddress, setTaskDone, type DayXBroadcast, type PlanBPreview, type PlanBScenario } from '@/lib/api/weddingWrite'
import { TimelineShiftControl } from '@/components/TimelineShift'
import { PlanBScenarioEditor } from '@/components/PlanBScenarioEditor'
import { PlanBPreviewDetails } from '@/components/PlanBPreviewDetails'
import { DayXCoordination } from '@/components/DayXCoordination'
import { recallDay, rememberDay } from '@/lib/offlineDay'
import { AUTH_CHANGED_EVENT, forgetOfflineDay, offlineGeneration, offlineScope, subscribeOfflineChanges, type OfflineScope } from '@/lib/offlineAccess'
import { safeGet } from '@/lib/usePersist'
import { formatWeddingDate } from '@/lib/weddingDate'
import { getCategories, getFavorites, getVendor } from '@/lib/api/catalog'
import { getShortlist, type ShortlistEntry } from '@/lib/api/shortlist'
import type { components } from '@/lib/api/schema'
import { accessTokenForWs, ApiError, isAuthorized, newIdempotencyKey, type ProgramEventPrecondition } from '@/lib/api/client'
import { cn, goBack, plural } from '@/lib/utils'
import { chatRouteForVendor, dayChatRoute, teamChatRoute, tillyChatRoute } from '@/lib/api/chats'
import { getI18nLang, t, key } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { OfferAcceptance } from '@/components/OfferAcceptance'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { listMyWeddings } from '@/lib/api/wedding'
import { OfferSummary } from '@/components/OfferSummary'
import { OfferAvailabilityObservation } from '@/components/OfferComparisonTerms'
import { OFFER_COMPARISON_FIELDS } from '@/lib/offerComparisonTerms'
import { readSeating } from '@/lib/useSeating'
import { slotEventContext, type ProgramEventMaterial } from '@/lib/slotEventContext'
import { useProgramOnline } from '@/lib/offlineProgramHooks'

const PLAN_B_SCENARIOS = new Map([
  ['rain', 'Дождь'],
  ['vendor_missing', 'Подрядчик не приехал'],
  ['power', 'Отключение электричества'],
  ['transport', 'Сбой транспорта'],
])
const isPlanBScenario = (value: string | null | undefined): value is PlanBScenario =>
  value != null && PLAN_B_SCENARIOS.has(value)

interface PlanBActivationProps {
  weddingId: string
  scenario: PlanBScenario
  disabled?: boolean
  active?: boolean
  onAccepted: (receipt: DayXBroadcast) => void
}

function PlanBActivation(props: PlanBActivationProps) {
  const origin = useLegacySessionKey(JSON.stringify([props.weddingId, props.scenario]))
  return <PlanBActivationAction key={origin} {...props} />
}

function PlanBActivationAction({ weddingId, scenario, disabled, active, onAccepted }: PlanBActivationProps) {
  const captureOrigin = useLegacyActionScope(scenario, weddingId)
  const inFlight = useRef(false)
  const selectionToReview = useRef<string[] | null>(null)
  const [draft, setDraft] = useState<{
    preview: PlanBPreview; key: string; selectedIds: string[] | null; attempted: boolean; urgent: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updated, setUpdated] = useState(false)

  const submit = async () => {
    if (inFlight.current || accepted || disabled || draft?.preview.alreadyActive || !navigator.onLine) return
    const origin = captureOrigin()
    const refreshPreview = async () => {
      const preview = await previewPlanB(weddingId, scenario, origin.assertCurrent)
      origin.assertCurrent()
      const previousSelection = selectionToReview.current
      const ids = preview.inAppRecipients.flatMap(recipient => recipient.id ?? [])
      const selectedIds = ids.length === preview.inAppRecipients.length
        ? ids.filter(id => previousSelection === null || previousSelection.includes(id)) : null
      setDraft({ preview, key: newIdempotencyKey(), selectedIds, attempted: false, urgent: false })
      selectionToReview.current = null
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    setUpdated(false)
    try {
      if (!draft) {
        await refreshPreview()
        return
      }
      try {
        setDraft({ ...draft, attempted: true })
        const result = await activatePlanB(weddingId, scenario, draft.preview.previewToken, draft.key,
          origin.assertCurrent, draft.selectedIds ?? undefined, draft.urgent ? draft.preview.urgentEvent?.id : undefined)
        origin.assertCurrent()
        setDraft(null)
        setAccepted(true)
        onAccepted(result)
      } catch (failure) {
        if (!(failure instanceof ApiError) || !['planb_preview_changed', 'planb_preview_expired'].includes(failure.code)) throw failure
        if (!origin.isCurrent()) return
        selectionToReview.current = draft.selectedIds
        setDraft(null)
        await refreshPreview()
        setUpdated(true)
      }
    } catch (failure) {
      if (origin.isCurrent()) {
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          selectionToReview.current = null
          setDraft(null)
        }
        setError(explainError(failure))
      }
    } finally {
      inFlight.current = false
      if (origin.isCurrent()) setBusy(false)
    }
  }

  const preview = draft?.preview
  const publication = preview?.guestPublication
  const changeGuestAddress = async (visible: boolean) => {
    if (!publication || inFlight.current || disabled || !navigator.onLine) return
    const origin = captureOrigin()
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await setPlanBGuestAddress(weddingId, publication.activationId, visible, origin.assertCurrent)
      origin.assertCurrent()
      setDraft(current => current && ({
        ...current, preview: { ...current.preview, guestPublication: { ...publication, published: result.published } },
      }))
    } catch (failure) {
      if (origin.isCurrent()) {
        if (failure instanceof ApiError && [401, 403, 404, 409].includes(failure.status)) setDraft(null)
        setError(explainError(failure))
      }
    } finally {
      inFlight.current = false
      if (origin.isCurrent()) setBusy(false)
    }
  }
  const current = preview?.currentScenario
  const alreadyActive = preview?.alreadyActive === true
  const actionClass = 'press min-h-10 rounded-full border border-[var(--line)] px-4 text-[12px] font-semibold disabled:opacity-50'
  return (
    <div className="mt-2 space-y-2">
      {updated && <p role="status" className="text-[12px]">{t('Предпросмотр обновлён. Проверьте список и подтвердите ещё раз.')}</p>}
      {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{error}</p>}
      {preview && draft && (
        <section aria-label={t('Предпросмотр Плана Б')} className="space-y-2 rounded-2xl border border-[var(--line)] p-3 text-[12px]">
          <p className="font-semibold">{t(alreadyActive ? 'Эта версия уже включена' : 'Сценарий к включению')} · {t(PLAN_B_SCENARIOS.get(preview.scenario) ?? 'План Б')}</p>
          {current && !alreadyActive && <p>{t('Текущий сценарий')} · {t(PLAN_B_SCENARIOS.get(current) ?? current)}</p>}
          <PlanBPreviewDetails preview={preview} selection={draft.selectedIds} urgent={draft.urgent} disabled={!!disabled || busy || draft.attempted}
            updateSelection={selectedIds => {
              if (!inFlight.current) setDraft(current => current && !current.attempted
                ? { ...current, selectedIds, urgent: selectedIds.length > 0 && current.urgent } : current)
            }}
            updateUrgent={urgent => {
              if (!inFlight.current) setDraft(current => current && !current.attempted ? { ...current, urgent } : current)
            }} />
          {publication && (publication.published || publication.canPublish) && (
            <div className="space-y-1 border-t border-[var(--line)] pt-2">
              <p role="status">{t(publication.published ? 'Адрес открыт подтвердившим гостям основного дня.'
                : 'Адрес пока скрыт в приглашениях.')}</p>
              <button type="button" disabled={disabled || busy} className={actionClass}
                onClick={() => void changeGuestAddress(!publication.published)}>
                {t(publication.published ? 'Скрыть адрес в приглашениях' : 'Показать адрес подтвердившим гостям')}
              </button>
            </div>
          )}
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        {!alreadyActive && <button type="button" disabled={disabled || busy || accepted} onClick={() => void submit()} className={actionClass}>
          {busy ? t(preview ? 'Включаем…' : 'Загружаем…')
            : t(preview ? draft?.selectedIds?.length === 0 ? 'Включить без уведомлений' : 'Подтвердить'
              : active ? 'Проверить версию сценария' : 'Предпросмотр Плана Б')}
        </button>}
        {preview && <button type="button" disabled={busy} className={actionClass}
          onClick={() => { setDraft(null); setError(null); setUpdated(false) }}>{t(alreadyActive ? 'Закрыть' : 'Отмена')}</button>}
      </div>
    </div>
  )
}

function PlanBDelivery({ summary }: { summary: components['schemas']['PlanBDeliverySummary'] | null }) {
  if (!summary) return <p className="mt-2 text-[11px] text-[var(--soft)]">{t('История отправки недоступна')}</p>
  const counts = [
    ['Затронуто гостей', summary.guestsAffected],
    ['Уведомления в приложении', summary.inApp],
    ['Ожидают Web Push', summary.queued],
    ['Принял push-сервис', summary.providerAccepted],
    ['Только в приложении', summary.inboxOnly],
    ['Нет подтверждения от push-сервиса', summary.unconfirmed],
    ['Доставку подтвердили', summary.confirmedDelivered ?? t('Нет подтверждения')],
    ['Отметили прочитанным', summary.read],
  ] as const
  return (
    <div className="mt-3 border-t border-[var(--line)] pt-3">
      {summary.pushChannel && summary.pushChannel !== 'configured' && <p role="status" className="mb-2 text-[11.5px]">
        {t(summary.pushChannel === 'invalid_configuration'
          ? 'Настройки Web Push требуют исправления. Уведомления доступны в приложении.'
          : 'Web Push не подключён. Уведомления доступны в приложении.')}
      </p>}
      <dl className="space-y-1 text-[11.5px]">
        {counts.map(([label, count]) => count !== undefined && (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-[var(--soft)]">{t(label)}</dt>
            <dd className="tabular-nums font-semibold">{count}</dd>
          </div>
        ))}
      </dl>
      {summary.guestsAffected > 0 && <p className="mt-2 text-[11.5px]">{t('Гостям сообщите сами')}</p>}
    </div>
  )
}

/*
 * ИИ-координатор «Тиль».
 *
 * Экран был имитацией разговора. Переписка лежала в `tt_assistant`, «Тиль»
 * отвечала тремя ветками `if` по подстрокам: на «алкогол» — норма спиртного
 * на 80 гостей, на «забыл» — «Проверил проект: пустые слоты — DJ, декоратор,
 * транспорт, платье, кольца. Ближайший дедлайн — приглашения до 1 марта»,
 * на всё остальное — «Принято! Записал в план». Ни проекта, ни слотов, ни
 * дедлайнов она не читала: числа были написаны в коде. В шапке стояло
 * «42/50 сообщений сегодня» — счётчика не существовало. Точки «печатает…»
 * шли по таймеру на 900 мс.
 *
 * Разговор с Тиль — обычный чат свадьбы (`kind: tilly`), он заводится вместе
 * со свадьбой. Модели за ним пока нет, и сервер отвечает честно: вопрос
 * сохранён, ответ придёт, когда помощник заработает. Это и есть правда, а
 * выдуманный совет про 0,5 л игристого на человека пара приняла бы за расчёт
 * по своей свадьбе.
 *
 * Экран остаётся адресом `/assistant`: на него ведут подсказка на главной,
 * пустой поиск и уведомления. Он открывает настоящую переписку.
 */
export function Assistant() {
  const nav = useNavigate()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void tillyChatRoute()
      .then(route => { if (alive) nav(route, { replace: true }) })
      .catch(e => { if (alive) setErr(explainError(e)) })
    return () => { alive = false }
  }, [nav])

  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => goBack(x => nav(x), (to, o) => nav(to, o))} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}><ChevronLeft size={17} /></button>
        <div className="w-[38px] h-[38px] rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[15px]">✦</div>
        <div className="flex-1"><b className="text-[14px]">{t('Тиль')}</b></div>
      </div>
      <div className="flex-1 flex items-center justify-center px-8 text-center">
        {err
          ? <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed">{err}</p>
          : <p className="text-[12px] text-[var(--soft)]">{t('Открываем переписку…')}</p>}
      </div>
    </div>
  )
}

/* Выбор — лишь адресная подсказка. Данные и порядок принадлежат шорт-листу
   свадьбы: URL не даёт доступа к чужой записи и не подменяет ответ сервера. */
type CompareVendor = NonNullable<ShortlistEntry['vendor']> | components['schemas']['VendorDetail']
type CompareItem = {
  id: string
  vendor: CompareVendor | null
  available: boolean | null
  occupancy: ShortlistEntry['occupancy']
  availabilityObservation?: ShortlistEntry['availabilityObservation']
  request?: ShortlistEntry['request']
}

function CompareTable({ items, icons, weddingDate, weddingTz, acceptance, slotId, eventContextKey, programEventContext, currentProgramEvent, contextKnown = true, acquisitionReady = true, timeZoneKnown = true, eventContextExplicit = false }: {
  items: CompareItem[]; icons: Record<string, string>; weddingDate?: string | null; weddingTz?: string | null
  slotId?: string; eventContextKey?: string; contextKnown?: boolean
  acquisitionReady?: boolean; timeZoneKnown?: boolean
  eventContextExplicit?: boolean
  programEventContext?: ProgramEventPrecondition
  currentProgramEvent?: ProgramEventMaterial | null
  acceptance?: { weddingId: string; canAccept: boolean; onChanged: () => void }
}) {
  const nav = useNavigate()
  const quote = (item: CompareItem) => item.request && 'id' in item.request && item.request.offer?.kind === 'offer' ? item.request.offer : undefined
  const showsQuotedConditions = items.some(item => quote(item)?.comparisonTerms !== undefined)
  const rows: [string, (item: CompareItem) => ReactNode][] = [
    [t('Цена «от»'), ({ vendor }) => vendor?.priceFrom?.amount != null ? fmt(vendor.priceFrom.amount) : '—'],
    [t('Рейтинг'), ({ vendor }) => vendor?.rating != null ? `★ ${vendor.rating}` : '—'],
    [t('Отзывы'), ({ vendor }) => vendor?.reviewsCount != null
      ? `${vendor.reviewsCount} ${plural(vendor.reviewsCount, t('отзыв'), t('отзыва'), t('отзывов'))}` : '—'],
    [t('Свободен на вашу дату'), ({ occupancy, vendor, availabilityObservation }) => !contextKnown || (eventContextExplicit && availabilityObservation?.date !== weddingDate) || vendor?.bookingMode !== 'legacy_day' ? '—' : occupancy === 'free' ? t('Свободен')
      : occupancy === 'held' ? t('Идут переговоры с другой парой')
      : occupancy === 'busy' ? t('Занят на вашу дату') : '—'],
    [t('Актуальность доступности'), item => <OfferAvailabilityObservation observation={item.availabilityObservation} />],
    [t('Пакеты и цены'), ({ vendor }) => vendor?.packages?.length ? (
      <div className="space-y-2 text-left">
        {vendor.packages.map((p, index) => <div key={p.id ?? `${index}-${p.name}`} className="rounded-lg bg-[var(--bg)] p-2">
          <b className="block">{p.name}</b>
          <span className="block tabular">{p.price?.amount != null ? fmt(p.price.amount) : t('цена не названа')}</span>
          {p.includes.length ? <ul className="mt-1 list-disc pl-4 font-normal">{p.includes.map((part, index) => <li key={`${index}-${part}`}>{part}</li>)}</ul> : <span className="block font-normal">—</span>}
        </div>)}
      </div>
    ) : '—'],
    [t('Предложение'), item => <>
      <OfferSummary request={item.request} currentWeddingDate={weddingDate} weddingTz={weddingTz} timeZoneKnown={timeZoneKnown} compact showComparisonTerms={false} />
      {acceptance && <OfferAcceptance
        key={`${acceptance.weddingId}:${item.request && 'id' in item.request ? item.request.offer?.id ?? item.request.id : item.id}`}
        weddingId={acceptance.weddingId} request={item.request} currentWeddingDate={weddingDate ?? null} weddingTz={weddingTz}
        eventContextKey={eventContextKey} programEventContext={programEventContext} currentProgramEvent={currentProgramEvent} canAccept={acquisitionReady && acceptance.canAccept && item.available === true && item.occupancy !== 'busy'}
        onChanged={acceptance.onChanged}
      />}
    </>],
    ...(showsQuotedConditions ? [
      [t('Состав услуги в предложении'), (item: CompareItem) => {
        const offer = quote(item)
        return offer?.comparisonTerms !== undefined ? <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{offer.includes.length ? offer.includes.join('\n') : t('Неизвестно')}</span> : '—'
      }],
      ...OFFER_COMPARISON_FIELDS.map(({ name, label }): [string, (item: CompareItem) => ReactNode] => [t(label), item => {
        const terms = quote(item)?.comparisonTerms
        return terms !== undefined ? <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{terms?.[name] ?? t('Неизвестно')}</span> : '—'
      }]),
    ] as [string, (item: CompareItem) => ReactNode][] : []),
    [t('Видео-визитка'), ({ vendor }) => vendor?.hasVideo ? t('▶ Есть') : '—'],
    [t('Проверен'), ({ vendor }) => vendor?.verified ? t('✓ Да') : '—'],
  ]

  return <div className="px-5 mt-3 overflow-x-auto no-scrollbar">
    <table className="w-full min-w-[520px]">
      <thead><tr>
        <th scope="col" className="w-[110px]" />
        {items.map(item => <th scope="col" key={item.id} className="p-1.5 align-top font-normal">
          <div className="card-s p-3 text-center">
            <span className="text-[24px]" aria-hidden="true">{icons[item.vendor?.categoryId ?? ''] ?? '📋'}</span>
            <b className="font-serif-d text-[13px] block mt-1.5 leading-tight">{item.vendor?.name ?? t('Анкета недоступна')}</b>
            {item.available === false && <span className="block mt-1 text-[10px] text-[var(--soft)]">{t('Анкета недоступна или сменила категорию')}</span>}
          </div>
        </th>)}
      </tr></thead>
      <tbody>
        {rows.map(([label, render]) => <tr key={label}>
          <th scope="row" className="p-1.5 text-[11px] text-[var(--soft)] font-medium text-left">{label}</th>
          {items.map(item => <td key={item.id} className="p-1.5 align-top"><div className="bg-[var(--card)] rounded-xl px-2.5 py-2.5 text-[11.5px] text-center font-medium" style={{ boxShadow: 'var(--shadow)' }}>{render(item)}</div></td>)}
        </tr>)}
        <tr><th scope="row" />{items.map(item => <td key={item.id} className="p-1.5">
          {item.vendor && item.available === true && <button onClick={() => nav(`/vendor/${item.vendor!.id}${slotId ? `?${new URLSearchParams({ slotId })}` : ''}`)} className="press w-full h-[40px] rounded-full text-[11px] font-bold grad text-[var(--on-grad)]">{t('Открыть анкету')}</button>}
        </td>)}</tr>
      </tbody>
    </table>
  </div>
}

export function Compare() {
  const { weddingId, weddingDate, slots } = useStore()
  const [params] = useSearchParams()
  const slot = slots.find(s => s.id === params.get('slot'))
  const scopeKey = useLegacySessionKey(JSON.stringify([weddingId, weddingDate, params.toString(), slot?.programEvent]))
  return <CompareView key={scopeKey} />
}
function CompareView() {
  const nav = useNavigate()
  const { weddingId, weddingDate, weddingsState, slots, slotsState, refreshSlots } = useStore()
  const [params] = useSearchParams()
  const hasSlot = params.has('slot')
  const slotId = params.get('slot') ?? ''
  const catId = params.get('cat')
  const slot = slotsState === 'ready' ? slots.find(s => s.id === slotId) : undefined
  const requested = [...new Set((params.get('entries') ?? '').split(',').filter(Boolean))].slice(0, 3)
  const requestedKey = requested.join(',')
  const capture = useLegacyActionScope(JSON.stringify([hasSlot, weddingId, weddingDate, slotId, requestedKey, slot?.dealId, slot?.programEvent]), hasSlot ? weddingId : undefined)
  const currentSlot = useRef(slot)
  useLayoutEffect(() => { currentSlot.current = slot }, [slot])
  const shortlist = useApi(
    () => hasSlot && weddingId && slot ? getShortlist(weddingId, slotId, { assertCurrent: capture().assertCurrent }) : Promise.resolve([] as ShortlistEntry[]),
    [hasSlot, weddingId, slotId, slot?.id, capture],
  )
  const needsMain7 = ready(shortlist) && !shortlist.refreshing && (shortlist.data ?? []).some(entry =>
    entry.request && 'id' in entry.request && entry.request.programEvent != null)
  const mainEvents = useApi(() => {
    if (!hasSlot || !weddingId || !slot || slot.programEvent !== undefined || !needsMain7) return Promise.resolve(null)
    const owner = capture()
    return getWeddingEvents(weddingId, { assertCurrent: () => {
      owner.assertCurrent()
      if (currentSlot.current !== slot) throw new Error('Main comparison read source changed')
    } })
  }, [hasSlot, weddingId, slot, capture, needsMain7, shortlist.data])
  const mains = ready(mainEvents) && !mainEvents.refreshing ? mainEvents.data?.filter(event => event.isMain) : undefined
  const currentProgramEvent = slot?.programEvent === undefined ? mains?.length === 1 ? mains[0] : undefined : slot.programEvent
  /* Смена категории не переносит невидимые галочки в новый выбор. */
  const [choice, setChoice] = useState<{ category: string | null; ids: string[] }>({ category: catId, ids: [] })
  const chosen = choice.category === catId ? choice.ids : []

  const roles = useApi(() => hasSlot ? listMyWeddings({ assertCurrent: capture().assertCurrent }) : Promise.resolve([]), [hasSlot, weddingId, capture])
  const currentWedding = roles.data?.find(w => w.id === weddingId)
  const eventContext = slotEventContext(slot, weddingDate, currentWedding?.tz)
  const cats = useApi(() => getCategories(), [])
  const favs = useApi(
    () => hasSlot ? Promise.resolve([]) : getFavorites(),
    [hasSlot],
  )
  const visibleFavorites = (favs.data ?? []).filter(v => !!v.id && (!catId || v.categoryId === catId))
  const selectedIds = visibleFavorites.filter(v => chosen.includes(v.id ?? '')).map(v => v.id!).slice(0, 3)
  const selectionKey = selectedIds.join(',')
  const details = useApi(
    () => !hasSlot && selectedIds.length >= 2
      ? Promise.all(selectedIds.map(id => getVendor(id)))
      : Promise.resolve([] as components['schemas']['VendorDetail'][]),
    [hasSlot, selectionKey],
  )
  const icons = Object.fromEntries((cats.data ?? []).map(c => [c.id, c.icon ?? '📋']))
  const categoryTitle = (cats.data ?? []).find(c => c.id === (slot?.categoryId ?? catId))?.title
  const slotEntries = (shortlist.data ?? [])
    .filter(entry => requested.includes(entry.id) && entry.slotId === slotId)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const slotItems: CompareItem[] = slotEntries.map(entry => ({ id: entry.id, vendor: entry.vendor, available: entry.available, occupancy: entry.occupancy, availabilityObservation: entry.availabilityObservation, request: entry.request }))
  const favoriteItems: CompareItem[] = (details.data ?? []).filter(v => selectedIds.includes(v.id ?? '')).map(v => ({ id: v.id!, vendor: v, available: true, occupancy: null }))
  const slotCurrent = ready(shortlist) && !shortlist.refreshing
  const detailsCurrent = ready(details) && !details.refreshing

  return <div className="pb-28">
    <TopBar back title={t('Сравнение')} sub={hasSlot ? slot?.label ?? categoryTitle : categoryTitle ?? t('Избранное')} />
    {hasSlot ? (
      !isAuthorized() || !weddingId ? <div className="px-5 mt-6 text-center">
        <p className="text-[12px] text-[var(--soft)]">{!isAuthorized() ? t('Войдите, чтобы увидеть свою свадьбу') : weddingsState === 'error' ? t('Сервер недоступен. Попробуйте позже') : weddingsState === 'ready' ? t('Свадьбы пока нет') : t('Загружаем…')}</p>
        {(!isAuthorized() || weddingsState === 'ready') && <button onClick={() => nav(isAuthorized() ? '/quiz' : '/auth')} className="press mt-4 px-5 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12.5px] font-semibold">{isAuthorized() ? t('Завести свадьбу') : t('Войти')}</button>}
      </div>
        : slotsState !== 'ready' ? <p className="px-5 mt-6 text-[12px] text-[var(--soft)]">{slotsState === 'error' ? t('Сервер недоступен. Попробуйте позже') : t('Загружаем…')}</p>
          : !slot ? <p role="alert" className="px-5 mt-6 text-[12px] text-[var(--soft)]">{t('Слот не найден')}</p>
            : <>
              <AsyncState q={shortlist} />
              {shortlist.refreshing && <p className="px-5 py-6 text-center text-[12px] text-[var(--soft)]">{t('Загружаем…')}</p>}
              {slotCurrent && (requested.length < 2 || slotItems.length < 2 || slotItems.length !== requested.length) && <div className="px-5 mt-8 text-center">
                <p className="text-[12.5px] text-[var(--soft)]">{requestedKey ? t('Выбранные кандидаты изменились — отметьте их снова на месте в команде') : t('Отметьте двух или трёх кандидатов на месте в команде')}</p>
                <button onClick={() => nav(`/wedding/slot/${slotId}`)} className="press mt-4 px-5 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12.5px] font-semibold">{t('Открыть место в команде')}</button>
              </div>}
              {slotCurrent && eventContext.undatedAdditional && <p className="mx-5 mt-3 text-[11px] text-[var(--soft)]">{t('Дата ещё не выбрана. Занятость на конкретный день не подтверждена. Первую дату нужно согласовать с исполнителем.')}</p>}
              {slotCurrent && slotItems.length >= 2 && slotItems.length === requested.length && <CompareTable items={slotItems} icons={icons} weddingDate={eventContext.date} weddingTz={eventContext.timeZone} eventContextKey={eventContext.key} programEventContext={eventContext.precondition} currentProgramEvent={currentProgramEvent} contextKnown={eventContext.known} acquisitionReady={eventContext.acquisitionReady} timeZoneKnown={eventContext.timeZoneKnown} eventContextExplicit={eventContext.explicit} slotId={slotId}
                acceptance={weddingId ? { weddingId,
                  canAccept: ready(roles) && !roles.refreshing && currentWedding?.role === 'couple' && !slot?.dealId,
                  onChanged: () => { mainEvents.reload(); shortlist.reload(); refreshSlots() },
                } : undefined} />}
            </>
    ) : <>
      <AsyncState q={favs} />
      {ready(favs) && <div className="px-5 mt-4">
        <p className="text-[12px] text-[var(--soft)]">{t('Выберите двух или трёх подрядчиков из избранного')}</p>
        {visibleFavorites.length ? <div className="mt-3 space-y-2">
          {visibleFavorites.map(v => {
            const checked = chosen.includes(v.id ?? '')
            return <label key={v.id} className="card-s flex items-center gap-3 p-3 text-[12px] cursor-pointer">
              <input type="checkbox" checked={checked} disabled={!checked && selectedIds.length >= 3} onChange={() => setChoice(old => {
                const ids = old.category === catId ? old.ids : []
                return { category: catId, ids: checked ? ids.filter(id => id !== v.id) : [...ids, v.id!] }
              })} className="h-4 w-4 accent-[var(--rose)]" />
              <span>{v.name ?? '—'}</span>
            </label>
          })}
        </div> : <div className="mt-5 text-center">
          <p className="text-[12px] text-[var(--soft)]">{catId ? t('В этой категории пока некого сравнивать') : t('Добавьте подрядчиков в избранное — здесь они встанут рядом')}</p>
          <button onClick={() => nav(catId ? `/search/${encodeURIComponent(catId)}` : '/search')} className="press mt-4 px-5 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12.5px] font-semibold">{t('Открыть каталог')}</button>
        </div>}
      </div>}
      {ready(favs) && selectedIds.length >= 2 && <>
        <AsyncState q={details} />
        {details.refreshing && <p className="px-5 py-6 text-center text-[12px] text-[var(--soft)]">{t('Загружаем…')}</p>}
        {detailsCurrent && favoriteItems.length === selectedIds.length && <CompareTable items={favoriteItems} icons={icons} />}
        {detailsCurrent && favoriteItems.length !== selectedIds.length && <p role="alert" className="px-5 mt-5 text-[12px] text-[var(--soft)]">{t('Анкета недоступна')}</p>}
      </>}
    </>}
  </div>
}

/*
 * День X — тёмный режим пары в день свадьбы.
 *
 * Экран был выдуман целиком: «14 июня · День X» в заголовке, «СЕЙЧАС ·
 * Фотосессия · до 16:30 · парк у усадьбы», тайминг из `lib/data.ts`, четыре
 * подрядчика со статусами «на месте» и «едет · 20 мин» и четыре телефона
 * `+7 000 000-00-00`. Кнопка «+15 мин задержка» копила число в `tt_dayx`
 * браузера, а «План Б» переключал там же тумблер: у пары всё менялось, а
 * команда об этом не узнавала.
 *
 * Тайминг приходит с сервера; сдвиг выбранной области требует preview и
 * versioned confirm. Уведомления записываются руководителям и затронутым
 * участникам/подрядчикам; гостям доставки нет. План Б — в `POST …/planb/activate`.
 * Статусов подрядчиков («едет», «на месте») в контракте нет вовсе, и
 * рисовать их нельзя: пара приняла бы выдумку за факт в день, когда цена
 * ошибки максимальна.
 *
 * Палитра — тёмная в любой теме, как велит план (§10.2: «режим дня X —
 * тёмный, строго производная»). Токены для этого не выдумываются заново:
 * корень экрана несёт `data-theme="dark"`, и внутри действуют те же
 * переменные темы, что и у всего приложения в тёмном режиме. Раньше десяток
 * цветов стоял в JSX буквами (ревью D4-22, R-01).
 */
const daySessionKey = () => JSON.stringify(offlineScope(accessTokenForWs()))
function subscribeDaySession(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === null || event.key === 'tt_auth') listener() }
  window.addEventListener(AUTH_CHANGED_EVENT, listener)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(AUTH_CHANGED_EVENT, listener); window.removeEventListener('storage', storage) }
}

export function DayX() {
  const { weddingId } = useStore()
  const sessionKey = useSyncExternalStore(subscribeDaySession, daySessionKey)
  const scope = useMemo(() => JSON.parse(sessionKey) as OfflineScope | null, [sessionKey])
  useLayoutEffect(() => {
    if (safeGet('tt_dayx_offline') && !recallDay(weddingId, scope)) forgetOfflineDay()
  }, [weddingId, scope])
  return <DayXContent key={`${sessionKey}:${weddingId}`} scope={scope} />
}

async function readDaySnapshot<T>(fetcher: () => Promise<T>): Promise<{ snapshot: T; generation: number }> {
  const generation = offlineGeneration()
  return { snapshot: await fetcher(), generation }
}

function DayXContent({ scope }: { scope: OfflineScope | null }) {
  const nav = useNavigate()
  const { weddingId } = useStore()
  /* Отказ открыть чат — под той кнопкой, которую нажали: экран длинный, и
     строка у верхней карточки для нижней кнопки не видна (RF-04). */
  const [chatErr, setChatErr] = useState<{ at: 'day' | 'crew' | 'team'; text: string } | null>(null)
  /* Какая из кнопок чата ждёт адрес: своя переменная, чтобы не перебивать
     «Двигаем…» у сдвига тайминга. */
  const [chatBusy, setChatBusy] = useState<string | null>(null)
  // Время снимаем один раз за отрисовку: в теле компонента его брать нельзя (R-04).
  const [now, setNow] = useState(() => new Date())
  const [online, setOnline] = useState(() => navigator.onLine)
  const [connectionLost, setConnectionLost] = useState(() => !navigator.onLine)
  const generation = useSyncExternalStore(subscribeOfflineChanges, offlineGeneration)

  // Check live connectivity at each read/retry; online events already reload these same queries.
  const w = useApi(() => weddingId ? navigator.onLine ? getWedding(weddingId) : Promise.resolve(null) : noWedding(), [weddingId])
  const timelineRead = useApi(() => weddingId ? navigator.onLine ? readDaySnapshot(() => getTimelineSnapshot(weddingId)) : Promise.resolve(null) : noWedding(), [weddingId])
  const contextRead = useApi(() => weddingId ? navigator.onLine ? readDaySnapshot(() => getWeddingEventsSnapshot(weddingId)) : Promise.resolve(null) : noWedding(), [weddingId])
  const crewRead = useApi(() => weddingId ? navigator.onLine ? readDaySnapshot(() => getSlots(weddingId)) : Promise.resolve(null) : noWedding(), [weddingId])
  const q = { ...timelineRead, data: timelineRead.data?.snapshot ?? null }
  const contexts = { ...contextRead, data: contextRead.data?.snapshot ?? null }
  /* План Б спрашиваем и здесь. Без этого день X предлагал «Активировать» уже
     включённый сценарий, а экран «План Б» рядом писал «активирован»: два
     экрана отвечали на один вопрос по-разному, и второе нажатие разослало бы
     команде и гостям повторную рассылку. */
  const pb = useApi(() => weddingId ? navigator.onLine ? getPlanB(weddingId) : Promise.resolve(null) : noWedding(), [weddingId])
  const sameContextVersion = !!q.data?.etag && q.data.etag === contexts.data?.etag
  const states = [w, q, contexts, pb, crewRead]
  const cacheDenied = states.some(state => state.failure && !state.failure.isDown)
  const accessDenied = [w, q].some(state => state.failure && !state.failure.isDown)
  const unavailable = states.some(state => state.failure?.isDown)
  const offlineMode = !online || connectionLost || unavailable
  const role = w.data?.members?.find(member => member.user?.id === scope?.userId)?.role
  const canPrepareSeating = ready(w) && !w.refreshing && !!role && role !== 'vendor'
  useEffect(() => {
    if (!weddingId || !scope || !online || !canPrepareSeating) return
    // Optional offline preparation; refusals clean the copy in the shared API client.
    let active = true
    void readSeating(weddingId, scope, () => active).catch(() => undefined)
    return () => { active = false }
  }, [weddingId, scope, online, canPrepareSeating])
  const candidate = recallDay(weddingId, scope)
  const cachedRole = candidate?.role
  const snapshot = candidate && (!w.data || candidate.role === role) ? candidate : null
  const offline = offlineMode && !cacheDenied ? snapshot : null
  const events = offlineMode ? offline?.timeline ?? [] : accessDenied ? [] : q.data?.data ?? []
  const planBOn = offlineMode ? !!offline?.planBActivatedAt : !accessDenied && !!pb.data?.activatedAt
  const reloadTimeline = q.reload
  const reloadPlanB = pb.reload
  const reloadContexts = contexts.reload
  const reloadWedding = w.reload
  const reloadCrew = crewRead.reload

  useEffect(() => {
    const off = () => { setOnline(false); setConnectionLost(true) }
    const on = () => { setOnline(true); reloadTimeline(); reloadPlanB(); reloadContexts(); reloadWedding(); reloadCrew() }
    window.addEventListener('offline', off); window.addEventListener('online', on)
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on) }
  }, [reloadTimeline, reloadPlanB, reloadContexts, reloadWedding, reloadCrew])
  const revalidated = ready(w) && ready(q) && ready(contexts) && ready(pb) && ready(crewRead)
    && !w.refreshing && !q.refreshing && !contexts.refreshing && !pb.refreshing && !crewRead.refreshing && sameContextVersion
  useEffect(() => {
    if (unavailable) setConnectionLost(true)
    else if (online && revalidated) setConnectionLost(false)
  }, [online, unavailable, revalidated])
  useEffect(() => {
    if (cachedRole && w.data && cachedRole !== role) {
      forgetOfflineDay(weddingId ?? undefined)
      reloadTimeline(); reloadContexts(); reloadCrew()
    }
  }, [cachedRole, w.data, role, weddingId, reloadTimeline, reloadContexts, reloadCrew])
  useEffect(() => {
    if (online && revalidated && !cacheDenied && timelineRead.data && timelineRead.data.generation !== generation) {
      reloadTimeline(); reloadContexts(); reloadCrew()
    }
  }, [online, revalidated, cacheDenied, timelineRead.data, generation, reloadTimeline, reloadContexts, reloadCrew])

  /*
   * Экран живёт весь день открытым у координатора. Раньше «сейчас» снималось
   * один раз при монтировании, а тайминг перечитывался только после своих
   * действий: блок «СЕЙЧАС» оставался тем, что был при открытии, и сдвиг
   * «+15 мин», сделанный парой с другого телефона, сюда не доходил (ревью
   * D4-13, R-171). Раз в минуту — часы вперёд и тайминг с планом Б заново.
   *
   * Заново — через `reload()`, а не счётчиком в зависимостях запроса (RF-02):
   * смена зависимостей для `useApi` — «другой запрос», данные стираются до
   * ответа, и раз в минуту карточка «СЕЙЧАС» превращалась в «Загружаем…»,
   * «+15 мин» выключалась, а вместо бейджа «Включён» появлялась «Активировать».
   */
  useEffect(() => {
    const id = setInterval(() => { setNow(new Date()); if (online) { reloadTimeline(); reloadPlanB(); reloadContexts(); reloadWedding(); reloadCrew() } }, 60_000)
    return () => clearInterval(id)
  }, [online, reloadTimeline, reloadPlanB, reloadContexts, reloadWedding, reloadCrew])

  const clock = timelineNow<(typeof events)[number]>(events, now)
  const current = offlineMode ? [] : clock.active
  const next = offlineMode ? undefined : clock.next

  const liveTeam = useMemo(() => (crewRead.data?.snapshot ?? [])
    .filter(s => s.deal && ['booked', 'paid_deposit', 'done'].includes(s.deal.state ?? ''))
    .map(s => ({ id: s.id ?? '', label: s.label ?? '', vendor: s.deal?.vendor?.name ?? s.deal?.externalName ?? undefined,
      vendorId: s.deal?.vendor?.id, phone: s.deal?.externalPhone ?? undefined })), [crewRead.data])
  const team = offlineMode ? offline?.team ?? [] : accessDenied ? [] : liveTeam
  // Timeline and event context must share a version; other fields are captured observed state.
  useEffect(() => {
    if (!weddingId || !scope || !role || role === 'vendor' || !online || connectionLost || !revalidated
      || !q.data?.etag || !w.data || !contexts.data || !pb.data
      || timelineRead.data?.generation !== generation || contextRead.data?.generation !== generation || crewRead.data?.generation !== generation) return
    rememberDay({
      schema: 2, scope, role, weddingId, etag: q.data.etag,
      savedAt: new Date(Date.now()).toISOString(),
      weddingDate: w.data.date ?? null, weddingTimeZone: w.data.tz ?? null,
      timeline: q.data.data.map(b => ({ id: b.id ?? '', name: b.name, startsAt: b.startsAt ?? null, endsAt: b.endsAt ?? null, eventId: b.eventId ?? null, location: b.location ?? null })),
      events: contexts.data.data.map(e => ({ id: e.id, name: e.name, timeZone: e.timeZone ?? null })),
      planBActivatedAt: pb.data.activatedAt ?? null,
      team: liveTeam.map(t => ({ id: t.id, label: t.label, vendor: t.vendor, vendorId: t.vendorId, phone: t.phone })),
    }, generation)
  }, [weddingId, scope, role, online, connectionLost, revalidated, q.data, w.data, contexts.data, pb.data, liveTeam, generation, timelineRead.data?.generation, contextRead.data?.generation, crewRead.data?.generation])

  /*
   * Чем кончилось действие — словами из ответа (`DayXBroadcast`, фича 005):
   * скольких ответивших «да» гостей касается сдвиг или план Б. Им сообщает
   * команда — канала до гостей нет, и `notifiedGuests` (всегда ноль, D4-18)
   * экран не читает. Сервер числа не назвал — строки нет, а не «касается 0».
   */
  const [outcome, setOutcome] = useState<string | null>(null)
  const planBAccepted = ({ guestsAffected, alreadyActive }: DayXBroadcast) => {
    setOutcome(alreadyActive ? t('Эта версия уже включена. Новая рассылка не создана.') : typeof guestsAffected === 'number'
      ? `${t('План Б включён')} · ${t('касается гостей:')} ${guestsAffected} — ${t('сообщите им сами, приложение гостям не пишет')}` : null)
    reloadTimeline(); reloadPlanB()
  }
  /*
   * После принятой команды экран перечитывает тайминг и план Б, и до ответа
   * на нём прежние часы и прежнее «не включён» — человек читает это как
   * «не сработало» и жмёт снова (ревью R3-01). Пока свежий ответ в пути,
   * обе кнопки закрыты.
   */
  const stale = q.refreshing || pb.refreshing

  /* Адрес чата знает только сервер, и он может отказать: 429 ограничителя,
     истёкшая сессия, обрыв сети. Раньше промис висел без `catch` — кнопка
     молча не делала ничего, а ошибка уходила в `unhandledrejection` (RF-04,
     R-148); в день свадьбы «Написать всей команде» просто не отвечала. */
  const openChat = (at: 'day' | 'crew' | 'team', key: string, route: () => Promise<string>) => void (async () => {
    setChatBusy(key)
    setChatErr(null)
    try { nav(await route()) } catch (e) { setChatErr({ at, text: explainError(e) }) } finally { setChatBusy(null) }
  })()
  const chatErrAt = (at: 'day' | 'crew' | 'team') =>
    chatErr?.at === at ? <p role="alert" className="text-[11.5px] mt-2 text-[var(--rose-ink)]">{chatErr.text}</p> : null

  const deviceTime = (iso: string) => new Date(iso).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU')
  const eventContexts = offline ? offline.events : sameContextVersion ? contexts.data?.data ?? [] : []
  const contextMismatch = !offline && events.some(block => block.eventId) && !!q.data && !!contexts.data && !sameContextVersion
  const programClock = (block: (typeof events)[number]) => {
    const zone = programZone(block, eventContexts, offline ? offline.weddingTimeZone : w.data?.tz)
    const start = programTime(block.startsAt, zone, getI18nLang())
    const end = programTime(block.endsAt, zone, getI18nLang())
    if (instant(block.startsAt) === null) return <span>{t('Время не задано')}</span>
    if (!start) return <span className="break-words">{t('Часовой пояс неизвестен')} · <time dateTime={block.startsAt!}>{block.startsAt}</time></span>
    if (instant(block.endsAt) !== null && instant(block.endsAt)! <= instant(block.startsAt)!) return <span>{start} · {t('Недопустимый интервал')} · {zone}</span>
    return <span>{start} · {end ?? t('Окончание неизвестно')} · {zone}</span>
  }

  return (
    <div data-theme="dark" className="min-h-dvh pb-10 bg-[var(--dark-bg)] text-[var(--dark-ink)]">
      <div className="px-5 pt-7 flex items-center justify-between">
        <button onClick={() => goBack(x => nav(x), (to, o) => nav(to, o))} className="press w-10 h-10 rounded-full flex items-center justify-center bg-[var(--card)]" aria-label={t('Назад')}><ChevronLeft size={18} /></button>
        <div className="text-center">
          <b className="font-serif-d text-[19px]">{offline?.weddingDate ? formatWeddingDate(offline.weddingDate) : !offlineMode && !accessDenied && w.data?.date ? formatWeddingDate(w.data.date) : t('День X')}</b>
          <p className="text-[9.5px] tracking-[.2em] font-bold text-[var(--dark-gold)]">{t('РЕЖИМ ДНЯ СВАДЬБЫ')}</p>
        </div>
        <div className="w-10" />
      </div>
      {offline && (
        <p role="status" className="mx-5 mt-3 rounded-2xl px-4 py-2.5 text-[11.5px] leading-relaxed bg-[var(--card)] opacity-90">
          {t('Офлайн-копия')} · {t('Версия снимка')} {offline.etag.replaceAll('"', '')} · {deviceTime(offline.savedAt)}. {t('Актуальность и доступ не проверены.')}
        </p>
      )}

      {offlineMode && !offline && <p role="status" className="mx-5 mt-3 text-[11.5px]">{cacheDenied ? t('Сохранённой программы нет') : `${t('Нет связи с сервером')} · ${t('Сохранённой программы нет')}`}</p>}
      <div className="px-5 mt-5">
        <div className="rounded-[26px] p-5 bg-[var(--card)]">
          {current.length > 0 ? (
            <div className="space-y-3">
              {current.map(block => <div key={block.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[9px] tracking-[.2em] font-bold text-[var(--dark-gold)]">{t('СЕЙЧАС')}</span>
                  <b className="font-serif-d text-[21px] block mt-1 break-words">{block.name}</b>
                  <p className="text-[11px] opacity-60 mt-0.5 break-words">{programClock(block)}</p>
                </div>
                <span className="text-[10px] font-bold px-3 py-1.5 rounded-full shrink-0 bg-[var(--rose-deep)] text-[var(--card)]">● LIVE</span>
              </div>)}
              {next && <p className="text-[11px] opacity-60 break-words">{t('дальше')} · {next.name} · {programClock(next)}</p>}
            </div>
          ) : (
            <div>
              <span className="text-[9px] tracking-[.2em] font-bold text-[var(--dark-gold)]">{next ? t('ДАЛЬШЕ') : t('ТАЙМИНГ')}</span>
              {/* До первого блока и после последнего честнее сказать это
                  словами, чем показывать «идёт фотосессия». */}
              {/* «Тайминг пуст» — про пришедший тайминг: при отказе сервера
                  экран дня X говорил координатору, что программы нет. */}
              <b className="font-serif-d text-[21px] block mt-1 break-words">{offline ? t('Офлайн-копия') : offlineMode || accessDenied ? t('Тайминг не загрузился') : next ? next.name : ready(q) ? events.length ? clock.ended ? t('Программа завершена') : t('Текущий блок не определён') : t('Тайминг пуст') : q.loading ? t('Загружаем…') : t('Тайминг не загрузился')}</b>
              <p className="text-[11px] opacity-60 mt-0.5">
                {next ? programClock(next) : ready(q) && !events.length ? t('Соберите тайминг заранее — в день свадьбы он ведёт всю команду') : (q.error ?? q.forbiddenText ?? '')}
              </p>
            </div>
          )}

          <div className="flex gap-2.5 mt-4">
            {/* Сдвиг уходит на сервер и рассылается команде и подрядчикам.
                Раньше он копился в браузере пары и не доходил ни до кого. */}
            {/* Из офлайн-копии сдвигать нечего: запрос не дойдёт, а кнопка обещала бы. */}
            {weddingId && <TimelineShiftControl key={weddingId} weddingId={weddingId} date={w.data?.date ?? null} timeZone={w.data?.tz ?? null}
              blocks={events} disabled={stale || !events.length || offlineMode || cacheDenied || !w.data || w.loading || !!w.error || w.forbidden}
              onAccepted={() => { reloadTimeline(); reloadPlanB(); reloadContexts() }} />}
            <button disabled={offlineMode || accessDenied || chatBusy === 'chat:day'} onClick={() => openChat('day', 'chat:day', dayChatRoute)} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold border border-[var(--line)] disabled:opacity-50">{chatBusy === 'chat:day' ? t('Открываем чат…') : t('Чат дня X')}</button>
          </div>
          {chatErrAt('day')}
        </div>

        {outcome && <p role="status" className="text-[11.5px] mt-3 opacity-80">{outcome}</p>}

        <div className="mt-4 relative pl-6">
          {!offline && <AsyncState q={q} forbiddenText={q.forbiddenText} />}
          {!offline && events.some(block => block.eventId) && <AsyncState q={contexts} forbiddenText={contexts.forbiddenText} />}
          {contextMismatch && <div className="mb-4 text-[11.5px]">
            <p role="status">{t('Контекст программы другой версии')}</p>
            <button disabled={q.refreshing || contexts.refreshing} onClick={() => { reloadTimeline(); reloadContexts() }}
              className="press mt-2 h-9 px-3 inline-flex items-center gap-2 rounded-md border border-[var(--line)] disabled:opacity-50">
              <RefreshCw size={14} />{t('Обновить контекст программы')}
            </button>
          </div>}
          <div className="absolute left-[7px] top-2 bottom-2 w-[1.5px] opacity-50" style={{ background: 'linear-gradient(var(--dark-gold), transparent)' }} />
          {events.map(e => (
            <div key={e.id} data-timeline-block={e.id} className="relative mb-4">
              <span className={cn('absolute -left-[19.5px] top-1.5 w-[9px] h-[9px] rounded-full', current.some(block => block.id === e.id) ? 'bg-[var(--rose-deep)]' : 'bg-[var(--dark-gold)]')} style={{ boxShadow: '0 0 12px var(--dark-gold-glow)' }} />
              <span className="text-[9.5px] font-bold text-[var(--dark-gold)] break-words">{programClock(e)}</span>
              {e.eventId && eventContexts.find(event => event.id === e.eventId)?.name && <p className="text-[10.5px] opacity-60 break-words">{eventContexts.find(event => event.id === e.eventId)!.name}</p>}
              <b className="font-serif-d text-[15px] block break-words">{e.name}</b>
              {e.location && <p className="text-[10.5px] opacity-50">{e.location}</p>}
            </div>
          ))}
          {!events.length && (ready(q) || offline) && (
            <p className="text-[11.5px] opacity-60">{t('Тайминг ещё не собран. Его можно собрать на экране «Тайминг дня».')}</p>
          )}
        </div>

        {/* Раньше здесь стояли четыре подрядчика со статусами «на месте» и
            «едет · 20 мин» и телефоны +7 000 000-00-00. Ни статусов, ни
            телефонов такого рода сервер не знает: показываем свою команду и
            путь к разговору с ней. */}
        <div className="mt-5">
          <b className="text-[13px]">{t('Ваша команда')}</b>
          {/* Состав команды известен только вместе с мозаикой. */}
          {!offline && <AsyncState q={crewRead} forbiddenText={crewRead.forbiddenText} />}
          {!team.length && (offline || (!offlineMode && !accessDenied && ready(crewRead))) && <p className="text-[11px] opacity-60 mt-1.5">{t('Забронированных подрядчиков пока нет')}</p>}
          <div className={cn('flex gap-2 mt-2.5', offline ? 'flex-col' : 'overflow-x-auto no-scrollbar')}>
            {team.map(s => (
              /* Без сети чат не открыть — из копии остаётся телефон (виден
                 паре после брони), и в день свадьбы он важнее переписки. */
              offline ? (
                <a key={s.id} href={s.phone ? `tel:${s.phone}` : undefined} aria-disabled={!s.phone} className={cn('press flex items-center gap-2 px-4 py-3 min-h-[42px] rounded-lg text-[11px] font-semibold bg-[var(--card)]', !s.phone && 'opacity-50')}>
                  <span className="w-6 h-6 shrink-0 rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[10px]">{(s.vendor ?? '?')[0]}</span>
                  <span className="min-w-0 break-words">{`${s.vendor} · ${t(s.label)}`}<span className="block mt-0.5">{s.phone ?? t('телефона нет')}</span></span>
                </a>
              ) : (
              <button key={s.id} disabled={offlineMode || accessDenied || chatBusy === `chat:${s.id}`} onClick={() => openChat('crew', `chat:${s.id}`, () => chatRouteForVendor(s.vendorId))} className="press flex items-center gap-2 px-4 h-[42px] rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 bg-[var(--card)] disabled:opacity-50">
                <span className="w-6 h-6 rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[10px]">{(s.vendor ?? '?')[0]}</span>
                {chatBusy === `chat:${s.id}` ? t('Открываем чат…') : `${s.vendor} · ${t(s.label)}`}
              </button>
              )
            ))}
          </div>
          {chatErrAt('crew')}
        </div>

        {!offlineMode && !cacheDenied && !accessDenied && weddingId && pb.data?.canActivate === true &&
          <DayXCoordination weddingId={weddingId} />}

        <div className="rounded-[26px] p-5 mt-4 bg-[var(--card)]">
          <div className="flex items-center gap-3 flex-wrap">
            <CloudRain size={20} className="text-[var(--dark-gold)]" />
            <div className="flex-1 min-w-0 basis-[140px]">
              <b className="text-[13.5px]">{t('План Б')}</b>
              <p className="text-[10.5px] opacity-60 mt-0.5">{planBOn
                ? t(PLAN_B_SCENARIOS.get(pb.data?.scenario ?? '') ?? 'Сценарий активирован')
                : t('Активация дождевого сценария создаёт уведомления для команды.')}</p>
            </div>
            {planBOn && (
              <span className="text-[11px] font-bold px-3 py-2 rounded-full shrink-0 bg-[var(--sage-deep)] text-[var(--card)]">{t('Включён')}</span>
            )}
          </div>
          {!planBOn && weddingId && pb.data?.canActivate !== false && (
            <PlanBActivation key={offlineMode || cacheDenied ? 'unavailable' : 'live'} weddingId={weddingId} scenario="rain"
              disabled={offlineMode || cacheDenied || stale || !ready(pb) || pb.data?.canActivate !== true} onAccepted={planBAccepted} />
          )}
          {planBOn && !offlineMode && !accessDenied && ready(pb) && pb.data?.delivery !== undefined && <PlanBDelivery summary={pb.data.delivery} />}
          {planBOn && !offlineMode && !cacheDenied && !accessDenied && weddingId && ready(pb) &&
            pb.data?.canActivate === true && isPlanBScenario(pb.data.scenario) && (
              <PlanBActivation weddingId={weddingId} scenario={pb.data.scenario} active disabled={stale} onAccepted={planBAccepted} />
          )}
        </div>

        {/* SOS-координатора в контракте нет: отдельного пути «позвать
            координатора» не существует, а телефон +7 000 000-00-00 был
            выдуман. Пишем в командный чат — там координатор и сидит. */}
        <button disabled={offlineMode || accessDenied || chatBusy === 'chat:team'} onClick={() => openChat('team', 'chat:team', teamChatRoute)} className="press w-full h-[52px] rounded-full mt-4 text-[13.5px] font-bold flex items-center justify-center gap-2 bg-[var(--rose-deep)] text-[var(--card)] disabled:opacity-50">
          <Zap size={16} /> {chatBusy === 'chat:team' ? t('Открываем чат…') : t('Написать всей команде')}
        </button>
        {chatErrAt('team')}
      </div>
    </div>
  )
}

/* После свадьбы */
function SectionHeadSm({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mt-1 mb-2.5">
      <h3 className="font-serif-d text-[17px]">{title}</h3>
      {sub && <p className="text-[10.5px] text-[var(--soft)] mt-0.5">{sub}</p>}
    </div>
  )
}

/*
 * «После свадьбы» — итоги.
 *
 * Экран был витриной: «Алина & Тимур», 14 подрядчиков, 76 гостей, 312 фото и
 * два выдуманных отзыва гостей — одни и те же числа у любой пары. Отзыв команде
 * складывался в `tt_after_stars` браузера и до подрядчика не доходил, а «отзывы
 * гостей» читались из `tt_guest_reviews`: пара видела мок вместо того, что ей
 * действительно написали её гости.
 *
 * Теперь всё считается по своей свадьбе, а отзывы ходят на сервер обе стороны.
 */
export function After() {
  const { weddingId } = useStore()
  const origin = useLegacySessionKey(JSON.stringify(weddingId))
  return <AfterPage key={origin} weddingId={weddingId} />
}

function AfterPage({ weddingId }: { weddingId: string | null }) {
  const capture = useLegacyActionScope('wedding-completion', weddingId)
  const q = useApi(() => weddingId ? getWeddingCompletion(weddingId, { assertCurrent: capture().assertCurrent }) : noWedding(),
    [weddingId, capture])
  const { reload } = q
  const waiting = q.data?.state === 'waiting'
  useEffect(() => {
    window.addEventListener('focus', reload)
    window.addEventListener('online', reload)
    const timer = waiting ? window.setInterval(reload, 60_000) : undefined
    return () => {
      window.removeEventListener('focus', reload)
      window.removeEventListener('online', reload)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [reload, waiting])

  const phase = ready(q) ? q.data : null
  const planned = programTime(phase?.completionAt, phase?.timeZone ?? null, getI18nLang())
  const stateText = phase?.state === 'ready' ? 'Поздравляем! Ваша свадьба состоялась'
    : phase?.state === 'schedule_incomplete' ? 'Уточните даты, часовые пояса и время окончания программы.'
      : phase?.state === 'cancelled' ? 'Свадьба отменена'
        : 'Итоги откроются после последнего мероприятия.'
  return (
    <div className="pb-28">
      <TopBar back title={t('После свадьбы')} sub={formatWeddingDate(phase?.lastEventDate ?? null) || undefined} />
      <AsyncState q={q} />
      {phase && (
        <div className="px-5 mt-3">
          <div className="grad rounded-[32px] p-7 text-[var(--on-grad)] text-center relative overflow-hidden fade-up">
            <Heart size={26} className="mx-auto opacity-90" />
            <h2 className="font-serif-d text-[26px] mt-3">{phase.title}</h2>
            <p className="text-[12px] opacity-90 mt-1">{t(stateText)}</p>
            {phase.state === 'waiting' && planned && <p className="text-[12px] mt-1">{t('Плановое окончание программы')} · {planned}</p>}
          </div>
          {(phase.state === 'waiting' || phase.state === 'schedule_incomplete') && (
            <Link className="press card-s block mt-3 p-4 text-sm font-semibold" to="/wedding/events">{t('Открыть мероприятия')}</Link>
          )}
          {phase.state === 'ready' && weddingId && (
            <div inert={q.refreshing}>
              <AfterReady weddingId={weddingId} canManage={phase.canManage} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AfterReady({ weddingId, canManage }: { weddingId: string; canManage: boolean }) {
  const guests = useApi(() => getGuests(weddingId), [weddingId])
  const album = useApi(() => getAlbum(weddingId), [weddingId])
  const reviews = useApi(() => canManage ? getGuestReviews(weddingId) : Promise.resolve(null), [weddingId, canManage])
  /* Мозаика читается здесь своим запросом, а не из стора: у слота в сторе
     нет даты завершения сделки, а окно отзыва считается от неё (`doneAt`). */
  const slotsQ = useApi(() => getSlots(weddingId), [weddingId])
  const [rating, setRating] = useState(false)
  const photos = album.data ?? []
  const guestReviews = reviews.data ?? []
  /* Команда — те, с кем есть сделка. Свой подрядчик (§11) сюда не попадает:
     он не из каталога, и отзыв о нём публиковать негде. */
  const booked = (slotsQ.data ?? []).flatMap(slot => {
    const deal = slot.deal
    return deal?.id && deal.state && ['booked', 'paid_deposit', 'done'].includes(deal.state)
      ? [{ id: deal.id, label: slot.label, deal }] : []
  })
  const team = booked.filter(({ deal }) => deal.vendor?.id)
  /* Итоги — только по пришедшим ответам: «0 гостей · 0 кадров» после свадьбы
     при лежащем сервере читается как «никто не пришёл и не снимал». */
  const guestCount = guests.data?.length ?? 0
  const stats: [string, string][] = [
    [num(slotsQ, team.length), plural(team.length, t('подрядчик'), t('подрядчика'), t('подрядчиков'))],
    [num(guests, guestCount), plural(guestCount, t('гость'), t('гостя'), t('гостей'))],
    [num(album, photos.length), plural(photos.length, t('кадр от гостей'), t('кадра от гостей'), t('кадров от гостей'))],
  ]
  if (canManage) stats.push([num(reviews, guestReviews.length),
    plural(guestReviews.length, t('отзыв гостя'), t('отзыва гостей'), t('отзывов гостей'))])
  const statsError = guests.error ?? album.error
  const icons = ['🤝', '🥂', '📸', '★']

  return (
    <>
      <section className="mt-4" aria-label={t('План завершения')}>
        <SectionHeadSm title={t('План завершения')} />
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {canManage && <Link className="press card-s p-4 font-semibold" to="/wedding/payments">{t('Платежи и возвраты')}</Link>}
          <Link className="press card-s p-4 font-semibold" to="/wedding/album">{t('Гостевой альбом')}</Link>
          {canManage && <Link className="press card-s p-4 font-semibold" to="/wedding/documents">{t('Договоры и документы')}</Link>}
          <AccountDataExport weddingId={weddingId} buttonClassName="press card-s w-full p-4 text-left font-semibold disabled:opacity-50" />
          <Link className="press card-s p-4 font-semibold" to="/support">{t('Поддержка')}</Link>
        </div>
        {canManage && <GuestThanks weddingId={weddingId} />}
        {canManage && (
          <div className="mt-4">
            <SectionHeadSm title={t('Материалы и правки по сделкам')} />
            <AsyncState q={slotsQ} />
            {ready(slotsQ) && booked.length === 0 && <p className="text-sm">{t('Активных сделок нет')}</p>}
            <ul className="grid gap-2 text-sm">{booked.map(({ id, label, deal }) => (
              <li key={id}>
                <Link className="press card-s block p-3" to={`/deal/${id}`}>{deal.vendor?.name || deal.externalName || t(label ?? 'Подрядчик')}</Link>
              </li>
            ))}</ul>
          </div>
        )}
      </section>
      <div className="grid grid-cols-2 gap-2.5 mt-4 stagger">
        {stats.map(([v, l], i) => (
          <div key={l} className="card-s p-4 text-center fade-up">
            <span className="text-[20px]">{icons[i]}</span>
            <b className="font-serif-d text-[24px] block mt-1 tabular">{v}</b>
            <span className="text-[10px] text-[var(--soft)]">{l}</span>
          </div>
        ))}
      </div>
      {statsError && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] mt-2 px-1 leading-relaxed">{statsError}</p>}

      {canManage && (
        <>
          <button onClick={() => setRating(!rating)} className="press w-full card-s mt-3 py-4 text-[13px] font-semibold">{rating ? t('Скрыть') : t('Оставить отзывы команде')}</button>
          {rating && (
            <div className="mt-3 space-y-2.5 fade-up">
              <AsyncState q={slotsQ} />
              {ready(slotsQ) && !team.length && <p className="text-[12px] text-[var(--soft)] text-center py-3">{t('Пока некого оценивать — в команде нет забронированных подрядчиков')}</p>}
              {team.map(({ id, deal }) => (
                <CoupleReviewRow key={id} vendorId={deal.vendor?.id ?? ''} name={deal.vendor?.name ?? ''} done={deal.state === 'done'} doneAt={deal.doneAt ?? null} />
              ))}
            </div>
          )}

          <div className="mt-4">
            <SectionHeadSm title={t('Отзывы от гостей')} sub={t('гости отмечены значком и не смешиваются с вашими отзывами')} />
            <AsyncState q={reviews} />
            <div className="flex flex-col gap-2">
              {guestReviews.map(r => (
                <div key={r.id} className="card-s p-4">
                  <div className="flex items-center justify-between gap-2">
                    <b className="text-[12.5px] flex-1">{r.vendorName ?? t('Подрядчик')}</b>
                    <span className="text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--blue)] text-[var(--blue-ink)]">{t('Гость свадьбы')}</span>
                  </div>
                  <div className="flex items-center gap-1 mt-1.5 text-[11px]" style={{ color: 'var(--gold-soft)' }}>{'★'.repeat(r.rating ?? 0)}<span className="text-[var(--track)]">{'★'.repeat(5 - (r.rating ?? 0))}</span></div>
                  {r.text && <p className="text-[11.5px] text-[var(--ink2)] mt-1.5 leading-relaxed">{r.text}</p>}
                </div>
              ))}
              {!guestReviews.length && ready(reviews) && (
                <p className="text-[11.5px] text-[var(--soft)] py-2">{t('Гости пока не оставили отзывов. Форма откроется после окончания всей программы.')}</p>
              )}
            </div>
            <p className="text-[10.5px] text-[var(--soft2)] mt-2.5 leading-relaxed">{t('Отзывы гостей видны вам и учитываются в рейтинге подрядчика отдельно от отзывов пар.')}</p>
          </div>
        </>
      )}
    </>
  )
}

/*
 * Отзыв пары об одном подрядчике.
 *
 * Право на отзыв даёт завершённая сделка — это проверяет сервер, и до неё
 * форма не открывается: звёзды, которые никуда не уйдут, хуже честной строки
 * «после завершения сделки».
 *
 * Второе условие сервера — окно в 14 дней от завершения сделки
 * (`REVIEW_WINDOW_DAYS` в `routes/reviews.ts`, 403 после). Раньше форма
 * стояла у каждой завершённой сделки, и «через год» упиралось в отказ уже
 * после набранного текста (ревью D4-26). Срок считается от `doneAt` сделки;
 * без него сервер берёт дату создания сделки, которой у экрана нет, — тогда
 * форма открыта, а дата не называется: выдумывать её нельзя.
 */
const REVIEW_WINDOW_DAYS = 14

function CoupleReviewRow({ vendorId, name, done, doneAt }: { vendorId: string; name: string; done: boolean; doneAt: string | null }) {
  const [stars, setStars] = useState(0)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Момент открытия — один раз за монтирование (R-04).
  const [openedAt] = useState(() => Date.now())

  const deadline = doneAt ? new Date(doneAt).getTime() + REVIEW_WINDOW_DAYS * 86_400_000 : null
  const closed = deadline !== null && openedAt > deadline
  const deadlineText = deadline !== null
    ? new Date(deadline).toLocaleDateString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long' })
    : null

  const send = () => void (async () => {
    if (!stars || !text.trim()) return
    setBusy(true)
    setErr(null)
    try { await sendCoupleReview(vendorId, stars, text.trim()); setSent(true) } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <b className="text-[12.5px] flex-1">{name}</b>
        {!done && <span className="text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--track)] text-[var(--track-ink)]">{t('после завершения сделки')}</span>}
        {done && closed && <span className="text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--track)] text-[var(--track-ink)]">{t('Окно для отзыва закрылось')}</span>}
      </div>
      {done && closed && (
        <p className="text-[11px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Отзыв принимается 14 дней после завершения сделки — срок вышел')} {deadlineText}</p>
      )}
      {done && !closed && !sent && (
        <>
          <div className="flex items-center gap-1.5 mt-2">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setStars(n)} className="press text-[17px]" aria-label={`${n}`} style={{ color: n <= stars ? 'var(--gold-soft)' : 'var(--track)' }}>★</button>
            ))}
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={t('Что получилось, а что нет')} className="w-full mt-2 px-4 py-3 rounded-xl bg-[var(--bg)] text-[12.5px] outline-none resize-none placeholder:text-[var(--soft2)]" />
          {deadlineText && <p className="text-[10.5px] text-[var(--soft2)] mt-1.5">{t('Отзыв принимается до')} {deadlineText}</p>}
          {err && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] mt-1.5">{err}</p>}
          <button disabled={busy || !stars || !text.trim()} onClick={send} className="press w-full h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold mt-2 disabled:opacity-40">
            {busy ? t('Отправляем…') : t('Отправить отзыв')}
          </button>
        </>
      )}
      {sent && <p className="text-[11.5px] text-[var(--sage-deep)] font-medium mt-1.5">{t('✓ Отзыв отправлен')}</p>}
    </div>
  )
}

/* План Б: плохие сценарии дня X и готовые решения */
const planBRisks: { icon: string; title: string; how: string; action?: 'search'; scenario?: PlanBScenario }[] = [
  {
    icon: '🎤', title: key('Подрядчик не приехал или отменил в последний день'),
    /* Про эскроу и автоматический возврат аванса здесь было написано зря:
       платёжного провайдера нет, деньги идут напрямую подрядчику по договору,
       и возвращает их он. Штрафа рейтинга за отмену в коде тоже нет. */
    how: key('«Горячая замена»: каталог показывает только свободных на вашу дату. Аванс возвращает подрядчик по договору — потому договор и нужен; шаблон есть в разделе «Документы».'),
    action: 'search',
    scenario: 'vendor_missing',
  },
  {
    icon: '🌧', title: key('Дождь или непогода на выездной церемонии'),
    /* Гостям канала нет — SMS не подключены (хвост владельца), поэтому
       «гости получают уведомление» здесь не стояло бы честно ни в одной
       форме. Уведомление уходит команде, гостям звонит пара. */
    how: key('Уточните у площадки резервное место. После активации команда увидит уведомление. Гостям сообщите точку сбора сами.'),
    scenario: 'rain',
  },
  {
    icon: '🔌', title: key('Отключили электричество на площадке'),
    scenario: 'power',
    how: key('При бронировании площадка подтверждает наличие генератора — это пункт чек-листа договора. Запасной сценарий: свечи и накамерный свет фотографа превращают паузу в «зажжение семейного очага».'),
  },
  {
    icon: '⏰', title: key('Всё отстаёт от тайминга'),
    /* «Запас 15 минут заложен заранее» — автоплан такого не гарантирует; запас
       — дело пары при сборке тайминга. */
    how: key('В режиме дня X тайминг сдвигается одним тапом, и вся команда получает обновление. Запас в каждый блок закладывайте при сборке тайминга — тогда гости не заметят.'),
  },
  {
    icon: '🍰', title: key('Торт повредили при доставке'),
    how: key('Не выносить целиком: кондитер разрезает за кулисами и подаёт порционно — гости не догадаются. Фото торта делаются до выноса, при заказе.'),
  },
  {
    icon: '🥂', title: key('Гость перебрал или неловкий тост'),
    how: key('Ведущий тактично забирает микрофон и уводит программу дальше — это прописано в брифе ведущего. Координатор тихо вызывает такси до отеля, бармен наливает меньше.'),
  },
  {
    icon: '👶', title: key('Дети устроили истерику посреди церемонии'),
    how: key('В каталоге есть слот «Няня/аниматор» — дети заняты отдельно, за своим столом. Или формат «только взрослые»: пометка в приглашении.'),
  },
  {
    icon: '👥', title: key('Приехали незваные +1, мест не хватает'),
    /* Сводка для кейтеринга считает ровно по ответам гостей — запас в неё
       никто не «закладывает автоматически»; это совет, а не функция. */
    how: key('Попросите кейтеринг и площадку держать запас +2 места и порции: в сводке для кейтеринга стоит точное число по ответам гостей, запас добавьте сами. Координатор добавляет стулья без вашего участия.'),
  },
  {
    icon: '🚗', title: key('Автобус с гостями сломался или водитель приехал не туда'),
    scenario: 'transport',
    /* Приложения для водителя нет: маршрут ему передают руками. */
    how: key('Маршрут и точки сбора передайте водителю заранее — приложения для водителя нет, и «думать сам» он не должен. Запасной вариант: второй автобус из раздела Логистики или такси-контракт, эскалация на координатора.'),
  },
  {
    icon: '💍', title: key('Забыли кольца или паспорта'),
    how: key('Чек-лист ниже отдаёт кольца и паспорта свидетелям ещё накануне — проверено поколениями свадеб.'),
  },
]


export function PlanB() {
  const { weddingId } = useStore()
  const scope = useLegacySessionKey(JSON.stringify(weddingId))
  return <PlanBContent key={scope} weddingId={weddingId} />
}

function PlanBScenarioControls(props: PlanBActivationProps & { online: boolean }) {
  const [editing, setEditing] = useState(false)
  const settings = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={settings} type="button" aria-expanded={editing} disabled={!props.online || props.disabled}
        onClick={() => setEditing(true)}
        className="press mt-2 min-h-10 rounded-full border border-[var(--line)] px-4 text-[12px] font-semibold disabled:opacity-50">
        {t('Настроить сценарий')}
      </button>
      {editing
        ? <PlanBScenarioEditor weddingId={props.weddingId} scenario={props.scenario}
          title={t(PLAN_B_SCENARIOS.get(props.scenario) ?? 'План Б')} close={() => { setEditing(false); settings.current?.focus() }} />
        : <PlanBActivation key={props.active ? 'active' : 'inactive'} {...props} disabled={props.disabled || !props.online} />}
    </>
  )
}

function PlanBContent({ weddingId }: { weddingId: ReturnType<typeof useStore>['weddingId'] }) {
  const nav = useNavigate()
  const [open, setOpen] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [activationRepeated, setActivationRepeated] = useState(false)

  /*
   * Чек-лист накануне ведёт сервер: он один на всю команду, и координатор
   * должен видеть те же галочки, что и пара. Локальный `tt_planb` держал их
   * в одном браузере — второй человек видел пустой список, а после смены
   * телефона отметки пропадали совсем.
   *
   * Пункты плана Б — обычные задачи вида `planb`, поэтому и отмечаются через
   * `PATCH …/tasks/{taskId}`: отдельного пути у контракта нет намеренно.
   */
  const q = useApi(() => weddingId ? getPlanB(weddingId) : noWedding(), [weddingId])
  const online = useProgramOnline(q.reload)
  const checklist = q.data?.checklist ?? []
  /* Галочка отзывается сразу, запрос уходит следом. Отказ возвращает её
     обратно: показывать отмеченным то, чего сервер не принял, нельзя. */
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const isDone = (id: string, serverDone: boolean) => pending[id] ?? serverDone

  const toggle = (id: string, next: boolean) => {
    if (!weddingId || !id) return
    setPending(m => ({ ...m, [id]: next }))
    setErr(null)
    void setTaskDone(weddingId, id, next)
      .then(() => q.reload())
      .catch(e => {
        setPending(m => { const rest = { ...m }; delete rest[id]; return rest })
        setErr(explainError(e))
      })
  }

  const doneCount = checklist.filter(c => isDone(c.id ?? '', !!c.done)).length
  const pct = checklist.length ? Math.round(doneCount / checklist.length * 100) : 0
  const activated = !!q.data?.activatedAt
  const activeScenario = PLAN_B_SCENARIOS.get(q.data?.scenario ?? '')

  return (
    <div className="pb-28">
      <TopBar back title={t('План Б')} sub={t('Готовы ко всему, что может пойти не так')} />
      <AsyncState q={q} />
      <div className="px-5 mt-3 space-y-3">
        <div className="card p-4">
          {/* «0%» без ответа сервера — не готовность, а её отсутствие. */}
          <div className="flex justify-between text-[12px] mb-2"><span className="font-semibold">{t('Чек-лист накануне')}</span><b className="tabular">{num(q, `${pct}%`)}</b></div>
          {ready(q) && <Bar pct={pct} />}
          <div className="mt-3 space-y-2">
            {checklist.map(c => {
              const id = c.id ?? ''
              const checked = isDone(id, !!c.done)
              return (
                <button key={id} onClick={() => toggle(id, !checked)} className="press w-full flex items-center gap-3 text-left">
                  <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0', checked ? 'grad text-[var(--on-grad)]' : 'bg-[var(--track)] text-[var(--track-ink)]')}>{checked ? '✓' : ''}</span>
                  <span className={cn('text-[12px] leading-snug', checked && 'line-through text-[var(--soft2)]')}>{c.title}</span>
                </button>
              )
            })}
          </div>
        </div>

        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] px-1">{err}</p>}
        {activationRepeated && <p role="status" className="text-[12px] px-1">{t('Эта версия уже включена. Новая рассылка не создана.')}</p>}

        {activated && (
          <div className="card p-4 fade-up" style={{ border: '1.5px solid var(--sage-deep)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <b className="text-[13px]">{t('План Б активирован')}</b>
              {q.data?.delivery !== undefined && (
                <button type="button" onClick={q.reload} disabled={q.refreshing}
                  className="press text-[11px] font-semibold text-[var(--rose-deep)] disabled:opacity-50">{t('Обновить статусы')}</button>
              )}
            </div>
            {activeScenario && ready(q) && <p className="mt-1 text-[11.5px] text-[var(--soft)]">{t(activeScenario)}</p>}
            {ready(q) && q.data?.delivery !== undefined && <PlanBDelivery summary={q.data.delivery} />}
          </div>
        )}

        <div className="space-y-2.5 stagger">
          {planBRisks.map((r, i) => (
            <div key={r.title} className="card fade-up overflow-hidden">
              <button onClick={() => setOpen(o => o === i ? null : i)} className="press w-full p-4 flex items-center gap-3 text-left">
                <span className="text-[20px] w-8 text-center shrink-0">{r.icon}</span>
                <span className="flex-1 text-[12.5px] font-semibold leading-snug">{t(r.title)}</span>
                <span className={cn('text-[var(--soft2)] transition-transform', open === i && 'rotate-90')}>›</span>
              </button>
              {open === i && (
                <div className="px-4 pb-4 -mt-1 fade-in">
                  <p className="text-[11.5px] text-[var(--soft)] leading-relaxed">{t(r.how)}</p>
                  {r.action === 'search' && (
                    <button onClick={() => nav('/search')} className="press mt-3 h-10 px-5 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Найти горячую замену →')}</button>
                  )}
                  {r.scenario && weddingId && ready(q) && q.data?.canActivate && (
                    <PlanBScenarioControls key={online ? 'online' : 'offline'} online={online} weddingId={weddingId}
                      scenario={r.scenario} active={r.scenario === q.data.scenario} disabled={q.refreshing}
                      onAccepted={receipt => { setActivationRepeated(receipt.alreadyActive === true); q.reload() }} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Раньше здесь обещалась «SOS-кнопка», которой в приложении нет:
            отдельного пути «позвать координатора» контракт не знает. Зато
            есть командный чат — там и координатор, и подрядчики. */}
        <AiTip text={t('Самый частый совет профессионалов: не решайте проблемы сами в день X. Для этого есть командный чат — ваша задача только наслаждаться днём.')} />
      </div>
    </div>
  )
}
