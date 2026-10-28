import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { key, t } from '@/lib/i18n'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { acceptOwnLegacyCalendar, activateOwnLegacyCalendar, activateOwnerLegacyCalendar, captureLegacyCalendarInventory, getLegacyCalendarEditor, getLegacyCalendarSources, getOwnLegacyCalendarSources, proposeLegacyCalendar, readOwnLegacyCalendar } from '@/lib/api/legacy-calendar'
import type { CalendarActivateInput, CalendarBoundsView, CalendarSourceSummary, CalendarSpan } from '@/lib/api/legacy-calendar'
import { boundsButton, LegacyCalendarBoundsEditor } from './LegacyCalendarBoundsEditor'

type Target = { vendorId: string } | { weddingId: string; dealId: string }
type Props = { target: Target; parent: object }
type Command = { key: string; run: (key: string, assertCurrent: () => void) => Promise<CalendarBoundsView> }
const privateFailure = (error: unknown) => error instanceof ApiError && [401, 403, 404, 410].includes(error.status)
const uncertain = (error: unknown) => error instanceof ApiError && (error.isDown || error.code === 'idempotency_in_progress')
function failure(error: unknown): string {
  if (privateFailure(error)) return t('Доступ изменился. Откройте сведения заново после входа.')
  if (uncertain(error)) return t('Ответ не подтверждён. Ваш ввод сохранён; повторите ту же попытку.')
  return t('Сведения могли измениться. Перечитайте источник и проверьте предложение.')
}
export function LegacyCalendarBoundsOwner({ vendorId, parent }: { vendorId: string; parent: object }) {
  return <BoundsFence target={{ vendorId }} parent={parent} />
}
export function LegacyCalendarBoundsHolder({ weddingId, dealId, parent }: { weddingId: string; dealId: string; parent: object }) {
  return <BoundsFence target={{ weddingId, dealId }} parent={parent} />
}
function BoundsFence({ target, parent }: Props) {
  const key = useLegacySessionKey(JSON.stringify(target))
  const [seen, setSeen] = useState({ parent, epoch: 0 })
  // Retire equal-material but newly fetched parents before an old review can act.
  if (seen.parent !== parent) { setSeen({ parent, epoch: seen.epoch + 1 }); return null }
  return <BoundsDisclosure key={`${key}:${seen.epoch}`} target={target} />
}
function BoundsDisclosure({ target }: { target: Target }) {
  const [open, setOpen] = useState(false), [activated, setActivated] = useState(false)
  return <details className="min-w-0 max-w-full rounded-xl border border-[var(--line)] p-3" open={open} onToggle={e => { setOpen(e.currentTarget.open); if (e.currentTarget.open) setActivated(true) }}>
    <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{t('Границы прежних календарных обязательств')}</summary>
    {activated && <div hidden={!open}><BoundsList target={target} /></div>}
  </details>
}
function BoundsList({ target }: { target: Target }) {
  const [sources, setSources] = useState<CalendarSourceSummary[] | null>(null), [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null), [closed, setClosed] = useState(false), [epoch, setEpoch] = useState(0)
  const locked = useRef(new Set<string>()), [hasLocks, setHasLocks] = useState(false)
  const onLocked = useCallback((id: string, value: boolean) => { if (value) locked.current.add(id); else locked.current.delete(id); setHasLocks(locked.current.size > 0) }, [])
  const deny = useCallback((error: unknown) => { setSources(null); setClosed(true); setLoading(false); setMessage(failure(error)) }, [])
  const gate = useRef(false), capture = useLegacyActionScope(JSON.stringify(['bounds-list', target, closed]))
  const load = useCallback(async () => {
    if (gate.current || closed || locked.current.size > 0) return
    const action = capture(); action.assertCurrent(); gate.current = true; setLoading(true); setMessage(null)
    try {
      const reply = 'vendorId' in target ? await getLegacyCalendarSources(target.vendorId, action) : await getOwnLegacyCalendarSources(target.weddingId, target.dealId, action)
      action.assertCurrent(); setSources(reply.sources); setEpoch(old => old + 1)
    } catch (error) { if (action.isCurrent()) { setMessage(failure(error)); if (privateFailure(error)) { setSources(null); setClosed(true) } } }
    finally { gate.current = false; if (action.isCurrent()) setLoading(false) }
  }, [capture, closed, target])
  useEffect(() => { void load() }, [load]) // Only once per opened, current origin; no polling.
  if (closed) return <p role="alert" className="text-sm">{message}</p>
  return <div className="min-w-0 space-y-3">
    <p className="text-xs">{t('Каждый источник согласуется отдельно. Предложение и принятие не означают активацию или свободный ресурс.')}</p>
    {loading && <p role="status" className="text-sm">{t('Загрузка календарных источников…')}</p>}
    {message && <p role="alert" className="text-sm">{message}</p>}
    <button type="button" className={boundsButton} disabled={loading || hasLocks} onClick={() => void load()}>{t('Обновить календарные источники')}</button>
    {sources !== null && !loading && <p className="text-sm">{t('Источников:')} {sources.length}</p>}
    {sources?.length === 0 && !loading && <p className="text-sm">{t('Записанных источников нет. Это не подтверждение свободного времени.')}</p>}
    {sources?.map((source, index) => <SourcePanel key={`${source.sourceId}:${epoch}`} target={target} source={source} index={index} enabled={!loading} onDenied={deny} onLocked={onLocked} />)}
  </div>
}
function SourcePanel({ target, source, index, enabled, onDenied, onLocked }: { target: Target; source: CalendarSourceSummary; index: number; enabled: boolean; onDenied: (error: unknown) => void; onLocked: (id: string, value: boolean) => void }) {
  const [view, setView] = useState<CalendarBoundsView | null>(null), [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(0)
  const [message, setMessage] = useState<string | null>(null), [closed, setClosed] = useState(false), [pending, setPending] = useState<Command | null>(null), [needsRead, setNeedsRead] = useState(false)
  const gate = useRef(false), capture = useLegacyActionScope(JSON.stringify(['bounds-source', target, source.sourceId, epoch, enabled, closed]))
  const current = useRef({ view, enabled, needsRead, pending, closed })
  useLayoutEffect(() => { current.current = { view, enabled, needsRead, pending, closed } }, [view, enabled, needsRead, pending, closed])
  useLayoutEffect(() => { onLocked(source.sourceId, busy || !!pending); return () => onLocked(source.sourceId, false) }, [onLocked, source.sourceId, busy, pending])
  const owner = 'vendorId' in target
  const blocked = !enabled || busy || !!pending || needsRead || closed
  const install = (reply: CalendarBoundsView) => { setView(reply); setEpoch(value => value + 1); setNeedsRead(false) }
  async function read(version?: string) {
    if (gate.current || !enabled || pending || closed || !current.current.enabled || current.current.pending || current.current.closed) return
    const action = capture(); action.assertCurrent(); gate.current = true; setBusy(true); setMessage(null)
    // Remove the approval immediately, while retaining the owner's unsent draft.
    setNeedsRead(true)
    try {
      const reply = 'vendorId' in target ? await getLegacyCalendarEditor(target.vendorId, source.sourceId, action) : await readOwnLegacyCalendar(target.weddingId, target.dealId, source.sourceId, action, version)
      action.assertCurrent(); install(reply)
    } catch (error) { if (action.isCurrent()) { setMessage(failure(error)); if (privateFailure(error)) { setView(null); setClosed(true); onDenied(error) } } }
    finally { gate.current = false; if (action.isCurrent()) setBusy(false) }
  }
  async function execute(command: Command) {
    if (gate.current || !enabled || closed || !current.current.enabled || current.current.closed) return
    const action = capture(); action.assertCurrent(); gate.current = true; setBusy(true); setPending(command); setMessage(null)
    try { const reply = await command.run(command.key, action.assertCurrent); action.assertCurrent(); setPending(null); install(reply); setMessage(t('Изменение сохранено. Для нового согласия перечитайте текущую версию.')) }
    catch (error) {
      if (action.isCurrent()) {
        setMessage(failure(error))
        if (!uncertain(error)) { setPending(null); setNeedsRead(true) }
        if (privateFailure(error)) { setView(null); setPending(null); setClosed(true); onDenied(error) }
      }
    } finally { gate.current = false; if (action.isCurrent()) setBusy(false) }
  }
  const send = (run: Command['run']) => {
    const now = current.current
    if (!blocked && now.enabled && !now.closed && !now.pending && !now.needsRead && now.view === view) void execute({ key: newIdempotencyKey(), run })
  }
  const activate = () => {
    const proposal = view?.proposal
    if (!proposal || !view?.readiness.canActivate) return
    const body: CalendarActivateInput = { boundsVersionId: proposal.id, digest: proposal.digest, expectedHeadRevision: view.source.headRevision, expectedSourceFingerprint: proposal.sourceFingerprint }
    send((key, assertCurrent) => 'vendorId' in target ? activateOwnerLegacyCalendar(target.vendorId, source.sourceId, body, key, { assertCurrent }) : activateOwnLegacyCalendar(target.weddingId, target.dealId, source.sourceId, body, key, { assertCurrent }))
  }
  if (closed) return <p role="alert" className="text-sm">{message}</p>
  return <section className="min-w-0 max-w-full space-y-3 rounded-xl border border-[var(--line)] p-3">
    <h3 className="text-sm font-semibold">{t('Календарный источник')} {index + 1} · {sourceKind(source.kind)}</h3>
    <SourceStatus source={view?.source ?? source} />
    {message && <p role="status" className="text-sm break-words">{message}</p>}
    {pending && <button type="button" className={boundsButton} disabled={busy || !enabled} onClick={() => void execute(pending)}>{t('Повторить ту же календарную попытку')}</button>}
    <button type="button" className={boundsButton} disabled={!enabled || busy || !!pending} onClick={() => void read()}>{t(owner ? 'Открыть редактор источника' : 'Прочитать текущие границы для согласия')}</button>
    {busy && <p role="status" className="text-sm">{t('Проверяем текущие сведения…')}</p>}
    {view && <>
      <BoundsMaterial view={view} />
      {owner && view.editor && <>
        <button type="button" className={boundsButton} disabled={blocked} onClick={() => {
          if (!('vendorId' in target)) return
          const body = { expectedSourceRevision: view.source.sourceRevision, expectedInventoryRevision: view.source.inventoryRevision }
          send((key, assertCurrent) => captureLegacyCalendarInventory(target.vendorId, source.sourceId, body, key, { assertCurrent }))
        }}>{t('Зафиксировать текущий состав источника')}</button>
        <LegacyCalendarBoundsEditor view={view} disabled={blocked} onPropose={body => {
          if (!('vendorId' in target)) return
          const frozen = structuredClone(body)
          send((key, assertCurrent) => proposeLegacyCalendar(target.vendorId, source.sourceId, frozen, key, { assertCurrent }))
        }} />
        <p className="text-xs">{t('Согласие исполнителя даётся отдельно в соответствующем заказе. Редактор владельца не подписывает за участников.')}</p>
      </>}
      {!owner && <HolderApproval key={`${epoch}:${blocked}`} view={view} disabled={blocked} onAccept={() => {
        if (!view.proposal || !view.readToken || !('weddingId' in target)) return
        const body = { boundsVersionId: view.proposal.id, expectedVersion: view.proposal.version, digest: view.proposal.digest, readToken: view.readToken }
        send((key, assertCurrent) => acceptOwnLegacyCalendar(target.weddingId, target.dealId, source.sourceId, body, key, { assertCurrent }))
      }} />}
      <button type="button" className={boundsButton} disabled={blocked || !view.readiness.canActivate} onClick={activate}>{t('Активировать границы всей группы')}</button>
      <p className="text-xs">{t('Активация — отдельное действие после всех необходимых согласий. Последнее согласие не запускает её автоматически.')}</p>
      {view.history.length > 0 && <details><summary className="min-h-11 cursor-pointer py-2 text-sm">{t('История границ')}</summary><ul className="space-y-2">{view.history.map(row => <li key={row.id} className="text-sm break-words">{t('Версия')} {row.version} · {row.createdAt} · {t(row.effective ? 'Действует' : 'Историческая версия')}
        {!owner && <button type="button" className={boundsButton} disabled={busy || !!pending || !enabled} onClick={() => void read(row.id)}>{t('Прочитать историческую версию')}</button>}</li>)}</ul></details>}
    </>}
  </section>
}
function HolderApproval({ view, disabled, onAccept }: { view: CalendarBoundsView; disabled: boolean; onAccept: () => void }) {
  const [checked, setChecked] = useState(false)
  return <div className="min-w-0 space-y-2">
    {view.acceptedByCaller && <p className="text-sm">{t('Ваше согласие на эту версию уже записано')}</p>}
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0" checked={checked && !disabled} disabled={disabled || !view.readToken || !view.readiness.canAccept} onChange={e => setChecked(e.target.checked)} />{t('Я прочитал точную версию границ, все периоды, пояс и покрытие работ своего заказа')}</label>
    <button type="button" className={boundsButton} disabled={disabled || !checked || !view.readToken || !view.readiness.canAccept} onClick={onAccept}>{t('Принять эту версию границ')}</button>
  </div>
}
function SourceStatus({ source }: { source: CalendarSourceSummary }) {
  return <div className="text-xs space-y-1">
    <p>{t(source.state === 'finite' ? 'Конечные границы' : source.state === 'calendar_closed' ? 'Календарные работы завершены' : 'Границы не установлены')} · {t(source.freshness === 'current' ? 'Сведения актуальны' : source.freshness === 'stale' ? 'Сведения устарели' : 'Текущий состав недоступен')}</p>
    <p>{t('Обязательств в группе:')} {source.holderCount} · {t(source.scopeCompleteness === 'complete' ? 'Состав известен' : 'Состав неизвестен')}</p>
    {source.originDate && <p>{t('Исходная дата источника:')} {source.originDate}</p>}
    {source.proposedVersionId && <p>{t('Есть предложение границ')}</p>}{source.effectiveVersionId && <p>{t('Есть активированная версия границ')}</p>}
    {source.conflicted && <p role="alert">{t('Есть пересечение календарных обязательств')}</p>}
    {source.updatedAt && <p>{t('Обновлено:')} {source.updatedAt}</p>}
  </div>
}
function sourceKind(kind: CalendarSourceSummary['kind']): string {
  return t(({ app_day: key('Прежняя занятость на день'), app_root: key('Обязательство по заказу'), manual_day: key('Ручная занятость'), orphan_day: key('Источник без подтверждённого владельца'), live_negotiation: key('Действующие переговоры') })[kind])
}
function BoundsMaterial({ view }: { view: CalendarBoundsView }) {
  const proposal = view.proposal
  return <div className="min-w-0 space-y-3">
    {proposal ? <>
      <p className="text-sm font-semibold">{t('Версия границ')} {proposal.version}</p>
      {(proposal.holders ?? (proposal.ownHolder ? [proposal.ownHolder] : [])).map(holder => <article key={holder.id} className="min-w-0 border-l-2 border-[var(--line)] pl-3 space-y-2"><h4 className="text-sm font-semibold break-words">{holder.label || t('Обязательство')}</h4><OutcomeMaterial outcome={holder.outcome} spans={holder.spans} /><p className="text-xs">{t('Пара:')} {t(holder.accepted.customer ? 'Согласие записано' : 'Согласие отсутствует')} · {t('Исполнитель:')} {t(holder.accepted.performer ? 'Согласие записано' : 'Согласие отсутствует')}</p></article>)}
      {proposal.manualBounds && <OutcomeMaterial outcome={proposal.manualBounds.outcome} spans={proposal.manualBounds.spans} />}
      <p className="text-xs">{t(proposal.staffing.completeness === 'declared_complete' ? 'Заявлен полный состав людей' : 'Состав людей не подтверждён')}</p>
    </> : <p className="text-sm">{t('Предложения границ пока нет')}</p>}
    <p className="text-sm">{t('Текущих согласий:')} {view.readiness.acceptedReceipts} / {view.readiness.requiredReceipts}</p>
    {view.readiness.hasStaleReceipts && <p role="alert" className="text-sm">{t('Есть устаревшие согласия. Требуется новое предложение и новое чтение.')}</p>}
    <ul className="text-xs space-y-1">{view.receipts.map(receipt => <li key={receipt.id}>{t(receipt.party === 'customer' ? 'Согласие пары' : 'Согласие исполнителя')} · {receipt.acceptedAt}</li>)}</ul>
  </div>
}
function wholeDayDuration(span: CalendarSpan): string {
  if (!/Z$/.test(span.startsAt) || !/Z$/.test(span.endsAt)) return t('Фактическая длительность недоступна')
  const hours = (Date.parse(span.endsAt) - Date.parse(span.startsAt)) / 3_600_000
  return Number.isFinite(hours) && hours >= 0 ? t('Фактическая длительность: {hours} ч.').replace('{hours}', String(hours)) : t('Фактическая длительность недоступна')
}
function OutcomeMaterial({ outcome, spans }: { outcome: 'finite' | 'calendar_closed'; spans: CalendarSpan[] }) {
  if (outcome === 'calendar_closed') return <p className="text-sm">{t('Все календарные работы завершены, оставшихся выездов и возвратов нет')}</p>
  return <ul className="min-w-0 space-y-3">{spans.map((span, index) => <li key={index} className="min-w-0 break-words text-sm space-y-1">
    <p>{t('Местное время:')} {span.localStartsAt} — {span.localEndsAt}</p><p>{t('Часовой пояс:')} {span.timeZone}</p>
    <p>{t('UTC:')} {span.startsAt} — {span.endsAt}</p>{span.originalDate && <p>{t('Подтверждённая исходная дата:')} {span.originalDate}</p>}
    {span.spanMode === 'whole_local_day' && <p>{wholeDayDuration(span)}</p>}
    <p>{t('Указано со смещением:')} {span.suppliedStartsAt} — {span.suppliedEndsAt}</p>
    <p>{t('Покрыты подготовка, дорога, передача, возврат и остальные работы')}</p>
  </li>)}</ul>
}
