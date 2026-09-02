import { useState } from 'react'
import { MapPin, Search, X, Navigation, ChevronRight } from 'lucide-react'
import { POPULAR_CITIES, searchCities, nearestCity, type City } from '@/lib/cities'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'
import { useEscape } from '@/lib/useEscape'

/** Пикер города: полноэкранный оверлей с автопоиском. Используется в квизе, настройках, кабинете подрядчика. */
export function CityPicker({ onPick, onClose }: { onPick: (c: City) => void; onClose: () => void }) {
  useEscape(onClose)
  const [q, setQ] = useState('')
  const [geo, setGeo] = useState<'idle' | 'loading' | 'error'>('idle')
  const results = searchCities(q)
  const bashkir = POPULAR_CITIES.filter(c => c.r === 'Башкортостан')
  const russia = POPULAR_CITIES.filter(c => c.r !== 'Башкортостан').slice(0, 10)

  const locate = () => {
    if (!('geolocation' in navigator)) { setGeo('error'); return }
    setGeo('loading')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = nearestCity(pos.coords.latitude, pos.coords.longitude)
        if (c) onPick(c)
        else setGeo('error')
      },
      () => setGeo('error'),
      { timeout: 8000 },
    )
  }

  const Row = ({ c }: { c: City }) => (
    <button onClick={() => onPick(c)} className="press w-full flex items-center gap-3 px-5 py-3 text-left border-b border-[#F3ECE5] last:border-0">
      <MapPin size={15} className="text-[var(--rose-deep)] shrink-0" />
      <div className="flex-1 min-w-0">
        <b className="text-[13.5px]">{c.n}</b>
        <p className="text-[10.5px] text-[var(--soft)] truncate">{c.d ? `${c.d} · ` : ''}{c.r}</p>
      </div>
      <ChevronRight size={14} className="text-[var(--line)] shrink-0" />
    </button>
  )

  return (
    <div role="dialog" aria-modal="true" aria-label={t('Выбор города')} className="fixed inset-0 z-50 bg-[var(--bg)] flex flex-col app-shell !relative" style={{ margin: '0 auto' }}>
      <div className="px-5 pt-6 pb-3 flex items-center gap-3">
        <div className="flex-1 flex items-center gap-2.5 bg-[var(--card)] rounded-full px-4 h-12" style={{ boxShadow: 'var(--shadow)' }}>
          <Search size={15} className="text-[var(--soft2)]" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('Начните вводить: Сибай, Баймак…')} className="flex-1 bg-transparent text-[13.5px] outline-none" />
          {q && <button onClick={() => setQ('')} className="press text-[var(--soft2)]"><X size={15} /></button>}
        </div>
        <button onClick={onClose} className="press text-[12px] font-bold text-[var(--soft)]">{t('Отмена')}</button>
      </div>

      <button onClick={locate} disabled={geo === 'loading'} className="press mx-5 mb-3 flex items-center gap-2.5 text-[12px] font-bold text-[var(--sage-deep)] px-1">
        <Navigation size={13} className={geo === 'loading' ? 'animate-pulse' : ''} />
        {geo === 'loading' ? t('Определяем…') : geo === 'error' ? t('Не получилось — введите вручную') : t('Определить автоматически')}
      </button>

      <div className="flex-1 overflow-y-auto no-scrollbar pb-8">
        {q.length >= 2 ? (
          results.length ? (
            <div className="card mx-5 overflow-hidden !p-0 stagger">
              {results.map(c => <Row key={c.n + c.d} c={c} />)}
            </div>
          ) : (
            <div className="text-center pt-16 px-8">
              <span className="text-[34px]">🗺</span>
              <p className="font-serif-d text-[17px] mt-2">{t('Такого города пока нет')}</p>
              <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Проверьте написание — или выберите ближайший райцентр, гости всё равно увидят точный адрес в приглашении')}</p>
            </div>
          )
        ) : (
          <>
            <p className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-6 mb-2">{t('Башкортостан')}</p>
            <div className="card mx-5 overflow-hidden !p-0 mb-4">{bashkir.map(c => <Row key={c.n} c={c} />)}</div>
            <p className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-6 mb-2">{t('Популярные')}</p>
            <div className="flex flex-wrap gap-2 px-5">
              {russia.map(c => (
                <button key={c.n} onClick={() => onPick(c)} className={cn('press px-3.5 py-2 rounded-full bg-[var(--card)] text-[11.5px] font-semibold text-[var(--ink2)]')} style={{ boxShadow: 'var(--shadow)' }}>{c.n}</button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--soft2)] px-6 mt-5 leading-relaxed">{t('В базе')}  {t('все райцентры Башкортостана и соседних регионов. Не нашли свой — напишите в поддержку, добавим за день.')}</p>
          </>
        )}
      </div>
    </div>
  )
}
