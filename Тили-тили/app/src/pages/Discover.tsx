import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Heart, MapPin, Users, Wallet, ChevronRight, Navigation } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/data'
import { t } from '@/lib/i18n'
import { useEscape } from '@/lib/useEscape'

/* «Вдохновение» — реальные свадьбы пар региона (контент для виральности и SEO) */
type Story = { id: string; pair: string; style: string; styleName: string; place: string; guests: number; budget: number; photo: string; tip: string; grad: string; split: [string, number][]; season: string }
const STORIES: Story[] = [
  { id: 'w1', pair: t('Дина и Руслан'), style: 'boho', styleName: t('🌾 Бохо'), place: t('Шатёр у реки · Стерлитамак'), guests: 60, budget: 950000, photo: '🌾', season: t('Август 2025'), tip: t('Сэкономили на площадке — вложились в декор и живую музыку'), grad: 'from-[#A9BCA0] to-[#7E9A74]', split: [[t('Площадка и кейтеринг'), 42], [t('Декор и флористика'), 18], [t('Фото и видео'), 16], [t('Музыка и ведущий'), 12], [t('Образы и детали'), 12]] },
  { id: 'w2', pair: t('Регина и Артур'), style: 'classic', styleName: t('🤍 Классика'), place: t('Банкетный зал «Маркони» · Уфа'), guests: 120, budget: 1800000, photo: '🤍', season: t('Июнь 2025'), tip: t('Первый танец с дымом — гости до сих пор вспоминают'), grad: 'from-[#D9A8A0] to-[#C98A8A]', split: [[t('Площадка и кейтеринг'), 50], [t('Декор и флористика'), 14], [t('Фото и видео'), 12], [t('Музыка и ведущий'), 12], [t('Образы и детали'), 12]] },
  { id: 'w3', pair: t('Алсу и Марат'), style: 'minimal', styleName: t('◻️ Минимализм'), place: t('Лофт «Этажи» · Уфа'), guests: 40, budget: 620000, photo: '◻️', season: t('Сентябрь 2025'), tip: t('Камерный формат: только самые близкие, ноль лишнего'), grad: 'from-[var(--soft2)] to-[var(--soft)]', split: [[t('Площадка и кейтеринг'), 45], [t('Декор и флористика'), 10], [t('Фото и видео'), 20], [t('Музыка и ведущий'), 10], [t('Образы и детали'), 15]] },
  { id: 'w4', pair: t('Гузель и Ильяс'), style: 'boho', styleName: t('🌿 Рустик'), place: t('База отдыха · Караидельский район'), guests: 80, budget: 780000, photo: '🌿', season: t('Июль 2025'), tip: t('Выездная церемония на закате — фото получились космос'), grad: 'from-[#7E9A74] to-[var(--ink2)]', split: [[t('Площадка и кейтеринг'), 38], [t('Декор и флористика'), 22], [t('Фото и видео'), 15], [t('Музыка и ведущий'), 13], [t('Образы и детали'), 12]] },
  { id: 'w5', pair: t('Лейсан и Тимур'), style: 'classic', styleName: t('🏛 Палаты'), place: t('Ресторан «Белая речка» · Сибай'), guests: 90, budget: 1150000, photo: '🏛', season: t('Май 2026'), tip: t('Национальные мотивы в декоре — бабушки плакали от счастья'), grad: 'from-[#C9A96A] to-[#B57171]', split: [[t('Площадка и кейтеринг'), 48], [t('Декор и флористика'), 16], [t('Фото и видео'), 13], [t('Музыка и ведущий'), 12], [t('Образы и детали'), 11]] },
  { id: 'w6', pair: t('Влада и Егор'), style: 'minimal', styleName: t('🌆 Урбан'), place: t('Смотровая площадка · Баймак'), guests: 30, budget: 480000, photo: '🌆', season: t('Август 2026'), tip: t('Церемония на рассвете над степью — 30 гостей и ни одного лишнего'), grad: 'from-[var(--blue)] to-[var(--soft)]', split: [[t('Площадка и кейтеринг'), 35], [t('Декор и флористика'), 8], [t('Фото и видео'), 25], [t('Музыка и ведущий'), 12], [t('Образы и детали'), 20]] },
  { id: 'w7', pair: t('Айгуль и Данис'), style: 'boho', styleName: t('🍇 Усадьба'), place: t('Усадьба «Липовый сад» · Уфа'), guests: 150, budget: 2400000, photo: '🍇', season: t('Июнь 2026'), tip: t('Два дня праздника: первый — семья, второй — друзья'), grad: 'from-[var(--lav)] to-[#B57171]', split: [[t('Площадка и кейтеринг'), 52], [t('Декор и флористика'), 15], [t('Фото и видео'), 12], [t('Музыка и ведущий'), 11], [t('Образы и детали'), 10]] },
  { id: 'w8', pair: t('Камилла и Арслан'), style: 'classic', styleName: t('🕯 Вечерняя'), place: t('Шатёр «Речной берег» · Уфа'), guests: 70, budget: 890000, photo: '🕯', season: t('Сентябрь 2026'), tip: t('Свадьба при свечах после заката — без единого прожектора'), grad: 'from-[var(--ink2)] to-[var(--ink)]', split: [[t('Площадка и кейтеринг'), 44], [t('Декор и флористика'), 20], [t('Фото и видео'), 14], [t('Музыка и ведущий'), 12], [t('Образы и детали'), 10]] },
]

export function Inspiration() {
  const nav = useNavigate()
  const [style, setStyle] = useState('all')
  const [budget, setBudget] = useState('all')
  const [open, setOpen] = useState<Story | null>(null)
  useEscape(() => setOpen(null), open !== null)
  const [liked, setLiked] = usePersist<string[]>('tt_inspo_likes', [])
  const budgetOk = (b: number) => budget === 'all' || (budget === 'low' && b <= 700000) || (budget === 'mid' && b > 700000 && b <= 1200000) || (budget === 'high' && b > 1200000)
  const shown = STORIES.filter(s => (style === 'all' || s.style === style) && budgetOk(s.budget))
  return (
    <div className="pb-28">
      <TopBar back title={t('Вдохновение')} sub={t('Реальные свадьбы пар Башкортостана')} />
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {[['all', t('Все стили')], ['classic', t('🤍 Классика')], ['boho', t('🌾 Бохо')], ['minimal', t('◻️ Минимализм')]].map(([id, l]) => (
          <button key={id} onClick={() => setStyle(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', style === id ? 'grad text-white' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 flex gap-2 mt-2.5 overflow-x-auto no-scrollbar">
        {[['all', t('Любой бюджет')], ['low', t('до 700 тыс')], ['mid', t('700 тыс – 1,2 млн')], ['high', t('1,2 млн+')]].map(([id, l]) => (
          <button key={id} onClick={() => setBudget(id)} className={cn('press px-4 py-2 rounded-full text-[10.5px] font-semibold whitespace-nowrap border', budget === id ? 'border-[#C98A8A] text-[var(--rose-deep)] bg-[var(--rose-soft)]/50' : 'border-transparent bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <p className="px-6 mt-3 text-[10.5px] text-[var(--soft2)]">{t('Найдено историй:')}{shown.length}</p>
      <div className="px-5 mt-2 space-y-4 stagger">
        {shown.map(s => (
          <div key={s.id} className="card overflow-hidden fade-up !p-0">
            <button className="w-full text-left" onClick={() => setOpen(s)}>
              <div className={cn('h-36 bg-gradient-to-br flex items-center justify-center text-[54px] relative', s.grad)}>
                {s.photo}
                <span className="absolute bottom-2.5 right-3 text-[9px] font-bold px-2.5 py-1 rounded-full bg-black/30 text-white backdrop-blur-sm">{s.season}</span>
              </div>
            </button>
            <div className="p-4">
              <div className="flex items-start justify-between">
                <button className="text-left" onClick={() => setOpen(s)}>
                  <b className="font-serif-d text-[17px]">{s.pair}</b>
                  <p className="text-[10.5px] text-[var(--soft)] mt-0.5 flex items-center gap-1"><MapPin size={10} /> {s.place}</p>
                </button>
                <button onClick={() => setLiked(l => l.includes(s.id) ? l.filter(x => x !== s.id) : [...l, s.id])} className="press w-9 h-9 rounded-full bg-[var(--bg)] flex items-center justify-center" aria-label={t('Нравится')}>
                  <Heart size={15} className={liked.includes(s.id) ? 'text-[var(--rose-deep)] fill-[#C98A8A]' : 'text-[var(--soft2)]'} />
                </button>
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--bg)] flex items-center gap-1"><Users size={10} /> {s.guests} {t('гостей')}</span>
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--bg)] flex items-center gap-1"><Wallet size={10} /> {fmt(s.budget)}</span>
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--bg)]">{s.styleName}</span>
              </div>
              <p className="text-[11.5px] text-[var(--ink2)] mt-3 leading-relaxed font-light">💡 {s.tip}</p>
              <div className="flex items-center justify-between mt-3">
                <button onClick={() => setOpen(s)} className="press text-[11px] font-bold text-[var(--ink)] flex items-center gap-1">{t('Разбор бюджета')}<ChevronRight size={12} /></button>
                <button onClick={() => nav('/search/venue')} className="press text-[11px] font-bold text-[var(--rose-deep)] flex items-center gap-1">{t('Похожая площадка')}<ChevronRight size={12} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-center text-[10px] text-[var(--soft2)] mt-6 px-8 leading-relaxed">{t('Истории публикуются с согласия пар. После свадьбы мы предложим рассказать вашу ✨')}</p>

      {/* Детальный разбор истории — bottom sheet */}
      {open && (
        <div role="dialog" aria-modal="true" aria-label={t('Разбор свадьбы')} className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setOpen(null)}>
          <div className="absolute inset-0 bg-[var(--ink)]/45 backdrop-blur-sm fade-in" />
          <div className="relative w-full max-w-[430px] bg-[var(--bg)] rounded-t-[28px] p-6 pb-10 pop max-h-[85dvh] overflow-y-auto no-scrollbar" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full bg-[var(--line)] mx-auto mb-4" />
            <div className={cn('h-28 rounded-[20px] bg-gradient-to-br flex items-center justify-center text-[46px]', open.grad)}>{open.photo}</div>
            <b className="font-serif-d text-[20px] block mt-3">{open.pair}</b>
            <p className="text-[11px] text-[var(--soft)] mt-0.5">{open.place} · {open.season}</p>
            <div className="flex gap-2 mt-3">
              <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)]"><Users size={10} className="inline" /> {open.guests}</span>
              <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)]"><Wallet size={10} className="inline" /> {fmt(open.budget)}</span>
              <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)]">{open.styleName}</span>
            </div>
            <h3 className="font-serif-d text-[15px] mt-5 mb-3">{t('Куда ушёл бюджет')}</h3>
            {open.split.map(([label, pct]) => (
              <div key={label} className="mb-2.5">
                <div className="flex justify-between text-[11px] mb-1"><span className="text-[var(--ink2)]">{label}</span><b className="tabular">{pct}% · {fmt(Math.round(open.budget * pct / 100))}</b></div>
                <div className="h-1.5 rounded-full bg-[var(--track)] overflow-hidden"><div className="h-full rounded-full grad" style={{ width: `${pct}%` }} /></div>
              </div>
            ))}
            <p className="text-[11.5px] text-[var(--ink2)] mt-4 leading-relaxed font-light">💡 {open.tip}</p>
            <button onClick={() => nav('/search')} className="press sheen w-full mt-5 py-4 rounded-full grad text-white font-semibold text-[13px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Собрать такую же команду ✨')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* Карта площадок: Яндекс-виджет (без API-ключа) + карточки с маршрутом */
export function VenuesMap() {
  const { city } = useStore()
  const venues = [
    { n: t('Усадьба «Липовый сад»'), d: t('загородная · до 150 гостей'), p: 250000, ll: '54.8690,55.9210', tile: 'bg-[var(--honey)]', icon: '🏛' },
    { n: t('Банкетный зал «Маркони»'), d: t('город · до 200 гостей'), p: 180000, ll: '54.7355,55.9919', tile: 'bg-[var(--rose-soft)]', icon: '🥂' },
    { n: t('Шатёр «Речной берег»'), d: t('у воды · до 80 гостей'), p: 120000, ll: '54.7100,55.8500', tile: 'bg-[var(--sage-soft)]', icon: '⛺' },
    { n: t('Лофт «Этажи»'), d: t('индустриальный · до 60 гостей'), p: 90000, ll: '54.7500,56.0100', tile: 'bg-[var(--lav)]', icon: '🏙' },
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Площадки на карте')} sub={`${city}${t(' и окрестности')}`} />
      <div className="px-5 mt-3">
        <div className="card overflow-hidden !p-0">
          <iframe
            title={t('Карта площадок')}
            src={`https://yandex.ru/map-widget/v1/?ll=${city === 'Уфа' ? '55.9711%2C54.7388' : '58.6658%2C52.7181'}&z=10&pt=${venues.map(v => `${v.ll.split(',').reverse().join(',')},pm2rdm`).join('~')}`}
            className="w-full h-[300px] border-0"
            loading="lazy"
          />
        </div>
        <p className="text-[10px] text-[var(--soft2)] mt-2 px-1">{t('Точки приблизительные в моке; точные адреса — после подключения Яндекс Геокодера.')}</p>
        <div className="space-y-2.5 mt-3.5 stagger">
          {venues.map(v => (
            <div key={v.n} className="card-s p-4 flex items-center gap-3 fade-up">
              <Tile icon={v.icon} tile={v.tile} size={44} />
              <div className="flex-1 min-w-0">
                <b className="text-[13px] block truncate">{v.n}</b>
                <span className="text-[10px] text-[var(--soft)]">{v.d} · от {fmt(v.p)}</span>
              </div>
              <a href={`https://yandex.ru/maps/?rtext=~${v.ll}`} target="_blank" rel="noreferrer" className="press w-10 h-10 rounded-full grad text-white flex items-center justify-center shrink-0" aria-label={t('Маршрут')}><Navigation size={15} /></a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
