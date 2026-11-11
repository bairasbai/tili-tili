import { useCallback, useId, useRef, useState, type FormEvent } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { getMembers } from '@/lib/api/weddingData'
import { getPlanBSettings, savePlanBSettings, type PlanBScenario, type PlanBSettings, type PlanBSettingsInput } from '@/lib/api/weddingWrite'
import { t } from '@/lib/i18n'
import { useLegacyActionScope } from '@/lib/useLegacyActionScope'

type EditorProps = { weddingId: string; scenario: PlanBScenario; title: string; close: () => void }
type Member = { id: string; name: string }
type Action = { id: string; title: string; responsibleUserId: string }
type Contact = { id: string; label: string; value: string }
type Draft = {
  revision: string | null
  reason: string
  triggerCondition: string
  reserveAddress: string
  actions: Action[]
  contacts: Contact[]
}

async function readEditor(weddingId: string, scenario: PlanBScenario, assertCurrent: () => void) {
  const [{ plan }, team] = await Promise.all([
    getPlanBSettings(weddingId, scenario, assertCurrent),
    getMembers(weddingId, { assertCurrent }),
  ])
  assertCurrent()
  return {
    plan,
    members: team.flatMap(member => member.user?.id ? [{ id: member.user.id, name: member.user.name ?? '' }] : []),
  }
}

function toDraft(plan: PlanBSettings): Draft {
  return {
    revision: plan?.revision ?? null,
    reason: plan?.reason ?? '',
    triggerCondition: plan?.triggerCondition ?? '',
    reserveAddress: plan?.reserveAddress ?? '',
    actions: plan ? plan.actions.map((action, index) => ({
      id: `saved-action-${index}`, title: action.title, responsibleUserId: action.responsibleUserId ?? '',
    })) : [{ id: 'first-action', title: '', responsibleUserId: '' }],
    contacts: plan?.contacts.map((contact, index) => ({ ...contact, id: `saved-contact-${index}` })) ?? [],
  }
}

function toInput(draft: Draft, members: Member[]): PlanBSettingsInput | null {
  const reason = draft.reason.trim(), triggerCondition = draft.triggerCondition.trim()
  const actions = draft.actions.map(({ title, responsibleUserId }) => ({ title: title.trim(), responsibleUserId }))
  const contacts = draft.contacts.map(({ label, value }) => ({ label: label.trim(), value: value.trim() }))
  if (!reason || !triggerCondition || actions.some(action =>
    !action.title || !members.some(member => member.id === action.responsibleUserId),
  ) || contacts.some(contact => !contact.label || !contact.value)) return null
  return { expectedRevision: draft.revision, reason, triggerCondition, reserveAddress: draft.reserveAddress.trim() || null, actions, contacts }
}

export function PlanBScenarioEditor(props: EditorProps) {
  const { weddingId, scenario, title, close } = props
  const heading = useId()
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => { node?.focus() }, [])
  const capture = useLegacyActionScope(scenario, weddingId)
  const q = useApi(() => readEditor(weddingId, scenario, capture().assertCurrent), [weddingId, scenario, capture])
  return (
    <section aria-labelledby={heading} className="mt-3 space-y-3 rounded-2xl border border-[var(--line)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={heading} tabIndex={-1} ref={focusHeading} className="text-sm font-semibold">
          {t('Настройки сценария')} · {title}
        </h3>
        <Button type="button" variant="ghost" size="sm" onClick={close}>{t('Закрыть')}</Button>
      </div>
      <AsyncState q={q} />
      {ready(q) && q.data && <ScenarioForm {...props} initial={q.data} capture={capture} />}
    </section>
  )
}

function ScenarioForm({ weddingId, scenario, initial, capture }: EditorProps & {
  initial: { plan: PlanBSettings; members: Member[] }
  capture: ReturnType<typeof useLegacyActionScope>
}) {
  const formId = useId(), nextId = useRef(0), inFlight = useRef(false)
  const [draft, setDraft] = useState(() => toDraft(initial.plan))
  const [members, setMembers] = useState(initial.members)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const edit = (update: (current: Draft) => Draft) => {
    setDraft(update)
    setSaved(false)
    setError(null)
  }
  const changeAction = (id: string, fields: Partial<Omit<Action, 'id'>>) =>
    edit(current => ({ ...current, actions: current.actions.map(row => row.id === id ? { ...row, ...fields } : row) }))
  const changeContact = (id: string, fields: Partial<Omit<Contact, 'id'>>) =>
    edit(current => ({ ...current, contacts: current.contacts.map(row => row.id === id ? { ...row, ...fields } : row) }))

  const run = async (work: (assertCurrent: () => void) => Promise<void>) => {
    if (inFlight.current || !navigator.onLine) return
    const origin = capture()
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await work(origin.assertCurrent)
    } catch (failure) {
      if (!origin.isCurrent()) return
      if (failure instanceof ApiError) {
        if ([401, 403, 404].includes(failure.status)) {
          setAccessError(explainError(failure))
          return
        }
        if (failure.code === 'planb_scenario_changed') {
          setConflict(true)
          return
        }
      }
      setError(explainError(failure))
    } finally {
      inFlight.current = false
      if (origin.isCurrent()) setBusy(false)
    }
  }
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (conflict) return
    const body = toInput(draft, members)
    if (!body) {
      setError(t('Заполните обязательные поля и выберите ответственных из команды.'))
      return
    }
    void run(async assertCurrent => {
      const { plan } = await savePlanBSettings(weddingId, scenario, body, assertCurrent)
      assertCurrent()
      setDraft(toDraft(plan))
      setSaved(true)
    })
  }
  const loadLatest = () => void run(async assertCurrent => {
    const latest = await readEditor(weddingId, scenario, assertCurrent)
    setDraft(toDraft(latest.plan))
    setMembers(latest.members)
    setConflict(false)
  })

  if (accessError) return <p role="alert" className="text-sm text-[var(--rose-ink)]">{accessError}</p>
  return (
    <form onSubmit={save} className="space-y-3 text-sm">
      <fieldset disabled={busy} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-reason`}>{t('Причина')}</Label>
          <Textarea id={`${formId}-reason`} required maxLength={1000} value={draft.reason}
            onChange={event => edit(current => ({ ...current, reason: event.target.value }))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-trigger`}>{t('Когда включать')}</Label>
          <Textarea id={`${formId}-trigger`} required maxLength={1000} value={draft.triggerCondition}
            onChange={event => edit(current => ({ ...current, triggerCondition: event.target.value }))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-address`}>{t('Резервный адрес или точка сбора')}</Label>
          <Input id={`${formId}-address`} maxLength={500} value={draft.reserveAddress}
            onChange={event => edit(current => ({ ...current, reserveAddress: event.target.value }))} />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">{t('Действия')}</legend>
          {draft.actions.map((action, index) => {
            const id = `${formId}-${action.id}`
            return (
              <fieldset key={action.id} className="space-y-2 rounded-xl border border-[var(--line)] p-2">
                <legend className="px-1 text-xs">{t('Действие')} {index + 1}</legend>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-title`}>{t('Что сделать')}</Label>
                  <Input id={`${id}-title`} required maxLength={500} value={action.title}
                    onChange={event => changeAction(action.id, { title: event.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-person`}>{t('Ответственный')}</Label>
                  <select id={`${id}-person`} required
                    className="w-full min-h-10 rounded-md border border-input bg-background px-2"
                    value={members.some(member => member.id === action.responsibleUserId) ? action.responsibleUserId : ''}
                    onChange={event => changeAction(action.id, { responsibleUserId: event.target.value })}>
                    <option value="">{t('Выберите ответственного')}</option>
                    {members.map(member => <option key={member.id} value={member.id}>{member.name || t('Имя не указано')}</option>)}
                  </select>
                </div>
                {draft.actions.length > 1 && <Button type="button" variant="ghost" size="sm"
                  onClick={() => edit(current => ({ ...current, actions: current.actions.filter(row => row.id !== action.id) }))}>
                  {t('Убрать действие')}
                </Button>}
              </fieldset>
            )
          })}
          <Button type="button" variant="outline" size="sm" disabled={draft.actions.length >= 20} onClick={() => {
            const action = { id: `new-action-${++nextId.current}`, title: '', responsibleUserId: '' }
            edit(current => ({ ...current, actions: [...current.actions, action] }))
          }}>{t('Добавить действие')}</Button>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">{t('Закрытые контакты')}</legend>
          <p className="text-xs text-[var(--soft)]">{t('Видны только паре и координатору.')}</p>
          {draft.contacts.map((contact, index) => {
            const id = `${formId}-${contact.id}`
            return (
              <fieldset key={contact.id} className="space-y-2 rounded-xl border border-[var(--line)] p-2">
                <legend className="px-1 text-xs">{t('Контакт')} {index + 1}</legend>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-label`}>{t('К кому обратиться')}</Label>
                  <Input id={`${id}-label`} required maxLength={100} value={contact.label}
                    onChange={event => changeContact(contact.id, { label: event.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-value`}>{t('Телефон или другой контакт')}</Label>
                  <Input id={`${id}-value`} required maxLength={250} value={contact.value}
                    onChange={event => changeContact(contact.id, { value: event.target.value })} />
                </div>
                <Button type="button" variant="ghost" size="sm"
                  onClick={() => edit(current => ({ ...current, contacts: current.contacts.filter(row => row.id !== contact.id) }))}>
                  {t('Убрать контакт')}
                </Button>
              </fieldset>
            )
          })}
          <Button type="button" variant="outline" size="sm" disabled={draft.contacts.length >= 8} onClick={() => {
            const contact = { id: `new-contact-${++nextId.current}`, label: '', value: '' }
            edit(current => ({ ...current, contacts: [...current.contacts, contact] }))
          }}>{t('Добавить контакт')}</Button>
        </fieldset>
      </fieldset>
      {saved && <p role="status">{t('Сценарий сохранён.')}</p>}
      {conflict && (
        <div className="space-y-2">
          <p role="alert">{t('Сценарий изменился. Загрузка актуальной версии заменит ваш черновик.')}</p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={loadLatest}>
            {t('Загрузить актуальную версию')}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="text-[var(--rose-ink)]">{error}</p>}
      <Button type="submit" disabled={busy || conflict}>{t(busy ? 'Сохраняем…' : 'Сохранить сценарий')}</Button>
    </form>
  )
}
