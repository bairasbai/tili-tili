import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Search as SearchIcon, SlidersHorizontal, Play, MapPin, Calendar, Check } from 'lucide-react'
import { categories, vendors, fmt } from '@/lib/data'
import { TopBar, VendorCard } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

/* Каталог категорий */
export function SearchCategories() {
  const nav = useNavigate()
  const { slots } = useStore()
  const [q, setQ] = useState('')
  const stateOf = (id: string) => slots.find(s => s.categoryId === id)?.state
  const list = categories.filter(c => c.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="pb-28">
      <TopBar title="Все специалисты" sub={`${categories.length} категорий · Уфа · 14.06.2027`} />
      <div className="px-5 mt-2">
        <div className="card-s flex items-center gap-2.5 px-4 py-3.5">
          <SearchIcon size={17} className="text-[#93897F]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Фотограф, торт, шатёр…" className="bg-transparent outline-none text-[14px] w-full placeholder:text-[#BFB5AA]" />
        </div>
      </div>
      <div className="px-5 grid grid-cols-3 gap-2.5 mt-4 stagger">
        {list.map(c => {
          const st = stateOf(c.id)
          return (
            <button key={c.id} onClick={() => nav(`/search/${c.id}`)} className="press card-s p-3 text-center fade-up">
              <div className={cn('w-11 h-11 rounded-[14px] mx-auto flex items-center justify-center text-[19px]', c.tile)}>{c.icon}</div>
              <b className="text-[11px] block mt-2 leading-tight">{c.name}</b>
              <span className="text-[9px] text-[#93897F] block mt-1">{c.count} рядом</span>
              {st === 'booked' && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[#E6EEE2] text-[#7E9A74] mt-1.5">✓ Есть</span>}
              {(st === 'hold' || st === 'candidate') && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[#F7ECD9] text-[#B98A2F] mt-1.5">⏳ Ищем</span>}
            </button>
          )
        })}
      </div>
      {list.length === 0 && (
        <div className="px-5 mt-10 text-center fade-up">
          <div className="w-16 h-16 rounded-[22px] bg-[#F2DFDC] mx-auto flex items-center justify-center text-[26px]">🔍</div>
          <b className="text-[15px] block mt-4">Ничего не нашлось</b>
          <p className="text-[12px] text-[#93897F] mt-1.5">Попробуйте другое слово — или спросите Тиля — он подскажет категорию</p>
          <button onClick={() => nav('/assistant')} className="press mt-5 px-6 h-[44px] rounded-full grad text-white text-[12px] font-semibold">Спросить Тиля</button>
        </div>
      )}
    </div>
  )
}
export function VendorList() {
  const { catId = 'photo' } = useParams()
  const nav = useNavigate()
  const cat = categories.find(c => c.id === catId) ?? categories[0]
  const list = vendors.filter(v => v.category === cat.name || (catId === 'photo' && v.category === 'Фотограф'))
  const base = list.length ? list : vendors
  const [filter, setFilter] = useState('free')
  const shown = base.filter(v =>
    filter === 'free' ? v.freeOnDate :
    filter === 'video' ? v.hasVideo :
    filter === 'top' ? v.rating >= 4.8 :
    v.priceFrom <= 100000
  )

  return (
    <div className="pb-28">
      <TopBar back title={cat.name} sub={`${shown.length} рядом · сортировка: рекомендованные`} right={
        <button className="press w-10 h-10 rounded-full bg-white flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label="Фильтры">
          <SlidersHorizontal size={16} />
        </button>
      } />
      <div className="px-5 flex gap-2 mt-2 overflow-x-auto no-scrollbar">
        {[['free', 'Свободны 14.06'], ['video', 'С видео'], ['top', 'Рейтинг 4.8+'], ['budget', 'до 100 тыс ₽']].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', filter === id ? 'grad text-white' : 'bg-white text-[#93897F]')} style={{ boxShadow: 'var(--shadow)' }}>
            {label}
          </button>
        ))}
        <button onClick={() => nav('/compare')} className="press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap bg-white text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>⇄ Сравнить</button>
      </div>
      <div className="px-5 mt-4 space-y-3.5 stagger">
        {shown.map(v => <VendorCard key={v.id} v={v} onOpen={() => nav(`/vendor/${v.id}`)} />)}
        {shown.length === 0 && (
          <div className="text-center py-10 fade-up">
            <b className="text-[14px]">Под фильтр никто не подходит</b>
            <p className="text-[11.5px] text-[#93897F] mt-1.5">Смягчите условия — или спросите Тиля, он расширит поиск</p>
          </div>
        )}
      </div>
    </div>
  )
}

/* Анкета подрядчика */
export function VendorDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { slots, bookVendor } = useStore()
  const v = vendors.find(x => x.id === id) ?? vendors[0]
  const [pkg, setPkg] = useState(0)
  const [added, setAdded] = useState(false)
  const slot = slots.find(s => s.categoryId === categories.find(c => c.name === v.category)?.id)

  const add = () => {
    if (slot) bookVendor(slot.id, v.name, v.packages[pkg].price)
    setAdded(true)
    setTimeout(() => nav('/wedding'), 900)
  }

  return (
    <div className="pb-32">
      <TopBar back title={v.category} sub="Анкета подрядчика" />
      {/* Галерея */}
      <div className="px-5 mt-2">
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {Array.from({ length: v.photos }).map((_, k) => (
            <div key={k} className={cn('relative w-[200px] h-[250px] rounded-[22px] shrink-0', v.tile)} style={{ boxShadow: 'var(--shadow)' }}>
              <div className="absolute inset-0 rounded-[22px]" style={{ background: `radial-gradient(circle at ${30 + k * 15}% ${25 + k * 10}%, rgba(255,255,255,.7), transparent 60%)` }} />
              <span className="absolute inset-0 flex items-center justify-center text-[44px]">{v.categoryIcon}</span>
              {k === 0 && v.hasVideo && (
                <span className="absolute bottom-3 left-3 flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1.5 rounded-full bg-black/50 text-white"><Play size={10} /> 1:40</span>
              )}
            </div>
          ))}
        </div>
        <p className="text-[10px] text-[#93897F] mt-2 text-center">5 фото · видео до 3 минут</p>
      </div>

      <div className="px-5 mt-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="font-serif-d text-[26px]">{v.name}</h1>
            <p className="text-[12px] text-[#93897F] mt-1 flex items-center gap-1.5">
              <MapPin size={12} /> Уфа + 100 км
              {v.reviews > 0 ? <span>· ★ {v.rating} · {v.reviews} отзывов</span> : <span>· Новый на платформе</span>}
            </p>
          </div>
          {v.freeOnDate && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[#E6EEE2] text-[#7E9A74] whitespace-nowrap">● Свободен 14.06</span>}
        </div>
        <p className="text-[13px] text-[#5C554B] leading-relaxed mt-3 font-light">{v.desc}</p>
      </div>

      {/* Пакеты */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">Пакеты и цены</h2>
        <div className="space-y-2.5">
          {v.packages.map((p, k) => (
            <button key={p.name} onClick={() => setPkg(k)} className={cn('press w-full card p-4 text-left', pkg === k && 'ring-2 ring-[#C98A8A]')}>
              <div className="flex justify-between items-center">
                <b className="text-[14px]">{p.name}</b>
                <span className="font-serif-d text-[17px] text-[#B57171] font-semibold tabular">{fmt(p.price)}</span>
              </div>
              <ul className="mt-2 space-y-1">
                {p.items.map(it => (
                  <li key={it} className="text-[11.5px] text-[#93897F] flex items-center gap-1.5"><Check size={11} className="text-[#A9BCA0]" />{it}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </div>

      {/* Календарь */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">Июнь 2027</h2>
        <div className="card p-4">
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-[#93897F] font-semibold mb-1">
            {['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => <span key={d}>{d}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 30 }).map((_, k) => {
              const day = k + 1
              const isWedding = day === 14
              const busy = [5, 6, 19, 20, 26].includes(day)
              return (
                <div key={day} className={cn('aspect-square rounded-xl flex items-center justify-center text-[11.5px] font-medium',
                  isWedding ? 'grad text-white font-bold' : busy ? 'bg-[#F2DFDC] text-[#B57171] line-through' : 'text-[#2E2A26]')}>
                  {day}
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-[#93897F] mt-3 flex items-center gap-1.5"><Calendar size={11} /> 14 июня свободна · зачёркнуты занятые даты</p>
        </div>
      </div>

      {/* Отзывы */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">Отзывы пар</h2>
        <div className="space-y-2.5">
          {[
            ['Гульнара и Тимур', '★★★★★', 'Сняла даже то, чего мы не заметили. Фото прислала через неделю — все 600 обработанных!'],
            ['Дина и Руслан', '★★★★★', 'Спокойная, ненавязчивая, с чувством света. Родители в восторге от семейных кадров.'],
          ].map(([n, st, tx]) => (
            <div key={n} className="card-s p-4">
              <div className="flex justify-between items-center">
                <b className="text-[12.5px]">{n}</b>
                <span className="text-[10px] text-[#B98A2F] tracking-wide">{st}</span>
              </div>
              <p className="text-[11.5px] text-[#5C554B] leading-relaxed mt-1.5 font-light">{tx}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Похожие */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">Похожие специалисты</h2>
        <div className="flex gap-2.5 overflow-x-auto no-scrollbar">
          {vendors.filter(x => x.id !== v.id).slice(0, 4).map(x => (
            <button key={x.id} onClick={() => nav(`/vendor/${x.id}`)} className={cn('press w-[120px] shrink-0 card-s p-3 text-center', x.tile)}>
              <span className="text-[24px]">{x.categoryIcon}</span>
              <b className="text-[10.5px] block mt-1.5 leading-tight truncate">{x.name}</b>
              <span className="text-[9.5px] text-[#B57171] font-bold tabular">от {x.priceFrom.toLocaleString('ru-RU')} ₽</span>
            </button>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] glass-tab px-5 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] flex gap-2.5 z-40">
        <button onClick={() => nav('/us/chats/ch1')} className="press flex-1 h-[52px] rounded-full bg-white font-semibold text-[13.5px]" style={{ boxShadow: 'var(--shadow)' }}>Написать</button>
        <button onClick={add} className="press flex-[1.4] h-[52px] rounded-full grad text-white font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {added ? '✓ В моей свадьбе!' : slot ? 'Добавить в свадьбу' : 'Забронировать'}
        </button>
      </div>
    </div>
  )
}
