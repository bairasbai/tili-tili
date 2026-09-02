import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Check, X, Clock, Send, Star, TrendingUp, Eye, MessageCircle, CalendarCheck, ChevronRight } from 'lucide-react'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/data'
import { t } from '@/lib/i18n'

/* Заявка подрядчика: детально */
export function VendorLead() {
  const nav = useNavigate()
  const { id } = useParams()
  const lead = {
    ch1: { n: t('Алина и Тимур'), d: t('14 июня 2027'), b: t('до 90 тыс ₽'), msg: t('Здравствуйте! Нам очень понравился ваш светлый стиль. Свадьба в загородном клубе «Маркони», 120 гостей. Свободны ли вы 14 июня?') },
    ch2: { n: t('Дина и Руслан'), d: t('5 сентября 2027'), b: t('пакет «Полный день»'), msg: t('Добрый день! Рассматриваем вас на полный день. Можно созвониться на этой неделе?') },
    ch3: { n: t('Анна и Марк'), d: t('18 июля 2027'), b: t('церемония'), msg: t('Привет! Нужна съёмка только церемонии в Хамитове, 2 часа. Сколько будет стоить?') },
  }[id ?? 'ch1'] ?? { n: t('Алина и Тимур'), d: t('14 июня 2027'), b: t('до 90 тыс ₽'), msg: t('Здравствуйте! Нам очень понравился ваш стиль. Свободны ли вы?') }
  const [state, setState] = useState<'new' | 'hold' | 'declined'>('new')
  const [reply, setReply] = useState('')
  const [sent, setSent] = useState<string[]>([])
  const templates = [
    t('Здравствуйте! Дата свободна, с радостью обсудим детали 💛'),
    t('Спасибо за интерес! Предлагаю созвониться — когда удобно?'),
    t('К сожалению, на эту дату я занята. Могу порекомендовать коллег.'),
  ]
  const send = (text: string) => { if (text.trim()) { setSent(s => [...s, text]); setReply('') } }

  return (
    <div className="min-h-dvh flex flex-col pb-10">
      <TopBar back title={lead.n} sub={`${lead.d} · ${lead.b}`} />
      <div className="flex-1 px-5 mt-3 space-y-3">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full grad flex items-center justify-center text-white font-serif-d text-[17px]">{lead.n[0]}</div>
            <div className="flex-1">
              <b className="text-[14px]">{lead.n}</b>
              <p className="text-[10.5px] text-[var(--soft)]">{t('заявка из каталога · отвечаете в среднем за 2 ч')}</p>
            </div>
            {state === 'hold' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--honey)] text-[var(--honey-deep)]">{t('⏳ Hold 72 ч')}</span>}
            {state === 'declined' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--rose-soft)] text-[var(--rose-deep)]">{t('Отклонена')}</span>}
          </div>
          <div className="card-s p-3.5 mt-3 text-[12.5px] text-[var(--ink2)] leading-relaxed">{lead.msg}</div>
          {sent.map((m, k) => (
            <div key={k} className="mt-2.5 max-w-[85%] ml-auto grad text-white rounded-[18px] rounded-br-md px-4 py-2.5 text-[12.5px] leading-relaxed">{m}</div>
          ))}
        </div>

        {state === 'new' && (
          <>
            <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1">{t('Быстрые ответы')}</span>
            <div className="space-y-2">
              {templates.map(t => (
                <button key={t} onClick={() => send(t)} className="press w-full card-s px-4 py-3 text-left text-[12px] text-[var(--ink2)]">{t}</button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2.5 pt-1">
              <button onClick={() => setState('hold')} className="press h-11 rounded-full bg-[var(--honey)] text-[var(--honey-deep)] text-[11.5px] font-bold flex items-center justify-center gap-1"><Clock size={13} />{t('Hold 72 ч')}</button>
              <button onClick={() => setState('declined')} className="press h-11 rounded-full bg-[var(--rose-soft)] text-[var(--rose-deep)] text-[11.5px] font-bold flex items-center justify-center gap-1"><X size={13} />{t('Отклонить')}</button>
              <button onClick={() => nav('/us/chats')} className="press h-11 rounded-full grad text-white text-[11.5px] font-bold flex items-center justify-center gap-1"><Check size={13} />{t('В чат')}</button>
            </div>
          </>
        )}
        {state !== 'new' && (
          <div className="card-s p-4 text-center">
            <b className="text-[13px]">{state === 'hold' ? t('Дата на hold 72 часа') : t('Заявка отклонена')}</b>
            <p className="text-[11px] text-[var(--soft)] mt-1">{state === 'hold' ? t('Пара увидит бронь даты и сможет подтвердить сделку.') : t('Пара получит вежливый отказ и рекомендации похожих.')}</p>
            <button onClick={() => setState('new')} className="press mt-3 text-[11px] font-bold text-[var(--rose-deep)]">{t('Вернуть в работу')}</button>
          </div>
        )}
      </div>
      <div className="px-5 pt-3 flex gap-2">
        <input value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && send(reply)} placeholder={t('Написать паре…')} className="flex-1 h-12 px-5 rounded-full bg-[var(--card)] text-[13px] outline-none" style={{ boxShadow: 'var(--shadow)' }} />
        <button onClick={() => send(reply)} className="press w-12 h-12 rounded-full grad text-white flex items-center justify-center shrink-0"><Send size={16} /></button>
      </div>
    </div>
  )
}

/* Отзывы подрядчика */
export function VendorReviews() {
  const [reviews, setReviews] = useState([
    { n: t('Гульнара и Тимур'), d: t('23 мая 2026'), s: 5, t: t('Лёна, это лучшее, что случилось с нашей свадьбой! Каждый кадр — как из журнала, а живые эмоции пойманы идеально.'), reply: '' },
    { n: t('Регина и Артур'), d: t('12 апреля 2026'), s: 5, t: t('Очень деликатная съёмка, никто не уставал от камеры. Фото получили через 3 недели, как и обещали.'), reply: t('Спасибо вам за доверие! Было счастьем быть с вами 💛') },
    { n: t('Марсель и Алина'), d: t('14 марта 2026'), s: 4, t: t('Всё понравилось, единственное — хотелось бы больше групповых кадров с роднёй. В следующий раз составим список заранее :)'), reply: '' },
  ])
  const [answering, setAnswering] = useState<number | null>(null)
  const [text, setText] = useState('')
  const save = (k: number) => {
    setReviews(r => r.map((x, i) => i === k ? { ...x, reply: text } : x))
    setAnswering(null); setText('')
  }
  const answered = reviews.filter(r => r.reply).length
  return (
    <div className="pb-28">
      <TopBar back title={t('Отзывы')} sub={`${reviews.length}${t(' отзыва · отвечено ')}${answered}`} />
      <div className="px-5 mt-3">
        <div className="card p-4 flex items-center gap-4">
          <div className="text-center">
            <b className="font-serif-d text-[30px] tabular">4.9</b>
            <p className="text-[9.5px] text-[var(--honey-deep)]">★★★★★</p>
          </div>
          <div className="flex-1">
            <Bar pct={Math.round(answered / reviews.length * 100)} />
            <p className="text-[10.5px] text-[var(--soft)] mt-2">{t('Анкеты с ответами на все отзывы получают на 25% больше заявок.')}</p>
          </div>
        </div>
        <div className="space-y-2.5 mt-3.5 stagger">
          {reviews.map((r, k) => (
            <div key={r.n} className="card p-4 fade-up">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-[var(--rose-soft)] flex items-center justify-center text-[13px] font-serif-d text-[var(--rose-deep)]">{r.n[0]}</div>
                <div className="flex-1">
                  <b className="text-[12.5px]">{r.n}</b>
                  <p className="text-[9.5px] text-[var(--soft)]">{r.d}</p>
                </div>
                <span className="text-[10px] text-[var(--honey-deep)]">{'★'.repeat(r.s)}{'☆'.repeat(5 - r.s)}</span>
              </div>
              <p className="text-[12px] text-[var(--ink2)] leading-relaxed mt-2.5">{r.t}</p>
              {r.reply ? (
                <div className="mt-2.5 pl-3 border-l-2 border-[#A9BCA0]">
                  <p className="text-[10px] font-bold text-[var(--sage-deep)] mb-0.5">{t('Ваш ответ')}</p>
                  <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed">{r.reply}</p>
                </div>
              ) : answering === k ? (
                <div className="mt-2.5 flex gap-2">
                  <input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && save(k)} placeholder={t('Ответить…')} className="flex-1 h-10 px-4 rounded-full bg-[var(--bg)] text-[12px] outline-none" />
                  <button onClick={() => save(k)} className="press w-10 h-10 rounded-full grad text-white flex items-center justify-center"><Send size={13} /></button>
                </div>
              ) : (
                <button onClick={() => { setAnswering(k); setText('') }} className="press mt-2.5 text-[11px] font-bold text-[var(--sage-deep)]">{t('Ответить →')}</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* Аналитика анкеты: воронка */
export function VendorAnalytics() {
  const nav = useNavigate()
  const funnel = [
    { l: t('Просмотры анкеты'), v: 1240, pct: 100, Icon: Eye, tile: 'bg-[var(--blue)]' },
    { l: t('В избранное'), v: 96, pct: 38, Icon: Star, tile: 'bg-[var(--honey)]' },
    { l: t('Написали / заявки'), v: 34, pct: 18, Icon: MessageCircle, tile: 'bg-[var(--rose-soft)]' },
    { l: t('Сделки'), v: 8, pct: 8, Icon: CalendarCheck, tile: 'bg-[var(--sage-soft)]' },
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Аналитика')} sub={t('Июнь — август 2026')} />
      <div className="px-5 mt-3">
        <div className="card p-5 grad text-white">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] tracking-[.18em] uppercase opacity-80 font-semibold">{t('Доход за сезон')}</span>
            <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--card)]/25 flex items-center gap-1"><TrendingUp size={10} /> +38%</span>
          </div>
          <b className="font-serif-d text-[30px] block mt-1 tabular">{fmt(385000)}</b>
          <p className="text-[11px] opacity-85 mt-1">{t('ещё')} {fmt(215000)} {t('ожидается по активным сделкам')}</p>
        </div>

        <div className="flex justify-between items-baseline px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">{t('Воронка анкеты')}</h2>
          <span className="text-[10px] text-[var(--soft)]">{t('конверсия в заявку 2.7%')}</span>
        </div>
        <div className="card p-4 space-y-3">
          {funnel.map(({ l, v, pct, Icon, tile }) => (
            <div key={l} className="flex items-center gap-3">
              <div className={cn('w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0', tile)}><Icon size={15} className="text-[var(--ink2)]" /></div>
              <div className="flex-1">
                <div className="flex justify-between text-[11px] mb-1"><span className="text-[var(--soft)]">{l}</span><b className="tabular">{v}</b></div>
                <Bar pct={pct} />
              </div>
            </div>
          ))}
        </div>

        <div className="card-s px-4 py-3 mt-3.5 flex gap-2.5">
          <span>✦</span>
          <p className="text-[11px] text-[var(--ink2)] leading-relaxed"><b>{t('Тиль:')}</b>{t('главное фото решает половину просмотров. Пары из вашего сегмента чаще сохраняют анкеты с ценой «от …» в первой строке.')}</p>
        </div>

        <button onClick={() => nav('/vendor-app/profile')} className="press w-full card-s p-4 mt-3.5 flex items-center gap-3 text-left">
          <Tile icon="🚀" tile="bg-[var(--rose-soft)]" size={42} />
          <div className="flex-1">
            <b className="text-[13px]">{t('Усилить анкету')}</b>
            <p className="text-[10.5px] text-[var(--soft)]">{t('добавьте видео и ещё 2 пакета — прогноз +60% просмотров')}</p>
          </div>
          <ChevronRight size={16} className="text-[var(--soft)]" />
        </button>
      </div>
    </div>
  )
}
