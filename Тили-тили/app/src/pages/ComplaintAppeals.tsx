import { useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { ApiError, isAuthorized } from '@/lib/api/client'
import { commandAppeal, getAffectedDecisions, getOwnAppeal, getStaffAppeal, getStaffAppeals, submitAppeal,
  type AppealCommand, type ComplaintAppeal, type OriginalDecision } from '@/lib/api/complaintAppeals'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { useLiveAccess } from '@/lib/offlineProgramHooks'
import { useLegacyActionScope, useLegacySessionKey, type LegacyAction } from '@/lib/useLegacyActionScope'

const affectedPath = '/support/moderation'
const staffPath = '/admin/appeals'
const primary = 'press min-h-11 rounded-full grad px-4 font-semibold text-[var(--on-grad)] disabled:opacity-50'
const secondary = 'press min-h-11 rounded-full card-s px-4 font-semibold disabled:opacity-50'
const input = 'block w-full mt-1 rounded-xl border border-[var(--line)] bg-[var(--bg)] p-2 font-normal'
const actions = { dismiss: 'Жалоба отклонена', warn: 'Предупреждение', downrank: 'Понижение в выдаче', block: 'Блокировка' } as const
const kinds = { vendor: 'Анкета подрядчика', review: 'Отзыв', message: 'Сообщение', deal: 'Сделка' } as const
const categories = { fraud: 'Мошенничество', content: 'Недопустимое содержание', no_show: 'Неявка', spam: 'Спам' } as const
const outcomes = { upheld: 'Решение оставлено в силе', changed: 'Решение изменено' } as const
const number = (id: string) => '#' + id.slice(-8)
const date = (iso: string) => new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU',
  { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

function Page({ title, fallback, children }: { title: string; fallback: string; children: ReactNode }) {
  return <div className="pb-24">
    <TopBar back title={t(title)} fallback={fallback} />
    <div className="px-5 mt-3 space-y-3 text-sm">{children}</div>
  </div>
}

function SignIn() {
  return <Link to="/auth" className={secondary + ' inline-flex items-center'}>{t('Войти')}</Link>
}

function Offline() {
  return <p role="status" className="text-[var(--soft)]">{t('Подключитесь к интернету, чтобы открыть апелляции')}</p>
}

function PageButtons({ cursor, next, go }: { cursor: string | null; next: string | null; go: (value: string | null) => void }) {
  if (!cursor && !next) return null
  return <div className="flex flex-wrap gap-2">
    {cursor && <button type="button" className={secondary} onClick={() => go(null)}>{t('К началу списка')}</button>}
    {next && <button type="button" className={secondary} onClick={() => go(next)}>{t('Следующая страница')}</button>}
  </div>
}

function useAppealWrite(capture: () => LegacyAction, reload: () => void) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(request: (scope: LegacyAction) => Promise<{ id: string }>, saved: (id: string) => void) {
    if (pending.current) return
    const scope = capture()
    if (!scope.isCurrent()) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await request(scope)
      scope.assertCurrent()
      saved(result.id)
    } catch (reason) {
      if (!scope.isCurrent()) return
      setError(explainError(reason))
      if (reason instanceof ApiError && [401, 403, 404, 409].includes(reason.status)) reload()
    } finally {
      pending.current = false
      if (scope.isCurrent()) setBusy(false)
    }
  }

  return { run, busy, error }
}

function Original({ item }: { item: OriginalDecision }) {
  return <section className="card-s p-4 space-y-2">
    <h2 className="font-semibold">{t('Исходное решение')}</h2>
    <p>{t(kinds[item.targetKind])} · {t(categories[item.category])}</p>
    <p className="font-semibold">{t(actions[item.action])}</p>
    <time className="text-xs text-[var(--soft)]" dateTime={item.decisionAt}>{date(item.decisionAt)}</time>
    {item.reason && <p className="whitespace-pre-wrap break-words">{item.reason}</p>}
  </section>
}

function History({ item }: { item: ComplaintAppeal }) {
  return <section className="card-s p-4 space-y-2">
    <h2 className="font-semibold">{t('Апелляция')} {number(item.id)}</h2>
    <time className="text-xs text-[var(--soft)]" dateTime={item.submittedAt}>{date(item.submittedAt)}</time>
    <p className="whitespace-pre-wrap break-words">{item.message}</p>
    <div className="border-t border-[var(--line)] pt-2">
      <p className="font-semibold">{item.decision ? t(outcomes[item.decision.outcome]) : t('Апелляция на рассмотрении')}</p>
      {item.decision && <>
        {item.decision.newAction && <p>{t(actions[item.decision.newAction])}</p>}
        <time className="text-xs text-[var(--soft)]" dateTime={item.decision.decidedAt}>{date(item.decision.decidedAt)}</time>
        <p className="whitespace-pre-wrap break-words">{item.decision.reason}</p>
      </>}
    </div>
  </section>
}

export function OwnerAppeal() {
  const { complaintId = '' } = useParams()
  const key = useLegacySessionKey(complaintId)
  return isAuthorized() ? <OwnerDetail key={key} complaintId={complaintId} />
    : <Page title="Апелляция" fallback="/support"><SignIn /></Page>
}

function OwnerDetail({ complaintId }: { complaintId: string }) {
  const capture = useLegacyActionScope(complaintId)
  const [draft, setDraft] = useState('')
  const q = useApi(() => getOwnAppeal(complaintId, capture()), [complaintId, capture])
  const online = useLiveAccess(q.reload), write = useAppealWrite(capture, q.reload)
  const data = online && ready(q) && !q.refreshing ? q.data : null
  return <Page title="Апелляция" fallback={data?.role === 'affected' ? affectedPath : '/support/complaints'}>
    {!online ? <Offline /> : <AsyncState q={q} forbiddenText={q.forbiddenText} />}
    {data && <Original item={data.original} />}
    {data?.appeal && <History item={data.appeal} />}
    {data && !data.appeal && <form className="card-s p-4 space-y-3" onSubmit={event => {
      event.preventDefault()
      const message = draft.trim()
      if (message && !write.busy) void write.run(scope => submitAppeal(complaintId, message, scope), () => {
        setDraft('')
        q.reload()
      })
    }}>
      <label className="block font-semibold">{t('Почему решение стоит пересмотреть')}
        <textarea className={input} rows={4} maxLength={4000} required value={draft} disabled={write.busy}
          onChange={event => setDraft(event.target.value)} />
      </label>
      <button className={primary} type="submit" disabled={write.busy || !draft.trim()}>
        {write.busy ? t('Отправляем…') : t('Подать апелляцию')}
      </button>
    </form>}
    {write.error && <p role="alert" className="text-[var(--rose-ink)]">{write.error}</p>}
  </Page>
}

export function AffectedDecisions() {
  const key = useLegacySessionKey('affected-decisions')
  return <Page title="Решения модерации" fallback="/support">
    {isAuthorized() ? <AffectedList key={key} /> : <SignIn />}
  </Page>
}

function AffectedList() {
  const capture = useLegacyActionScope('affected-decisions')
  const [cursor, setCursor] = useState<string | null>(null)
  const q = useApi(() => getAffectedDecisions(cursor, capture()), [cursor, capture])
  const online = useLiveAccess(q.reload)
  if (!online) return <Offline />
  return <>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {ready(q) && !q.refreshing && q.data && <>
      {!q.data.items.length && !cursor && <p className="text-[var(--soft)]">{t('Решений модерации пока нет')}</p>}
      <ul className="space-y-2">
        {q.data.items.map(({ original, outcome }) => <li key={original.complaintId}>
          <Link className="press card-s block p-4" to={`/support/complaints/${original.complaintId}/appeal`}>
            <strong>{t(actions[original.action])}</strong>
            <p>{t(kinds[original.targetKind])} · {t(categories[original.category])}</p>
            <time className="text-xs text-[var(--soft)]" dateTime={original.decisionAt}>{date(original.decisionAt)}</time>
            {outcome && <p>{t(outcomes[outcome])}</p>}
            <p className="mt-2 font-semibold text-[var(--sage-deep)]">{t('Открыть апелляцию')}</p>
          </Link>
        </li>)}
      </ul>
      <PageButtons cursor={cursor} next={q.data.nextCursor} go={setCursor} />
    </>}
  </>
}

export function StaffAppeals() {
  const { appealId } = useParams()
  const key = useLegacySessionKey(appealId ?? 'staff-appeals')
  if (!isAuthorized()) return <Page title="Очередь апелляций" fallback="/admin"><SignIn /></Page>
  return appealId ? <StaffDetail key={key} appealId={appealId} /> : <StaffQueue key={key} />
}

function StaffQueue() {
  const nav = useNavigate(), capture = useLegacyActionScope('staff-appeals')
  const [cursor, setCursor] = useState<string | null>(null)
  const q = useApi(() => getStaffAppeals(cursor, capture()), [cursor, capture])
  const online = useLiveAccess(q.reload), write = useAppealWrite(capture, q.reload)
  return <Page title="Очередь апелляций" fallback="/admin">
    {!online ? <Offline /> : <AsyncState q={q} forbiddenText={q.forbiddenText} />}
    {online && ready(q) && !q.refreshing && q.data && <>
      {!q.data.items.length && !cursor && <p className="text-[var(--soft)]">{t('В очереди пока нет апелляций')}</p>}
      <ul className="space-y-2">
        {q.data.items.map(item => <li key={item.id} className="card-s p-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <strong>{number(item.id)} · {t(kinds[item.targetKind])}</strong>
            <p className="text-xs text-[var(--soft)]">{date(item.submittedAt)} · {t(item.role === 'reporter' ? 'Автор жалобы' : 'Адресат решения')}</p>
            {item.outcome && <p>{t(outcomes[item.outcome])}</p>}
          </div>
          {item.assignedToMe ? <Link to={`${staffPath}/${item.id}`} className={secondary + ' inline-flex items-center'}
            aria-label={`${t('Открыть апелляцию')} ${number(item.id)}`}>{t('Открыть апелляцию')}</Link>
            : <button type="button" className={primary} disabled={write.busy}
              aria-label={`${t('Взять апелляцию')} ${number(item.id)}`}
              onClick={() => void write.run(scope => commandAppeal(item.id, { action: 'claim' }, scope), id => nav(`${staffPath}/${id}`))}>
              {t('Взять апелляцию')}
            </button>}
        </li>)}
      </ul>
      <PageButtons cursor={cursor} next={q.data.nextCursor} go={setCursor} />
    </>}
    {write.error && <p role="alert" className="text-[var(--rose-ink)]">{write.error}</p>}
  </Page>
}

function StaffDetail({ appealId }: { appealId: string }) {
  const nav = useNavigate(), capture = useLegacyActionScope(appealId)
  const [reason, setReason] = useState('')
  const [choice, setChoice] = useState<OriginalDecision['action'] | 'upheld' | ''>('')
  const q = useApi(() => getStaffAppeal(appealId, capture()), [appealId, capture])
  const online = useLiveAccess(q.reload), write = useAppealWrite(capture, q.reload)
  const data = online && ready(q) && !q.refreshing ? q.data : null
  const choiceAllowed = choice === 'upheld' || (choice !== '' && data?.allowedActions.includes(choice))

  function command(input: AppealCommand) {
    void write.run(scope => commandAppeal(appealId, input, scope), () => {
      setReason('')
      setChoice('')
      if (input.action === 'release') nav(staffPath, { replace: true })
      else q.reload()
    })
  }

  return <Page title="Апелляция" fallback={staffPath}>
    {!online ? <Offline /> : <AsyncState q={q} forbiddenText={q.forbiddenText} />}
    {data && <>
      <Original item={data.original} />
      {data.complaintText && <section className="card-s p-4">
        <h2 className="font-semibold">{t('Текст жалобы')}</h2>
        <p className="mt-2 whitespace-pre-wrap break-words">{data.complaintText}</p>
      </section>}
      <History item={data.appeal} />
      {!data.appeal.decision && <form className="card-s p-4 space-y-3" onSubmit={event => {
        event.preventDefault()
        if (!choiceAllowed || !reason.trim() || write.busy || !choice) return
        command(choice === 'upheld' ? { action: 'decide', outcome: 'upheld', reason: reason.trim() }
          : { action: 'decide', outcome: 'changed', newAction: choice, reason: reason.trim() })
      }}>
        <label className="block font-semibold">{t('Решение по апелляции')}
          <select className={input} value={choiceAllowed ? choice : ''} required disabled={write.busy} onChange={event => {
            const value = event.target.value as typeof choice
            setChoice(value)
          }}>
            <option value="" disabled>{t('Выберите решение')}</option>
            <option value="upheld">{t('Оставить исходное решение в силе')}</option>
            {data.allowedActions.map(action => <option value={action} key={action}>{t(actions[action])}</option>)}
          </select>
        </label>
        <label className="block font-semibold">{t('Пояснение для заявителя')}
          <textarea className={input} rows={4} required maxLength={2000} disabled={write.busy}
            value={reason} onChange={event => setReason(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primary} disabled={!choiceAllowed || !reason.trim() || write.busy}>
            {t('Сохранить решение')}
          </button>
          <button type="button" className={secondary} disabled={write.busy}
            onClick={() => command({ action: 'release' })}>{t('Вернуть в очередь')}</button>
        </div>
      </form>}
    </>}
    {write.error && <p role="alert" className="text-[var(--rose-ink)]">{write.error}</p>}
  </Page>
}
