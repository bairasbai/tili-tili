import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { ApiError, isAuthorized } from '@/lib/api/client'
import {
  acceptTaskDelegation, getDelegatedTasks, getWeddingTaskDelegations, issueTaskDelegation,
  revokeTaskDelegation, setDelegatedTaskDone, type TaskDelegationInvitation,
} from '@/lib/api/taskDelegations'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { useLegacyActionScope, useLegacySessionKey, type LegacyAction } from '@/lib/useLegacyActionScope'
import { copyText } from '@/lib/utils'
import { shortWeddingDate } from '@/lib/weddingDate'

const button = 'press min-h-11 rounded-xl bg-[var(--sage-soft)] px-4 py-2 text-sm font-semibold disabled:opacity-50'
const field = 'min-h-11 w-full rounded-xl border border-[var(--line)] bg-transparent px-3 py-2 text-sm'
const inviteCode = /^[A-Za-z0-9_-]{32}$/

function useTaskDelegationAction(capture: () => LegacyAction, reload: () => void) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  async function run<T>(action: (origin: LegacyAction) => Promise<T>, onSuccess?: (result: T) => void) {
    if (pending.current) return
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
  return { busy, error, run }
}

export function WeddingTaskDelegations() {
  const { weddingId } = useStore()
  const scope = useLegacySessionKey(weddingId ?? '')
  return <WeddingBoard key={scope} scope={scope} weddingId={weddingId} />
}

function WeddingBoard({ scope, weddingId }: { scope: string; weddingId: string | null }) {
  const capture = useLegacyActionScope(scope, weddingId)
  const q = useApi(() => weddingId ? getWeddingTaskDelegations(weddingId, capture()) : noWedding(), [weddingId, capture])
  const { busy, error, run } = useTaskDelegationAction(capture, q.reload)
  const [selected, setSelected] = useState('')
  const [invitation, setInvitation] = useState<TaskDelegationInvitation | null>(null)
  const selectId = useId()
  const linkId = useId()
  const data = ready(q) ? q.data : null
  const occupied = new Set(data?.items.map(item => item.taskId))
  const available = data?.tasks.filter(task => !occupied.has(task.id)) ?? []
  const taskId = available.some(task => task.id === selected) ? selected : ''
  const disabled = busy || q.refreshing || Boolean(data?.readOnly)
  const link = invitation ? new URL('/delegated-tasks#' + invitation.code, window.location.origin).href : ''
  const create = (event: FormEvent) => {
    event.preventDefault()
    if (!weddingId || !taskId || disabled) return
    void run(origin => issueTaskDelegation(weddingId, taskId, origin), result => {
      setInvitation(result)
      setSelected('')
    })
  }
  return <div className="pb-28">
    <TopBar back title={t('Поручения')} />
    <div className="space-y-4 px-5">
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
            <button className={button} disabled={disabled || !taskId}>{t('Создать ссылку для помощника')}</button>
          </form>
          {link && <div className="card space-y-2 p-4">
            <label className="block text-sm font-semibold" htmlFor={linkId}>{t('Ссылка для помощника')}</label>
            <input id={linkId} className={field} value={link} readOnly onFocus={event => event.target.select()} />
            <p className="text-sm">{t('Отправьте ссылку только выбранному помощнику. Принять её можно один раз в течение семи дней.')}</p>
            <button type="button" className={button} onClick={() => copyText(link)}>{t('Скопировать ссылку')}</button>
          </div>}
        </>}
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
  const scope = useLegacySessionKey(location.key)
  const code = location.hash.slice(1)
  const initialCode = inviteCode.test(code) ? code : ''
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
  const { busy, error, run } = useTaskDelegationAction(capture, q.reload)
  const [code, setCode] = useState(initialCode)
  const codeId = useId()
  const tasks = ready(q) ? q.data : null
  const accept = (event: FormEvent) => {
    event.preventDefault()
    if (!inviteCode.test(code.trim())) return
    void run(origin => acceptTaskDelegation(code.trim(), origin), () => {
      setCode('')
      if (initialCode) navigate('/delegated-tasks', { replace: true })
    })
  }
  return <div className="pb-12">
    <TopBar back title={t('Мои поручения')} />
    <div className="space-y-4 px-5">
      <AsyncState q={q} />
      {error && <p role="alert" className="card p-3 text-sm">{error}</p>}
      {tasks && <>
        <form className="card space-y-3 p-4" onSubmit={accept}>
          <label className="block text-sm font-semibold" htmlFor={codeId}>{t('Код поручения')}</label>
          <input id={codeId} className={field} value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} required />
          <button className={button} disabled={busy || !inviteCode.test(code.trim())}>{t('Принять поручение')}</button>
        </form>
        {!tasks.length && <p className="text-sm text-[var(--soft)]">{t('Поручений пока нет')}</p>}
        {tasks.map(task => <article key={task.id} className="card space-y-2 p-4">
          <h2 className="break-words font-bold">{task.title}</h2>
          {task.due && <p className="text-sm">{shortWeddingDate(task.due)}</p>}
          {task.blocked && <p className="text-sm">{t('Сначала должны быть выполнены условия задачи')}</p>}
          <button type="button" className={button} disabled={busy || q.refreshing || task.blocked} onClick={() =>
            void run(origin => setDelegatedTaskDone(task, origin))}>{t(task.done ? 'Вернуть в работу' : 'Отметить выполненной')}</button>
        </article>)}
      </>}
    </div>
  </div>
}
