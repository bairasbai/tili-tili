import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { ApiError, isAuthorized, newIdempotencyKey } from '@/lib/api/client'
import { commandSupportCase, createSupportCase, getStaffSupportCase, getStaffSupportQueue,
  getSupportCase, getSupportCases, type SupportCommand, type SupportDetail } from '@/lib/api/support'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { useLegacyActionScope, useLegacySessionKey, type LegacyAction } from '@/lib/useLegacyActionScope'

const primary = 'press min-h-11 rounded-full grad px-4 font-semibold text-[var(--on-grad)] disabled:opacity-50'
const secondary = 'press min-h-11 rounded-full card-s px-4 font-semibold disabled:opacity-50'
const inputClass = 'block w-full mt-1 rounded-xl border border-[var(--line)] p-2 font-normal'
const ownerUrl = '/support/cases', staffUrl = '/admin/support'
const statusLabels = { open: 'Ожидает сотрудника', in_progress: 'В работе', resolved: 'Обращение закрыто' } as const
const eventLabels = { opened: 'Обращение отправлено', assigned: 'Сотрудник взял обращение',
  released: 'Обращение возвращено в очередь', resolved: 'Ответ поддержки' } as const
const number = (id: string) => '#' + id.slice(-8)
const dateLabel = (date: string) => new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU',
  { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date))

function useLiveAccess(reload: () => void) {
  const online = useProgramOnline(reload)
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  return online
}

function useCaseWrite(capture: () => LegacyAction, refresh: () => void) {
  const receipt = useRef<{ intent: string; key: string } | null>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(intent: unknown, request: (options: { assertCurrent: () => void; idempotencyKey: string }) => Promise<{ id: string }>,
    saved: (id: string) => void) {
    if (pending.current) return
    const scope = capture()
    if (!scope.isCurrent()) return
    const digest = JSON.stringify(intent)
    if (receipt.current?.intent !== digest) receipt.current = { intent: digest, key: newIdempotencyKey() }
    const idempotencyKey = receipt.current.key
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await request({ assertCurrent: scope.assertCurrent, idempotencyKey })
      scope.assertCurrent()
      receipt.current = null
      saved(result.id)
    } catch (reason) {
      if (scope.isCurrent()) {
        setError(explainError(reason))
        if (reason instanceof ApiError && [401, 403, 404, 409].includes(reason.status)) refresh()
      }
    } finally {
      pending.current = false
      if (scope.isCurrent()) setBusy(false)
    }
  }
  return { run, busy, error }
}

function PageButtons({ cursor, next, go }: { cursor: string | null; next: string | null; go: (cursor: string | null) => void }) {
  if (!cursor && !next) return null
  return <div className="flex flex-wrap gap-2">
    {cursor && <button type="button" className={secondary} onClick={() => go(null)}>{t('К началу списка')}</button>}
    {next && <button type="button" className={secondary} onClick={() => go(next)}>{t('Следующая страница')}</button>}
  </div>
}

function OfflineCases() {
  return <p role="status" className="text-sm text-[var(--soft)]">{t('Подключитесь к интернету, чтобы открыть обращения')}</p>
}

export function SupportCases() {
  const key = useLegacySessionKey('own-support-list')
  return isAuthorized() ? <OwnerCases key={key} /> : <Link className="press card-s block px-4 py-3 font-semibold" to="/auth">
    {t('Войти, чтобы написать в поддержку')}
  </Link>
}

function OwnerCases() {
  const nav = useNavigate(), capture = useLegacyActionScope('own-support-list')
  const [cursor, setCursor] = useState<string | null>(null)
  const [subject, setSubject] = useState(''), [message, setMessage] = useState('')
  const q = useApi(() => getSupportCases(cursor, capture()), [cursor, capture])
  const online = useLiveAccess(q.reload)
  const write = useCaseWrite(capture, q.reload)
  const editable = online && ready(q) && !q.refreshing && !write.busy
  const draft = { subject: subject.trim(), message: message.trim() }

  return <section className="space-y-3 text-sm">
    <h2 className="font-semibold">{t('Мои обращения')}</h2>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {!online && <OfflineCases />}
    {ready(q) && q.data && <form className="card-s space-y-3 p-4" onSubmit={event => {
      event.preventDefault()
      if (editable && draft.subject && draft.message) void write.run(draft,
        options => createSupportCase(draft, options), id => nav(`${ownerUrl}/${id}`))
    }}>
      <label className="block font-semibold">{t('Тема обращения')}
        <input className={inputClass} maxLength={160} required disabled={!editable} value={subject} onChange={event => setSubject(event.target.value)} />
      </label>
      <label className="block font-semibold">{t('Опишите вопрос')}
        <textarea className={inputClass} rows={4} maxLength={4000} required disabled={!editable} value={message} onChange={event => setMessage(event.target.value)} />
      </label>
      <button type="submit" className={primary} disabled={!editable || !draft.subject || !draft.message}>
        {write.busy ? t('Отправляем…') : t('Отправить обращение')}
      </button>
    </form>}
    {write.error && <p role="alert" className="text-[var(--rose-ink)]">{write.error}</p>}
    {online && ready(q) && !q.refreshing && q.data && <>
      {q.data.items.length === 0 && !cursor && <p className="text-[var(--soft)]">{t('Обращений пока нет')}</p>}
      <ul className="space-y-2">
        {q.data.items.map(item => <li key={item.id}>
          <Link to={`${ownerUrl}/${item.id}`} className="press card-s block p-3">
            <span className="block break-words font-semibold">{item.subject}</span>
            <span className="text-xs text-[var(--soft)]">{number(item.id)} · {t(statusLabels[item.status])}</span>
          </Link>
        </li>)}
      </ul>
      <PageButtons cursor={cursor} next={q.data.nextCursor} go={setCursor} />
    </>}
  </section>
}

export function StaffSupport() {
  const { caseId } = useParams<{ caseId: string }>()
  const key = useLegacySessionKey(caseId ?? 'staff-support-list')
  return caseId ? <CaseDetail key={key} caseId={caseId} staff /> : <StaffQueue key={key} />
}

function StaffQueue() {
  const nav = useNavigate(), capture = useLegacyActionScope('staff-support-list')
  const [cursor, setCursor] = useState<string | null>(null)
  const q = useApi(() => getStaffSupportQueue(cursor, capture()), [cursor, capture])
  const online = useLiveAccess(q.reload), write = useCaseWrite(capture, q.reload)
  return <div className="pb-24">
    <TopBar back title={t('Очередь поддержки')} fallback="/admin" />
    <div className="px-5 mt-3 space-y-3 text-sm">
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {!online && <OfflineCases />}
      {write.error && <p role="alert" className="text-[var(--rose-ink)]">{write.error}</p>}
      {online && ready(q) && !q.refreshing && q.data && <>
        {q.data.items.length === 0 && !cursor && <p className="text-[var(--soft)]">{t('В очереди пока нет обращений')}</p>}
        <ul className="space-y-2">
          {q.data.items.map(item => <li key={item.id} className="card-s p-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong>{number(item.id)}</strong>
              <p className="text-xs text-[var(--soft)]">{dateLabel(item.createdAt)} · {t(statusLabels[item.status === 'open' && item.assignedToMe ? 'in_progress' : item.status])}</p>
            </div>
            {item.assignedToMe ? <Link className={`${secondary} inline-flex items-center`} to={`${staffUrl}/${item.id}`}
              aria-label={`${t('Открыть обращение')} ${number(item.id)}`}>{t('Открыть обращение')}</Link>
              : <button type="button" className={primary} disabled={write.busy} aria-label={`${t('Взять обращение')} ${number(item.id)}`}
                onClick={() => void write.run([item.id, 'claim'], options => commandSupportCase(item.id, { action: 'claim' }, options),
                  id => nav(`${staffUrl}/${id}`))}>{t('Взять обращение')}</button>}
          </li>)}
        </ul>
        <PageButtons cursor={cursor} next={q.data.nextCursor} go={setCursor} />
      </>}
    </div>
  </div>
}

export function SupportCaseScreen() {
  const { caseId = '' } = useParams<{ caseId: string }>()
  const key = useLegacySessionKey(caseId)
  return <CaseDetail key={key} caseId={caseId} staff={false} />
}

function CaseHistory({ item }: { item: SupportDetail }) {
  return <article className="card-s p-4 space-y-3">
    <p className="text-xs text-[var(--soft)]">{number(item.id)} · {t(statusLabels[item.status])}</p>
    <h2 className="break-words text-base font-semibold">{item.subject}</h2>
    <ol className="space-y-3">
      {item.history.map(event => <li key={event.id} className="border-t border-[var(--line)] pt-2">
        <p className="font-semibold">{t(eventLabels[event.kind])}</p>
        <time dateTime={event.createdAt} className="text-xs text-[var(--soft)]">{dateLabel(event.createdAt)}</time>
        {event.message && <p className="mt-1 whitespace-pre-wrap break-words">{event.message}</p>}
      </li>)}
    </ol>
  </article>
}

function CaseDetail({ caseId, staff }: { caseId: string; staff: boolean }) {
  const nav = useNavigate(), capture = useLegacyActionScope(JSON.stringify([staff, caseId]))
  const [answer, setAnswer] = useState('')
  const q = useApi(() => (staff ? getStaffSupportCase : getSupportCase)(caseId, capture()), [staff, caseId, capture])
  const online = useLiveAccess(q.reload), write = useCaseWrite(capture, q.reload)
  const item = online && ready(q) && !q.refreshing ? q.data : null
  function command(input: SupportCommand) {
    void write.run(input, options => commandSupportCase(caseId, input, options), () => {
      setAnswer('')
      if (input.action === 'release') nav(staffUrl, { replace: true })
      else q.reload()
    })
  }

  return <div className="pb-24">
    <TopBar back title={t('Обращение в поддержку')} fallback={staff ? staffUrl : '/support'} />
    <div className="px-5 mt-3 space-y-3 text-sm">
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {!online && <OfflineCases />}
      {item && <CaseHistory item={item} />}
      {staff && item?.status === 'in_progress' && <form className="card-s p-4 space-y-3" onSubmit={event => {
        event.preventDefault()
        if (!write.busy && answer.trim()) command({ action: 'resolve', message: answer.trim() })
      }}>
        <label className="block font-semibold">{t('Ответ пользователю')}
          <textarea rows={4} className={inputClass} maxLength={4000} required disabled={write.busy}
            value={answer} onChange={event => setAnswer(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primary} disabled={write.busy || !answer.trim()}>{t('Закрыть с ответом')}</button>
          <button type="button" className={secondary} disabled={write.busy} onClick={() => command({ action: 'release' })}>{t('Вернуть в очередь')}</button>
        </div>
      </form>}
      {write.error && <p role="alert" className="text-[var(--rose-ink)]">{write.error}</p>}
    </div>
  </div>
}
