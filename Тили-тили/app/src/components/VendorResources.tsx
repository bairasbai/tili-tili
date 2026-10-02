import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { useApi } from '@/lib/api/useApi'
import { createResourceCapacityWindow, createVendorResource, getVendorAvailabilityPolicy, getVendorResourceOptions, getVendorResources,
  patchResourceCapacityWindow, patchVendorAvailabilityPolicy, retireVendorResource, type ResourceCapacityWindow,
  type VendorAvailabilityPolicy, type VendorResource, type VendorResourceCreate, type VendorResourceOptions } from '@/lib/api/resources'
import { parseOrderLocal, type OrderTimeResult } from '@/lib/orderTime'
import { getI18nLang, key, t } from '@/lib/i18n'
import { AsyncState, ready } from './AsyncState'

type Snapshot = { resources: VendorResource[]; options: VendorResourceOptions; policy: VendorAvailabilityPolicy }
type Command = { key: string; scope: string; run: (key: string) => Promise<unknown>; check: (reply: unknown) => boolean }
type Send = (run: Command['run'], check: Command['check'], scope: string) => void
const control = 'w-full min-w-0 max-w-full min-h-11 rounded-[12px] border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm'
const button = 'press min-h-11 rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40'
const kinds = { person: key('Человек'), equipment: key('Оборудование'), capacity: key('Мощность или вместимость') }
const modeNames = { legacy_day: key('Учёт по занятым дням'), resources: key('Учёт по ресурсам') }
const unavailable = { retired: key('Выведен из использования'), identity_unknown: key('Личность человека не подтверждена'), person_unavailable: key('Человек больше недоступен') }
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2_147_483_647
const exactVersion = (n: unknown): n is string => typeof n === 'string' && /^[1-9]\d{0,18}$/.test(n)
const nullableString = (n: unknown) => n === null || typeof n === 'string'
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function validWindow(value: unknown): value is ResourceCapacityWindow {
  return object(value) && typeof value.id === 'string' && exactVersion(value.version) && typeof value.startsAt === 'string' && typeof value.endsAt === 'string'
    && Number.isFinite(Date.parse(value.startsAt)) && Number.isFinite(Date.parse(value.endsAt)) && Date.parse(value.endsAt) > Date.parse(value.startsAt)
    && positive(value.capacity) && typeof value.used === 'number' && Number.isInteger(value.used) && value.used >= 0 && value.used <= value.capacity
}
function validResource(value: unknown): value is VendorResource {
  return object(value) && typeof value.id === 'string' && typeof value.label === 'string' && exactVersion(value.version)
    && typeof value.kind === 'string' && Object.hasOwn(kinds, value.kind) && nullableString(value.personUserId) && nullableString(value.staffMemberId)
    && nullableString(value.capacityUnit) && nullableString(value.retiredAt) && ['current', 'unavailable'].includes(String(value.source))
    && (value.unavailableReason === null || Object.hasOwn(unavailable, String(value.unavailableReason)))
    && (value.source === 'current' ? value.retiredAt === null && value.unavailableReason === null : value.unavailableReason !== null)
    && Array.isArray(value.windows) && value.windows.every(validWindow)
}
function validPolicy(value: unknown, vendorId: string): value is VendorAvailabilityPolicy {
  if (!object(value) || value.vendorId !== vendorId || !(value.revision === '0' || exactVersion(value.revision)) || !['legacy_day', 'resources'].includes(String(value.mode))
    || !nullableString(value.changedBy) || !nullableString(value.changedAt) || !object(value.legacyObligations)) return false
  const old = value.legacyObligations
  return typeof old.unresolved === 'boolean' && (old.reason === null || old.reason === 'unresolved_legacy_obligations')
    && ['manualDays', 'dealDays', 'unknownDays', 'committedDeals', 'negotiatingDeals'].every(k => typeof old[k] === 'number' && Number.isSafeInteger(old[k]) && Number(old[k]) >= 0)
}
function privacy(error: unknown): boolean { return error instanceof ApiError && [401, 403, 404, 410].includes(error.status) }
function friendly(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('Сессия истекла — войдите снова')
    if (error.status === 403) return t('Доступ к ресурсам компании закрыт')
    if (error.status === 404 || error.status === 410) return t('Ресурсы компании больше недоступны')
    if (error.status === 409 || error.status === 422) return t('Данные не приняты. Обновите сведения и проверьте форму.')
  }
  return t('Не удалось подтвердить данные ресурсов. Попробуйте ещё раз.')
}
async function load(vendorId: string, onDenied: (error: unknown) => void): Promise<Snapshot> {
  // A network failure in one read must not swallow a later permission failure
  // in its sibling. Each current reader independently observes privacy errors.
  async function guarded<T>(request: Promise<T>): Promise<T> {
    try { return await request } catch (error) { if (privacy(error)) onDenied(error); throw error }
  }
  const [resources, options, policy] = await Promise.all([guarded(getVendorResources(vendorId)), guarded(getVendorResourceOptions(vendorId)), guarded(getVendorAvailabilityPolicy(vendorId))])
  if (!Array.isArray(resources) || !resources.every(validResource) || !options || options.vendorId !== vendorId
    || !['owner', 'resource_manager'].includes(options.actorRole) || !Array.isArray(options.persons)
    || !options.persons.every(p => typeof p.userId === 'string' && nullableString(p.name) && nullableString(p.staffMemberId))
    || new Set(options.persons.map(p => p.userId)).size !== options.persons.length || !validPolicy(policy, vendorId)) throw new Error('Unconfirmed resource data')
  return { resources, options, policy }
}

/** Collapse retains an uncertain command. Company/session boundaries destroy it. */
export function VendorResources({ vendorId }: { vendorId: string }) {
  const [expired, setExpired] = useState(false)
  useEffect(() => { const clear = () => setExpired(true); const a = onSessionExpired(clear), b = onSessionChanged(clear); return () => { a(); b() } }, [])
  return <ResourceSection key={vendorId} vendorId={vendorId} expired={expired} />
}
function ResourceSection({ vendorId, expired }: { vendorId: string; expired: boolean }) {
  const [open, setOpen] = useState(false), [activated, setActivated] = useState(false), [denied, setDenied] = useState<string | null>(null)
  return <details open={open} onToggle={e => { setOpen(e.currentTarget.open); if (e.currentTarget.open) setActivated(true) }} className="min-w-0 max-w-full break-words rounded-[16px] border border-[var(--line)] p-3">
    <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{t('Ресурсы компании')}</summary>
    {activated && <div hidden={!open}>{expired || denied ? <p role="alert">{expired ? t('Сессия истекла — войдите снова') : denied}</p> : <ResourceRead vendorId={vendorId} deny={setDenied} />}</div>}
  </details>
}
function ResourceRead({ vendorId, deny }: { vendorId: string; deny: (message: string) => void }) {
  const alive = useRef(true), generation = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const q = useApi(async () => {
    const current = ++generation.current
    try { return await load(vendorId, e => { if (alive.current && generation.current === current) deny(friendly(e)) }) } catch (error) {
      // Never surface raw driver keys/UUIDs or arbitrary server messages.
      throw new Error(friendly(error))
    }
  }, [vendorId])
  return <><AsyncState q={q} />{ready(q) && !q.refreshing && q.data && <ResourceEditor vendorId={vendorId} initial={q.data} deny={deny} />}</>
}
function ResourceEditor({ vendorId, initial, deny }: { vendorId: string; initial: Snapshot; deny: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<Command | null>(null), [refreshRequired, setRefreshRequired] = useState(false), [review, setReview] = useState(false)
  const [acknowledged, setAcknowledged] = useState<{ command: Command; confirmed: boolean } | null>(null), [epochs, setEpochs] = useState<Record<string, number>>({}), [zone, setZone] = useState(''), [zoneEpoch, setZoneEpoch] = useState(0)
  const alive = useRef(true), inFlight = useRef(false), readGeneration = useRef(0), id = useId()
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const complete = (command: Command) => {
    setAcknowledged(null); setEpochs(old => ({ ...old, [command.scope]: (old[command.scope] ?? 0) + 1 })); setMessage(t('Ресурсы сохранены'))
  }
  const refresh = async () => {
    const generation = ++readGeneration.current
    const current = await load(vendorId, e => { if (alive.current && readGeneration.current === generation) { setPending(null); setAcknowledged(null); deny(friendly(e)) } })
    if (alive.current && readGeneration.current === generation) { setSnapshot(current); setRefreshRequired(false) }
  }
  const error = (e: unknown) => { if (privacy(e)) { setPending(null); setAcknowledged(null); deny(friendly(e)) } else setMessage(friendly(e)) }
  const execute = async (command: Command) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setMessage(null)
    try {
      const reply = await command.run(command.key)
      if (!alive.current) return
      // A received success must never be retransmitted just because its follow-up
      // GET failed. Invalid success bodies also require a read, not a new write.
      const confirmed = command.check(reply)
      setPending(null); setAcknowledged({ command, confirmed }); setRefreshRequired(true)
      if (!confirmed) { setReview(true); setMessage(t('Ответ о сохранении не подтверждён. Обновите ресурсы.')); return }
      try { await refresh(); if (alive.current) complete(command) } catch (e) { if (alive.current) error(e) }
    } catch (e) {
      if (!alive.current) return
      if (privacy(e)) error(e)
      else if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
        setPending(null); setReview(true); setRefreshRequired(true); setMessage(friendly(e))
        try { await refresh(); if (alive.current) setMessage(t('Сведения обновлены. Ваш ввод сохранён — проверьте его перед новой попыткой.')) } catch (readError) { if (alive.current) error(readError) }
      } else {
        setPending(command); setMessage(t('Результат сохранения неизвестен. Повторная проверка отправит то же действие.'))
      }
    } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const send: Send = (run, check, scope) => {
    if (inFlight.current || pending || refreshRequired || review) return
    void execute({ key: crypto.randomUUID(), run, check, scope })
  }
  const reload = async () => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try { await refresh(); if (alive.current) { if (acknowledged?.confirmed) complete(acknowledged.command); else { setAcknowledged(null); setMessage(t('Сведения обновлены. Ваш ввод сохранён — проверьте его перед новой попыткой.')) } } }
    catch (e) { if (alive.current) error(e) } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const disabled = busy || !!pending || refreshRequired || review
  return <div className="min-w-0 max-w-full space-y-3 pt-2">
    <p className="text-xs text-[var(--soft)]">{t('Необязательный учёт людей, оборудования и вместимости. Запись ресурса не подтверждает свободное время, бронь или готовность.')}</p>
    <p className="text-xs">{t(snapshot.options.actorRole === 'owner' ? 'Вы управляете ресурсами как владелец компании' : 'Вы управляете ресурсами по принятой роли управляющего')}</p>
    {message && <p role="status" className="text-sm break-words">{message}</p>}
    <div className="flex flex-wrap gap-2">
      {pending && <button type="button" disabled={busy} className={button} onClick={() => void execute(pending)}>{t('Проверить сохранение ресурса')}</button>}
      {refreshRequired && <button type="button" disabled={busy} className={button} onClick={() => void reload()}>{t('Обновить ресурсы')}</button>}
      {review && !refreshRequired && <button type="button" disabled={busy} className={button} onClick={() => { setReview(false); setMessage(null) }}>{t('Проверил сведения, продолжить')}</button>}
      {!disabled && <button type="button" className={button} onClick={() => { setRefreshRequired(true); void reload() }}>{t('Перечитать сведения')}</button>}
    </div>
    <details className="min-w-0"><summary className="min-h-11 py-2 cursor-pointer text-sm font-semibold">{t('Как учитывать новые обязательства')}</summary>
      <PolicyForm key={epochs.policy ?? 0} vendorId={vendorId} policy={snapshot.policy} hasResource={snapshot.resources.some(r => r.source === 'current')} disabled={disabled} send={send} />
    </details>
    <details className="min-w-0"><summary className="min-h-11 py-2 cursor-pointer text-sm font-semibold">{t('Добавить ресурс')}</summary>
      <ResourceForm key={epochs.resource ?? 0} vendorId={vendorId} options={snapshot.options} disabled={disabled} send={send} />
    </details>
    {snapshot.resources.some(r => r.kind === 'capacity') && <><label className="block text-xs font-semibold" htmlFor={`${id}-zone`}>{t('Часовой пояс для просмотра и новых окон')}</label>
    <select id={`${id}-zone`} className={control} value={zone} disabled={disabled} onChange={e => { setZone(e.target.value); setZoneEpoch(old => old + 1) }}>
      <option value="">{t('Выберите часовой пояс')}</option>{zoneOptions().map(z => <option key={z} value={z}>{zoneName(z)}</option>)}
    </select>
    {!zone && <p className="text-xs text-[var(--soft)]">{t('Часовой пояс не выбран. Местное время окон пока неизвестно.')}</p>}</>}
    {!snapshot.resources.length && <p className="text-sm">{t('Ресурсы ещё не указаны')}</p>}
    {snapshot.resources.map(resource => <article key={resource.id} className="min-w-0 max-w-full rounded-[12px] border border-[var(--line)] p-3 space-y-2">
      <h3 className="text-sm font-semibold break-words">{resource.label}</h3><p className="text-xs">{t(kinds[resource.kind])}</p>
      {resource.kind === 'person' && <p className="text-xs">{personName(snapshot.options.persons.find(p => p.userId === resource.personUserId))}</p>}
      {resource.kind === 'capacity' && <p className="text-xs">{t('Единица вместимости:')} {resource.capacityUnit ?? t('Не указана')}</p>}
      {resource.unavailableReason && <p className="text-xs">{t(unavailable[resource.unavailableReason])}</p>}
      {!resource.retiredAt && <button type="button" className={button} disabled={disabled} onClick={() => send(k => retireVendorResource(vendorId, resource.id, resource.version, k), reply => validResource(reply) && reply.id === resource.id && reply.kind === resource.kind && reply.label === resource.label && reply.retiredAt !== null && BigInt(reply.version) > BigInt(resource.version), `retire:${resource.id}`)}>{t('Вывести из использования')}</button>}
      {resource.kind === 'capacity' && <>
        {!resource.windows.length && <p className="text-xs">{t('Окна вместимости ещё не заданы')}</p>}
        {resource.windows.map(window => <div key={window.id} className="min-w-0 border-t border-[var(--line)] pt-2 space-y-2">
          <p className="text-xs break-words">{zone ? `${showTime(window.startsAt, zone)} — ${showTime(window.endsAt, zone)}` : t('Выберите часовой пояс, чтобы увидеть время окна')}</p>
          <p className="text-xs">{t('Заявлено:')} {window.capacity} · {t('Учтено в обязательствах:')} {window.used}</p>
          {resource.source === 'current' && <WindowPatch key={`${window.id}-${epochs[`window:${window.id}`] ?? 0}`} vendorId={vendorId} resourceId={resource.id} window={window} disabled={disabled} send={send} />}
        </div>)}
        {resource.source === 'current' && <details className="min-w-0"><summary className="min-h-11 py-2 cursor-pointer text-xs">{t('Добавить окно вместимости')}</summary>
          <WindowForm key={`${resource.id}-${epochs[`new-window:${resource.id}`] ?? 0}`} vendorId={vendorId} resourceId={resource.id} zone={zone} zoneEpoch={zoneEpoch} disabled={disabled} send={send} />
        </details>}
      </>}
    </article>)}
  </div>
}
function personName(person: VendorResourceOptions['persons'][number] | undefined): string {
  if (!person) return t('Человек не подтверждён текущим списком')
  return person.name?.trim() || t(person.staffMemberId === null ? 'Владелец компании — имя не указано' : 'Сотрудник — имя не указано')
}
function ResourceForm({ vendorId, options, disabled, send }: { vendorId: string; options: VendorResourceOptions; disabled: boolean; send: Send }) {
  const [kind, setKind] = useState<VendorResource['kind']>('equipment'), [label, setLabel] = useState(''), [person, setPerson] = useState(''), [unit, setUnit] = useState(''), [error, setError] = useState<string | null>(null), id = useId()
  const selected = options.persons.find(p => p.userId === person)
  return <form className="min-w-0 space-y-2" onSubmit={e => {
    e.preventDefault(); if (disabled) return
    if (!label.trim() || label.length > 200 || (kind === 'capacity' && (!unit.trim() || unit.length > 80)) || (kind === 'person' && !selected)) { setError(t('Укажите название и необходимые сведения ресурса')); return }
    const body: VendorResourceCreate = kind === 'person' && selected ? { kind, label, personUserId: selected.userId, ...(selected.staffMemberId ? { staffMemberId: selected.staffMemberId } : {}) }
      : kind === 'capacity' ? { kind, label, capacityUnit: unit } : { kind: 'equipment', label }
    setError(null); send(k => createVendorResource(vendorId, body, k), reply => validResource(reply) && reply.kind === body.kind && reply.label === body.label && reply.source === 'current'
      && reply.version === '1' && (body.kind !== 'person' || (reply.personUserId === body.personUserId && reply.staffMemberId === (body.staffMemberId ?? null)))
      && (body.kind !== 'capacity' || reply.capacityUnit === body.capacityUnit), 'resource')
  }}>
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <label htmlFor={`${id}-kind`} className="block text-xs">{t('Вид ресурса')}</label><select id={`${id}-kind`} className={control} value={kind} onChange={e => { setKind(e.target.value as VendorResource['kind']); setError(null) }}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
      <label htmlFor={`${id}-label`} className="block text-xs">{t('Название ресурса')}</label><input id={`${id}-label`} className={control} value={label} maxLength={200} onChange={e => setLabel(e.target.value)} />
      {kind === 'person' && <><label htmlFor={`${id}-person`} className="block text-xs">{t('Человек из действующей команды')}</label><select id={`${id}-person`} className={control} value={person} onChange={e => setPerson(e.target.value)}>
        <option value="">{t('Выберите человека')}</option>{person && !selected && <option value={person} disabled>{t('Выбранный человек недоступен')}</option>}{options.persons.map(p => <option key={p.userId} value={p.userId}>{personName(p)}</option>)}
      </select><p className="text-xs text-[var(--soft)]">{t('В списке только владелец и принявшие приглашение сотрудники. Выбор не подтверждает их свободное время.')}</p></>}
      {kind === 'capacity' && <><label htmlFor={`${id}-unit`} className="block text-xs">{t('Единица вместимости')}</label><input id={`${id}-unit`} className={control} value={unit} maxLength={80} placeholder={t('Например: места или порции')} onChange={e => setUnit(e.target.value)} /></>}
      <button type="submit" className={button}>{t('Сохранить ресурс')}</button>
    </fieldset>{error && <p role="alert" className="text-xs">{error}</p>}
  </form>
}
function PolicyForm({ vendorId, policy, hasResource, disabled, send }: { vendorId: string; policy: VendorAvailabilityPolicy; hasResource: boolean; disabled: boolean; send: Send }) {
  const [draft, setDraft] = useState<VendorAvailabilityPolicy['mode'] | null>(null), id = useId(), old = policy.legacyObligations, mode = draft ?? policy.mode
  return <form className="min-w-0 space-y-2" onSubmit={e => { e.preventDefault(); if (disabled || mode === policy.mode || (mode === 'resources' && !hasResource)) return; const body = { mode, expectedRevision: policy.revision }; send(k => patchVendorAvailabilityPolicy(vendorId, body, k), reply => validPolicy(reply, vendorId) && reply.mode === mode && BigInt(reply.revision) > BigInt(policy.revision), 'policy') }}>
    <p className="text-xs">{t('Сейчас действует:')} {t(modeNames[policy.mode])}</p><p className="text-xs">{t('Старые обязательства сохраняются при смене режима.')}</p>
    <dl className="text-xs grid grid-cols-2 gap-1 min-w-0"><dt>{t('Занятые дни вручную')}</dt><dd>{old.manualDays}</dd><dt>{t('Дни по заказам')}</dt><dd>{old.dealDays}</dd><dt>{t('Дни с неизвестным источником')}</dt><dd>{old.unknownDays}</dd><dt>{t('Действующие обязательства')}</dt><dd>{old.committedDeals}</dd><dt>{t('Заказы на обсуждении')}</dt><dd>{old.negotiatingDeals}</dd></dl>
    {old.unresolved && <p className="text-xs">{t('Часть старых обязательств ещё не сопоставлена с ресурсами. Этот экран не распределяет их автоматически.')}</p>}
    <label className="block text-xs" htmlFor={`${id}-mode`}>{t('Режим учёта новых обязательств')}</label><select id={`${id}-mode`} className={control} disabled={disabled} value={mode} onChange={e => setDraft(e.target.value as VendorAvailabilityPolicy['mode'])}>{Object.entries(modeNames).map(([value, label]) => <option key={value} value={value} disabled={value === 'resources' && !hasResource}>{t(label)}</option>)}</select>
    {!hasResource && <p className="text-xs text-[var(--soft)]">{t('Для учёта по ресурсам сначала укажите действующий ресурс.')}</p>}
    <button type="submit" disabled={disabled || mode === policy.mode || (mode === 'resources' && !hasResource)} className={button}>{t('Сохранить режим учёта')}</button>
  </form>
}
const zoneLabels: Record<string, string> = { 'Europe/Moscow': key('Москва'), 'Asia/Yekaterinburg': key('Екатеринбург / Уфа'), 'Europe/Berlin': key('Берлин'), 'Europe/London': key('Лондон'), 'Asia/Dubai': key('Дубай'), 'America/New_York': key('Нью-Йорк'), UTC: key('Всемирное время UTC') }
function zoneOptions(): string[] { return [...new Set(['UTC', ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : Object.keys(zoneLabels))])] }
function zoneName(zone: string): string { return zoneLabels[zone] ? `${t(zoneLabels[zone])} (${zone})` : zone.replaceAll('_', ' ') }
function showTime(instant: string, zone: string): string { return new Intl.DateTimeFormat(getI18nLang(), { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(instant)) }
function integer(value: string): number | null { if (!/^[1-9]\d{0,9}$/.test(value)) return null; const n = Number(value); return positive(n) ? n : null }
function WindowPatch({ vendorId, resourceId, window, disabled, send }: { vendorId: string; resourceId: string; window: ResourceCapacityWindow; disabled: boolean; send: Send }) {
  const [draft, setDraft] = useState<string | null>(null), [error, setError] = useState<string | null>(null), id = useId(), capacity = draft ?? String(window.capacity), count = integer(capacity)
  return <form className="min-w-0 space-y-2" onSubmit={e => { e.preventDefault(); if (disabled || count === window.capacity) return; if (count === null || count < window.used) { setError(t('Укажите положительное целое число не меньше уже учтённых обязательств')); return }; setError(null); const body = { expectedVersion: window.version, capacity: count }; send(k => patchResourceCapacityWindow(vendorId, resourceId, window.id, body, k), reply => validWindow(reply) && reply.id === window.id && reply.capacity === count && BigInt(reply.version) > BigInt(window.version) && Date.parse(reply.startsAt) === Date.parse(window.startsAt) && Date.parse(reply.endsAt) === Date.parse(window.endsAt), `window:${window.id}`) }}>
    <label className="block text-xs" htmlFor={`${id}-capacity`}>{t('Изменить заявленное количество')}</label><input id={`${id}-capacity`} className={control} disabled={disabled} type="number" min={Math.max(1, window.used)} max={2_147_483_647} step="1" value={capacity} onChange={e => setDraft(e.target.value)} />
    <button type="submit" disabled={disabled || count === window.capacity} className={button}>{t('Сохранить количество')}</button>{error && <p role="alert" className="text-xs">{error}</p>}
  </form>
}
function Clock({ name, value, zone, offset, change, choose }: { name: string; value: string; zone: string; offset: string; change: (v: string) => void; choose: (v: string) => void }) {
  const id = useId(), result = parseOrderLocal(value, zone || null)
  return <div className="min-w-0 space-y-1"><label className="block text-xs" htmlFor={id}>{t(name)}</label><input id={id} className={control} type="datetime-local" value={value} onChange={e => change(e.target.value)} />
    {value && result.status === 'gap' && <p role="alert" className="text-xs">{t('Такого местного времени нет из-за перевода часов. Выберите другое время.')}</p>}
    {result.status === 'ambiguous' && <><label className="block text-xs" htmlFor={`${id}-occurrence`}>{t('Какое повторение времени выбрать:')} {t(name)}</label><select id={`${id}-occurrence`} className={control} value={offset} onChange={e => choose(e.target.value)}>
      <option value="">{t('Выберите повторение времени')}</option>{result.candidates.map((c, index) => <option key={c.instant} value={String(c.offsetMinutes)}>{t(index === 0 ? 'Первое повторение' : 'Второе повторение')} (UTC{c.offsetMinutes < 0 ? '−' : '+'}{String(Math.floor(Math.abs(c.offsetMinutes) / 60)).padStart(2, '0')}:{String(Math.abs(c.offsetMinutes) % 60).padStart(2, '0')})</option>)}
    </select></>}
  </div>
}
function validTime(result: OrderTimeResult): string | null { return result.status === 'valid' ? result.candidate.instant : null }
function WindowForm({ vendorId, resourceId, zone, zoneEpoch, disabled, send }: { vendorId: string; resourceId: string; zone: string; zoneEpoch: number; disabled: boolean; send: Send }) {
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [startChoice, setStartChoice] = useState({ value: '', epoch: -1 }), [endChoice, setEndChoice] = useState({ value: '', epoch: -1 }), [capacity, setCapacity] = useState(''), [error, setError] = useState<string | null>(null), id = useId()
  const startOffset = startChoice.epoch === zoneEpoch ? startChoice.value : '', endOffset = endChoice.epoch === zoneEpoch ? endChoice.value : ''
  return <form className="min-w-0 space-y-2" onSubmit={e => {
    e.preventDefault(); if (disabled) return
    const from = validTime(parseOrderLocal(start, zone || null, startOffset ? Number(startOffset) : undefined)), to = validTime(parseOrderLocal(end, zone || null, endOffset ? Number(endOffset) : undefined)), count = integer(capacity)
    if (!from || !to || Date.parse(to) <= Date.parse(from) || count === null) { setError(t('Выберите часовой пояс, конечный интервал и положительное целое количество. Повторение времени нужно выбрать явно.')); return }
    setError(null); const body = { startsAt: from, endsAt: to, capacity: count }
    send(k => createResourceCapacityWindow(vendorId, resourceId, body, k), reply => validWindow(reply) && reply.capacity === count && Date.parse(reply.startsAt) === Date.parse(from) && Date.parse(reply.endsAt) === Date.parse(to), `new-window:${resourceId}`)
  }}>
    <p className="text-xs text-[var(--soft)]">{t('Окно описывает заявленную вместимость в выбранном часовом поясе и само ничего не резервирует.')}</p>
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <Clock name={key('Начало окна')} value={start} zone={zone} offset={startOffset} change={v => { setStart(v); setStartChoice({ value: '', epoch: zoneEpoch }) }} choose={value => setStartChoice({ value, epoch: zoneEpoch })} />
      <Clock name={key('Окончание окна')} value={end} zone={zone} offset={endOffset} change={v => { setEnd(v); setEndChoice({ value: '', epoch: zoneEpoch }) }} choose={value => setEndChoice({ value, epoch: zoneEpoch })} />
      <label className="block text-xs" htmlFor={`${id}-quantity`}>{t('Заявленное количество в окне')}</label><input id={`${id}-quantity`} className={control} type="number" min="1" max={2_147_483_647} step="1" value={capacity} onChange={e => setCapacity(e.target.value)} />
      <button type="submit" className={button}>{t('Сохранить окно вместимости')}</button>
    </fieldset>{error && <p role="alert" className="text-xs">{error}</p>}
  </form>
}
