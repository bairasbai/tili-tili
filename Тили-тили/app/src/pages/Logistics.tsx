import { useState } from 'react'
import { Bus, Hotel, Plus, Send, UtensilsCrossed, Copy, Check, Trash2, Users, MapPin, Clock3, Percent } from 'lucide-react'
import { AiTip, Bar, SectionHead, SyncNote, TopBar } from '@/components/chrome'
import { usePersist } from '@/lib/usePersist'
import { t } from '@/lib/i18n'
import { copyText } from '@/lib/utils'
import { fmt, guests, type Guest } from '@/lib/data'

/* ---------- ЛОГИСТИКА: автобусы + отельный блок ---------- */

interface BusRoute { id: string; name: string; from: string; time: string; seats: number; taken: number }
interface HotelBlock { id: string; name: string; rooms: number; booked: number; price: number; deadline: string; promo: string }

const initBuses: BusRoute[] = [
  { id: 'b1', name: t('Автобус №1'), from: t('Уфа, ост. «Гостиный двор»'), time: '14:30', seats: 20, taken: 5 },
  { id: 'b2', name: t('Автобус №2'), from: t('Уфа, ТЦ «Мега»'), time: '14:45', seats: 20, taken: 2 },
]
const initHotels: HotelBlock[] = [
  { id: 'h1', name: t('Отель «Башкирия»'), rooms: 6, booked: 3, price: 4200, deadline: t('20 мая'), promo: 'TILI1406' },
]

export function Logistics() {
  const [buses, setBuses] = usePersist<BusRoute[]>('tt_buses', initBuses)
  const [hotels, setHotels] = usePersist<HotelBlock[]>('tt_hotels', initHotels)
  const [busForm, setBusForm] = useState(false)
  const [hotelForm, setHotelForm] = useState(false)
  const [bn, setBn] = useState(''); const [bf, setBf] = useState(''); const [bt, setBt] = useState('')
  const [hn, setHn] = useState(''); const [hr, setHr] = useState(''); const [hp, setHp] = useState('')
  const [sent, setSent] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const addBus = () => {
    if (!bn.trim()) return
    setBuses(bs => [...bs, { id: `b${Date.now()}`, name: bn.trim(), from: bf.trim() || t('Точка сбора уточняется'), time: bt.trim() || '14:30', seats: 20, taken: 0 }])
    setBn(''); setBf(''); setBt(''); setBusForm(false)
  }
  const addHotel = () => {
    if (!hn.trim()) return
    const rooms = Math.max(1, parseInt(hr) || 10)
    setHotels(hs => [...hs, { id: `h${Date.now()}`, name: hn.trim(), rooms, booked: 0, price: Math.max(0, parseInt(hp) || 4000), deadline: t('20 мая'), promo: `TILI${1000 + hs.length * 7}` }])
    setHn(''); setHr(''); setHp(''); setHotelForm(false)
  }
  const copy = (code: string) => {
    copyText(code)
    setCopied(code); setTimeout(() => setCopied(null), 1600)
  }

  const totalSeats = buses.reduce((a, b) => a + b.seats, 0)
  const totalTaken = buses.reduce((a, b) => a + b.taken, 0)

  return (
    <div className="pb-28">
      <TopBar back title={t('Логистика гостей')} sub={t('Как все доберутся и где переночуют')} />

      {/* АВТОБУСЫ */}
      <SectionHead title={t('Трансфер для гостей')} sub={`${totalTaken}/${totalSeats} ${t('мест занято')}`} />
      <div className="px-5 mt-2 space-y-2.5 stagger">
        <div className="card-s px-4 py-3 text-[11px] text-[var(--soft)] leading-relaxed">
          {t('Гости отмечают «нужен трансфер» в приглашении и выбирают автобус — места считаются сами, вам не нужно обзванивать всех.')}
        </div>
        {buses.length === 0 && (
          <div className="card p-6 text-center fade-up">
            <span className="w-12 h-12 rounded-2xl bg-[var(--blue)] mx-auto flex items-center justify-center"><Bus size={20} className="text-[var(--ink2)]" /></span>
            <b className="text-[13.5px] block mt-3">{t('Маршрутов пока нет')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Добавьте точку сбора и время — гости запишутся сами прямо в приглашении.')}</p>
          </div>
        )}
        {buses.map(b => (
          <div key={b.id} className="card p-4 fade-up">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-2xl bg-[var(--blue)] flex items-center justify-center shrink-0"><Bus size={18} className="text-[var(--ink2)]" /></span>
              <div className="min-w-0 flex-1">
                <b className="text-[13.5px]">{b.name}</b>
                <p className="text-[11px] text-[var(--soft)] flex items-center gap-1 mt-0.5"><MapPin size={10} /> {b.from} · <Clock3 size={10} /> {b.time}</p>
              </div>
              <span className="text-[11px] font-bold text-[var(--ink2)]">{b.taken}/{b.seats}</span>
            </div>
            <div className="mt-3"><Bar pct={Math.round(b.taken / b.seats * 100)} /></div>
            {b.seats - b.taken <= 5 && <p className="text-[10px] text-[var(--rose-deep)] font-semibold mt-2">{t('Осталось мало мест — добавьте ещё один автобус')}</p>}
          </div>
        ))}
        {busForm ? (
          <div className="card p-4 space-y-2 fade-up">
            <input value={bn} onChange={e => setBn(e.target.value)} placeholder={t('Название (Автобус №3)')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <input value={bf} onChange={e => setBf(e.target.value)} placeholder={t('Точка сбора')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <input value={bt} onChange={e => setBt(e.target.value)} placeholder={t('Время отправления')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <div className="flex gap-2 pt-1">
              <button onClick={() => setBusForm(false)} className="press flex-1 h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Отмена')}</button>
              <button onClick={addBus} className="press flex-1 h-11 rounded-full grad text-white text-[12px] font-semibold">{t('Добавить автобус')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setBusForm(true)} className="press w-full card-s py-3.5 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить автобус')}</button>
        )}
        <button onClick={() => setSent(true)} className="press w-full h-[46px] rounded-full bg-[var(--ink)] text-[var(--bg)] text-[12.5px] font-semibold flex items-center justify-center gap-2">
          <Send size={14} />{sent ? t('Точки сбора отправлены ✓') : t('Отправить гостям точки сбора')}
        </button>
      </div>

      {/* ОТЕЛЬНЫЙ БЛОК */}
      <SectionHead title={t('Отельный блок')} sub={t('для иногородних гостей')} />
      <div className="px-5 mt-2 space-y-2.5 stagger">
        <div className="card-s px-4 py-3 text-[11px] text-[var(--soft)] leading-relaxed">
          {t('Договоритесь с отелем о блоке номеров со скидкой, внесите его сюда — гости бронируют по промокоду из приглашения. Вы видите, сколько номеров занято, и не платите за пустые.')}
        </div>
        {hotels.length === 0 && (
          <div className="card p-6 text-center fade-up">
            <span className="w-12 h-12 rounded-2xl bg-[var(--lav)] mx-auto flex items-center justify-center"><Hotel size={20} className="text-[var(--ink2)]" /></span>
            <b className="text-[13.5px] block mt-3">{t('Отельных блоков пока нет')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Договоритесь с отелем о скидке для гостей и добавьте блок — за невыкупленные номера платить не придётся.')}</p>
          </div>
        )}
        {hotels.map(h => (
          <div key={h.id} className="card p-4 fade-up">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-2xl bg-[var(--lav)] flex items-center justify-center shrink-0"><Hotel size={18} className="text-[var(--ink2)]" /></span>
              <div className="min-w-0 flex-1">
                <b className="text-[13.5px]">{h.name}</b>
                <p className="text-[11px] text-[var(--soft)] mt-0.5">{fmt(h.price)}{t('/ночь · бронь до ')}{h.deadline}</p>
              </div>
              <button onClick={() => setHotels(hs => hs.filter(x => x.id !== h.id))} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center text-[var(--soft)]" aria-label={t('Удалить')}><Trash2 size={13} /></button>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1"><Bar pct={Math.round(h.booked / h.rooms * 100)} /></div>
              <span className="text-[11px] font-bold text-[var(--ink2)]">{h.booked}/{h.rooms} {t('номеров')}</span>
            </div>
            <button onClick={() => copy(h.promo)} className="press mt-3 w-full h-10 rounded-xl bg-[var(--bg)] text-[12px] font-bold tracking-widest flex items-center justify-center gap-2">
              {copied === h.promo ? <><Check size={13} className="text-[var(--sage-deep)]" />{t('Скопировано')}</> : <><Copy size={13} />{t('Промокод: ')}{h.promo}</>}
            </button>
          </div>
        ))}
        {hotelForm ? (
          <div className="card p-4 space-y-2 fade-up">
            <input value={hn} onChange={e => setHn(e.target.value)} placeholder={t('Название отеля')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <div className="flex gap-2">
              <input value={hr} onChange={e => setHr(e.target.value)} placeholder={t('Номеров')} inputMode="numeric" className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
              <input value={hp} onChange={e => setHp(e.target.value)} placeholder={t('₽/ночь')} inputMode="numeric" className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setHotelForm(false)} className="press flex-1 h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Отмена')}</button>
              <button onClick={addHotel} className="press flex-1 h-11 rounded-full grad text-white text-[12px] font-semibold">{t('Добавить отель')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setHotelForm(true)} className="press w-full card-s py-3.5 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить отельный блок')}</button>
        )}
        <AiTip text={t('3 из 6 номеров уже заняты. По опыту, к дедлайну добронируют ещё 1–2 — можно сразу просить у отеля блок 8 номеров по той же цене.')} />
      </div>
    </div>
  )
}

/* ---------- КЕЙТЕРИНГ: опрос гостей по меню ---------- */

interface DishOption { id: string; name: string; icon: string; votes: number }
interface MenuPoll { question: string; options: DishOption[]; sent: boolean }

const initPoll: MenuPoll = {
  question: t('Что приготовить на горячее?'),
  sent: true,
  options: [
    { id: 'o1', name: t('Говядина по-башкирски'), icon: '🥩', votes: 4 },
    { id: 'o2', name: t('Стейк из форели'), icon: '🐟', votes: 2 },
    { id: 'o3', name: t('Овощи гриль с тофу'), icon: '🥦', votes: 1 },
  ],
}

export function Catering() {
  const [poll, setPoll] = usePersist<MenuPoll>('tt_menu_poll', initPoll)
  // Кому вообще нужен ужин: реальный список гостей минус отказавшиеся,
  // с учётом «+1». Раньше здесь стояло фиксированное 44 — при восьми гостях
  // экран сам себе противоречил.
  const [guestList] = usePersist<Guest[]>('tt_guests', guests)
  const [adding, setAdding] = useState(false)
  const [optName, setOptName] = useState('')
  const [reminded, setReminded] = useState(false)
  const answered = poll.options.reduce((a, o) => a + o.votes, 0)
  const totalGuests = guestList.filter(g => g.status !== 'no').reduce((a, g) => a + 1 + (g.plus ? 1 : 0), 0)
  const pending = Math.max(0, totalGuests - answered)

  const addOption = () => {
    if (!optName.trim()) return
    setPoll(p => ({ ...p, options: [...p.options, { id: `o${Date.now()}`, name: optName.trim(), icon: '🍽', votes: 0 }] }))
    setOptName(''); setAdding(false)
  }

  return (
    <div className="pb-28">
      <TopBar back title={t('Меню и кейтеринг')} sub={t('Опрос гостей · сводка для площадки')} />

      <div className="px-5 mt-3 card p-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-2xl bg-[var(--honey)] flex items-center justify-center shrink-0"><UtensilsCrossed size={18} className="text-[var(--ink2)]" /></span>
          <div className="flex-1">
            <b className="text-[13.5px]">{poll.question}</b>
            <p className="text-[11px] text-[var(--soft)] mt-0.5">{answered} {t('из')} {totalGuests} {t('ответили · опрос в приглашении')}</p>
          </div>
        </div>
        <div className="mt-4 space-y-2.5">
          {poll.options.map(o => (
            <div key={o.id} className="flex items-center gap-3">
              <span className="text-[18px] w-7 text-center">{o.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between text-[11.5px] mb-1">
                  <span className="font-medium truncate">{o.name}</span>
                  <b>{o.votes}</b>
                </div>
                <Bar pct={answered ? Math.round(o.votes / answered * 100) : 0} />
              </div>
            </div>
          ))}
        </div>
        {adding ? (
          <div className="mt-4 flex gap-2">
            <input value={optName} onChange={e => setOptName(e.target.value)} placeholder={t('Название блюда')} className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <button onClick={addOption} className="press h-11 px-5 rounded-full grad text-white text-[12px] font-semibold">{t('Добавить')}</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="press mt-4 w-full card-s py-3 text-[12px] font-semibold flex items-center justify-center gap-2"><Plus size={14} />{t('Добавить вариант блюда')}</button>
        )}
      </div>

      <div className="px-5 mt-3 space-y-2.5">
        {pending > 0 && (
          <div className="card-s px-4 py-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-[var(--peach)] flex items-center justify-center shrink-0"><Users size={15} className="text-[var(--ink2)]" /></span>
            <p className="text-[11.5px] flex-1"><b>{pending}</b> {t('гостей ещё не выбрали блюдо')}</p>
            <button onClick={() => setReminded(true)} className="press text-[11px] font-bold text-[var(--rose-deep)] shrink-0">{reminded ? t('Напомнили ✓') : t('Напомнить')}</button>
          </div>
        )}
        <div className="card p-4">
          <b className="text-[13px]">{t('Сводка для кейтеринга')}</b>
          <div className="mt-2.5 space-y-1.5 text-[12px] text-[var(--soft)]">
            {poll.options.map(o => <p key={o.id}>{o.icon} {o.name} — <b className="text-[var(--ink)]">{o.votes}</b></p>)}
            <p>🌿 {t('Аллергии и особые пожелания')} — <b className="text-[var(--ink)]">2</b> ({t('орехи, лактоза')})</p>
          </div>
          <div className="mt-3 rounded-xl bg-[var(--sage-soft)] px-3.5 py-2.5 text-[11px] text-[#4C5B45] flex items-center gap-2">
            <Percent size={13} className="shrink-0" />
            {t('Автоматически уйдёт кейтерингу за 14 дней до даты — 31 мая, правки до 7 июня.')}
          </div>
        </div>
        <AiTip text={t('Опрос уже встроен в ваши приглашения: гость отвечает на RSVP и сразу выбирает горячее — один тап, без регистрации. Отдельных анкет и звонков не нужно.')} />
        <SyncNote to={t('Кейтеринг «Восточный банкет»')} />
      </div>
    </div>
  )
}
