import { useEffect, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { ApiError, beginLocalSessionAction, onSessionChanged } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { readWeeklyOrderTerms } from '@/lib/api/weeklyOrderTerms'
import type { TermsSummary } from '@/lib/weeklyOrderTerms'
import { t } from '@/lib/i18n'

const action = 'press min-h-11 rounded-xl px-3 py-2 text-sm font-semibold text-[var(--sage-deep)]'
function status(summary: TermsSummary): string {
  switch (summary.state) {
    case 'unpublished': return t('Редакция условий ещё не опубликована')
    case 'agreed': return t('Текущая редакция согласована обеими сторонами')
    case 'stale': return t('Описание заказа изменилось — условия нужно обновить')
    case 'unavailable': return t('Исполнитель недоступен для нового согласования')
    case 'invalid': return t('Актуальность условий не подтверждена')
    case 'waiting': return summary.awaiting.length === 2 ? t('Ожидается подтверждение пары и исполнителя')
      : summary.awaiting[0] === 'customer' ? t('Ожидается подтверждение пары') : t('Ожидается подтверждение исполнителя')
  }
}

/** Optional section: no list/terms requests until the explicit check action. */
export function WeeklyOrderTerms({ weddingId }: { weddingId: string }) {
  const [generation, reset] = useReducer((n: number) => n + 1, 0)
  useEffect(() => onSessionChanged(reset), [])
  return <TermsEntry key={JSON.stringify([weddingId, generation])} weddingId={weddingId} />
}
function TermsEntry({ weddingId }: { weddingId: string }) {
  const [active, activate] = useState(false)
  return <section aria-label={t('Условия заказов')} className="card min-w-0 p-4 space-y-3">
    <h2 className="text-base font-semibold">{t('Условия заказов')}</h2>
    <p className="text-xs text-[var(--soft)]">{t('Проверка активных сделок в текущих слотах. Сроки подтверждения не указаны, поэтому список не ограничен неделей.')}</p>
    <p className="text-xs text-[var(--soft)]">{t('Отметки о найденном подрядчике без карточки сделки сюда не входят.')}</p>
    {active ? <TermsReader weddingId={weddingId} /> : <button type="button" className={action} onClick={() => activate(true)}>{t('Проверить условия заказов')}</button>}
  </section>
}
function TermsReader({ weddingId }: { weddingId: string }) {
  const readers = useRef(new Set<AbortController>())
  useEffect(() => {
    const current = readers.current
    return () => { for (const reader of current) reader.abort(); current.clear() }
  }, [])
  const q = useApi(async () => {
    const controller = new AbortController(), scope = beginLocalSessionAction()
    readers.current.add(controller)
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error('Closed terms reader')
      scope.assertCurrent()
    }
    try { return await readWeeklyOrderTerms(weddingId, assertCurrent) }
    finally { scope.close(); readers.current.delete(controller) }
  }, [weddingId])
  const shown = ready(q) && !q.refreshing ? q.data : null
  return <>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {q.refreshing && <p role="status">{t('Загружаем…')}</p>}
    {shown && <>
      {shown.length === 0 ? <p className="text-sm">{t('Активных сделок в текущих слотах нет.')}</p> : <ul className="space-y-2">
        {shown.map(item => <li key={item.dealId} className="min-w-0 rounded-xl bg-[var(--bg)] p-3 break-words">
          <h3 className="text-sm font-semibold">{item.label || t('Заказ без названия')}</h3>
          {item.summary ? <>
            <p className="text-sm mt-1">{status(item.summary)}</p>
            {item.summary.version !== null && <p className="text-xs">{t('Редакция')} {item.summary.version}</p>}
            {item.summary.previousAgreement && <p className="text-xs text-[var(--soft)]">{t('Прежнее согласование не подтверждает новую редакцию.')}</p>}
            {item.external && item.summary.awaiting.includes('performer') && <p className="text-xs text-[var(--soft)]">{t('Внешний контакт не является подтверждением исполнителя в приложении.')}</p>}
            <Link className={`${action} inline-flex items-center px-0`} to={`/deal/${item.dealId}`}>{t('Открыть заказ для проверки условий')}</Link>
          </> : <p role="alert" className="text-sm mt-1">{t('Состояние условий не подтверждено:')} {explainError(item.failure)}</p>}
        </li>)}
      </ul>}
      {shown.some(item => item.failure !== null) && <p className="text-xs text-[var(--soft)]">{t('Есть непроверенные заказы. Ошибка чтения не означает согласование.')}</p>}
      <p className="text-xs text-[var(--soft)]">{t('Сводка не принимает условия. Проверьте актуальную редакцию в карточке заказа.')}</p>
      {!shown.length || shown.some(item => !(item.failure instanceof ApiError) || item.failure.status !== 403)
        ? <button type="button" className={action} onClick={q.reload}>{t('Обновить проверку условий')}</button> : null}
    </>}
  </>
}
