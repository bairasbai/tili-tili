import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Send, CloudRain, Zap, Heart } from 'lucide-react'
import { vendors, timeline } from '@/lib/data'
import { TopBar } from '@/components/chrome'
import { cn } from '@/lib/utils'

/* ИИ-координатор «Тиль» */
export function Assistant() {
  const nav = useNavigate()
  const [msgs, setMsgs] = useState([
    { me: false, text: 'Здравствуйте, Алина и Тимур! Я Тиль — ваш ИИ-координатор. Слежу за бюджетом, дедлайнами и датами подрядчиков. Что обсудим?' },
  ])
  const [text, setText] = useState('')
  const canned: Record<string, string> = {}
  const answer = (q: string) =>
    canned[q] ?? (q.includes('алкогол')
      ? 'На 80 гостей банкетного формата закладывайте: игристое 0,5 л/чел, вино 0,4 л/чел, крепкое 0,25 л/чел + безалкогольное 1,5 л/чел. Для усадьбы уточните пробковый сбор.'
      : q.includes('забыл') || q.includes('забыли')
      ? 'Проверил проект: пустые слоты — DJ, декоратор, транспорт, платье, кольца. Ближайший дедлайн — приглашения до 1 марта. С чего начнём?'
      : 'Принято! Записал в план. Хотите, добавлю задачу в чек-лист с дедлайном?')
  const quick = ['Что мы забыли?', 'Сколько алкоголя на 80 гостей?', 'Найди DJ до 40 тыс ₽', 'Собери план дня']
  const send = (t: string) => {
    if (!t.trim()) return
    setMsgs(m => [...m, { me: true, text: t }])
    setText('')
    setTimeout(() => setMsgs(m => [...m, { me: false, text: answer(t) }]), 600)
  }
  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => nav(-1)} className="press w-9 h-9 rounded-full bg-white flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label="Назад"><ChevronLeft size={17} /></button>
        <div className="w-[38px] h-[38px] rounded-full grad flex items-center justify-center text-white text-[15px]">✦</div>
        <div className="flex-1"><b className="text-[14px]">Тиль</b><p className="text-[10px] text-[#7E9A74]">ИИ-координатор · на связи · 42/50 сообщений сегодня</p></div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
        {msgs.map((m, k) => (
          <div key={k} className={cn('flex fade-up', m.me ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[80%] px-4 py-3 text-[13px] leading-relaxed', m.me ? 'grad text-white rounded-[18px] rounded-br-[6px]' : 'card rounded-[18px] rounded-bl-[6px]')}>{m.text}</div>
          </div>
        ))}
      </div>
      <div className="px-4 pb-2 flex gap-2 overflow-x-auto no-scrollbar">
        {quick.map(q => <button key={q} onClick={() => send(q)} className="press px-4 py-2 rounded-full bg-white text-[11px] font-semibold whitespace-nowrap text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>{q}</button>)}
      </div>
      <div className="glass-tab border-t-0 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] flex gap-2.5">
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send(text)} placeholder="Спросите Тиля…" className="flex-1 bg-white rounded-full px-5 h-[48px] text-[13.5px] outline-none placeholder:text-[#CFC5BA]" style={{ boxShadow: 'var(--shadow)' }} />
        <button onClick={() => send(text)} className="press w-[48px] h-[48px] rounded-full grad text-white flex items-center justify-center shrink-0" aria-label="Отправить"><Send size={17} /></button>
      </div>
    </div>
  )
}

/* Сравнение кандидатов */
export function Compare() {
  const list = vendors.slice(0, 3)
  const rows: [string, (v: typeof list[0]) => string][] = [
    ['Цена «от»', v => `${v.priceFrom.toLocaleString('ru-RU')} ₽`],
    ['Рейтинг', v => (v.reviews ? `★ ${v.rating} · ${v.reviews} отзывов` : 'Новый')],
    ['Свободен 14.06', v => (v.freeOnDate ? '✓ Да' : '✕ Занят')],
    ['Видео-визитка', v => (v.hasVideo ? '▶ Есть' : '—')],
    ['Пакетов', v => String(v.packages.length)],
  ]
  return (
    <div className="pb-28">
      <TopBar back title="Сравнение" sub="3 кандидата · категория «Фотограф»" />
      <div className="px-5 mt-3 overflow-x-auto no-scrollbar">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr>
              <td className="w-[110px]" />
              {list.map((v, k) => (
                <td key={v.id} className="p-1.5 align-top">
                  <div className={cn('card-s p-3 text-center relative', v.tile)}>
                    {k === 0 && <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[8px] font-bold px-2.5 py-1 rounded-full grad text-white whitespace-nowrap">Рекомендуем</span>}
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
                <td className="p-1.5 text-[11px] text-[#93897F] font-medium">{label}</td>
                {list.map(v => <td key={v.id} className="p-1.5"><div className="bg-white rounded-xl px-2.5 py-2.5 text-[11.5px] text-center font-medium" style={{ boxShadow: 'var(--shadow)' }}>{fn(v)}</div></td>)}
              </tr>
            ))}
            <tr>
              <td />
              {list.map(v => (
                <td key={v.id} className="p-1.5">
                  <button className="press w-full h-[40px] rounded-full grad text-white text-[11px] font-bold">Выбрать</button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="px-5 mt-4">
        <div className="card-s p-4 text-[11.5px] text-[#5C554B] leading-relaxed">
          ✦ <b>Совет Тиля:</b> {list[0].name} — лучшее соотношение цены и рейтинга, и свободен на вашу дату. «Выбрать» создаст hold на 72 часа — дата никому не уйдёт, пока вы решаете.
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
        <button onClick={() => nav(-1)} className="press w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#2A2520' }} aria-label="Назад"><ChevronLeft size={18} /></button>
        <div className="text-center">
          <b className="font-serif-d text-[19px]">14 июня · День X</b>
          <p className="text-[9.5px] tracking-[.2em] font-bold" style={{ color: '#C9A96A' }}>LIVE · {delay > 0 ? `+${delay} МИН К ПЛАНУ` : 'ИДЁМ ПО ГРАФИКУ'}</p>
        </div>
        <div className="w-10" />
      </div>

      <div className="px-5 mt-5">
        <div className="rounded-[26px] p-5" style={{ background: '#2A2520' }}>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[9px] tracking-[.2em] font-bold" style={{ color: '#C9A96A' }}>СЕЙЧАС</span>
              <b className="font-serif-d text-[21px] block mt-1">Фотосессия</b>
              <p className="text-[11px] opacity-60 mt-0.5">до 16:30 · парк у усадьбы</p>
            </div>
            <span className="text-[10px] font-bold px-3 py-1.5 rounded-full" style={{ background: '#C4705A' }}>● LIVE</span>
          </div>
          <div className="flex gap-2.5 mt-4">
            <button onClick={() => setDelay(d => d + 15)} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold" style={{ background: '#C9A96A', color: '#141210' }}>+15 мин задержка</button>
            <button onClick={() => nav('/us/chats/ch5')} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold border border-[#4a443c]">Чат дня X</button>
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
            ['📸', 'Елена', 'на месте'],
            ['🎤', 'Артём', 'едет · 20 мин'],
            ['🌸', 'Пион', 'на месте'],
            ['🎂', 'Марципан', 'доставлен'],
          ].map(([ic, n, st]) => (
            <div key={n} className="rounded-2xl p-3 text-center" style={{ background: '#2A2520' }}>
              <span className="text-[18px]">{ic}</span>
              <b className="text-[10px] block mt-1">{n}</b>
              <span className="text-[8px] font-bold" style={{ color: st === 'едет · 20 мин' ? '#C9A96A' : '#7E9A74' }}>{st}</span>
            </div>
          ))}
        </div>

        <div className="rounded-[26px] p-5 mt-4" style={{ background: planB ? '#3A2E22' : '#2A2520', border: planB ? '1px solid #C9A96A' : '1px solid transparent' }}>
          <div className="flex items-center gap-3">
            <CloudRain size={20} style={{ color: '#C9A96A' }} />
            <div className="flex-1">
              <b className="text-[13.5px]">План Б: дождь</b>
              <p className="text-[10.5px] opacity-60 mt-0.5">Церемония → шатёр. Пересоберёт тайминг и уведомит всех.</p>
            </div>
            <button onClick={() => setPlanB(!planB)} className={cn('press px-4 h-[38px] rounded-full text-[11px] font-bold', planB ? 'grad text-white' : 'border border-[#4a443c]')}>
              {planB ? 'Активирован ✓' : 'Активировать'}
            </button>
          </div>
        </div>

        <button className="press w-full h-[52px] rounded-full mt-4 text-[13.5px] font-bold flex items-center justify-center gap-2" style={{ background: '#C4705A' }}>
          <Zap size={16} /> SOS · Координатору
        </button>
      </div>
    </div>
  )
}

/* После свадьбы */
export function After() {
  const stats = [
    ['14', 'подрядчиков', '🤝'],
    ['76', 'гостей', '🥂'],
    ['312', 'фото от гостей', '📸'],
    ['9', 'отзывов оставлено', '★'],
  ]
  return (
    <div className="pb-28">
      <TopBar back title="После свадьбы" sub="14 июня 2027 · это было прекрасно" />
      <div className="px-5 mt-3">
        <div className="grad rounded-[32px] p-7 text-white text-center relative overflow-hidden fade-up">
          <Heart size={26} className="mx-auto opacity-90" />
          <h2 className="font-serif-d text-[26px] mt-3">Алина & Тимур</h2>
          <p className="text-[12px] opacity-90 mt-1">Поздравляем! Ваша свадьба состоялась</p>
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-4 stagger">
          {stats.map(([v, l, ic]) => (
            <div key={l} className="card-s p-4 text-center fade-up">
              <span className="text-[20px]">{ic}</span>
              <b className="font-serif-d text-[24px] block mt-1 tabular">{v}</b>
              <span className="text-[10px] text-[#93897F]">{l}</span>
            </div>
          ))}
        </div>
        <div className="card p-5 mt-4">
          <div className="flex justify-between text-[12px] mb-2"><span className="text-[#93897F]">Отзывы команде</span><b>9 из 14</b></div>
          <div className="h-1.5 rounded-full bg-[#F1E9E2] overflow-hidden"><div className="h-full grad rounded-full" style={{ width: '64%' }} /></div>
          <p className="text-[10.5px] text-[#93897F] mt-2.5">Отзывы помогают другим парам и поднимают рейтинг тех, кто сделал ваш день.</p>
        </div>
        <button className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-4" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>Скачать общий альбом (ZIP)</button>
        <button className="press w-full card-s mt-2.5 py-4 text-[13px] font-semibold">Оставить отзывы команде</button>
        <p className="text-center text-[10.5px] text-[#BFB5AA] mt-5">Проект и документы хранятся бессрочно. Встретимся в годовщину 💌</p>
      </div>
    </div>
  )
}
