import { Link } from 'react-router'
import { t } from '@/lib/i18n'
import { weeklyChecklistHref, weeklyDependencyState } from '@/lib/weeklyTaskDependencies'

/** Links remain separate from the task link. No completion or graph write is offered. */
export function WeeklyTaskPrerequisites({ task, weddingId }: { task: unknown; weddingId: string }) {
  const summary = weeklyDependencyState(task)
  if (summary.state === 'none') return null
  if (summary.state === 'unknown') return <p className="text-xs text-[var(--soft)] mt-2">
    {t('Состояние предпосылок не подтверждено. Откройте задачу для проверки.')}
  </p>
  if (summary.state === 'satisfied') return <p className="text-xs text-[var(--sage-deep)] mt-2">
    {t('Все предпосылки выполнены')}
  </p>
  return <div className="mt-2 border-t border-[var(--track)] pt-2">
    <p className="text-xs font-semibold">{t('Сначала завершите:')}</p>
    <ul aria-label={t('Незавершённые предпосылки')} className="text-xs">
      {summary.pending.map(item => <li key={item.id}>
        <Link className="inline-flex min-h-11 items-center py-2 underline break-words max-w-full"
          to={weeklyChecklistHref(weddingId, item.id)}>{item.title || t('Без названия')}</Link>
      </li>)}
    </ul>
  </div>
}
