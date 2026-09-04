import { t } from '@/lib/i18n'
import type { AsyncData } from '@/lib/api/useApi'

/*
 * Три состояния запроса на экране: грузится, закрыто правами, не дошло.
 *
 * Вынесены в одно место не ради краткости, а ради одинакового поведения: на
 * семи экранах чтения свадьбы человек должен видеть одни и те же слова и одну
 * и ту же кнопку, иначе «сервер недоступен» на бюджете и «ошибка» на гостях
 * читаются как две разные поломки.
 *
 * Отказ по правам отделён намеренно: у него нет кнопки «Повторить». Повторять
 * нечего — раздел закрыт роли, и предлагать повтор значит обещать, что со
 * второго раза пустят.
 */
export function AsyncState({ q, forbiddenText }: { q: AsyncData<unknown>; forbiddenText?: string }) {
  if (q.loading) return <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Загружаем…')}</p>
  if (q.forbidden) return (
    <p className="text-[12px] text-[var(--soft)] py-6 text-center leading-relaxed px-6">
      {forbiddenText ?? t('Этот раздел ведёт пара — у вашей роли к нему доступа нет.')}
    </p>
  )
  if (q.error) return (
    <div className="py-6 text-center">
      <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed px-6">{q.error}</p>
      <button onClick={q.reload} className="press mt-3 px-5 h-[40px] rounded-full card-s text-[12px] font-semibold">{t('Повторить')}</button>
    </div>
  )
  return null
}

/** Показывать ли содержимое: данные есть и ни одно из трёх состояний не активно. */
export function ready(q: AsyncData<unknown>): boolean {
  return !q.loading && !q.error && !q.forbidden
}
