import { useEffect, useReducer, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { TopBar } from '@/components/chrome'
import { WeeklyTaskPrerequisites } from '@/components/WeeklyTaskPrerequisites'
import { weeklyChecklistHref } from '@/lib/weeklyTaskDependencies'
import { WeeklyOrderTerms } from '@/components/WeeklyOrderTerms'
import { AsyncState, ready } from '@/components/AsyncState'
import { beginLocalSessionAction, isAuthorized, onSessionChanged } from '@/lib/api/client'
import { noWedding, useApi, type AsyncData } from '@/lib/api/useApi'
import { getGuests, getTasks, getWedding } from '@/lib/api/weddingData'
import { getPaymentSchedule } from '@/lib/api/paymentSchedule'
import { pendingGuestPeople, weddingWeek, weeklyPayments, weeklyTasks, type WeekRange } from '@/lib/weeklyAgenda'
import { useStore } from '@/lib/store'
import { t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { shortWeddingDate } from '@/lib/weddingDate'
import { plural } from '@/lib/utils'

const action = 'press inline-flex min-h-11 items-center rounded-xl px-3 py-2 text-sm font-semibold text-[var(--sage-deep)]'
const rowClass = 'block min-w-0 rounded-xl bg-[var(--bg)] p-3 break-words'

/** Local privacy fence only; the existing API still enforces permissions. */
async function readCurrent<T>(read: () => Promise<T>): Promise<T> {
  const scope = beginLocalSessionAction()
  try { scope.assertCurrent(); const value = await read(); scope.assertCurrent(); return value } finally { scope.close() }
}

export default function WeeklyAgenda() {
  const { weddingId } = useStore()
  const [generation, refresh] = useReducer((n: number) => n + 1, 0)
  useEffect(() => onSessionChanged(refresh), [])
  return <div className="pb-28">
    <TopBar title={t('На этой неделе')} back fallback="/home" wrapTitle />
    <div className="px-5 space-y-4 mt-3">
      <p className="text-xs text-[var(--soft)]">{t('Срез на момент открытия. После изменений обновите сводку.')}</p>
      <button type="button" className={action} onClick={refresh}>{t('Обновить сводку')}</button>
      <AgendaSnapshot key={JSON.stringify([weddingId, generation])} weddingId={weddingId} />
    </div>
  </div>
}

function AgendaSnapshot({ weddingId }: { weddingId: string | null }) {
  const [now] = useState(() => new Date())
  const q = useApi(() => weddingId && isAuthorized() ? readCurrent(async () => {
    const wedding = await getWedding(weddingId)
    return weddingWeek(now, wedding.tz)
  }) : noWedding<WeekRange | null>(), [weddingId, now])
  return <>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {ready(q) && !q.refreshing && (q.data && weddingId ? <>
      <p className="text-sm break-words" data-testid="week-range">
        <time dateTime={q.data.from}>{shortWeddingDate(q.data.from)}</time> — <time dateTime={q.data.to}>{shortWeddingDate(q.data.to)}</time>
        <span className="block text-xs text-[var(--soft)]">{t('Часовой пояс свадьбы:')} {q.data.timeZone}</span>
      </p>
      <TaskSection weddingId={weddingId} range={q.data} />
      <PaymentSection weddingId={weddingId} range={q.data} />
      <GuestSection weddingId={weddingId} />
      <WeeklyOrderTerms weddingId={weddingId} />
    </> : <p role="alert" className="text-sm text-[var(--rose-ink)]">{t('Часовой пояс свадьбы не подтверждён. Недельные сроки не рассчитаны.')}</p>)}
  </>
}

function Section({ title, q, children }: { title: string; q: AsyncData<unknown>; children: ReactNode }) {
  return <section aria-label={title} className="card min-w-0 p-4 space-y-3">
    <h2 className="text-base font-semibold">{title}</h2>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {q.refreshing && <p role="status" className="text-sm">{t('Загружаем…')}</p>}
    {ready(q) && !q.refreshing && q.data !== null && children}
  </section>
}

function TaskSection({ weddingId, range }: { weddingId: string; range: WeekRange }) {
  const q = useApi(() => readCurrent(async () => weeklyTasks(await getTasks(weddingId), range)), [weddingId, range])
  const taskRow = ({ task, index, due }: ReturnType<typeof weeklyTasks>['dated'][number]) => <li key={task.id ?? index} className={rowClass}>
    <Link to={weeklyChecklistHref(weddingId, task.id)} className="block">
      <b className="block text-sm">{task.title?.trim() || t('Без названия')}</b>
      <span className="block text-xs mt-1">{due.state === 'known'
        ? <>{due.date < range.today && <strong>{t('Просрочено')} · </strong>}<time dateTime={due.date}>{shortWeddingDate(due.date)}</time></>
        : due.state === 'missing' ? t('Срок не задан') : t('Срок требует уточнения')}</span>
      <span className="block text-xs text-[var(--soft)] mt-1">{task.assignee?.name?.trim()
        ? `${t('Ответственный:')} ${task.assignee.name.trim()}` : t('Ответственный не указан')}</span>
    </Link>
    <WeeklyTaskPrerequisites task={task} weddingId={weddingId} />
  </li>
  return <Section title={t('Задачи этой недели')} q={q}>
    {q.data && <>
      <p className="text-xs text-[var(--soft)]">{t('Включены незавершённые задачи до воскресенья и все просроченные.')}</p>
      <p className="text-xs text-[var(--soft)]">{t('Предпосылки показаны независимо от срока. Сводка не меняет связи и не завершает задачи.')}</p>
      {q.data.dated.length ? <ul className="space-y-2">{q.data.dated.map(taskRow)}</ul> : <p className="text-sm">{t('Открытых задач с датой до конца недели нет.')}</p>}
      {q.data.undated.length > 0 && <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t('Срок нужно уточнить')}</h3>
        <ul className="space-y-2">{q.data.undated.map(taskRow)}</ul>
      </div>}
      <Link to={weeklyChecklistHref(weddingId)} className={action}>{t('Открыть чек-лист')}</Link>
    </>}
  </Section>
}

function PaymentSection({ weddingId, range }: { weddingId: string; range: WeekRange }) {
  const q = useApi(() => readCurrent(async () => weeklyPayments(await getPaymentSchedule(weddingId, {
    from: range.from, to: range.to, includeOverdue: true, includeCancelled: false,
  }), range)), [weddingId, range])
  return <Section title={t('Платежи этой недели')} q={q}>
    {q.data && <>
      <p className="text-xs text-[var(--soft)]">{t('Остатки взяты из графика оплат. Это не проверка банковского перевода.')}</p>
      {q.data.length ? <ul className="space-y-2">{q.data.map(item => <li key={item.id}>
        <Link to="/wedding/payments" className={rowClass}>
          <b className="block text-sm">{item.title}</b>
          <span className="block text-xs mt-1">{item.due < range.today && <strong>{t('Просрочено')} · </strong>}<time dateTime={item.due}>{shortWeddingDate(item.due)}</time></span>
          <span className="block text-sm font-semibold mt-1">{t('Осталось по этапу:')} {fmt(item.remaining.amount)}</span>
          {item.unknownAmountPayments > 0 && <span className="block text-xs text-[var(--honey-ink)]">{t('Есть отметки оплаты с неизвестной суммой.')}</span>}
        </Link>
      </li>)}</ul> : <p className="text-sm">{t('Открытых этапов оплаты до конца недели нет.')}</p>}
      <Link to="/wedding/payments" className={action}>{t('Открыть график оплат')}</Link>
    </>}
  </Section>
}

function GuestSection({ weddingId }: { weddingId: string }) {
  const q = useApi(() => readCurrent(async () => pendingGuestPeople(await getGuests(weddingId))), [weddingId])
  return <Section title={t('Ожидаемые ответы гостей')} q={q}>
    {q.data && <>
      <p className="text-xs text-[var(--soft)]">{t('Срок ответа не указан в этих данных. Список не ограничен текущей неделей.')}</p>
      <p className="text-sm font-semibold">{q.data.length} {plural(q.data.length, t('персона ждёт ответа'), t('персоны ждут ответа'), t('персон ждут ответа'))}</p>
      {q.data.length > 0 && <ul className="space-y-2">{q.data.map(guest => <li key={guest.id}>
        <Link to="/wedding/guests" className={`${rowClass} text-sm`}>{guest.name?.trim() || t('Имя не указано')}</Link>
      </li>)}</ul>}
      <Link to="/wedding/guests" className={action}>{t('Открыть список гостей')}</Link>
    </>}
  </Section>
}
