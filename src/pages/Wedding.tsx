import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Wallet, ListChecks, Clock3, Users, FileText, Plus, Send, Download, Armchair } from 'lucide-react'
import { budgetItems, couple, tasks, timeline, guests, contractTemplates, fmt } from '@/lib/data'
import { AiTip, Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

/* Навигация раздела «Свадьба» */
function WeddingNav() {
  const nav = useNavigate()
  const items = [
    { to: '/wedding/budget', icon: Wallet, label: 'Бюджет', tile: 'bg-[#F2DFDC]' },
    { to: '/wedding/checklist', icon: ListChecks, label: 'Чек-лист', tile: 'bg-[#E6EEE2]' },
    { to: '/wedding/timeline', icon: Clock3, label: 'Тайминг', tile: 'bg-[#F0DCB8]' },
    { to: '/wedding/guests', icon: Users, label: 'Гости', tile: 'bg-[#D9CCE3]' },
    { to: '/wedding/documents', icon: FileText, label: 'Документы', tile: 'bg-[#C3D5E8]' },
  ]
  return (
    <div className="grid grid-cols-5 gap-2 px-5 mt-3">
      {items.map(it => (
        <button key={it.to} onClick={() => nav(it.to)} className="press flex flex-col items-center gap-1.5">
          <div className={cn('w-[52px] h-[52px] rounded-[18px] flex items-center justify-center', it.tile)} style={{ boxShadow: 'var(--shadow)' }}>
            <it.icon size={20} className="text-[#5C554B]" />
          </div>
          <span className="text-[9px] text-[#93897F] font-medium">{it.label}</span>
        </button>
      ))}
    </div>
  )
}

/* Команда (мозаика слотов) */
export function WeddingTeam() {
  const nav = useNavigate()
  const { slots } = useStore()
  const booked = slots.filter(s => s.state === 'booked').length
  const progress = slots.filter(s => s.state !== 'empty').length

  return (
    <div className="pb-28">
      <TopBar title="Наш день" sub={`${booked} забронировано · ${progress - booked} в работе · ${slots.length - progress} пустых`} />
      <WeddingNav />
      <div className="px-5 mt-3.5">
        <button onClick={() => nav('/dayx')} className="press w-full rounded-[22px] p-4 flex items-center gap-3 text-left text-white" style={{ background: 'linear-gradient(120deg,#3A322B,#1E1A16)', boxShadow: 'var(--shadow)' }}>
          <span className="text-[22px]">🎬</span>
          <span className="flex-1">
            <b className="text-[13px] block">Режим дня X</b>
            <span className="text-[10px] text-white/60">Live-тайминг, задержки, план Б и SOS</span>
          </span>
          <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-white/15">демо</span>
        </button>
      </div>
      <div className="px-5 mt-5">
        <div className="grid grid-cols-3 gap-2.5 stagger">
          {slots.map(s => (
            <button
              key={s.id}
              onClick={() => (s.state === 'empty' ? nav(`/search/${s.categoryId}`) : nav(`/wedding/slot/${s.id}`))}
              className={cn('press rounded-[18px] p-3 flex flex-col items-center justify-center gap-1.5 aspect-[0.85] fade-up',
                s.state === 'empty' ? 'border-[1.5px] border-dashed border-[#D8B4AE] bg-[#F2DFDC]/30' : 'card-s')}
            >
              <span className="text-[22px]">{s.state === 'empty' ? <Plus size={20} className="text-[#C98A8A]" /> : s.icon}</span>
              <b className="text-[10.5px] text-center leading-tight">{s.label}</b>
              {s.state === 'booked' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[#7E9A74]">booked</span>}
              {s.state === 'hold' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[#B98A2F]">{s.status}</span>}
              {s.state === 'candidate' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[#C98A8A]">кандидаты</span>}
            </button>
          ))}
        </div>
        <div className="mt-4"><AiTip text="Пустой слот «DJ» и «Декоратор» — подобрать свободных на 14.06 под ваш бюджет?" onPress={() => nav('/search/dj')} /></div>
      </div>

      <div className="px-5">
        <SectionHead title="Сводка" />
        <div className="card p-5 mt-2">
          <div className="flex justify-between text-[12px] mb-1.5"><span className="text-[#93897F]">Команда собрана</span><b>{booked} из {slots.length}</b></div>
          <Bar pct={(booked / slots.length) * 100} />
          <div className="flex justify-between text-[12px] mb-1.5 mt-4"><span className="text-[#93897F]">Забронировано на сумму</span><b className="tabular">{fmt(slots.filter(s => s.price).reduce((a, s) => a + (s.price ?? 0), 0))}</b></div>
          <Bar pct={46} />
        </div>
      </div>
    </div>
  )
}

/* Деталь слота */
export function SlotDetail() {
  const nav = useNavigate()
  const { slots } = useStore()
  const id = location.pathname.split('/').pop()
  const s = slots.find(x => x.id === id) ?? slots[0]
  return (
    <div className="pb-28">
      <TopBar back title={s.label} sub="Слот команды" />
      <div className="px-5 mt-3">
        <div className="card p-5 text-center">
          <div className={cn('w-16 h-16 rounded-[20px] mx-auto flex items-center justify-center text-[28px]', s.tile)}>{s.icon}</div>
          <b className="font-serif-d text-[19px] block mt-3">{s.vendor ?? 'Исполнитель не выбран'}</b>
          {s.price && <span className="font-serif-d text-[17px] text-[#B57171] block mt-1 tabular">{fmt(s.price)}</span>}
          {s.status && <span className="inline-block mt-2 text-[10px] font-bold px-3 py-1.5 rounded-full bg-[#E6EEE2] text-[#7E9A74]">{s.status}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3">
          <button onClick={() => nav('/us/chats/ch1')} className="press card-s py-3.5 text-[13px] font-semibold">Написать</button>
          <button onClick={() => nav('/deal')} className="press card-s py-3.5 text-[13px] font-semibold">Сделка</button>
          <button onClick={() => nav(`/search/${s.categoryId}`)} className="press card-s py-3.5 text-[13px] font-semibold">Заменить</button>
          <button className="press card-s py-3.5 text-[13px] font-semibold text-[#B57171]">Отменить бронь</button>
        </div>
      </div>
    </div>
  )
}

/* Бюджет */
export function Budget() {
  const total = budgetItems.reduce((a, b) => a + b.amount, 0)
  const pct = Math.round((total / couple.budgetTotal) * 100)
  return (
    <div className="pb-28">
      <TopBar back title="Бюджет" sub="Распределение средств" />
      <div className="px-5 mt-3">
        <div className="card p-5">
          <div className="flex justify-between items-end">
            <span className="text-[30px] font-extrabold tracking-tight tabular">{total.toLocaleString('ru-RU')} ₽</span>
            <span className="text-[#B57171] font-bold">{pct}%</span>
          </div>
          <p className="text-[11.5px] text-[#93897F] mt-1">из {couple.budgetTotal.toLocaleString('ru-RU')} ₽ запланировано · осталось {(couple.budgetTotal - total).toLocaleString('ru-RU')} ₽</p>
          <div className="mt-3"><Bar pct={pct} /></div>
          <div className="mt-4 space-y-4">
            {budgetItems.map(b => {
              const p = Math.round((b.amount / b.limit) * 100)
              return (
                <div key={b.name}>
                  <div className="flex justify-between text-[12.5px] items-center">
                    <span className="flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: b.color }} />{b.name}</span>
                    <b className="tabular">{(b.amount / 1000).toFixed(0)}К <span className="text-[#93897F] font-normal text-[10.5px]">/ {(b.limit / 1000).toFixed(0)}К</span></b>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#F1E9E2] mt-1.5 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${p}%`, background: b.color }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="mt-3.5"><AiTip text="«Площадка и кейтеринг» на 86% лимита. Зафиксируйте меню до 1 марта — дальше цены вырастут ~10%." /></div>
        <button className="press w-full card-s mt-3.5 py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2"><Plus size={16} /> Добавить расход</button>
      </div>
    </div>
  )
}

/* Чек-лист */
export function Checklist() {
  const [period, setPeriod] = useState('9')
  const [done, setDone] = useState<string[]>(tasks.filter(t => t.done).map(t => t.id))
  const list = tasks.filter(t => t.period === period)
  const toggle = (id: string) => setDone(d => d.includes(id) ? d.filter(x => x !== id) : [...d, id])

  return (
    <div className="pb-28">
      <TopBar back title="Чек-лист" sub="Что уже сделано, что впереди" right={
        <button className="press h-10 px-4 rounded-full bg-white text-[12px] font-semibold text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>+ Задача</button>
      } />
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {[['9', 'За 9 мес'], ['6', 'За 6 мес'], ['3', 'За 3 мес'], ['1', 'За 1 мес']].map(([id, l]) => (
          <button key={id} onClick={() => setPeriod(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', period === id ? 'grad text-white' : 'bg-white text-[#93897F]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 mt-4">
        <div className="card px-4 py-1.5">
          {list.map((t, i) => {
            const isDone = done.includes(t.id)
            return (
              <button key={t.id} onClick={() => toggle(t.id)} className={cn('w-full flex items-center gap-3 py-3.5 text-left', i !== list.length - 1 && 'border-b border-[#F1E9E2]')}>
                <span className={cn('w-[26px] h-[26px] rounded-[9px] flex items-center justify-center text-[12px] shrink-0 transition-all',
                  isDone ? 'bg-[#E6EEE2] text-[#7E9A74]' : 'bg-white border-[1.5px] border-[#E8DED4] text-[#B57171] font-bold text-[11px]')}>
                  {isDone ? '✓' : i + 1 + tasks.filter(x => x.period === period && done.includes(x.id)).length}
                </span>
                <span className={cn('flex-1 text-[13px]', isDone && 'text-[#93897F] line-through')}>{t.title}</span>
                <i className={cn('w-2 h-2 rounded-full', t.urgent ? 'bg-[#C98A8A]' : 'bg-[#A9BCA0]')} />
                <span className="text-[10.5px] text-[#93897F]">{t.due}</span>
              </button>
            )
          })}
        </div>
        <p className="text-[10.5px] text-[#93897F] text-center mt-3">● розовый — важный срок · ● зелёный — плановый</p>
      </div>
    </div>
  )
}

/* Тайминг дня */
export function Timeline() {
  return (
    <div className="pb-28">
      <TopBar back title="День свадьбы" sub="Расписание 14 июня · полный сценарий" right={
        <button className="press h-10 px-4 rounded-full bg-white text-[12px] font-semibold text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>Править</button>
      } />
      <div className="px-5 mt-2 space-y-2.5 stagger">
        {timeline.map(e => (
          <div key={e.id} className="card-s p-4 flex gap-3 fade-up">
            <Tile icon={e.icon} tile={e.tile} size={42} />
            <div className="min-w-0">
              <b className="text-[13.5px]">{e.name}</b>
              <p className="text-[11px] text-[#93897F] mt-0.5">{e.loc}</p>
              <p className="text-[11px] text-[#B57171] font-semibold mt-1 tabular">{e.time}</p>
              <p className="text-[10px] text-[#7E9A74] mt-0.5">{e.who}</p>
            </div>
          </div>
        ))}
        <div className="mt-2"><AiTip text="Автоплан готов: конфликтов нет. План Б на дождь для церемонии — шатёр уже включён в аренду усадьбы." /></div>
        <button className="press w-full card-s py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} /> Скачать PDF для координатора</button>
      </div>
    </div>
  )
}

/* Гости */
export function Guests() {
  const nav = useNavigate()
  const yes = guests.filter(g => g.status === 'yes').length
  const pending = guests.filter(g => g.status === 'pending').length
  return (
    <div className="pb-28">
      <TopBar back title="Гости" sub={`${couple.guestsTotal} приглашено · ${yes * 3}+ ответили`} right={
        <button onClick={() => nav('/wedding/invites')} className="press h-10 px-4 rounded-full grad text-white text-[12px] font-semibold flex items-center gap-1.5"><Send size={13} /> Пригласить</button>
      } />
      <div className="px-5 mt-3 grid grid-cols-3 gap-2.5">
        {[['42', 'придут', 'text-[#7E9A74]'], [String(pending * 4), 'ждём ответ', 'text-[#B98A2F]'], ['2', 'не смогут', 'text-[#B57171]']].map(([v, l, c]) => (
          <div key={l} className="card-s p-3.5 text-center">
            <b className={cn('text-[20px] tabular', c)}>{v}</b>
            <span className="text-[9.5px] text-[#93897F] block mt-0.5">{l}</span>
          </div>
        ))}
      </div>
      <div className="px-5 mt-4">
        <div className="card px-4 py-1.5">
          {guests.map((g, i) => (
            <div key={g.id} className={cn('flex items-center gap-3 py-3', i !== guests.length - 1 && 'border-b border-[#F1E9E2]')}>
              <div className={cn('w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-serif-d text-white shrink-0',
                g.status === 'yes' ? 'bg-[#A9BCA0]' : g.status === 'no' ? 'bg-[#C98A8A]' : 'bg-[#E3C892]')}>
                {g.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] block truncate">{g.name}</b>
                <span className="text-[10px] text-[#93897F]">{g.plus ? 'с +1' : 'один/одна'}{g.table ? ` · стол №${g.table}` : ''}</span>
              </div>
              <span className={cn('text-[9px] font-bold px-2.5 py-1 rounded-full',
                g.status === 'yes' ? 'bg-[#E6EEE2] text-[#7E9A74]' : g.status === 'no' ? 'bg-[#F2DFDC] text-[#B57171]' : 'bg-[#F7ECD9] text-[#B98A2F]')}>
                {g.status === 'yes' ? 'Придёт' : g.status === 'no' ? 'Не придёт' : 'Ждём'}
              </span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3.5">
          <button onClick={() => nav('/wedding/seating')} className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Armchair size={15} /> Рассадка</button>
          <button className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} /> Список PDF</button>
        </div>
        <div className="mt-3.5"><AiTip text="8 гостей не ответили — дедлайн RSVP 1 мая. Отправить напоминание одной кнопкой?" /></div>
      </div>
    </div>
  )
}

/* Документы */
export function Documents() {
  const nav = useNavigate()
  return (
    <div className="pb-28">
      <TopBar back title="Документы" sub="Договоры из шаблонов — за 2 минуты" />
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {contractTemplates.map(c => (
          <button key={c.id} onClick={() => nav('/wedding/documents/new')} className="press w-full card-s p-4 flex items-center gap-3 text-left fade-up">
            <Tile icon={c.icon} tile={c.tile} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px] block">{c.name}</b>
              <span className="text-[10.5px] text-[#93897F]">{c.desc}</span>
            </div>
            <span className="text-[10px] font-bold px-3 py-1.5 rounded-full grad text-white shrink-0">Создать</span>
          </button>
        ))}
      </div>
      <p className="px-6 mt-4 text-[10.5px] text-[#93897F] leading-relaxed text-center">
        Шаблоны носят информационный характер и не заменяют консультацию юриста. Данные подставляются автоматически из сделки.
      </p>
    </div>
  )
}
