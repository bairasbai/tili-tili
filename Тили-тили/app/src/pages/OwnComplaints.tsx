import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { isAuthorized } from '@/lib/api/client'
import { getOwnComplaints } from '@/lib/api/reviews'
import { useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'

const targets = { vendor: 'Анкета подрядчика', review: 'Отзыв', message: 'Сообщение', deal: 'Сделка' } as const
const outcomes = { dismissed: 'Жалоба отклонена', measures_taken: 'Меры приняты', closed: 'Жалоба рассмотрена' } as const
const button = 'press min-h-11 rounded-full card-s px-4 font-semibold'

export default function OwnComplaints() {
  const key = useLegacySessionKey('own-complaints')
  return <div className="pb-24">
    <TopBar back fallback="/support" title={t('Мои жалобы')} />
    <div className="px-5 mt-3">
      {isAuthorized() ? <ComplaintHistory key={key} /> : <Link className={button + ' inline-flex items-center'} to="/auth">{t('Войти')}</Link>}
    </div>
  </div>
}

function ComplaintHistory() {
  const capture = useLegacyActionScope('own-complaints')
  const [cursor, setCursor] = useState<string | null>(null)
  const q = useApi(() => getOwnComplaints(cursor, capture()), [cursor, capture])
  const { data, reload } = q
  const next = data?.nextCursor ?? null
  const online = useProgramOnline(reload)
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  const date = new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', {
    dateStyle: 'medium', timeStyle: 'short',
  })

  if (!online) return <p role="status" className="text-sm text-[var(--soft)]">{t('Подключитесь к интернету, чтобы открыть жалобы')}</p>
  return <section className="space-y-3 text-sm">
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {ready(q) && !q.refreshing && data && <>
      {data.items.length === 0 && !cursor && <p className="text-[var(--soft)]">{t('Жалоб пока нет')}</p>}
      <ul className="space-y-2">
        {data.items.map(complaint => <li className="card-s space-y-2 p-4" key={complaint.id}>
          <div className="flex flex-wrap justify-between gap-2">
            <strong>{t(targets[complaint.targetKind])}</strong>
            <time className="text-xs text-[var(--soft)]" dateTime={complaint.createdAt}>
              {date.format(new Date(complaint.createdAt))}
            </time>
          </div>
          {complaint.text && <p className="whitespace-pre-wrap break-words">{complaint.text}</p>}
          <p className="font-semibold">{complaint.decision ? t(outcomes[complaint.decision.outcome]) : t('На рассмотрении')}</p>
          {complaint.decision && <>
            <p className="whitespace-pre-wrap break-words">{complaint.decision.reason ?? t('Пояснение не было сохранено')}</p>
            {complaint.decision.resolvedAt && <time className="text-xs text-[var(--soft)]" dateTime={complaint.decision.resolvedAt}>
              {date.format(new Date(complaint.decision.resolvedAt))}
            </time>}
          </>}
        </li>)}
      </ul>
      {(cursor || next) && <div className="flex flex-wrap gap-2">
        {cursor && <button className={button} type="button" onClick={() => setCursor(null)}>{t('К началу списка')}</button>}
        {next && <button className={button} type="button" onClick={() => setCursor(next)}>
          {t('Следующая страница')}
        </button>}
      </div>}
    </>}
  </section>
}
