import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Send, CloudRain, Zap, Heart } from 'lucide-react'
import { vendors, timeline, categories } from '@/lib/data'
import { useStore } from '@/lib/store'
import { TopBar } from '@/components/chrome'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* ИИ-координатор «Тиль» */
export function Assistant() {
  const nav = useNavigate()
  const [msgs, setMsgs] = useState([
    { me: false, text: t('Здравствуйте, Алина и Тимур! Я Тиль — ваш ИИ-координатор. Слежу за бюджетом, дедлайнами и датами подрядчиков. Что обсудим?') },
  ])
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const canned: Record<string, string> = {}
  const answer = (q: string) =>
    canned[q] ?? (q.includes('алкогол')
      ? t('На 80 гостей банкетного формата закладывайте: игристое 0,5 л/чел, вино 0,4 л/чел, крепкое 0,25 л/чел + безалкогольное 1,5 л/чел. Для усадьбы уточните пробковый сбор.')
      : q.includes('забыл') || q.includes('забыли')
      ? t('Проверил проект: пустые слоты — DJ, декоратор, транспорт, платье, кольца. Ближайший дедлайн — приглашения до 1 марта. С чего начнём?')
      : t('Принято! Записал в план. Хотите, добавлю задачу в чек-лист с дедлайном?'))
  const quick = [t('Что мы забыли?'), t('Сколько алкоголя на 80 гостей?'), t('Найди DJ до 40 тыс ₽'), t('Собери план дня')]
  const send = (t: string) => {
    if (!t.trim()) return
    setMsgs(m => [...m, { me: true, text: t }])
    setText('')
    setTyping(true)
    setTimeout(() => { setMsgs(m => [...m, { me: false, text: answer(t) }]); setTyping(false) }, 900)
  }
  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => nav(-1)} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}><ChevronLeft size={17} /></button>
        <div className="w-[38px] h-[38px] rounded-full grad flex items-center justify-center text-white text-[15px]">✦</div>
        <div className="flex-1"><b className="text-[14px]">{t('Тиль')}</b><p className="text-[10px] text-[#7E9A74]">{t('ИИ-координатор · на связи · 42/50 сообщений сегодня')}</p></div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
        {msgs.map((m, k) => (
          <div key={k} className={cn('flex fade-up', m.me ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[80%] px-4 py-3 text-[13px] leading-relaxed', m.me ? 'grad text-white rounded-[18px] rounded-br-[6px]' : 'card rounded-[18px] rounded-bl-[6px]')}>{m.text}</div>
          </div>
        ))}
        {typing && (
          <div className="flex justify-start fade-up">
            <div className="card rounded-[18px] rounded-bl-[6px] px-4 py-3.5 flex gap-1.5">
              {[0, 1, 2].map(d => <span key={d} className="w-1.5 h-1.5 rounded-full bg-[#C98A8A] animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />)}
            </div>
          </div>
        )}
      </div>
      <div className="px-4 pb-2 flex gap-2 overflow-x-auto no-scrollbar">
        {quick.map(q => <button key={q} onClick={() => send(q)} className="press px-4 py-2 rounded-full bg-[var(--card)] text-[11px] font-semibold whitespace-nowrap text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>{q}</button>)}
      </div>
      <div className="glass-tab border-t-0 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] flex gap-2.5">
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send(text)} placeholder={t('Спросите Тиля…')} className="flex-1 bg-[var(--card)] rounded-full px-5 h-[48px] text-[13.5px] outline-none placeholder:text-[var(--soft2)]" style={{ boxShadow: 'var(--shadow)' }} />
        <button onClick={() => send(text)} className="press w-[48px] h-[48px] rounded-full grad text-white flex items-center justify-center shrink-0" aria-label={t('Отправить')}><Send size={17} /></button>
      </div>
    </div>
  )
}

/* Сравнение кандидатов */
export function Compare() {
  const nav = useNavigate()
  const { slots, bookVendor } = useStore()
  const [picked, setPicked] = useState<string | null>(null)
  const list = vendors.slice(0, 3)
  const pick = (v: typeof list[0]) => {
    const slot = slots.find(s => s.categoryId === categories.find(c => c.name === v.category)?.id) ?? slots.find(s => s.state === 'empty')
    if (slot) bookVendor(slot.id, v.name, v.priceFrom)
    setPicked(v.id)
    setTimeout(() => nav('/wedding'), 900)
  }
  const rows: [string, (v: typeof list[0]) => string][] = [
    [t('Цена «от»'), v => `${v.priceFrom.toLocaleString('ru-RU')} ₽`],
    [t('Рейтинг'), v => (v.reviews ? `★ ${v.rating} · ${v.reviews}${t(' отзывов')}` : t('Новый'))],
    [t('Свободен 14.06'), v => (v.freeOnDate ? '✓ Да' : t('✕ Занят'))],
    [t('Видео-визитка'), v => (v.hasVideo ? '▶ Есть' : '—')],
    [t('Пакетов'), v => String(v.packages.length)],
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Сравнение')} sub={t('3 кандидата · категория «Фотограф»')} />
      <div className="px-5 mt-3 overflow-x-auto no-scrollbar">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr>
              <td className="w-[110px]" />
              {list.map((v, k) => (
                <td key={v.id} className="p-1.5 align-top">
                  <div className={cn('card-s p-3 text-center relative', v.tile)}>
                    {k === 0 && <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[8px] font-bold px-2.5 py-1 rounded-full grad text-white whitespace-nowrap">{t('Рекомендуем')}</span>}
                    <span className="text-[24px]">{v.categoryIcon}</span>
                    <b className="font-serif-d text-[13px] block mt-1.5 leading-tight">{v.name}</b>
                  </div>
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, fn]) => (
              <tr key={label}>
                <td className="p-1.5 text-[11px] text-[var(--soft)] font-medium">{label}</td>
                {list.map(v => <td key={v.id} className="p-1.5"><div className="bg-[var(--card)] rounded-xl px-2.5 py-2.5 text-[11.5px] text-center font-medium" style={{ boxShadow: 'var(--shadow)' }}>{fn(v)}</div></td>)}
              </tr>
            ))}
            <tr>
              <td />
              {list.map(v => (
                <td key={v.id} className="p-1.5">
                  <button onClick={() => pick(v)} className={cn('press w-full h-[40px] rounded-full text-[11px] font-bold', picked === v.id ? 'bg-[var(--sage-soft)] text-[#7E9A74]' : 'grad text-white')}>
                    {picked === v.id ? t('✓ В команде') : t('Выбрать')}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="px-5 mt-4">
        <div className="card-s p-4 text-[11.5px] text-[var(--ink2)] leading-relaxed">
          ✦ <b>{t('Совет Тиля:')}</b> {list[0].name} — лучшее соотношение цены и рейтинга, и свободен на вашу дату. «Выбрать» создаст hold на 72 часа — дата никому не уйдёт, пока вы решаете.
        </div>
      </div>
    </div>
  )
}

/* День X — тёмный live-режим пары */
export function DayX() {
  const nav = useNavigate()
  const [delay, setDelay] = useState(0)
  const [planB, setPlanB] = useState(false)
  return (
    <div className="min-h-dvh pb-10" style={{ background: 'linear-gradient(180deg,#1E1A16,#0E0C0A)', color: '#EFE9DF' }}>
      <div className="px-5 pt-7 flex items-center justify-between">
        <button onClick={() => nav(-1)} className="press w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#2A2520' }} aria-label={t('Назад')}><ChevronLeft size={18} /></button>
        <div className="text-center">
          <b className="font-serif-d text-[19px]">{t('14 июня · День X')}</b>
          <p className="text-[9.5px] tracking-[.2em] font-bold" style={{ color: '#C9A96A' }}>LIVE · {delay > 0 ? `+${delay}${t(' МИН К ПЛАНУ')}` : t('ИДЁМ ПО ГРАФИКУ')}</p>
        </div>
        <div className="w-10" />
      </div>

      <div className="px-5 mt-5">
        <div className="rounded-[26px] p-5" style={{ background: '#2A2520' }}>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[9px] tracking-[.2em] font-bold" style={{ color: '#C9A96A' }}>{t('СЕЙЧАС')}</span>
              <b className="font-serif-d text-[21px] block mt-1">{t('Фотосессия')}</b>
              <p className="text-[11px] opacity-60 mt-0.5">{t('до 16:30 · парк у усадьбы')}</p>
            </div>
            <span className="text-[10px] font-bold px-3 py-1.5 rounded-full" style={{ background: '#C4705A' }}>● LIVE</span>
          </div>
          <div className="flex gap-2.5 mt-4">
            <button onClick={() => setDelay(d => d + 15)} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold" style={{ background: '#C9A96A', color: '#141210' }}>{t('+15 мин задержка')}</button>
            <button onClick={() => nav('/us/chats/ch5')} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold border border-[#4a443c]">{t('Чат дня X')}</button>
          </div>
        </div>

        <div className="mt-4 relative pl-6">
          <div className="absolute left-[7px] top-2 bottom-2 w-[1.5px]" style={{ background: 'linear-gradient(rgba(201,169,106,.7),rgba(201,169,106,.1))' }} />
          {timeline.map((e, k) => (
            <div key={e.id} className="relative mb-4">
              <span className="absolute -left-[19.5px] top-1.5 w-[9px] h-[9px] rounded-full" style={{ background: k === 3 ? '#C4705A' : '#C9A96A', boxShadow: '0 0 12px rgba(201,169,106,.8)' }} />
              <span className="text-[9.5px] tracking-[.15em] font-bold" style={{ color: '#C9A96A' }}>{e.time}</span>
              <b className="font-serif-d text-[15px] block">{e.name}</b>
              <p className="text-[10.5px] opacity-50">{e.loc}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2">
          {[
            ['📸', t('Елена'), t('на месте')],
            ['🎤', t('Артём'), t('едет · 20 мин')],
            ['🌸', t('Пион'), t('на месте')],
            ['🎂', t('Марципан'), t('доставлен')],
          ].map(([ic, n, st]) => (
            <div key={n} className="rounded-2xl p-3 text-center" style={{ background: '#2A2520' }}>
              <span className="text-[18px]">{ic}</span>
              <b className="text-[10px] block mt-1">{n}</b>
              <span className="text-[8px] font-bold" style={{ color: st === t('едет · 20 мин') ? '#C9A96A' : '#7E9A74' }}>{st}</span>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mt-4 overflow-x-auto no-scrollbar">
          {[
            [t('Координатор'), t('Мария')],
            [t('Фотограф'), t('Елена')],
            [t('Ведущий'), t('Артём')],
            [t('Усадьба'), t('Рустам')],
          ].map(([r, n]) => (
            <a key={n} href="tel:+70000000000" className="press flex items-center gap-2 px-4 h-[42px] rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0" style={{ background: '#2A2520' }}>
              <span className="w-6 h-6 rounded-full grad flex items-center justify-center text-white text-[10px]">{n[0]}</span>
              {n} · {r}
            </a>
          ))}
        </div>

        <div className="rounded-[26px] p-5 mt-4" style={{ background: planB ? '#3A2E22' : '#2A2520', border: planB ? '1px solid #C9A96A' : '1px solid transparent' }}>
          <div className="flex items-center gap-3">
            <CloudRain size={20} style={{ color: '#C9A96A' }} />
            <div className="flex-1">
              <b className="text-[13.5px]">{t('План Б: дождь')}</b>
              <p className="text-[10.5px] opacity-60 mt-0.5">{t('Церемония → шатёр. Пересоберёт тайминг и уведомит всех.')}</p>
            </div>
            <button onClick={() => setPlanB(!planB)} className={cn('press px-4 h-[38px] rounded-full text-[11px] font-bold', planB ? 'grad text-white' : 'border border-[#4a443c]')}>
              {planB ? 'Активирован ✓' : t('Активировать')}
            </button>
          </div>
        </div>

        <a href="tel:+70000000000" className="press w-full h-[52px] rounded-full mt-4 text-[13.5px] font-bold flex items-center justify-center gap-2" style={{ background: '#C4705A' }}>
          <Zap size={16} /> {t('SOS · Координатору')}
        </a>
      </div>
    </div>
  )
}

/* После свадьбы */
export function After() {
  const [dl, setDl] = useState(0)
  const [rating, setRating] = useState(false)
  const [stars, setStars] = useState<Record<string, number>>({})
  const reviewList = [t('Елена Смирнова · фотограф'), t('Артём Краснов · ведущий'), t('Студия «Пион» · флористика'), t('Усадьба «Липовый сад»'), t('«Марципан» · торт')]
  const stats = [
    ['14', t('подрядчиков'), '🤝'],
    ['76', t('гостей'), '🥂'],
    ['312', t('фото от гостей'), '📸'],
    ['9', t('отзывов оставлено'), '★'],
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('После свадьбы')} sub={t('14 июня 2027 · это было прекрасно')} />
      <div className="px-5 mt-3">
        <div className="grad rounded-[32px] p-7 text-white text-center relative overflow-hidden fade-up">
          <Heart size={26} className="mx-auto opacity-90" />
          <h2 className="font-serif-d text-[26px] mt-3">{t('Алина & Тимур')}</h2>
          <p className="text-[12px] opacity-90 mt-1">{t('Поздравляем! Ваша свадьба состоялась')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-4 stagger">
          {stats.map(([v, l, ic]) => (
            <div key={l} className="card-s p-4 text-center fade-up">
              <span className="text-[20px]">{ic}</span>
              <b className="font-serif-d text-[24px] block mt-1 tabular">{v}</b>
              <span className="text-[10px] text-[var(--soft)]">{l}</span>
            </div>
          ))}
        </div>
        <div className="card p-5 mt-4">
          <div className="flex justify-between text-[12px] mb-2"><span className="text-[var(--soft)]">{t('Отзывы команде')}</span><b>{t('9 из 14')}</b></div>
          <div className="h-1.5 rounded-full bg-[var(--track)] overflow-hidden"><div className="h-full grad rounded-full" style={{ width: '64%' }} /></div>
          <p className="text-[10.5px] text-[var(--soft)] mt-2.5">{t('Отзывы помогают другим парам и поднимают рейтинг тех, кто сделал ваш день.')}</p>
        </div>
        <button onClick={() => {
            if (dl !== 0) return
            setDl(1)
            const t = setInterval(() => setDl(d => { if (d >= 100) { clearInterval(t); return 100 } return d + 5 }), 120)
          }}
          className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-4" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {dl === 0 ? t('Скачать общий альбом (ZIP)') : dl < 100 ? t('Собираем архив…') + ` ${dl}%` : t('✓ Архив готов · ссылка отправлена')}
        </button>
        {dl > 0 && dl < 100 && <div className="h-1.5 rounded-full bg-[var(--track)] mt-2.5 overflow-hidden"><div className="h-full grad rounded-full transition-all" style={{ width: `${dl}%` }} /></div>}
        <button onClick={() => setRating(!rating)} className="press w-full card-s mt-2.5 py-4 text-[13px] font-semibold">{rating ? 'Скрыть' : t('Оставить отзывы команде')}</button>
        {rating && (
          <div className="card px-4 py-1.5 mt-3 fade-up">
            {reviewList.map((r, i) => (
              <div key={r} className={cn('flex items-center justify-between py-3', i !== reviewList.length - 1 && 'border-b border-[var(--track)]')}>
                <span className="text-[12px] font-medium flex-1">{r}</span>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map(s => (
                    <button key={s} onClick={() => setStars(x => ({ ...x, [r]: s }))} className="press text-[15px]" style={{ color: (stars[r] ?? 0) >= s ? 'var(--gold-soft)' : 'var(--track)' }}>★</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-center text-[10.5px] text-[var(--soft2)] mt-5">{t('Проект и документы хранятся бессрочно. Встретимся в годовщину 💌')}</p>
      </div>
    </div>
  )
}
