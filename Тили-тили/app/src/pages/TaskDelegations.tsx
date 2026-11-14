import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { WeddingPicker } from '@/components/WeddingPicker'
import { ApiError, isAuthorized } from '@/lib/api/client'
import { getMe } from '@/lib/api/auth'
import { listMyWeddings } from '@/lib/api/wedding'
import {
  acceptTaskDelegation, getDelegatedTasks, getWeddingTaskDelegations, issueTaskDelegation,
  leaveDelegatedWedding, removeDelegatedEmployee, revokeTaskDelegation, setDelegatedTaskDone, type DelegatedTask, type TaskDelegationInvitation,
} from '@/lib/api/taskDelegations'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { appRoot, t } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { useLegacyActionScope, useLegacySessionKey, type LegacyAction } from '@/lib/useLegacyActionScope'
import { useLiveAccess } from '@/lib/offlineProgramHooks'
import { copyText } from '@/lib/utils'
import { shortWeddingDate } from '@/lib/weddingDate'

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rose-ink)]'
const button = `press min-h-11 rounded-xl bg-[var(--sage-soft)] px-4 py-2 text-sm font-semibold disabled:opacity-50 aria-disabled:opacity-50 ${focus}`
const field = `min-h-11 w-full rounded-xl border border-[var(--line)] bg-transparent px-3 py-2 text-sm ${focus}`
const inviteCode = /^[A-Za-z0-9_-]{32}$/
const employeeCodeFormat = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function useTaskDelegationAction(capture: () => LegacyAction, reload: () => void) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const online = useLiveAccess(reload)

  async function run<T>(action: (origin: LegacyAction) => Promise<T>, onSuccess?: (result: T) => void) {
    if (!navigator.onLine || pending.current) return
    const origin = capture()
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await action(origin)
      if (!origin.isCurrent()) return
      onSuccess?.(result)
      reload()
    } catch (cause) {
      if (origin.isCurrent()) {
        setError(explainError(cause))
        if (cause instanceof ApiError && [404, 409].includes(cause.status)) reload()
      }
    } finally {
      pending.current = false
      if (origin.isCurrent()) setBusy(false)
    }
  }
  return { online, busy, error, run }
}

export function WeddingTaskDelegations() {
  const { weddingId, setWeddingId } = useStore()
  const scope = useLegacySessionKey(weddingId ?? '')
  return <WeddingBoard key={scope} scope={scope} weddingId={weddingId} onSelectWedding={setWeddingId} />
}

function WeddingBoard({ scope, weddingId, onSelectWedding }: { scope: string; weddingId: string | null; onSelectWedding: (id: string) => void }) {
  const capture = useLegacyActionScope(scope, weddingId)
  const memberships = useApi(() => listMyWeddings(capture()), [capture])
  const q = useApi(() => weddingId ? getWeddingTaskDelegations(weddingId, capture()) : noWedding(), [weddingId, capture])
  const { busy, error, run } = useTaskDelegationAction(capture, q.reload)
  const [selected, setSelected] = useState('')
  const [employeeCode, setEmployeeCode] = useState('')
  const [confirmRemoval, setConfirmRemoval] = useState<string | null>(null)
  const [invitation, setInvitation] = useState<TaskDelegationInvitation | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const invitationField = useRef<HTMLInputElement>(null)
  const selectId = useId()
  const linkId = useId()
  const employeeId = useId()
  const data = ready(q) ? q.data : null
  const occupied = new Set(data?.items.map(item => item.taskId))
  const available = data?.tasks.filter(task => !occupied.has(task.id)) ?? []
  const taskId = available.some(task => task.id === selected) ? selected : ''
  const disabled = busy || q.refreshing || Boolean(data?.readOnly)
  const target = data?.requiresEmployeeCode ? employeeCode.trim() : undefined
  const targetReady = target === undefined || employeeCodeFormat.test(target)
  const employees = new Map(data?.items.flatMap(item => item.employeeId ? [[item.employeeId, item] as const] : []))
  const reassign = available.filter(task => task.needsReassignment)
  const link = invitation ? new URL(appRoot() + 'delegated-tasks#' + invitation.code, window.location.origin).href : ''
  useLayoutEffect(() => {
    if (link && document.activeElement === createButton.current) invitationField.current?.focus()
  }, [link])
  const create = (event: FormEvent) => {
    event.preventDefault()
    if (!weddingId || !taskId || disabled || !targetReady) return
    void run(origin => issueTaskDelegation(weddingId, taskId, origin, target), result => {
      setInvitation(result)
      setSelected('')
    })
  }
  return <div className="pb-28">
    <TopBar back title={t('Поручения')} sub={data?.weddingTitle} />
    <div className="space-y-4 px-5">
      {memberships.data && ready(memberships) && !memberships.refreshing && <WeddingPicker
        weddings={memberships.data.filter(w => w.role === 'couple' || w.role === 'coordinator')} weddingId={weddingId} onSelect={onSelectWedding} />}
      <AsyncState q={q} />
      {error && <p role="alert" className="card p-3 text-sm">{error}</p>}
      {weddingId && data && <>
        {data.readOnly ? <p className="card p-4 text-sm">{t('Свадьба отменена')}</p> : <>
          <form className="card space-y-3 p-4" onSubmit={create}>
            <label className="block text-sm font-semibold" htmlFor={selectId}>{t('Задача для помощника')}</label>
            <select id={selectId} className={field} value={taskId} onChange={event => setSelected(event.target.value)} required>
              <option value="">{t('Выберите задачу')}</option>
              {available.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
            {data.requiresEmployeeCode && <>
              <label className="block text-sm font-semibold" htmlFor={employeeId}>{t('Код сотрудника')}</label>
              <input id={employeeId} className={field} value={employeeCode} onChange={event => setEmployeeCode(event.target.value)}
                autoComplete="off" spellCheck={false} maxLength={36} required />
            </>}
            <button ref={createButton} className={button} aria-disabled={disabled || !taskId || !targetReady}>
              {t(data.requiresEmployeeCode ? 'Создать ссылку сотруднику' : 'Создать ссылку для помощника')}
            </button>
          </form>
          {link && <div className="card space-y-2 p-4">
            <label className="block text-sm font-semibold" htmlFor={linkId}>{t('Ссылка для помощника')}</label>
            <input ref={invitationField} id={linkId} className={field} value={link} readOnly onFocus={event => event.target.select()} />
            <p className="text-sm">{t(data.requiresEmployeeCode
              ? 'Ссылку может принять только указанный сотрудник в течение семи дней.'
              : 'Отправьте ссылку только выбранному помощнику. Принять её можно один раз в течение семи дней.')}</p>
            <button type="button" className={button} onClick={() => copyText(link)}>{t('Скопировать ссылку')}</button>
          </div>}
        </>}
        {!data.readOnly && reassign.length > 0 && <section className="card space-y-2 p-4">
          <h2 className="font-bold">{t('Задачи для переназначения')}</h2>
          {reassign.map(task => <button key={task.id} className={button} type="button" disabled={disabled} onClick={() => {
            setSelected(task.id)
            document.getElementById(selectId)?.focus()
          }}>{task.title}</button>)}
        </section>}
        {!data.readOnly && employees.size > 0 && <section className="card space-y-3 p-4">
          <h2 className="font-bold">{t('Доступ сотрудников')}</h2>
          {[...employees].map(([id, item]) => <div key={id} className="space-y-2">
            <p className="text-sm">{item.recipientName || t('Сотрудник')}</p>
            {confirmRemoval === id ? <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={disabled} onClick={() => void run(
                origin => removeDelegatedEmployee(weddingId, id, item.id, origin), () => {
                  setConfirmRemoval(null)
                  setInvitation(null)
                })}>{t('Подтвердить отзыв доступа')}</button>
              <button type="button" className={button} disabled={busy} onClick={() => setConfirmRemoval(null)}>{t('Отмена')}</button>
            </div> : <button type="button" className={button} disabled={disabled} onClick={() => setConfirmRemoval(id)}>
              {t('Отозвать доступ сотрудника')}
            </button>}
          </div>)}
        </section>}
        {!data.items.length && <p className="text-sm text-[var(--soft)]">{t('Поручений пока нет')}</p>}
        {data.items.map(item => <article key={item.id} className="card space-y-2 p-4">
          <h2 className="break-words font-bold">{item.taskTitle}</h2>
          <p className="break-words text-sm">{item.accepted ? item.recipientName || t('Поручение принято') : t('Ожидает принятия')}</p>
          {!data.readOnly && <button type="button" className={button} disabled={disabled} onClick={() =>
            void run(origin => revokeTaskDelegation(weddingId, item.id, origin), () => {
              if (invitation?.id === item.id) setInvitation(null)
            })}>{t('Отозвать поручение')}</button>}
        </article>)}
      </>}
    </div>
  </div>
}

export function DelegatedTasks() {
  const location = useLocation()
  const code = location.hash.slice(1)
  const initialCode = inviteCode.test(code) ? code : ''
  const scope = useLegacySessionKey(JSON.stringify([location.key, initialCode]))
  if (!isAuthorized()) return <div className="pb-12">
    <TopBar back title={t('Мои поручения')} />
    <div className="px-5">
      <Link className={button} to="/auth" replace state={{ delegatedTaskCode: initialCode }}>{t('Войти')}</Link>
    </div>
  </div>
  return <RecipientBoard key={scope} scope={scope} initialCode={initialCode} />
}

function RecipientBoard({ scope, initialCode }: { scope: string; initialCode: string }) {
  const navigate = useNavigate()
  const capture = useLegacyActionScope(scope)
  const q = useApi(() => getDelegatedTasks(capture()), [capture])
  const region = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const { reload } = q
  const retainFocus = useCallback(() => {
    if (content.current?.contains(document.activeElement)) region.current?.focus()
  }, [])
  const refresh = useCallback(() => { retainFocus(); reload() }, [reload, retainFocus])
  const { online, busy, error, run } = useTaskDelegationAction(capture, refresh)
  useEffect(() => {
    window.addEventListener('offline', retainFocus)
    return () => window.removeEventListener('offline', retainFocus)
  }, [retainFocus])
  const [code, setCode] = useState(initialCode)
  const [showEmployeeCode, setShowEmployeeCode] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState<string | null>(null)
  const me = useApi(() => showEmployeeCode ? getMe(capture()) : Promise.resolve(null), [showEmployeeCode, capture])
  const codeId = useId()
  const tasks = online && ready(q) && !q.refreshing ? q.data : null
  const grouped = new Map<string, DelegatedTask[]>()
  for (const task of tasks ?? []) {
    const key = task.weddingId ?? ''
    const items = grouped.get(key)
    if (items) items.push(task)
    else grouped.set(key, [task])
  }
  const accept = (event: FormEvent) => {
    event.preventDefault()
    if (!tasks || !inviteCode.test(code.trim())) return
    void run(origin => acceptTaskDelegation(code.trim(), origin), () => {
      setCode('')
      if (initialCode) navigate('/delegated-tasks', { replace: true })
    })
  }
  return <div className="pb-12">
    <TopBar back title={t('Мои поручения')} />
    <div ref={region} role="region" aria-label={t('Мои поручения')} tabIndex={-1} className={`space-y-4 px-5 ${focus}`}>
      {!online ? <p role="status">{t('Нет связи с сервером')}</p>
        : q.refreshing ? <p role="status">{t('Проверяем доступ…')}</p>
        : <AsyncState q={q} forbiddenText={q.forbiddenText} />}
      {error && <p role="alert" className="card p-3 text-sm">{error}</p>}
      {tasks && <div ref={content} className="space-y-4">
        <div className="card space-y-2 p-4">
          <button type="button" className={button} aria-expanded={showEmployeeCode}
            onClick={() => setShowEmployeeCode(show => !show)}>{t('Мой код сотрудника')}</button>
          {showEmployeeCode && <>
            <AsyncState q={me} />
            {me.data?.id && <div className="space-y-2">
              <p className="text-sm">{t('Передайте код организатору, чтобы получить поручение.')}</p>
              <input className={field} aria-label={t('Код сотрудника')} readOnly value={me.data.id} onFocus={event => event.target.select()} />
              <button type="button" className={button} onClick={() => copyText(me.data!.id!)}>{t('Скопировать код сотрудника')}</button>
            </div>}
          </>}
        </div>
        <form className="card space-y-3 p-4" onSubmit={accept}>
          <label className="block text-sm font-semibold" htmlFor={codeId}>{t('Код поручения')}</label>
          <input id={codeId} className={field} value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} required />
          <button className={button} aria-disabled={busy || !inviteCode.test(code.trim())}>{t('Принять поручение')}</button>
        </form>
        {!tasks.length && <p className="text-sm text-[var(--soft)]">{t('Поручений пока нет')}</p>}
        {[...grouped].map(([weddingId, weddingTasks]) => <section key={weddingId} className="space-y-2">
          {weddingTasks[0]?.weddingTitle && <h2 className="text-sm font-bold">{weddingTasks[0].weddingTitle}</h2>}
          {weddingTasks.map(task => <article key={task.id} className="card space-y-2 p-4">
            <h3 className="break-words font-bold">{task.title}</h3>
            {task.due && <p className="text-sm">{shortWeddingDate(task.due)}</p>}
            {task.blocked && <p className="text-sm">{t('Сначала должны быть выполнены условия задачи')}</p>}
            <button type="button" className={button} aria-disabled={busy || q.refreshing || task.blocked} onClick={() => {
              if (!busy && !q.refreshing && !task.blocked) void run(origin => setDelegatedTaskDone(task, origin))
            }}>{t(task.done ? 'Вернуть в работу' : 'Отметить выполненной')}</button>
          </article>)}
          {weddingId && (confirmLeave === weddingId ? <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy || q.refreshing} onClick={() => void run(
              origin => leaveDelegatedWedding(weddingTasks[0]!.id, origin), () => setConfirmLeave(null))}>
              {t('Подтвердить выход из поручений')}
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => setConfirmLeave(null)}>{t('Отмена')}</button>
          </div> : <button type="button" className={button} disabled={busy || q.refreshing} onClick={() => setConfirmLeave(weddingId)}>
            {t('Выйти из поручений свадьбы')}
          </button>)}
        </section>)}
      </div>}
    </div>
  </div>
}
