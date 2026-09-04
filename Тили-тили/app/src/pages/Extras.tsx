import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Heart, Plus, Trash2, Wine, Users } from 'lucide-react'
import { fmt } from '@/lib/data'
import { CATEGORY_TILE, DEFAULT_TILE } from '@/lib/categoryTiles'
import { getCategories, getFavorites } from '@/lib/api/catalog'
import { useApi } from '@/lib/api/useApi'
import { Tile, TopBar, VendorCard } from '@/components/chrome'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* Избранное — отложенные подрядчики (боль: «кандидаты теряются в переписках») */
export function Favorites() {
  const nav = useNavigate()
  /* Список приходит с сервера, а не собирается из мока по локальным
     идентификаторам: избранное — это данные аккаунта, и на новом телефоне
     оно должно быть тем же. */
  const favs = useApi(() => getFavorites(), [])
  const cats = useApi(() => getCategories(), [])
  const list = favs.data ?? []
  const catOf = (id?: string) => (cats.data ?? []).find(c => c.id === id)
  return (
    <div className="pb-28">
      <TopBar back title={t('Избранное')} sub={`${list.length}${t(' отложено · сравните и выберите')}`} />
      <div className="px-5 mt-3 space-y-3.5 stagger">
        {favs.loading && <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Загружаем…')}</p>}
        {favs.error && (
          <div className="py-6 text-center">
            <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed">{favs.error}</p>
            <button onClick={favs.reload} className="press mt-3 px-5 h-[40px] rounded-full card-s text-[12px] font-semibold">{t('Повторить')}</button>
          </div>
        )}
        {list.map(v => (
          <VendorCard key={v.id} v={v}
            categoryTitle={catOf(v.categoryId)?.title}
            categoryIcon={catOf(v.categoryId)?.icon}
            tile={CATEGORY_TILE[v.categoryId ?? ''] ?? DEFAULT_TILE}
            onOpen={() => nav(`/vendor/${v.id}`)} />
        ))}
        {!favs.loading && !favs.error && list.length === 0 && (
          <div className="text-center py-14 fade-up">
            <div className="w-16 h-16 rounded-[22px] bg-[var(--rose-soft)] mx-auto flex items-center justify-center"><Heart size={26} className="text-[var(--rose-ink)]" /></div>
            <b className="text-[15px] block mt-4">{t('Пока пусто')}</b>
            <p className="text-[12px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Нажимайте ♥ на карточках подрядчиков —')}<br />{t('они соберутся здесь для сравнения')}</p>
            <button onClick={() => nav('/search')} className="press mt-5 px-6 h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('К каталогу')}</button>
          </div>
        )}
        {list.length >= 2 && (
          <button onClick={() => nav('/compare')} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            {t('Сравнить выбранных ⇄')}
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
      { id: 'n1', icon: '💐', tile: 'bg-[var(--rose-soft)]', text: t('Букет: пионы + эвкалипт, показать флористу референс из Pinterest') },
      { id: 'n2', icon: '🎵', tile: 'bg-[var(--lav)]', text: t('Первый танец — обсудить с DJ песню «Perfect»') },
      { id: 'n3', icon: '📸', tile: 'bg-[var(--sage-soft)]', text: t('Спросить у фотографа про съёмку утра невесты') },
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
      <TopBar back title={t('Заметки и идеи')} sub={t('Всё, что не хочется забыть')} />
      <div className="px-5 mt-3">
        <div className="card-s flex items-center gap-2.5 px-4 py-2">
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
            placeholder={t('Новая заметка…')} className="flex-1 bg-transparent outline-none text-[13.5px] py-2.5 placeholder:text-[var(--soft2)]" />
          <button onClick={add} className="press w-9 h-9 rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0" aria-label={t('Добавить')}><Plus size={16} /></button>
        </div>
        <div className="space-y-2.5 mt-4 stagger">
          {notes.map(n => (
            <div key={n.id} className="card-s p-4 flex items-center gap-3 fade-up">
              <Tile icon={n.icon} tile={n.tile} size={40} />
              <p className="flex-1 text-[12.5px] leading-relaxed">{n.text}</p>
              <button onClick={() => save(notes.filter(y => y.id !== n.id))} className="press text-[var(--soft2)]" aria-label={t('Удалить')}><Trash2 size={15} /></button>
            </div>
          ))}
          {notes.length === 0 && <p className="text-center text-[12px] text-[var(--soft2)] py-10">{t('Все заметки разобраны ✨')}</p>}
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
    { name: t('Игристое'), per: 0.5, unit: t('л/чел'), bottle: 0.75, icon: '🥂' },
    { name: t('Вино'), per: 0.4, unit: t('л/чел'), bottle: 0.75, icon: '🍷' },
    ...(strong ? [{ name: t('Крепкое'), per: 0.25, unit: t('л/чел'), bottle: 0.5, icon: '🥃' }] : []),
    { name: t('Вода и соки'), per: 1.5, unit: t('л/чел'), bottle: 1.5, icon: '💧' },
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Калькулятор алкоголя')} sub={t('Нормы банкетного формата · по Тилю')} />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium flex items-center gap-2"><Users size={15} className="text-[var(--rose-deep)]" />{t('Гостей')}</span>
            <div className="flex items-center gap-3">
              <button onClick={() => setGuestsN(g => Math.max(10, g - 10))} className="press w-9 h-9 rounded-full bg-[var(--bg)] font-bold">−</button>
              <b className="tabular text-[18px] w-10 text-center">{guestsN}</b>
              <button onClick={() => setGuestsN(g => Math.min(300, g + 10))} className="press w-9 h-9 rounded-full bg-[var(--bg)] font-bold">+</button>
            </div>
          </div>
          <div className="flex items-center justify-between mt-4">
            <span className="text-[13px] font-medium flex items-center gap-2"><Wine size={15} className="text-[var(--rose-deep)]" />{t('Крепкие напитки')}</span>
            <button onClick={() => setStrong(!strong)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', strong ? 'grad' : 'bg-[var(--track)]')} aria-label={t('Крепкие напитки')}>
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
                <b className="font-serif-d text-[16px] text-[var(--rose-deep)] tabular">{bottles} {t('бут.')}</b>
              </div>
            )
          })}
        </div>

        <div className="card-s p-4 text-[11.5px] text-[var(--ink2)] leading-relaxed">
          ✦ <b>{t('Совет Тиля:')}</b> закладывайте +10% запаса. Для усадьбы уточните пробковый сбор — иногда выгоднее закупаться самим. Берите с чеком: невскрытое часто принимают обратно.
        </div>

        <div className="card p-4 flex justify-between items-center">
          <span className="text-[12.5px] text-[var(--soft)]">{t('Ориентир по бюджету')}</span>
          <b className="font-serif-d text-[18px] tabular">{fmt(guestsN * (strong ? 750 : 500))}</b>
        </div>
      </div>
    </div>
  )
}
