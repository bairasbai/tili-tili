import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Search as SearchIcon, SlidersHorizontal, Play, MapPin, Calendar, Check } from 'lucide-react'
import { categories, vendors, fmt } from '@/lib/data'
import { TopBar, VendorCard } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn, copyText } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* Каталог категорий */
export function SearchCategories() {
  const nav = useNavigate()
  const { slots, city } = useStore()
  const [q, setQ] = useState('')
  const stateOf = (id: string) => slots.find(s => s.categoryId === id)?.state
  const list = categories.filter(c => c.name.toLowerCase().includes(q.toLowerCase()))
  const foundVendors = q.trim().length >= 2
    ? vendors.filter(v => `${v.name} ${v.category} ${v.desc}`.toLowerCase().includes(q.toLowerCase())).slice(0, 5)
    : []

  return (
    <div className="pb-28">
      <TopBar title={t('Все специалисты')} sub={`${categories.length}${t(' категорий · ')}${t(city)} · 14.06.2027`} />
      <div className="px-5 mt-2">
        <div className="card-s flex items-center gap-2.5 px-4 py-3.5">
          <SearchIcon size={17} className="text-[var(--soft)]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Фотограф, торт, шатёр…')} className="bg-transparent outline-none text-[14px] w-full placeholder:text-[var(--soft2)]" />
        </div>
      </div>
      <div className="px-5 grid grid-cols-3 gap-2.5 mt-4 stagger">
        {list.map(c => {
          const st = stateOf(c.id)
          return (
            <button key={c.id} onClick={() => nav(`/search/${c.id}`)} className="press card-s p-3 text-center fade-up">
              <div className={cn('w-11 h-11 rounded-[14px] mx-auto flex items-center justify-center text-[19px]', c.tile)}>{c.icon}</div>
              <b className="text-[11px] block mt-2 leading-tight">{c.name}</b>
              <span className="text-[9px] text-[var(--soft)] block mt-1">{c.count}{t('рядом')}</span>
              {st === 'booked' && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[var(--sage-soft)] text-[#7E9A74] mt-1.5">{t('✓ Есть')}</span>}
              {(st === 'hold' || st === 'candidate') && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[var(--honey)] text-[#B98A2F] mt-1.5">{t('⏳ Ищем')}</span>}
            </button>
          )
        })}
      </div>
      {foundVendors.length > 0 && (
        <div className="px-5 mt-5">
          <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1">{t('Подрядчики')}</span>
          <div className="space-y-2.5 mt-2 stagger">
            {foundVendors.map(v => (
              <VendorCard key={v.id} v={v} onOpen={() => nav(`/vendor/${v.id}`)} />
            ))}
          </div>
        </div>
      )}
      {list.length === 0 && !foundVendors.length && (
        <div className="px-5 mt-10 text-center fade-up">
          <div className="w-16 h-16 rounded-[22px] bg-[var(--rose-soft)] mx-auto flex items-center justify-center text-[26px]">🔍</div>
          <b className="text-[15px] block mt-4">{t('Ничего не нашлось')}</b>
          <p className="text-[12px] text-[var(--soft)] mt-1.5">{t('Попробуйте другое слово — или спросите Тиля — он подскажет категорию')}</p>
          <button onClick={() => nav('/assistant')} className="press mt-5 px-6 h-[44px] rounded-full grad text-white text-[12px] font-semibold">{t('Спросить Тиля')}</button>
        </div>
      )}
    </div>
  )
}
export function VendorList() {
  const { catId = 'photo' } = useParams()
  const nav = useNavigate()
  const cat = categories.find(c => c.id === catId) ?? categories[0]
  const list = vendors.filter(v => v.category === cat.name || (catId === 'photo' && v.category === t('Фотограф')))
  const base = list.length ? list : vendors
  const [filter, setFilter] = useState('free')
  const [showFilters, setShowFilters] = useState(true)
  const shown = base.filter(v =>
    filter === 'free' ? v.freeOnDate :
    filter === 'video' ? v.hasVideo :
    filter === 'top' ? v.rating >= 4.8 :
    v.priceFrom <= 100000
  )

  return (
    <div className="pb-28">
      <TopBar back title={cat.name} sub={`${shown.length}${t(' рядом · сортировка: рекомендованные')}`} right={
        <button onClick={() => setShowFilters(s => !s)} className={cn('press w-10 h-10 rounded-full flex items-center justify-center', showFilters ? 'grad text-white' : 'bg-[var(--card)]')} style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Фильтры')}>
          <SlidersHorizontal size={16} />
        </button>
      } />
      {showFilters && <div className="px-5 flex gap-2 mt-2 overflow-x-auto no-scrollbar">
        {[['free', t('Свободны 14.06')], ['video', t('С видео')], ['top', t('Рейтинг 4.8+')], ['budget', t('до 100 тыс ₽')]].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', filter === id ? 'grad text-white' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>
            {label}
          </button>
        ))}
        <button onClick={() => nav('/compare')} className="press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap bg-[var(--card)] text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>{t('⇄ Сравнить')}</button>
      </div>}
      <div className="px-5 mt-4 space-y-3.5 stagger">
        {shown.map(v => <VendorCard key={v.id} v={v} onOpen={() => nav(`/vendor/${v.id}`)} />)}
        {shown.length === 0 && (
          <div className="text-center py-10 fade-up">
            <b className="text-[14px]">{t('Под фильтр никто не подходит')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5">{t('Смягчите условия — или спросите Тиля, он расширит поиск')}</p>
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
  const { slots, bookVendor, city } = useStore()
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
      <TopBar back title={v.category} sub={t('Анкета подрядчика')} right={
        <button onClick={() => {
          const data = { title: `${v.name}${t(' — Тили-тили')}`, text: `${v.category} · ${t(city)}${t(' · от ')}${fmt(v.priceFrom)}`, url: location.href }
          if (navigator.share) navigator.share(data).catch(() => {})
          else { copyText(`${data.title}\n${data.text}\n${data.url}`) }
        }} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[11.5px] font-semibold text-[#B57171]" style={{ boxShadow: 'var(--shadow)' }}>{t('Поделиться')}</button>
      } />
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
        <p className="text-[10px] text-[var(--soft)] mt-2 text-center">{t('5 фото · видео до 3 минут')}</p>
      </div>

      <div className="px-5 mt-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="font-serif-d text-[26px]">{v.name}</h1>
            <p className="text-[12px] text-[var(--soft)] mt-1 flex items-center gap-1.5">
              <MapPin size={12} /> {t(city)}{t(' + 100 км')}
              {v.reviews > 0 ? <span>· ★ {v.rating} · {v.reviews}{t('отзывов')}</span> : <span>{t('· Новый на платформе')}</span>}
            </p>
          </div>
          {v.freeOnDate && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[#7E9A74] whitespace-nowrap">{t('● Свободен 14.06')}</span>}
        </div>
        <p className="text-[13px] text-[var(--ink2)] leading-relaxed mt-3 font-light">{v.desc}</p>
      </div>

      {/* Проверка подрядчика */}
      <div className="px-5 mt-4">
        <div className="card p-4" style={{ border: '1.5px solid rgba(126,154,116,.4)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-[var(--sage-soft)] flex items-center justify-center text-[14px]">🛡</span>
            <b className="text-[13px]">{t('Проверен «Тили-тили»')}</b>
            <span className="ml-auto text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--sage-soft)] text-[#4C5B45]">{t('✓ верифицирован')}</span>
          </div>
          <div className="mt-3 space-y-1.5 text-[11.5px] text-[var(--soft)]">
            <p>✓ {t('Паспорт / ИП сверены с базой ФНС')}</p>
            <p>✓ {t('Отзывы — только от пар после реальной сделки')}</p>
            <p>✓ {t('Оплата через эскроу: деньги заморожены до дня X')}</p>
            <p>✓ {t('За отмену в последний момент — штраф рейтинга и горячая замена вам')}</p>
          </div>
        </div>
      </div>

      {/* Пакеты */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Пакеты и цены')}</h2>
        <div className="space-y-2.5">
          {v.packages.map((p, k) => (
            <button key={p.name} onClick={() => setPkg(k)} className={cn('press w-full card p-4 text-left', pkg === k && 'ring-2 ring-[#C98A8A]')}>
              <div className="flex justify-between items-center">
                <b className="text-[14px]">{p.name}</b>
                <span className="font-serif-d text-[17px] text-[#B57171] font-semibold tabular">{fmt(p.price)}</span>
              </div>
              <ul className="mt-2 space-y-1">
                {p.items.map(it => (
                  <li key={it} className="text-[11.5px] text-[var(--soft)] flex items-center gap-1.5"><Check size={11} className="text-[#A9BCA0]" />{it}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </div>

      {/* Календарь */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Июнь 2027')}</h2>
        <div className="card p-4">
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-[var(--soft)] font-semibold mb-1">
            {[t('Пн'),t('Вт'),t('Ср'),t('Чт'),t('Пт'),t('Сб'),t('Вс')].map(d => <span key={d}>{d}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 30 }).map((_, k) => {
              const day = k + 1
              const isWedding = day === 14
              // реальный календарь занятости подрядчика (мок: детерминированно по id)
              const h = [...v.id].reduce((a, c) => a + c.charCodeAt(0), 0)
              const busy = [3 + (h % 4), 6 + (h % 3), 12 + (h % 5), 19 + (h % 3), 25 + (h % 4)].includes(day) || (!v.freeOnDate && isWedding)
              return (
                <div key={day} className={cn('aspect-square rounded-xl flex items-center justify-center text-[11.5px] font-medium',
                  isWedding && v.freeOnDate ? 'grad text-white font-bold' : busy ? 'bg-[var(--rose-soft)] text-[#B57171] line-through' : isWedding ? 'ring-2 ring-[#C98A8A] text-[#B57171] font-bold' : 'text-[var(--ink)]')}>
                  {day}
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-[var(--soft)] mt-3 flex items-center gap-1.5"><Calendar size={11} />{v.freeOnDate ? t('14 июня свободна · зачёркнуты занятые даты') : t('14 июня занята — посмотрите похожих свободных ниже')}</p>
        </div>
      </div>

      {/* Отзывы */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Отзывы пар')}</h2>
        <div className="space-y-2.5">
          {[
            [t('Гульнара и Тимур'), '★★★★★', t('Сняла даже то, чего мы не заметили. Фото прислала через неделю — все 600 обработанных!')],
            [t('Дина и Руслан'), '★★★★★', t('Спокойная, ненавязчивая, с чувством света. Родители в восторге от семейных кадров.')],
          ].map(([n, st, tx]) => (
            <div key={n} className="card-s p-4">
              <div className="flex justify-between items-center">
                <b className="text-[12.5px]">{n}</b>
                <span className="text-[10px] text-[#B98A2F] tracking-wide">{st}</span>
              </div>
              <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed mt-1.5 font-light">{tx}</p>
              <p className="text-[9px] font-bold text-[#7E9A74] mt-2">✓ {t('сделка через «Тили-тили» — отзыв подтверждён')}</p>
            </div>
          ))}
          <div className="card-s p-4">
            <div className="flex justify-between items-center gap-2">
              <b className="text-[12.5px]">{t('Гость свадьбы Алины и Тимура')}</b>
              <span className="text-[10px] text-[#B98A2F] tracking-wide">★★★★★</span>
            </div>
            <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed mt-1.5 font-light">{t('Фотографировала нас незаметно, но на фото мы все — и бабушки, и дети. Очень живые кадры!')}</p>
            <span className="inline-block text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--blue)] text-[#5B7898] mt-2">{t('Гость свадьбы')}</span>
          </div>
        </div>
      </div>

      {/* Похожие */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Похожие специалисты')}</h2>
        <div className="flex gap-2.5 overflow-x-auto no-scrollbar">
          {vendors.filter(x => x.id !== v.id).slice(0, 4).map(x => (
            <button key={x.id} onClick={() => nav(`/vendor/${x.id}`)} className={cn('press w-[120px] shrink-0 card-s p-3 text-center', x.tile)}>
              <span className="text-[24px]">{x.categoryIcon}</span>
              <b className="text-[10.5px] block mt-1.5 leading-tight truncate">{x.name}</b>
              <span className="text-[9.5px] text-[#B57171] font-bold tabular">{t('от')}{x.priceFrom.toLocaleString('ru-RU')} ₽</span>
            </button>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] glass-tab px-5 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] flex gap-2.5 z-40">
        <button onClick={() => nav('/us/chats/ch1')} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13.5px]" style={{ boxShadow: 'var(--shadow)' }}>{t('Написать')}</button>
        <button onClick={add} className="press flex-[1.4] h-[52px] rounded-full grad text-white font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {added ? t('✓ В моей свадьбе!') : slot ? t('Добавить в свадьбу') : t('Забронировать')}
        </button>
      </div>
    </div>
  )
}
