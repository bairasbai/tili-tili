import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Wallet, ListChecks, Clock3, Users, FileText, Plus, Send, Download, Armchair, Heart, NotebookPen, Wine } from 'lucide-react'
import { budgetItems, couple, tasks, timeline, guests, contractTemplates, fmt } from '@/lib/data'
import { AiTip, Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* Навигация раздела «Свадьба» */
function WeddingNav() {
  const nav = useNavigate()
  const items = [
    { to: '/wedding/budget', icon: Wallet, label: t('Бюджет'), tile: 'bg-[var(--rose-soft)]' },
    { to: '/wedding/checklist', icon: ListChecks, label: t('Чек-лист'), tile: 'bg-[var(--sage-soft)]' },
    { to: '/wedding/timeline', icon: Clock3, label: t('Тайминг'), tile: 'bg-[var(--honey)]' },
    { to: '/wedding/guests', icon: Users, label: t('Гости'), tile: 'bg-[var(--lav)]' },
    { to: '/wedding/documents', icon: FileText, label: t('Документы'), tile: 'bg-[var(--blue)]' },
    { to: '/favorites', icon: Heart, label: t('Избранное'), tile: 'bg-[var(--rose-soft)]' },
    { to: '/notes', icon: NotebookPen, label: t('Заметки'), tile: 'bg-[var(--peach)]' },
    { to: '/tools/alcohol', icon: Wine, label: t('Алко-кальк.'), tile: 'bg-[var(--sage-soft)]' },
  ]
  return (
    <div className="grid grid-cols-4 gap-2 px-5 mt-3">
      {items.map(it => (
        <button key={it.to} onClick={() => nav(it.to)} className="press flex flex-col items-center gap-1.5">
          <div className={cn('w-[52px] h-[52px] rounded-[18px] flex items-center justify-center', it.tile)} style={{ boxShadow: 'var(--shadow)' }}>
            <it.icon size={20} className="text-[var(--ink2)]" />
          </div>
          <span className="text-[9px] text-[var(--soft)] font-medium">{it.label}</span>
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
      <TopBar title={t('Наш день')} sub={`${booked}${t(' забронировано · ')}${progress - booked}${t(' в работе · ')}${slots.length - progress}${t(' пустых')}`} />
      <WeddingNav />
      <div className="px-5 mt-3.5">
        <button onClick={() => nav('/dayx')} className="press w-full rounded-[22px] p-4 flex items-center gap-3 text-left text-white" style={{ background: 'linear-gradient(120deg,#3A322B,#1E1A16)', boxShadow: 'var(--shadow)' }}>
          <span className="text-[22px]">🎬</span>
          <span className="flex-1">
            <b className="text-[13px] block">{t('Режим дня X')}</b>
            <span className="text-[10px] text-white/60">{t('Live-тайминг, задержки, план Б и SOS')}</span>
          </span>
          <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--card)]/15">{t('демо')}</span>
        </button>
      </div>
      <div className="px-5 mt-5">
        <div className="grid grid-cols-3 gap-2.5 stagger">
          {slots.map(s => (
            <button
              key={s.id}
              onClick={() => (s.state === 'empty' ? nav(`/search/${s.categoryId}`) : nav(`/wedding/slot/${s.id}`))}
              className={cn('press rounded-[18px] p-3 flex flex-col items-center justify-center gap-1.5 aspect-[0.85] fade-up',
                s.state === 'empty' ? 'border-[1.5px] border-dashed border-[#D8B4AE] bg-[var(--rose-soft)]/30' : 'card-s')}
            >
              <span className="text-[22px]">{s.state === 'empty' ? <Plus size={20} className="text-[#C98A8A]" /> : s.icon}</span>
              <b className="text-[10.5px] text-center leading-tight">{s.label}</b>
              {s.state === 'booked' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[#7E9A74]">booked</span>}
              {s.state === 'hold' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[#B98A2F]">{s.status}</span>}
              {s.state === 'candidate' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[#C98A8A]">{t('кандидаты')}</span>}
            </button>
          ))}
        </div>
        <div className="mt-4"><AiTip text={t('Пустой слот «DJ» и «Декоратор» — подобрать свободных на 14.06 под ваш бюджет?')} onPress={() => nav('/search/dj')} /></div>
      </div>

      <div className="px-5">
        <SectionHead title={t('Сводка')} />
        <div className="card p-5 mt-2">
          <div className="flex justify-between text-[12px] mb-1.5"><span className="text-[var(--soft)]">{t('Команда собрана')}</span><b>{booked} из {slots.length}</b></div>
          <Bar pct={(booked / slots.length) * 100} />
          <div className="flex justify-between text-[12px] mb-1.5 mt-4"><span className="text-[var(--soft)]">{t('Забронировано на сумму')}</span><b className="tabular">{fmt(slots.filter(s => s.price).reduce((a, s) => a + (s.price ?? 0), 0))}</b></div>
          <Bar pct={Math.round((slots.filter(s => s.price).reduce((a, s) => a + (s.price ?? 0), 0) / couple.budgetTotal) * 100)} />
        </div>
      </div>
    </div>
  )
}

/* Деталь слота */
export function SlotDetail() {
  const nav = useNavigate()
  const { slots, cancelBooking } = useStore()
  const id = location.pathname.split('/').pop()
  const s = slots.find(x => x.id === id) ?? slots[0]
  const [confirmCancel, setConfirmCancel] = useState(false)
  return (
    <div className="pb-28">
      <TopBar back title={s.label} sub={t('Слот команды')} />
      <div className="px-5 mt-3">
        <div className="card p-5 text-center">
          <div className={cn('w-16 h-16 rounded-[20px] mx-auto flex items-center justify-center text-[28px]', s.tile)}>{s.icon}</div>
          <b className="font-serif-d text-[19px] block mt-3">{s.vendor ?? t('Исполнитель не выбран')}</b>
          {s.price && <span className="font-serif-d text-[17px] text-[#B57171] block mt-1 tabular">{fmt(s.price)}</span>}
          {s.status && <span className="inline-block mt-2 text-[10px] font-bold px-3 py-1.5 rounded-full bg-[var(--sage-soft)] text-[#7E9A74]">{s.status}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3">
          <button onClick={() => nav('/us/chats/ch1')} className="press card-s py-3.5 text-[13px] font-semibold">{t('Написать')}</button>
          <button onClick={() => nav('/deal')} className="press card-s py-3.5 text-[13px] font-semibold">{t('Сделка')}</button>
          <button onClick={() => nav(`/search/${s.categoryId}`)} className="press card-s py-3.5 text-[13px] font-semibold">{t('Заменить')}</button>
          {confirmCancel ? (
            <button onClick={() => { cancelBooking(s.id); nav('/wedding') }} className="press card-s py-3.5 text-[13px] font-bold text-white" style={{ background: '#C98A8A' }}>{t('Точно отменить?')}</button>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="press card-s py-3.5 text-[13px] font-semibold text-[#B57171]">{t('Отменить бронь')}</button>
          )}
        </div>

        {s.price && (
          <div className="card p-4 mt-3.5">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('График платежей')}</span>
            {[
              [t('Аванс · при бронировании'), Math.round(s.price * 0.5), true],
              [t('Доплата · за 7 дней до даты'), s.price - Math.round(s.price * 0.5), false],
            ].map(([l, v, paid]) => (
              <div key={String(l)} className="flex items-center justify-between mt-3">
                <span className="text-[12px] text-[var(--ink2)]">{l}</span>
                <span className="flex items-center gap-2">
                  <b className="text-[12.5px] tabular">{fmt(Number(v))}</b>
                  <span className={cn('text-[8.5px] font-bold px-2 py-1 rounded-full', paid ? 'bg-[var(--sage-soft)] text-[#7E9A74]' : 'bg-[var(--honey)] text-[#B98A2F]')}>{paid ? '✓ Оплачен' : t('Ожидает')}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="card px-4 py-1.5 mt-3.5">
          {[
            ['📄', 'bg-[var(--blue)]', t('Договор подписан обеими сторонами'), '/wedding/documents'],
            ['🗓', 'bg-[var(--honey)]', t('Дата 14.06 закрыта у подрядчика'), '/wedding/timeline'],
            ['💬', 'bg-[var(--sage-soft)]', t('Чат по сделке — 3 новых сообщения'), '/us/chats/ch1'],
          ].map(([ic, tile, l, to], i) => (
            <button key={String(l)} onClick={() => nav(String(to))} className={cn('press w-full flex items-center gap-3 py-3 text-left', i !== 2 && 'border-b border-[var(--track)]')}>
              <Tile icon={String(ic)} tile={String(tile)} size={34} />
              <span className="flex-1 text-[12px] font-medium">{l}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* Бюджет */
export function Budget() {
  const { slots } = useStore()
  // Бизнес-логика: категории бюджета наполняются ценами забронированных слотов команды.
  // Отмена брони в конструкторе автоматически уменьшает бюджет.
  const catOf: Record<string, string> = { venue: t('Площадка и кейтеринг'), photo: t('Фото и видео'), video: t('Фото и видео'), dress: t('Одежда и красота'), stylist: t('Одежда и красота'), rings: t('Одежда и красота'), host: t('Развлечения и декор'), dj: t('Развлечения и декор'), florist: t('Развлечения и декор'), decor: t('Развлечения и декор'), cake: t('Развлечения и декор'), transport: t('Прочее') }
  const booked = slots.filter(s => (s.state === 'booked' || s.state === 'hold') && s.price)
  const [custom, setCustom] = useState<(typeof budgetItems[number] & { live?: string })[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const add = () => {
    const a = parseInt(amount.replace(/\D/g, ''), 10)
    if (!name.trim() || !a) return
    setCustom(it => [...it, { name: name.trim(), amount: a, limit: Math.ceil(a * 1.2), color: 'var(--lav)' }])
    setName(''); setAmount(''); setAdding(false)
  }
  const items: (typeof budgetItems[number] & { live?: string })[] = budgetItems.map(b => {
    const inCat = booked.filter(s => catOf[s.categoryId] === b.name)
    if (!inCat.length) return { ...b }
    return { ...b, amount: inCat.reduce((a, s) => a + (s.price ?? 0), 0), live: inCat.map(s => s.vendor).join(' · ') }
  }).concat(custom)
  const total = items.reduce((a, b) => a + b.amount, 0)
  const pct = Math.round((total / couple.budgetTotal) * 100)
  return (
    <div className="pb-28">
      <TopBar back title={t('Бюджет')} sub={t('Распределение средств')} />
      <div className="px-5 mt-3">
        <div className="card p-5">
          <div className="flex justify-between items-end">
            <span className="text-[30px] font-extrabold tracking-tight tabular">{total.toLocaleString('ru-RU')} ₽</span>
            <span className="text-[#B57171] font-bold">{pct}%</span>
          </div>
          <p className="text-[11.5px] text-[var(--soft)] mt-1">{t('из')} {couple.budgetTotal.toLocaleString('ru-RU')} ₽ {t('запланировано · осталось')} {(couple.budgetTotal - total).toLocaleString('ru-RU')} ₽</p>
          <div className="mt-3"><Bar pct={pct} /></div>
          <div className="mt-4 space-y-4">
            {items.map((b, bi) => {
              const p = Math.round((b.amount / b.limit) * 100)
              return (
                <div key={b.name}>
                  <div className="flex justify-between text-[12.5px] items-center">
                    <span className="flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: b.color }} />{b.name}{b.live && <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--sage-soft)] text-[#7E9A74]">{t('из команды')}</span>}</span>
                    <b className="tabular">{(b.amount / 1000).toFixed(0)}{t('К')}<span className="text-[var(--soft)] font-normal text-[10.5px]">/ {(b.limit / 1000).toFixed(0)}{t('К')}</span>{bi >= budgetItems.length && <button onClick={() => setCustom(c => c.filter((_, ci) => ci !== bi - budgetItems.length))} className="press text-[#C98A8A] text-[12px] ml-1.5" aria-label={t('Удалить статью')}>×</button>}</b>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--track)] mt-1.5 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${p}%`, background: b.color }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="mt-3.5"><AiTip text={t('«Площадка и кейтеринг» на 86% лимита. Зафиксируйте меню до 1 марта — дальше цены вырастут ~10%.')} /></div>

        {/* Ожидают оплаты */}
        <div className="card p-4 mt-3.5">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Ожидают оплаты')}</span>
          {[
            [t('Флорист · доплата'), '45 000 ₽', t('до 7 июн')],
            [t('Ведущий · аванс'), '35 000 ₽', t('до 15 мар')],
          ].map(([l, v, d]) => (
            <div key={l} className="flex items-center justify-between mt-3">
              <span className="text-[12px] font-medium">{l}</span>
              <span className="text-right"><b className="text-[12.5px] tabular block">{v}</b><span className="text-[9.5px] text-[#B98A2F] font-semibold">{d}</span></span>
            </div>
          ))}
        </div>

        {adding ? (
          <div className="card p-4 mt-3.5 fade-up">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('Статья расхода (например, «Фейерверк»)')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" placeholder={t('Сумма, ₽')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] mt-2.5 tabular" />
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setAdding(false)} className="press flex-1 h-[44px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button onClick={add} className="press flex-1 h-[44px] rounded-full grad text-white text-[12px] font-semibold">{t('Добавить')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="press w-full card-s mt-3.5 py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2"><Plus size={16} />{t('Добавить расход')}</button>
        )}
      </div>
    </div>
  )
}

/* Чек-лист */
export function Checklist() {
  const [period, setPeriod] = useState('9')
  const [extra, setExtra] = usePersist<{ id: string; title: string; period: string; due: string; urgent?: boolean }[]>('tt_tasks_extra', [])
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const allTasks = [...tasks, ...extra.map(t => ({ ...t, done: false }))]
  const [done, setDone] = usePersist<string[]>('tt_tasks_done', tasks.filter(t => t.done).map(t => t.id))
  const list = allTasks.filter(t => t.period === period)
  const toggle = (id: string) => setDone(d => d.includes(id) ? d.filter(x => x !== id) : [...d, id])
  const addTask = () => {
    if (!title.trim()) return
    setExtra(x => [...x, { id: `x${x.length + 1}`, title: title.trim(), period, due: t('без срока') }])
    setTitle(''); setAdding(false)
  }

  return (
    <div className="pb-28">
      <TopBar back title={t('Чек-лист')} sub={t('Что уже сделано, что впереди')} right={
        <button onClick={() => setAdding(true)} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>{t('+ Задача')}</button>
      } />
      <div className="px-5 mt-3">
        <div className="card-s px-4 py-3 flex items-center gap-3">
          <b className="text-[12px] whitespace-nowrap">{done.length} из {allTasks.length}</b>
          <div className="flex-1 h-1.5 rounded-full bg-[var(--track)] overflow-hidden">
            <div className="h-full grad rounded-full transition-all duration-500" style={{ width: `${(done.length / allTasks.length) * 100}%` }} />
          </div>
          <span className="text-[10px] font-bold text-[#7E9A74] tabular">{Math.round((done.length / allTasks.length) * 100)}%</span>
        </div>
      </div>
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {[['9', t('За 9 мес')], ['6', t('За 6 мес')], ['3', t('За 3 мес')], ['1', t('За 1 мес')]].map(([id, l]) => (
          <button key={id} onClick={() => setPeriod(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', period === id ? 'grad text-white' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 mt-4">
        {adding && (
          <div className="card p-4 mb-3.5 fade-up">
            <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()}
              placeholder={t('Новая задача…')} autoFocus className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setAdding(false)} className="press flex-1 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button onClick={addTask} className="press flex-1 h-[42px] rounded-full grad text-white text-[12px] font-semibold">{t('Добавить')}</button>
            </div>
          </div>
        )}
        <div className="card px-4 py-1.5">
          {list.map((t, i) => {
            const isDone = done.includes(t.id)
            return (
              <button key={t.id} onClick={() => toggle(t.id)} className={cn('w-full flex items-center gap-3 py-3.5 text-left', i !== list.length - 1 && 'border-b border-[var(--track)]')}>
                <span className={cn('w-[26px] h-[26px] rounded-[9px] flex items-center justify-center text-[12px] shrink-0 transition-all',
                  isDone ? 'bg-[var(--sage-soft)] text-[#7E9A74]' : 'bg-[var(--card)] border-[1.5px] border-[#E8DED4] text-[#B57171] font-bold text-[11px]')}>
                  {isDone ? '✓' : i + 1 + allTasks.filter(x => x.period === period && done.includes(x.id)).length}
                </span>
                <span className={cn('flex-1 text-[13px]', isDone && 'text-[var(--soft)] line-through')}>{t.title}</span>
                <i className={cn('w-2 h-2 rounded-full', t.urgent ? 'bg-[#C98A8A]' : 'bg-[#A9BCA0]')} />
                <span className="text-[10.5px] text-[var(--soft)]">{t.due}</span>
              </button>
            )
          })}
        </div>
        <p className="text-[10.5px] text-[var(--soft)] text-center mt-3">{t('● розовый — важный срок · ● зелёный — плановый')}</p>
      </div>
    </div>
  )
}

/* Тайминг дня */
export function Timeline() {
  const [events, setEvents] = useState(timeline)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [time, setTime] = useState('')
  const addEvent = () => {
    if (!name.trim() || !time.trim()) return
    setEvents(ev => [...ev, { id: `e${Date.now()}`, time, name: name.trim(), loc: t('Усадьба «Липовый сад»'), icon: '📌', tile: 'bg-[var(--peach)]', who: t('Согласовать с координатором') }])
    setName(''); setTime(''); setEditing(false)
  }
  return (
    <div className="pb-28">
      <TopBar back title={t('День свадьбы')} sub={t('Расписание 14 июня · полный сценарий')} right={
        <button onClick={() => setEditing(!editing)} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>{editing ? 'Готово' : t('Править')}</button>
      } />
      <div className="px-5 mt-2.5">
        <div className="card-s px-4 py-3 flex items-center gap-3">
          <span className="text-[20px]">⛅</span>
          <div className="flex-1">
            <b className="text-[12px]">{t('Прогноз на 14 июня: +22°, к вечеру кратковременный дождь')}</b>
            <p className="text-[10px] text-[var(--soft)] mt-0.5">{t('План Б (шатёр) уже включён в аренду — ничего делать не нужно')}</p>
          </div>
        </div>
      </div>
      <div className="px-5 mt-2 space-y-2.5 stagger">
        {editing && (
          <div className="card p-4 fade-up">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('Событие (например, «Первый танец»)')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            <input value={time} onChange={e => setTime(e.target.value)} placeholder={t('Время (например, 19:00 — 19:10)')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] mt-2.5" />
            <button onClick={addEvent} className="press w-full h-[44px] rounded-full grad text-white text-[12px] font-semibold mt-3">{t('Добавить в тайминг')}</button>
          </div>
        )}
        {events.map(e => (
          <div key={e.id} className="card-s p-4 flex gap-3 fade-up">
            <Tile icon={e.icon} tile={e.tile} size={42} />
            <div className="min-w-0">
              <b className="text-[13.5px]">{e.name}</b>
              <p className="text-[11px] text-[var(--soft)] mt-0.5">{e.loc}</p>
              <p className="text-[11px] text-[#B57171] font-semibold mt-1 tabular">{e.time}</p>
              <p className="text-[10px] text-[#7E9A74] mt-0.5">{e.who}</p>
            </div>
          </div>
        ))}
        <div className="mt-2"><AiTip text={t('Автоплан готов: конфликтов нет. План Б на дождь для церемонии — шатёр уже включён в аренду усадьбы.')} /></div>
        <button onClick={() => window.print()} className="press w-full card-s py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} />{t('Скачать PDF для координатора')}</button>
      </div>
    </div>
  )
}

/* Гости */
export function Guests() {
  const nav = useNavigate()
  const [list, setList] = usePersist('tt_guests', guests)
  const [filter, setFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [plus, setPlus] = useState(false)
  const add = () => {
    if (!name.trim()) return
    setList(l => [...l, { id: `g${Date.now()}`, name: name.trim(), status: 'pending' as const, plus }])
    setName(''); setPlus(false); setAdding(false)
  }
  const yes = list.filter(g => g.status === 'yes').length
  const pending = list.filter(g => g.status === 'pending').length
  const shown = filter === 'all' ? list : list.filter(g => g.status === filter)
  return (
    <div className="pb-28">
      <TopBar back title={t('Гости')} sub={`${list.length}${t(' в списке · ')}${yes}${t(' подтвердили')}`} right={
        <div className="flex gap-2">
          <button onClick={() => setAdding(!adding)} className="press h-10 w-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Добавить гостя')}><Plus size={16} /></button>
          <button onClick={() => nav('/wedding/invites')} className="press h-10 px-4 rounded-full grad text-white text-[12px] font-semibold flex items-center gap-1.5"><Send size={13} />{t('Пригласить')}</button>
        </div>
      } />
      {adding && (
        <div className="px-5 mt-3 fade-up">
          <div className="card p-4 space-y-2.5">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder={t('Имя гостя или семьи')} className="w-full h-11 px-4 rounded-full bg-[var(--bg)] text-[13px] outline-none" />
            <div className="flex items-center gap-2">
              <button onClick={() => setPlus(!plus)} className={cn('press px-3.5 py-2 rounded-full text-[11.5px] font-semibold', plus ? 'grad text-white' : 'bg-[var(--bg)] text-[var(--soft)]')}>{t('с +1')}</button>
              <div className="flex-1" />
              <button onClick={() => setAdding(false)} className="press px-4 py-2 text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button onClick={add} className="press px-5 py-2 rounded-full grad text-white text-[12px] font-bold">{t('Добавить')}</button>
            </div>
          </div>
        </div>
      )}
      <div className="px-5 mt-3 grid grid-cols-3 gap-2.5">
        {[['42', t('придут'), 'text-[#7E9A74]'], [String(pending * 4), t('ждём ответ'), 'text-[#B98A2F]'], ['2', t('не смогут'), 'text-[#B57171]']].map(([v, l, c]) => (
          <div key={l} className="card-s p-3.5 text-center">
            <b className={cn('text-[20px] tabular', c)}>{v}</b>
            <span className="text-[9.5px] text-[var(--soft)] block mt-0.5">{l}</span>
          </div>
        ))}
      </div>
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {[['all', t('Все')], ['yes', t('Придут')], ['pending', t('Ждём')], ['no', t('Не придут')]].map(([id, l]) => (
          <button key={id} onClick={() => setFilter(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', filter === id ? 'grad text-white' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 mt-4">
        <div className="card px-4 py-1.5">
          {shown.map((g, i) => (
            <div key={g.id} className={cn('flex items-center gap-3 py-3', i !== shown.length - 1 && 'border-b border-[var(--track)]')}>
              <div className={cn('w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-serif-d text-white shrink-0',
                g.status === 'yes' ? 'bg-[#A9BCA0]' : g.status === 'no' ? 'bg-[#C98A8A]' : 'bg-[var(--gold-soft)]')}>
                {g.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] block truncate">{g.name}</b>
                <span className="text-[10px] text-[var(--soft)]">{g.plus ? 'с +1' : t('один/одна')}{g.table ? `${t(' · стол №')}${g.table}` : ''}</span>
              </div>
              <button onClick={() => setList(l => l.map(x => x.id === g.id ? { ...x, status: x.status === 'yes' ? 'no' : x.status === 'no' ? 'pending' : 'yes' } : x))} title={t('Нажмите, чтобы сменить статус')} className={cn('press text-[9px] font-bold px-2.5 py-1 rounded-full transition-all',
                g.status === 'yes' ? 'bg-[var(--sage-soft)] text-[#7E9A74]' : g.status === 'no' ? 'bg-[var(--rose-soft)] text-[#B57171]' : 'bg-[var(--honey)] text-[#B98A2F]')}>
                {g.status === 'yes' ? t('Придёт') : g.status === 'no' ? t('Не придёт') : t('Ждём')}
              </button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3.5">
          <button onClick={() => nav('/wedding/seating')} className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Armchair size={15} />{t('Рассадка')}</button>
          <button onClick={() => {
            const csv = 'Имя;Статус;+1;Стол\n' + list.map(g => `${g.name};${g.status === 'yes' ? t('Придёт') : g.status === 'no' ? t('Не придёт') : t('Ждём')};${g.plus ? 'да' : 'нет'};${g.table ?? ''}`).join('\n')
            const a = document.createElement('a')
            a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv' }))
            a.download = 'gosti-alina-timur.csv'
            a.click()
          }} className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} />{t('Список CSV')}</button>
        </div>
        <div className="mt-3.5"><AiTip text={t('8 гостей не ответили — дедлайн RSVP 1 мая. Отправить напоминание одной кнопкой?')} /></div>
      </div>
    </div>
  )
}

/* Документы */
export function Documents() {
  const nav = useNavigate()
  return (
    <div className="pb-28">
      <TopBar back title={t('Документы')} sub={t('Договоры из шаблонов — за 2 минуты')} />
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {contractTemplates.map(c => (
          <button key={c.id} onClick={() => nav('/wedding/documents/new')} className="press w-full card-s p-4 flex items-center gap-3 text-left fade-up">
            <Tile icon={c.icon} tile={c.tile} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px] block">{c.name}</b>
              <span className="text-[10.5px] text-[var(--soft)]">{c.desc}</span>
            </div>
            <span className="text-[10px] font-bold px-3 py-1.5 rounded-full grad text-white shrink-0">{t('Создать')}</span>
          </button>
        ))}
      </div>

      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Подписанные')}</h2>
        <div className="space-y-2.5">
          {[
            [t('Договор с фотографом'), t('подписан обеими сторонами · PDF'), '✓'],
            [t('Аренда усадьбы «Липовый сад»'), t('подписан · скан загружен'), '✓'],
          ].map(([n, d]) => (
            <button key={n} onClick={() => {
              const html = `<html><head><meta charset="utf-8"></head><body style="font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.7"><h1>${n}</h1><p>${t('г. Уфа · подписан обеими сторонами')}</p><p>${t('Заказчик: Алина Козлова и Тимур Волков. Предмет, стоимость, ответственность сторон — по шаблону «Тили-тили».')}</p><p><i>${t('Сформировано tili-tili.ru')}</i></p></body></html>`
              const a = document.createElement('a')
              a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }))
              a.download = `${n.replace(/[«»\s]+/g, '-').toLowerCase()}.doc`
              a.click(); URL.revokeObjectURL(a.href)
            }} className="press w-full card-s p-4 flex items-center gap-3 text-left">
              <div className="w-10 h-10 rounded-[14px] bg-[var(--sage-soft)] flex items-center justify-center">📄</div>
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] block truncate">{n}</b>
                <span className="text-[10px] text-[#7E9A74]">{d}</span>
              </div>
              <Download size={14} className="text-[var(--soft2)] shrink-0" />
            </button>
          ))}
        </div>
      </div>

      <p className="px-6 mt-4 text-[10.5px] text-[var(--soft)] leading-relaxed text-center">
        {t('Шаблоны носят информационный характер и не заменяют консультацию юриста. Данные подставляются автоматически из сделки.')}
      </p>
    </div>
  )
}
