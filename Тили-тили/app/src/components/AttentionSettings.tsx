import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, onSessionExpired } from '@/lib/api/client'
import { getAttention, patchAttention, type AttentionMode, type WeddingAttention } from '@/lib/api/attention'
import { explainError, useApi } from '@/lib/api/useApi'
import { key, t } from '@/lib/i18n'
import { AsyncState, ready } from './AsyncState'

interface Props { weddingId: string; coordinators: readonly { id: string; name: string }[] }
const modes = [
  { id: 'essential', label: key('Только важное'), description: key('Решения и существенные проблемы; остальные обновления доступны в приложении.') },
  { id: 'coordinator', label: key('Через координатора'), description: key('Оперативные вопросы получает выбранный координатор в пределах своих прав.') },
  { id: 'detailed', label: key('Подробный обзор'), description: key('Дополнительные обновления для пары без дополнительных отчётов подрядчиков.') },
] as const
const modeLabel = (mode: AttentionMode) => modes.find(item => item.id === mode)!.label

function validAttention(value: WeddingAttention): boolean {
  if (!value || typeof value.version !== 'string' || !/^[1-9]\d*$/.test(value.version) || !modes.some(item => item.id === value.mode)
    || !modes.some(item => item.id === value.effectiveMode)) return false
  if (value.coordinatorUserId !== null && typeof value.coordinatorUserId !== 'string') return false
  if (value.coordinatorState === 'active') {
    if (!value.coordinator || value.coordinator.id !== value.coordinatorUserId || typeof value.coordinator.name !== 'string') return false
  } else if (value.coordinatorState === 'not_selected') {
    if (value.coordinatorUserId !== null || value.coordinator !== null) return false
  } else if (value.coordinatorState === 'unavailable') {
    if (!value.coordinatorUserId || value.coordinator !== null) return false
  } else return false
  return value.effectiveMode === (value.mode === 'coordinator' && value.coordinatorState !== 'active' ? 'essential' : value.mode)
}

export function AttentionSettings(props: Props) {
  const [expired, setExpired] = useState(false)
  useEffect(() => onSessionExpired(() => setExpired(true)), [])
  // A ready accepted roster is an authority boundary, not a periodic refresh.
  // Invalidate its entire reader immediately so an old active identity cannot
  // survive while a fresh attention read is unresolved or denied.
  const readContext = JSON.stringify([props.weddingId, ...props.coordinators.map(person => person.id).sort()])
  return <section aria-label={t('Уведомления свадьбы')} className="min-w-0 break-words rounded-2xl border border-[var(--line)] p-4">
    <h2 className="text-sm font-semibold">{t('Уведомления свадьбы')}</h2>
    <p className="text-xs text-[var(--soft)] mt-1">{t('Выбор необязателен. Режим можно изменить позднее; права участников сохраняются.')}</p>
    {expired ? <p role="alert" className="text-sm mt-3">{t('Сессия истекла — войдите снова')}</p> : <AttentionRead key={readContext} {...props} />}
  </section>
}

function AttentionRead(props: Props) {
  const q = useApi(() => getAttention(props.weddingId), [props.weddingId])
  const snapshot = q.data
  const coherent = snapshot && validAttention(snapshot.data) && snapshot.etag === `"${snapshot.data.version}"`
    && (snapshot.data.coordinatorState !== 'active' || props.coordinators.some(person => person.id === snapshot.data.coordinatorUserId))
  return <>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {ready(q) && !q.refreshing && (coherent
      ? <AttentionEditor {...props} initial={snapshot.data} />
      : <div className="mt-3"><p role="alert" className="text-sm">{t('Настройки не подтверждены сервером — обновите их')}</p><button type="button" onClick={q.reload} className="press min-h-11 mt-2 px-3 rounded-xl card-s">{t('Повторить')}</button></div>)}
  </>
}

function AttentionEditor({ weddingId, coordinators, initial }: Props & { initial: WeddingAttention }) {
  const [server, setServer] = useState(initial)
  const [mode, setMode] = useState(initial.mode)
  const [coordinatorId, setCoordinatorId] = useState(initial.coordinatorUserId)
  const [busy, setBusy] = useState(false)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [closed, setClosed] = useState(false)
  const [message, setMessage] = useState<{ text: string; kind: 'error' | 'saved' | 'conflict' } | null>(null)
  const alive = useRef(true), inFlight = useRef(false)
  const edited = useRef({ mode: false, coordinator: false })
  const id = useId()
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const options = coordinators.filter((person, index) => coordinators.findIndex(other => other.id === person.id) === index
    && !(server.coordinatorState === 'unavailable' && person.id === server.coordinatorUserId))
  const selectedAvailable = coordinatorId === null || options.some(person => person.id === coordinatorId)
  const changed = mode !== server.mode || coordinatorId !== server.coordinatorUserId
  const refuse = (error: unknown) => {
    if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) setClosed(true)
    setMessage({ text: explainError(error), kind: 'error' })
  }
  const refresh = async () => {
    const snapshot = await getAttention(weddingId)
    if (!alive.current) return
    if (!validAttention(snapshot.data) || snapshot.etag !== `"${snapshot.data.version}"`) throw new Error('Unconfirmed attention snapshot')
    setServer(snapshot.data)
    // Preserve entered choices, but never overwrite the partner's unrelated
    // changes just because untouched fields were copied into our initial draft.
    if (!edited.current.mode) setMode(snapshot.data.mode)
    if (!edited.current.coordinator) setCoordinatorId(snapshot.data.coordinatorUserId)
    setRefreshRequired(false)
    setMessage({ text: t('Настройки изменились. Ваш выбор сохранён в форме — проверьте его и сохраните снова.'), kind: 'conflict' })
  }
  const retryRefresh = async () => {
    if (inFlight.current || closed) return
    inFlight.current = true; setBusy(true)
    try { await refresh() } catch (error) { if (alive.current) refuse(error) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const save = async () => {
    if (inFlight.current || closed || refreshRequired || !changed) return
    if (!selectedAvailable && coordinatorId !== server.coordinatorUserId) {
      setMessage({ text: t('Выберите действующего координатора или снимите выбор'), kind: 'error' }); return
    }
    inFlight.current = true; setBusy(true); setMessage(null)
    const patch = {
      ...(mode !== server.mode ? { mode } : {}),
      ...(coordinatorId !== server.coordinatorUserId ? { coordinatorUserId: coordinatorId } : {}),
    }
    try {
      const result = await patchAttention(weddingId, server.version, patch)
      if (!alive.current) return
      if (!validAttention(result) || result.mode !== mode || result.coordinatorUserId !== coordinatorId || BigInt(result.version) <= BigInt(server.version)) { setRefreshRequired(true); setMessage({ text: t('Настройки не подтверждены сервером — обновите их'), kind: 'error' }); return }
      setServer(result); setMode(result.mode); setCoordinatorId(result.coordinatorUserId)
      edited.current = { mode: false, coordinator: false }
      setMessage({ text: t('Настройки сохранены'), kind: 'saved' })
    } catch (error) {
      if (!alive.current) return
      if (error instanceof ApiError && error.status === 409) {
        setRefreshRequired(true)
        try { await refresh() } catch (refreshError) { if (alive.current) refuse(refreshError) }
      } else refuse(error)
    } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  if (closed) return <p role="alert" className="text-sm mt-3 text-[var(--rose-ink)]">{message?.text}</p>
  return <form onSubmit={event => { event.preventDefault(); void save() }} className="min-w-0 mt-3">
    <p className="text-xs">{t('Сейчас действует:')} <strong>{t(modeLabel(server.effectiveMode))}</strong></p>
    {server.mode === 'coordinator' && server.coordinatorState !== 'active' && <p role="status" className="text-xs mt-2 text-[var(--soft)]">{t('Координатор не выбран или недоступен. Сейчас действует «Только важное».')}</p>}
    <fieldset disabled={busy} className="min-w-0 space-y-2 mt-3">
      <legend className="text-xs font-semibold mb-2">{t('Как получать обновления')}</legend>
      {modes.map(item => <label key={item.id} className="flex items-start gap-3 rounded-xl border border-[var(--line)] p-3 min-w-0 cursor-pointer">
        <input type="radio" name={`${id}-mode`} value={item.id} checked={mode === item.id} onChange={() => { if (!inFlight.current) { edited.current.mode = true; setMode(item.id); setMessage(null) } }} className="mt-1 shrink-0" />
        <span className="min-w-0 text-sm"><span className="font-semibold">{t(item.label)}</span><span className="block text-xs text-[var(--soft)] mt-1">{t(item.description)}</span></span>
      </label>)}
      <label htmlFor={`${id}-coordinator`} className="block text-xs font-semibold pt-2">{t('Координатор для оперативных вопросов')}</label>
      <select id={`${id}-coordinator`} value={coordinatorId ?? ''} onChange={event => { if (!inFlight.current) { edited.current.coordinator = true; setCoordinatorId(event.target.value || null); setMessage(null) } }} className="block w-full min-w-0 max-w-full min-h-11 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 text-sm">
        <option value="">{t('Координатор не выбран')}</option>
        {!selectedAvailable && <option value={coordinatorId!} disabled>{t('Выбранный координатор недоступен')}</option>}
        {options.map(person => <option key={person.id} value={person.id}>{person.name || t('Без имени')}</option>)}
      </select>
      <p className="text-xs text-[var(--soft)]">{t('Здесь выбираются уже принятые координаторы. Дополнительные права не выдаются.')}</p>
    </fieldset>
    {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className="text-xs mt-3 break-words">{message.text}</p>}
    {refreshRequired && <button type="button" disabled={busy} onClick={() => void retryRefresh()} className="press min-h-11 mt-3 px-3 rounded-xl card-s disabled:opacity-40">{t('Обновить настройки')}</button>}
    <button type="submit" disabled={busy || refreshRequired || !changed} className="press min-h-11 w-full mt-3 rounded-xl grad text-[var(--on-grad)] text-sm font-semibold disabled:opacity-40">{t(busy ? 'Сохраняем…' : 'Сохранить настройки')}</button>
  </form>
}
