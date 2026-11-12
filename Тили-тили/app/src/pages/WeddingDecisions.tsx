import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { ApiError } from '@/lib/api/client'
import { createCoupleDecision, getCoupleDecisions, proposeCoupleDecision, respondCoupleDecision } from '@/lib/api/coupleDecisions'
import type { CoupleDecision, CoupleDecisionCreate } from '@/lib/api/coupleDecisions'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { useLegacyActionScope, useLegacySessionKey, type LegacyAction } from '@/lib/useLegacyActionScope'

type Answer = NonNullable<CoupleDecision['proposal']['myResponse']>
type Save = (action: (origin: LegacyAction) => Promise<unknown>) => Promise<boolean>
const fieldClass = 'min-h-11 w-full rounded-xl border border-[var(--line)] bg-transparent px-3 py-2 text-sm'
const actionClass = 'press min-h-11 rounded-xl bg-[var(--sage-soft)] px-4 py-2 text-sm font-semibold disabled:opacity-50'
const answerLabel = (answer: Answer | null) => answer === 'approved' ? t('Согласие получено')
  : answer === 'rejected' ? t('Предложение отклонено') : t('Ответа пока нет')

function DecisionCard({ item, weddingId, disabled, save }: {
  item: CoupleDecision; weddingId: string; disabled: boolean; save: Save
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.proposal.text)
  const draftId = useId()
  const current = item.proposal
  const agreed = item.effective?.version === current.version
  const reply = (response: Answer) => void save(origin =>
    respondCoupleDecision(weddingId, item.id, { version: current.version, response }, origin))
  const propose = async (event: FormEvent) => {
    event.preventDefault()
    if (await save(origin => proposeCoupleDecision(weddingId, item.id,
      { expectedVersion: current.version, proposal: draft.trim() }, origin))) setEditing(false)
  }
  return <article className="card min-w-0 space-y-3 p-4">
    <h2 className="break-words text-base font-bold">{item.title}</h2>
    <div className="space-y-1">
      <p className="text-sm font-semibold">{t('Предложение, версия {version}').replace('{version}', String(current.version))}</p>
      <p className="whitespace-pre-wrap break-words text-sm">{current.text}</p>
    </div>
    <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
      <div><dt className="font-semibold">{t('Ваш ответ')}</dt><dd>{answerLabel(current.myResponse)}</dd></div>
      <div><dt className="break-words font-semibold">{item.partnerName || t('Ответ партнёра')}</dt><dd>{answerLabel(current.partnerResponse)}</dd></div>
    </dl>
    <div className="rounded-xl bg-[var(--sage-soft)] p-3 text-sm">
      <p className="font-semibold">{item.effective
        ? t('Действующая версия {version}').replace('{version}', String(item.effective.version))
        : t('Пока нет согласованной версии')}</p>
      {item.effective && !agreed && <p className="whitespace-pre-wrap break-words">{item.effective.text}</p>}
    </div>
    {!item.partnerAvailable ? <p className="text-sm">{t('Партнёр больше не может согласовать это решение')}</p> : <>
      {!agreed && <div className="flex flex-wrap gap-2">
        <button type="button" className={actionClass} disabled={disabled || current.myResponse === 'approved'} onClick={() => reply('approved')}>{t('Согласиться')}</button>
        <button type="button" className={actionClass} disabled={disabled || current.myResponse === 'rejected'} onClick={() => reply('rejected')}>{t('Отклонить предложение')}</button>
      </div>}
      {editing ? <form onSubmit={propose} className="space-y-2">
        <label htmlFor={draftId} className="block text-sm font-semibold">{t('Новый вариант')}</label>
        <textarea id={draftId} className={fieldClass} rows={3} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} required />
        <div className="flex flex-wrap gap-2">
          <button className={actionClass} disabled={disabled || !draft.trim() || draft.trim() === current.text}>{t('Отправить на согласование')}</button>
          <button type="button" className="press min-h-11 px-3 text-sm" onClick={() => setEditing(false)}>{t('Отмена')}</button>
        </div>
      </form> : <button type="button" className={actionClass} disabled={disabled} onClick={() => { setDraft(current.text); setEditing(true) }}>{t('Предложить новый вариант')}</button>}
    </>}
  </article>
}

export default function WeddingDecisions() {
  const { weddingId } = useStore()
  const scope = useLegacySessionKey(weddingId ?? '')
  return <DecisionBoard key={scope} scope={scope} weddingId={weddingId} />
}

function DecisionBoard({ scope, weddingId }: { scope: string; weddingId: string | null }) {
  const capture = useLegacyActionScope(scope, weddingId)
  const q = useApi(() => weddingId ? getCoupleDecisions(weddingId, capture()) : noWedding(), [weddingId, capture])
  const [title, setTitle] = useState('')
  const [proposal, setProposal] = useState('')
  const [partner, setPartner] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fieldId = useId()
  const pending = useRef(false)
  const lastCreate = useRef<CoupleDecisionCreate | null>(null)
  const reload = q.reload
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  const save: Save = async action => {
    if (pending.current) return false
    const origin = capture()
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await action(origin)
      if (!origin.isCurrent()) return false
      reload()
      return true
    } catch (cause) {
      if (origin.isCurrent()) {
        setError(explainError(cause))
        if (cause instanceof ApiError && cause.status === 409) reload()
      }
      return false
    } finally {
      pending.current = false
      if (origin.isCurrent()) setBusy(false)
    }
  }
  const data = ready(q) ? q.data : null
  const partnerId = partner || (data?.partners.length === 1 ? data.partners[0]!.userId : '')
  const selectedPartner = data?.partners.some(person => person.userId === partnerId) ? partnerId : ''
  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!weddingId || !selectedPartner || !title.trim() || !proposal.trim()) return
    const draft = { title: title.trim(), proposal: proposal.trim(), partnerId: selectedPartner }
    const previous = lastCreate.current
    const requestId = previous && previous.title === draft.title && previous.proposal === draft.proposal && previous.partnerId === draft.partnerId
      ? previous.requestId : crypto.randomUUID()
    const body = { ...draft, requestId }
    lastCreate.current = body
    if (await save(origin => createCoupleDecision(weddingId, body, origin))) {
      lastCreate.current = null
      setTitle('')
      setProposal('')
    }
  }
  const disabled = busy || q.refreshing || Boolean(data?.readOnly)
  return <div className="pb-28">
    <TopBar back title={t('Согласования')} />
    <div className="space-y-4 px-5">
      <AsyncState q={q} />
      {error && <p role="alert" className="card p-3 text-sm">{error}</p>}
      {weddingId && data && <>
        <button type="button" className={actionClass} disabled={busy || q.refreshing} onClick={reload}>{t('Обновить')}</button>
        {data.readOnly ? <p className="card p-4 text-sm">{t('Свадьба отменена')}</p>
          : data.partners.length === 0 ? <p className="card p-4 text-sm">{t('Пригласите второго партнёра, чтобы согласовать решение')}</p>
            : <form className="card space-y-3 p-4" onSubmit={create}>
              <div className="space-y-1">
                <label htmlFor={`${fieldId}-title`} className="block text-sm font-semibold">{t('Решение')}</label>
                <input id={`${fieldId}-title`} className={fieldClass} maxLength={120} value={title} onChange={event => setTitle(event.target.value)} required />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${fieldId}-proposal`} className="block text-sm font-semibold">{t('Предложенный вариант')}</label>
                <textarea id={`${fieldId}-proposal`} className={fieldClass} rows={3} maxLength={2000} value={proposal} onChange={event => setProposal(event.target.value)} required />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${fieldId}-partner`} className="block text-sm font-semibold">{t('Партнёр для согласования')}</label>
                <select id={`${fieldId}-partner`} className={fieldClass} value={selectedPartner} onChange={event => setPartner(event.target.value)} required>
                  <option value="">{t('Выберите партнёра')}</option>
                  {data.partners.map((person, index) => <option key={person.userId} value={person.userId}>{person.name || `${t('Партнёр')} ${index + 1}`}</option>)}
                </select>
              </div>
              <button className={actionClass} disabled={disabled || !title.trim() || !proposal.trim() || !selectedPartner}>{t('Отправить на согласование')}</button>
            </form>}
        {data.items.length === 0 && <p className="text-sm text-[var(--soft)]">{t('Согласований пока нет')}</p>}
        {data.items.map(item => <DecisionCard key={`${item.id}:${item.proposal.version}`} item={item} weddingId={weddingId} disabled={disabled} save={save} />)}
      </>}
    </div>
  </div>
}
