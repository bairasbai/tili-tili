import { AsyncState, ready } from './AsyncState'
import { getDealEvents } from '@/lib/api/slots'
import { useApi, type AsyncData } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { useLiveAccess } from '@/lib/offlineProgramHooks'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'

const stateLabels: Record<string, string> = {
  candidate: 'Не связывались',
  contacted: 'Написали',
  negotiating: 'Переговоры',
  booked: 'Забронировано',
  paid_deposit: 'Аванс внесён',
  done: 'Выполнено',
  cancelled: 'Сделка отменена',
}
const vendorStateLabels: Record<string, string> = {
  ...stateLabels,
  candidate: 'Вернулась к статусу «Не связывались»',
  contacted: 'Пара написала',
}
const coupleAuthors: Record<string, string> = { couple: 'вы', vendor: 'подрядчик', system: 'автоматически' }
const vendorAuthors: Record<string, string> = { couple: 'пара', vendor: 'вы', system: 'автоматически' }

export function DealJournal({ dealId, revision, vendor }: { dealId: string; revision?: string; vendor?: boolean }) {
  const key = useLegacySessionKey(dealId)
  return <DealJournalReader key={key} dealId={dealId} revision={revision} vendor={vendor} />
}

function DealJournalReader({ dealId, revision, vendor }: { dealId: string; revision?: string; vendor?: boolean }) {
  const capture = useLegacyActionScope(dealId)
  const events = useApi(() => getDealEvents(dealId, { assertCurrent: capture().assertCurrent }), [dealId, revision, capture])
  return <DealJournalView events={events} vendor={vendor} />
}

export function DealJournalView({ events, vendor = false }: {
  events: AsyncData<Awaited<ReturnType<typeof getDealEvents>>>
  vendor?: boolean
}) {
  const online = useLiveAccess(events.reload)
  const rows = online && ready(events) && !events.refreshing ? events.data : null
  const labels = vendor ? vendorStateLabels : stateLabels
  const authors = vendor ? vendorAuthors : coupleAuthors
  const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
  return <section className="card p-5">
    <h3 className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Что происходило')}</h3>
    {online ? <AsyncState q={events} forbiddenText={events.forbiddenText} />
      : <p role="status" className="text-xs text-[var(--soft)] mt-3">{t('Нет связи с сервером')}</p>}
    {online && events.refreshing && <p role="status" className="text-xs text-[var(--soft)] mt-3">{t('Обновляем…')}</p>}
    {rows?.length === 0 && <p className="text-[12px] text-[var(--soft)] mt-3">{t('Пока ничего не происходило')}</p>}
    {!!rows?.length && <ul className="mt-3 space-y-3">
      {rows.map(row => {
        const state = row.toState ?? ''
        const title = row.kind === 'price' ? row.note ?? t('Цена изменена')
          : row.fromState === null && state === 'candidate' ? t('Создан черновик заказа') : t(labels[state] ?? state)
        return <li key={row.id} className="flex gap-3">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--rose-deep)] mt-1.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] font-medium">{title}</p>
            <p className="text-[10.5px] text-[var(--soft2)] mt-0.5">
              {row.at && <time dateTime={row.at}>{new Date(row.at).toLocaleString(locale, {
                day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
              })}</time>}
              {row.by && ` · ${t(authors[row.by] ?? row.by)}`}
            </p>
          </div>
        </li>
      })}
    </ul>}
  </section>
}
