import { Link } from 'react-router'
import { ChevronRight } from 'lucide-react'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import type { components } from '@/lib/api/schema'
import { noWedding, useApi } from '@/lib/api/useApi'
import { getWeddingWeek } from '@/lib/api/weddingData'
import { key, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { useStore } from '@/lib/store'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { formatWeddingDate } from '@/lib/weddingDate'

type WeekItem = components['schemas']['WeddingWeekItem']

const kinds: Record<WeekItem['kind'], string> = {
  task: key('Задача'),
  payment: key('Платёж'),
  guest_reply: key('Ответы гостей'),
  offer_reply: key('Ответ исполнителя'),
  terms: key('Неподтверждённые условия'),
}

const responsibility: Record<WeekItem['responsible'], string> = {
  unassigned: key('Ответственный не назначен'),
  member: key('Участник команды'),
  couple: key('Пара'),
  guest: key('Гости'),
  performer: key('Исполнитель'),
  both: key('Пара и исполнитель'),
}

function WeekItems({ items }: { items: WeekItem[] }) {
  return <ul className="space-y-2">
    {items.map(item => <li key={`${item.kind}:${item.id}`}>
      <Link to={item.href} className="press card flex min-h-14 items-center gap-3 p-3.5 focus-visible:ring-2 focus-visible:ring-[var(--rose)]">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-[var(--soft)]">{t(kinds[item.kind])}</p>
          <p className="break-words text-[14px] font-bold">{item.title}</p>
          <p className="text-[12px] text-[var(--soft)]">
            {t('Кто отвечает — {name}').replace('{name}', item.responsibleName || t(responsibility[item.responsible]))}
          </p>
          {item.pendingCount !== undefined && <p className="text-[12px] text-[var(--soft)]">{t('Без ответа — {count}').replace('{count}', String(item.pendingCount))}</p>}
          {item.kind === 'payment' && <p className="text-[12px] font-semibold">{item.amount ? fmt(item.amount.amount) : t('Сумма уточняется')}</p>}
        </div>
        {item.due && <time dateTime={item.due} className="max-w-[30%] text-right text-[11px] font-semibold">{formatWeddingDate(item.due)}</time>}
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--soft)]" />
      </Link>
    </li>)}
  </ul>
}

export default function WeddingWeek() {
  const { weddingId } = useStore()
  const scope = useLegacySessionKey(weddingId ?? '')
  const capture = useLegacyActionScope(scope, weddingId)
  const q = useApi(() => weddingId ? getWeddingWeek(weddingId, capture().assertCurrent) : noWedding(), [weddingId, capture])
  const data = ready(q) && !q.refreshing ? q.data : null
  const dated = data?.items.filter(item => item.due !== null) ?? []
  const undated = data?.items.filter(item => item.due === null) ?? []
  return <div className="pb-28">
    <TopBar back title={t('На этой неделе')} />
    <div className="px-5 space-y-4">
      <AsyncState q={q} />
      {data && <>
        <p className="text-[13px] font-semibold text-[var(--soft)]">
          {`${formatWeddingDate(data.range.startsOn)} — ${formatWeddingDate(data.range.endsOn)}`}
        </p>
        {data.readOnly ? <p className="card p-4 text-sm">{t('Свадьба отменена')}</p> : <>
          {data.items.length === 0 && <p className="card p-4 text-sm">{t('На эту неделю нет открытых дел')}</p>}
          {dated.length > 0 && <WeekItems items={dated} />}
          {undated.length > 0 && <section className="space-y-2">
            <h2 className="text-sm font-bold">{t('Без срока')}</h2>
            <WeekItems items={undated} />
          </section>}
        </>}
      </>}
    </div>
  </div>
}
