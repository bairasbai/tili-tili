import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Heart, Plus, Trash2, Wine, Users } from 'lucide-react'
import { vendors, fmt } from '@/lib/data'
import { Tile, TopBar, VendorCard } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

/* Избранное — отложенные подрядчики (боль: «кандидаты теряются в переписках») */
export function Favorites() {
  const nav = useNavigate()
  const { favorites } = useStore()
  const list = vendors.filter(v => favorites.includes(v.id))
  return (
    <div className="pb-28">
      <TopBar back title="Избранное" sub={`${list.length} отложено · сравните и выберите`} />
      <div className="px-5 mt-3 space-y-3.5 stagger">
        {list.map(v => <VendorCard key={v.id} v={v} onOpen={() => nav(`/vendor/${v.id}`)} />)}
        {list.length === 0 && (
          <div className="text-center py-14 fade-up">
            <div className="w-16 h-16 rounded-[22px] bg-[var(--rose-soft)] mx-auto flex items-center justify-center"><Heart size={26} className="text-[#C98A8A]" /></div>
            <b className="text-[15px] block mt-4">Пока пусто</b>
            <p className="text-[12px] text-[var(--soft)] mt-1.5 leading-relaxed">Нажимайте ♥ на карточках подрядчиков —<br />они соберутся здесь для сравнения</p>
            <button onClick={() => nav('/search')} className="press mt-5 px-6 h-[44px] rounded-full grad text-white text-[12px] font-semibold">К каталогу</button>
          </div>
        )}
        {list.length >= 2 && (
          <button onClick={() => nav('/compare')} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            Сравнить выбранных ⇄
          </button>
        )}
      </div>
    </div>
  )
}

/* Заметки и идеи (боль: «референсы в трёх мессенджерах») */
export function Notes() {
  const [notes, setNotes] = useState<{ id: string; icon: string; tile: string; text: string }[]>(() => {
    try { return JSON.parse(localStorage.getItem('tt_notes') ?? 'null') ?? [
      { id: 'n1', icon: '💐', tile: 'bg-[var(--rose-soft)]', text: 'Букет: пионы + эвкалипт, показать флористу референс из Pinterest' },
      { id: 'n2', icon: '🎵', tile: 'bg-[var(--lav)]', text: 'Первый танец — обсудить с DJ песню «Perfect»' },
      { id: 'n3', icon: '📸', tile: 'bg-[var(--sage-soft)]', text: 'Спросить у фотографа про съёмку утра невесты' },
    ] } catch { return [] }
  })
  const save = (n: typeof notes) => { setNotes(n); localStorage.setItem('tt_notes', JSON.stringify(n)) }
  const [text, setText] = useState('')
  const add = () => {
    if (!text.trim()) return
    save([{ id: `n${Date.now()}`, icon: '📌', tile: 'bg-[var(--honey)]', text: text.trim() }, ...notes])
    setText('')
  }
  return (
    <div className="pb-28">
      <TopBar back title="Заметки и идеи" sub="Всё, что не хочется забыть" />
      <div className="px-5 mt-3">
        <div className="card-s flex items-center gap-2.5 px-4 py-2">
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
            placeholder="Новая заметка…" className="flex-1 bg-transparent outline-none text-[13.5px] py-2.5 placeholder:text-[var(--soft2)]" />
          <button onClick={add} className="press w-9 h-9 rounded-full grad text-white flex items-center justify-center shrink-0" aria-label="Добавить"><Plus size={16} /></button>
        </div>
        <div className="space-y-2.5 mt-4 stagger">
          {notes.map(n => (
            <div key={n.id} className="card-s p-4 flex items-center gap-3 fade-up">
              <Tile icon={n.icon} tile={n.tile} size={40} />
              <p className="flex-1 text-[12.5px] leading-relaxed">{n.text}</p>
              <button onClick={() => save(notes.filter(y => y.id !== n.id))} className="press text-[var(--soft2)]" aria-label="Удалить"><Trash2 size={15} /></button>
            </div>
          ))}
          {notes.length === 0 && <p className="text-center text-[12px] text-[var(--soft2)] py-10">Все заметки разобраны ✨</p>}
        </div>
      </div>
    </div>
  )
}

/* Калькулятор алкоголя (боль жениха: «сколько брать, чтобы хватило и не переплатить») */
export function AlcoholCalc() {
  const [guestsN, setGuestsN] = useState(80)
  const [strong, setStrong] = useState(true)
  const drinks = [
    { name: 'Игристое', per: 0.5, unit: 'л/чел', bottle: 0.75, icon: '🥂' },
    { name: 'Вино', per: 0.4, unit: 'л/чел', bottle: 0.75, icon: '🍷' },
    ...(strong ? [{ name: 'Крепкое', per: 0.25, unit: 'л/чел', bottle: 0.5, icon: '🥃' }] : []),
    { name: 'Вода и соки', per: 1.5, unit: 'л/чел', bottle: 1.5, icon: '💧' },
  ]
  return (
    <div className="pb-28">
      <TopBar back title="Калькулятор алкоголя" sub="Нормы банкетного формата · по Тилю" />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium flex items-center gap-2"><Users size={15} className="text-[#B57171]" /> Гостей</span>
            <div className="flex items-center gap-3">
              <button onClick={() => setGuestsN(g => Math.max(10, g - 10))} className="press w-9 h-9 rounded-full bg-[var(--bg)] font-bold">−</button>
              <b className="tabular text-[18px] w-10 text-center">{guestsN}</b>
              <button onClick={() => setGuestsN(g => Math.min(300, g + 10))} className="press w-9 h-9 rounded-full bg-[var(--bg)] font-bold">+</button>
            </div>
          </div>
          <div className="flex items-center justify-between mt-4">
            <span className="text-[13px] font-medium flex items-center gap-2"><Wine size={15} className="text-[#B57171]" /> Крепкие напитки</span>
            <button onClick={() => setStrong(!strong)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', strong ? 'grad' : 'bg-[var(--track)]')} aria-label="Крепкие напитки">
              <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-[var(--card)] shadow transition-all', strong ? 'left-[22px]' : 'left-[3px]')} />
            </button>
          </div>
        </div>

        <div className="card px-4 py-1.5">
          {drinks.map((d, i) => {
            const litres = d.per * guestsN
            const bottles = Math.ceil(litres / d.bottle)
            return (
              <div key={d.name} className={cn('flex items-center gap-3 py-3.5', i !== drinks.length - 1 && 'border-b border-[var(--track)]')}>
                <span className="text-[22px]">{d.icon}</span>
                <div className="flex-1">
                  <b className="text-[13px]">{d.name}</b>
                  <p className="text-[10px] text-[var(--soft)]">{d.per} {d.unit}</p>
                </div>
                <b className="font-serif-d text-[16px] text-[#B57171] tabular">{bottles} бут.</b>
              </div>
            )
          })}
        </div>

        <div className="card-s p-4 text-[11.5px] text-[var(--ink2)] leading-relaxed">
          ✦ <b>Совет Тиля:</b> закладывайте +10% запаса. Для усадьбы уточните пробковый сбор — иногда выгоднее закупаться самим. Берите с чеком: невскрытое часто принимают обратно.
        </div>

        <div className="card p-4 flex justify-between items-center">
          <span className="text-[12.5px] text-[var(--soft)]">Ориентир по бюджету</span>
          <b className="font-serif-d text-[18px] tabular">{fmt(guestsN * (strong ? 750 : 500))}</b>
        </div>
      </div>
    </div>
  )
}
