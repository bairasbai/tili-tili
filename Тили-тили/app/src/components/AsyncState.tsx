/* eslint-disable react-refresh/only-export-components -- рядом с компонентом
   живут `ready()` и `num()`: это одно правило «ничего не утверждать до ответа
   сервера» (R-178) в трёх формах, и разносить их по файлам значило бы
   разносить правило. Само правило линта — про скорость hot-reload, не про
   поведение приложения (тот же случай, что `lib/store.tsx`). */
import { useNavigate } from 'react-router'
import { t } from '@/lib/i18n'
import { SESSION_EXPIRED } from '@/lib/api/client'
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
 *
 * Смерть сессии — тоже отдельно (ревью D6-09): после неудачного refresh
 * клиент снимает токены, и «Повторить» ушло бы без заголовка — сервер ответил
 * бы служебным «Нужен заголовок Authorization: Bearer», и этот текст читал
 * человек. Здесь вместо повтора — «Войти». Узнаём случай по словам клиента
 * (`SESSION_EXPIRED`): `AsyncData` кода ошибки не несёт.
 */
export function AsyncState({ q, forbiddenText }: { q: AsyncData<unknown>; forbiddenText?: string }) {
  const nav = useNavigate()
  if (q.loading) return <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Загружаем…')}</p>
  if (q.forbidden) return (
    <p className="text-[12px] text-[var(--soft)] py-6 text-center leading-relaxed px-6">
      {forbiddenText ?? t('Этот раздел ведёт пара — у вашей роли к нему доступа нет.')}
    </p>
  )
  if (q.error === SESSION_EXPIRED) return (
    <div className="py-6 text-center">
      <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed px-6">{t(SESSION_EXPIRED)}</p>
      <button onClick={() => nav('/auth')} className="press mt-3 px-5 h-[40px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Войти')}</button>
    </div>
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

/**
 * Число, которое можно показать. Пока ответа нет — прочерк.
 *
 * Ноль — это значение, а не «неизвестно». Счётчики считались от `?? []`, и при
 * лежащем сервере рядом с честным «Сервер недоступен» стояло «0 гостей»,
 * «0 забронировано», «Доход 0 ₽». Пара читает это не как «мы не знаем», а как
 * «никто не ответил» — и звонит подрядчикам выяснять, куда делись гости.
 */
export function num(q: AsyncData<unknown>, value: number | string): string {
  return ready(q) ? String(value) : '—'
}
