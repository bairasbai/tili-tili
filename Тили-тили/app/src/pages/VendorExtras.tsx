import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { X, Clock, Send, Star, TrendingUp, Eye, MessageCircle, CalendarCheck, ChevronRight } from 'lucide-react'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { explainError, useApi } from '@/lib/api/useApi'
import { getVendorAnalytics, getVendorLeads, getVendorReviews, leadAction, replyToReview } from '@/lib/api/vendor'
import { cn, pct, plural } from '@/lib/utils'
import { fmt } from '@/lib/money'
import { t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'

/*
 * Заявка подрядчика.
 *
 * Экран был словарём из трёх выдуманных пар: `ch1`, `ch2`, `ch3` — какой бы
 * идентификатор ни стоял в адресе, показывалась «Алина и Тимур». Быстрые
 * ответы никуда не уходили, «Hold 72 ч» и «Отклонить» переключали состояние
 * внутри экрана, а пара об этом не узнавала.
 *
 * Теперь заявка настоящая, а каждое действие уходит в `POST /vendor/leads/{id}`.
 * Что именно делает сервер, важно называть точно: ответ уходит сообщением в
 * чат пары и поднимает ей уведомление, а hold и отказ живут у самой заявки —
 * дату они не бронируют и паре не пишут. Экран говорит это словами, потому
 * что подрядчик планирует свой месяц по этим пометкам.
 */
export function VendorLead() {
  const nav = useNavigate()
  const { id } = useParams()
  const q = useApi(() => getVendorLeads(), [])
  const lead = (q.data ?? []).find(l => l.id === id)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const act = (action: 'reply' | 'hold' | 'decline' | 'reopen', text?: string) => void (async () => {
    if (!id) return
    setBusy(true)
    setErr(null)
    try { await leadAction(id, action, text); setReply(''); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  if (!lead) return (
    <div className="pb-28">
      <TopBar back title={t('Заявка')} />
      <AsyncState q={q} />
      {ready(q) && <p className="px-5 mt-6 text-[13px] text-[var(--soft)]">{t('Заявка не найдена')}</p>}
    </div>
  )

  const status = lead.status ?? 'new'
  const templates = [
    t('Здравствуйте! Дата свободна, с радостью обсудим детали 💛'),
    t('Спасибо за интерес! Предлагаю созвониться — когда удобно?'),
    t('К сожалению, на эту дату я занят. Могу порекомендовать коллег.'),
  ]

  return (
    <div className="min-h-dvh flex flex-col pb-10">
      <TopBar back title={lead.coupleName ?? t('Заявка')} sub={lead.weddingDate ? formatWeddingDate(lead.weddingDate) : t('дата не назначена')} />
      <div className="flex-1 px-5 mt-3 space-y-3">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full grad flex items-center justify-center text-[var(--on-grad)] font-serif-d text-[17px]">{(lead.coupleName ?? '?')[0]}</div>
            <div className="flex-1 min-w-0">
              <b className="text-[14px]">{lead.coupleName}</b>
              <p className="text-[10.5px] text-[var(--soft)]">{lead.city ?? t('город не указан')}</p>
            </div>
            {status === 'hold' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--honey)] text-[var(--honey-ink)]">{t('⏳ Держим дату')}</span>}
            {status === 'declined' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)]">{t('Отклонена')}</span>}
            {status === 'won' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('Сделка')}</span>}
          </div>
          {lead.message && <div className="card-s p-3.5 mt-3 text-[12.5px] text-[var(--ink2)] leading-relaxed">{lead.message}</div>}
          {/* Срок — ваш собственный: сервер держит его у заявки и ничего не
              бронирует. Бронь появляется только со сделкой. */}
          {lead.holdUntil && (
            <p className="text-[10.5px] text-[var(--honey-deep)] mt-2.5">{t('Держите до')} {new Date(lead.holdUntil).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>
          )}
        </div>

        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}

        {(status === 'new' || status === 'replied') && (
          <>
            <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1">{t('Быстрые ответы')}</span>
            <div className="space-y-2">
              {templates.map(x => (
                <button key={x} disabled={busy} onClick={() => act('reply', x)} className="press w-full card-s px-4 py-3 text-left text-[12px] text-[var(--ink2)] disabled:opacity-50">{x}</button>
              ))}
            </div>
            {/* Кнопки «В чат» здесь нет: список чатов ещё на моках (этап 10),
                и подрядчик попадал в чужую выдуманную переписку. Ответ уходит
                отсюда — полем ниже, и он же ложится в чат пары. */}
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button disabled={busy} onClick={() => act('hold')} className="press h-11 rounded-full bg-[var(--honey)] text-[var(--honey-ink)] text-[11.5px] font-bold flex items-center justify-center gap-1 disabled:opacity-50"><Clock size={13} />{t('Hold 72 ч')}</button>
              <button disabled={busy} onClick={() => act('decline')} className="press h-11 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[11.5px] font-bold flex items-center justify-center gap-1 disabled:opacity-50"><X size={13} />{t('Отклонить')}</button>
            </div>
          </>
        )}
        {/* Выигранная заявка — уже сделка, и действий над ней здесь нет.
            Без этой строки экран выглядит пустым и сломанным: ни кнопок, ни
            объяснения, куда делась заявка. */}
        {status === 'won' && (
          <div className="card-s p-4 text-center">
            <b className="text-[13px]">{t('Заявка стала сделкой')}</b>
            <p className="text-[11px] text-[var(--soft)] mt-1">{t('Пара забронировала вас — дальше всё в разделе «Сделки»: сумма, аванс и состояние.')}</p>
            <button onClick={() => nav('/vendor-app/deals')} className="press mt-3 text-[11px] font-bold text-[var(--sage-deep)]">{t('Открыть сделки →')}</button>
          </div>
        )}
        {(status === 'hold' || status === 'declined') && (
          <div className="card-s p-4 text-center">
            <b className="text-[13px]">{status === 'hold' ? t('Держим дату 72 часа') : t('Заявка отклонена')}</b>
            {/* Прежние подписи обещали чужое действие: «пара видит бронь» и
                «пара получила отказ». Сервер не делает ни того, ни другого —
                hold и отказ живут у заявки, пара узнаёт о решении из чата. */}
            <p className="text-[11px] text-[var(--soft)] mt-1">{status === 'hold' ? t('Это ваша пометка со сроком. Бронь даты появится, когда пара подтвердит сделку — напишите ей, чтобы не потерять время.') : t('Пара уведомления не получит: если нужно объяснить отказ, напишите в чат.')}</p>
            <button disabled={busy} onClick={() => act('reopen')} className="press mt-3 text-[11px] font-bold text-[var(--rose-deep)] disabled:opacity-50">{t('Вернуть в работу')}</button>
          </div>
        )}
      </div>
      {(status === 'new' || status === 'replied') && (
        <div className="px-5 pt-3 flex gap-2">
          <input value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && reply.trim() && act('reply', reply.trim())} placeholder={t('Написать паре…')} className="flex-1 h-12 px-5 rounded-full bg-[var(--card)] text-[13px] outline-none" style={{ boxShadow: 'var(--shadow)' }} />
          <button disabled={busy || !reply.trim()} onClick={() => act('reply', reply.trim())} className="press w-12 h-12 rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0 disabled:opacity-50"><Send size={16} /></button>
        </div>
      )}
    </div>
  )
}

/*
 * Отзывы о подрядчике.
 *
 * Три отзыва стояли в состоянии экрана, рейтинг «4.9» — в разметке, а ответ
 * подрядчика оставался в браузере и до пары не доходил. Теперь отзывы читаются
 * с сервера, а ответ уходит в `POST /vendor/reviews/{id}/reply` и виден всем в
 * карточке анкеты.
 */
export function VendorReviews() {
  const q = useApi(() => getVendorReviews(), [])
  const reviews = q.data ?? []
  const [answering, setAnswering] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const answered = reviews.filter(r => r.reply).length
  /* Средняя оценка считается по тем же отзывам, что на экране. Сервер держит
     свой рейтинг с затуханием — он в карточке анкеты, и это разные числа. */
  const avg = reviews.length ? Math.round(reviews.reduce((s, r) => s + (r.rating ?? 0), 0) / reviews.length * 10) / 10 : null

  const save = (reviewId: string) => void (async () => {
    if (!text.trim()) return
    setBusy(true)
    setErr(null)
    try { await replyToReview(reviewId, text.trim()); setAnswering(null); setText(''); q.reload() }
    catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <div className="pb-28">
      <TopBar back title={t('Отзывы')} sub={reviews.length ? `${reviews.length} ${plural(reviews.length, t('отзыв'), t('отзыва'), t('отзывов'))} · ${t('отвечено')} ${answered}` : ''} />
      <AsyncState q={q} />
      <div className="px-5 mt-3">
        {!reviews.length && ready(q) && (
          <p className="text-[12px] text-[var(--soft)] py-3">{t('Отзывов пока нет. Их оставляют пары после завершённой сделки и гости — после свадьбы.')}</p>
        )}
        {reviews.length > 0 && (
          <div className="card p-4 flex items-center gap-4">
            <div className="text-center">
              <b className="font-serif-d text-[30px] tabular">{avg}</b>
              <p className="text-[9.5px] text-[var(--honey-deep)]">{'★'.repeat(Math.round(avg ?? 0))}</p>
            </div>
            <div className="flex-1">
              <Bar pct={pct(answered, reviews.length)} />
              <p className="text-[10.5px] text-[var(--soft)] mt-2">{t('Отвечено на')} {answered} {t('из')} {reviews.length}. {t('Ответ виден парам в карточке анкеты.')}</p>
              {/* Число слева — простое среднее по вашим отзывам. В каталоге
                  стоит другое: взвешенное, со скидкой на давность и на вес
                  гостя, и оно появляется только с третьего отзыва — один
                  отзыв от знакомого не должен делать пятёрку. */}
              {reviews.length < 3 && (
                <p className="text-[10px] text-[var(--soft2)] mt-1">{t('В каталоге оценка появится с третьего отзыва')}</p>
              )}
            </div>
          </div>
        )}
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-2">{err}</p>}
        <div className="space-y-2.5 mt-3.5 stagger">
          {reviews.map(r => (
            <div key={r.id} className="card p-4 fade-up">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-[var(--rose-soft)] flex items-center justify-center text-[13px] font-serif-d text-[var(--rose-ink)]">{(r.authorName ?? '?')[0]}</div>
                <div className="flex-1 min-w-0">
                  <b className="text-[12.5px]">{r.authorName}</b>
                  <p className="text-[9.5px] text-[var(--soft)]">{r.createdAt ? new Date(r.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</p>
                </div>
                {/* Гость и пара весят в рейтинге по-разному — значок об этом
                    честно предупреждает (§15). */}
                {r.source === 'guest' && <span className="text-[8.5px] font-bold px-2 py-1 rounded-full bg-[var(--blue)] text-[var(--blue-ink)]">{t('Гость')}</span>}
                <span className="text-[10px] text-[var(--honey-deep)]">{'★'.repeat(r.rating ?? 0)}{'☆'.repeat(5 - (r.rating ?? 0))}</span>
              </div>
              {r.text && <p className="text-[12px] text-[var(--ink2)] leading-relaxed mt-2.5">{r.text}</p>}
              {r.reply ? (
                <div className="mt-2.5 pl-3 border-l-2 border-[#A9BCA0]">
                  <p className="text-[10px] font-bold text-[var(--sage-deep)] mb-0.5">{t('Ваш ответ')}</p>
                  <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed">{r.reply.text}</p>
                </div>
              ) : answering === r.id ? (
                <div className="mt-2.5 flex gap-2">
                  <input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && save(r.id ?? '')} placeholder={t('Ответить…')} className="flex-1 h-10 px-4 rounded-full bg-[var(--bg)] text-[12px] outline-none" />
                  <button disabled={busy} onClick={() => save(r.id ?? '')} className="press w-10 h-10 rounded-full grad text-[var(--on-grad)] flex items-center justify-center disabled:opacity-50"><Send size={13} /></button>
                </div>
              ) : (
                <button onClick={() => { setAnswering(r.id ?? null); setText('') }} className="press mt-2.5 text-[11px] font-bold text-[var(--sage-deep)]">{t('Ответить →')}</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/*
 * Аналитика анкеты.
 *
 * Воронка «1 240 → 96 → 34 → 8», доход 385 000 ₽ и «+38%» стояли в разметке:
 * одни и те же числа у каждого подрядчика. Теперь их считает сервер, а период
 * выбирается — месяц, сезон, год.
 */
export function VendorAnalytics() {
  const nav = useNavigate()
  const [period, setPeriod] = useState<'month' | 'season' | 'year'>('season')
  const q = useApi(() => getVendorAnalytics(period), [period])
  const a = q.data
  const f = a?.funnel
  const views = f?.views ?? 0

  const funnel = [
    { l: t('Просмотры анкеты'), v: views, Icon: Eye, tile: 'bg-[var(--blue)]' },
    { l: t('Написали'), v: f?.contacts ?? 0, Icon: Star, tile: 'bg-[var(--honey)]' },
    { l: t('Заявки'), v: f?.leads ?? 0, Icon: MessageCircle, tile: 'bg-[var(--rose-soft)]' },
    { l: t('Сделки'), v: f?.deals ?? 0, Icon: CalendarCheck, tile: 'bg-[var(--sage-soft)]' },
  ]

  return (
    <div className="pb-28">
      <TopBar back title={t('Аналитика')} sub={t(PERIOD_LABEL[period])} />
      <AsyncState q={q} />
      <div className="px-5 mt-3">
        <div className="flex gap-2">
          {(['month', 'season', 'year'] as const).map(x => (
            <button key={x} onClick={() => setPeriod(x)} className={cn('press flex-1 h-9 rounded-full text-[11.5px] font-semibold', period === x ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)] text-[var(--soft)]')}>{t(PERIOD_LABEL[x])}</button>
          ))}
        </div>
        {/* Доход и воронка — только когда цифры пришли. «Доход 0 ₽» при
            отказе сервера читается как факт о своём месяце. */}
        {ready(q) && (
        <div className="card p-5 grad text-[var(--on-grad)] mt-3">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] tracking-[.18em] uppercase opacity-80 font-semibold">{t('Доход')}</span>
            {/* Прирост приходит пустым, когда прошлого периода не было:
                «+100%» от нуля — это выдумка, и сервер её не делает. */}
            {a?.revenueDeltaPct != null && (
              <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--card)]/25 flex items-center gap-1">
                <TrendingUp size={10} /> {a.revenueDeltaPct > 0 ? '+' : ''}{Math.round(a.revenueDeltaPct)}%
              </span>
            )}
          </div>
          <b className="font-serif-d text-[30px] block mt-1 tabular">{fmt(a?.revenue?.amount ?? 0)}</b>
        </div>

        )}

        {ready(q) && (<>
        <div className="flex justify-between items-baseline px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">{t('Воронка анкеты')}</h2>
          {views > 0 && <span className="text-[10px] text-[var(--soft)]">{t('в заявку')} {pct(f?.leads ?? 0, views)}%</span>}
        </div>
        <div className="card p-4 space-y-3">
          {funnel.map(({ l, v, Icon, tile }) => (
            <div key={l} className="flex items-center gap-3">
              <div className={cn('w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0', tile)}><Icon size={15} className="text-[var(--ink2)]" /></div>
              <div className="flex-1">
                <div className="flex justify-between text-[11px] mb-1"><span className="text-[var(--soft)]">{l}</span><b className="tabular">{v}</b></div>
                <Bar pct={pct(v, views)} />
              </div>
            </div>
          ))}
        </div>
        {views === 0 && (
          <p className="text-[11.5px] text-[var(--soft)] mt-3 px-1">{t('Пока нет данных: анкету ещё не смотрели. Числа появятся, когда она будет опубликована и попадёт в выдачу.')}</p>
        )}
        </>)}

        <button onClick={() => nav('/vendor-app/profile')} className="press w-full card-s p-4 mt-3.5 flex items-center gap-3 text-left">
          <Tile icon="🚀" tile="bg-[var(--rose-soft)]" size={42} />
          <div className="flex-1">
            <b className="text-[13px]">{t('Открыть анкету')}</b>
            <p className="text-[10.5px] text-[var(--soft)]">{t('заполненные пакеты и рассказ о себе поднимают конверсию')}</p>
          </div>
          <ChevronRight size={16} className="text-[var(--soft)]" />
        </button>
      </div>
    </div>
  )
}

const PERIOD_LABEL: Record<string, string> = { month: 'Месяц', season: 'Сезон', year: 'Год' }
