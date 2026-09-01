import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Heart, MapPin, Users, Wallet, ChevronRight, Navigation } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/data'

/* «Вдохновение» — реальные свадьбы пар региона (контент для виральности и SEO) */
export function Inspiration() {
  const nav = useNavigate()
  const [style, setStyle] = useState('all')
  const [liked, setLiked] = usePersist<string[]>('tt_inspo_likes', [])
  const stories = [
    { id: 'w1', pair: 'Дина и Руслан', style: 'boho', styleName: '🌾 Бохо', place: 'Шатёр у реки · Стерлитамак', guests: 60, budget: 950000, photo: '🌾', tip: 'Сэкономили на площадке — вложились в декор и живую музыку', grad: 'from-[#A9BCA0] to-[#7E9A74]' },
    { id: 'w2', pair: 'Регина и Артур', style: 'classic', styleName: '🤍 Классика', place: 'Банкетный зал «Маркони» · Уфа', guests: 120, budget: 1800000, photo: '🤍', tip: 'Первый танец с дымом — гости до сих пор вспоминают', grad: 'from-[#D9A8A0] to-[#C98A8A]' },
    { id: 'w3', pair: 'Алсу и Марат', style: 'minimal', styleName: '◻️ Минимализм', place: 'Лофт «Этажи» · Уфа', guests: 40, budget: 620000, photo: '◻️', tip: 'Камерный формат: только самые близкие, ноль лишнего', grad: 'from-[#BFB5AA] to-[#93897F]' },
    { id: 'w4', pair: 'Гузель и Ильяс', style: 'boho', styleName: '🌿 Рустик', place: 'База отдыха · Караидельский район', guests: 80, budget: 780000, photo: '🌿', tip: 'Выездная церемония на закате — фото получились космос', grad: 'from-[#7E9A74] to-[#5C554B]' },
  ]
  const shown = style === 'all' ? stories : stories.filter(s => s.style === style)
  return (
    <div className="pb-28">
      <TopBar back title="Вдохновение" sub="Реальные свадьбы пар Башкортостана" />
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {[['all', 'Все'], ['classic', '🤍 Классика'], ['boho', '🌾 Бохо'], ['minimal', '◻️ Минимализм']].map(([id, l]) => (
          <button key={id} onClick={() => setStyle(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', style === id ? 'grad text-white' : 'bg-white text-[#93897F]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 mt-4 space-y-4 stagger">
        {shown.map(s => (
          <div key={s.id} className="card overflow-hidden fade-up !p-0">
            <div className={cn('h-36 bg-gradient-to-br flex items-center justify-center text-[54px]', s.grad)}>{s.photo}</div>
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <b className="font-serif-d text-[17px]">{s.pair}</b>
                  <p className="text-[10.5px] text-[#93897F] mt-0.5 flex items-center gap-1"><MapPin size={10} /> {s.place}</p>
                </div>
                <button onClick={() => setLiked(l => l.includes(s.id) ? l.filter(x => x !== s.id) : [...l, s.id])} className="press w-9 h-9 rounded-full bg-[#FBF6F1] flex items-center justify-center" aria-label="Нравится">
                  <Heart size={15} className={liked.includes(s.id) ? 'text-[#C98A8A] fill-[#C98A8A]' : 'text-[#BFB5AA]'} />
                </button>
              </div>
              <div className="flex gap-2 mt-3">
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[#FBF6F1] flex items-center gap-1"><Users size={10} /> {s.guests} гостей</span>
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[#FBF6F1] flex items-center gap-1"><Wallet size={10} /> {fmt(s.budget)}</span>
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[#FBF6F1]">{s.styleName}</span>
              </div>
              <p className="text-[11.5px] text-[#5C554B] mt-3 leading-relaxed font-light">💡 {s.tip}</p>
              <button onClick={() => nav('/search/venue')} className="press mt-3 text-[11px] font-bold text-[#B57171] flex items-center gap-1">Найти похожую площадку <ChevronRight size={12} /></button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-center text-[10px] text-[#BFB5AA] mt-6 px-8 leading-relaxed">Истории публикуются с согласия пар. После свадьбы мы предложим рассказать вашу ✨</p>
    </div>
  )
}

/* Карта площадок: Яндекс-виджет (без API-ключа) + карточки с маршрутом */
export function VenuesMap() {
  const { city } = useStore()
  const venues = [
    { n: 'Усадьба «Липовый сад»', d: 'загородная · до 150 гостей', p: 250000, ll: '54.8690,55.9210', tile: 'bg-[#F0DCB8]', icon: '🏛' },
    { n: 'Банкетный зал «Маркони»', d: 'город · до 200 гостей', p: 180000, ll: '54.7355,55.9919', tile: 'bg-[#F2DFDC]', icon: '🥂' },
    { n: 'Шатёр «Речной берег»', d: 'у воды · до 80 гостей', p: 120000, ll: '54.7100,55.8500', tile: 'bg-[#E6EEE2]', icon: '⛺' },
    { n: 'Лофт «Этажи»', d: 'индустриальный · до 60 гостей', p: 90000, ll: '54.7500,56.0100', tile: 'bg-[#D9CCE3]', icon: '🏙' },
  ]
  return (
    <div className="pb-28">
      <TopBar back title="Площадки на карте" sub={`${city} и окрестности`} />
      <div className="px-5 mt-3">
        <div className="card overflow-hidden !p-0">
          <iframe
            title="Карта площадок"
            src={`https://yandex.ru/map-widget/v1/?ll=${city === 'Уфа' ? '55.9711%2C54.7388' : '58.6658%2C52.7181'}&z=10&pt=${venues.map(v => `${v.ll.split(',').reverse().join(',')},pm2rdm`).join('~')}`}
            className="w-full h-[300px] border-0"
            loading="lazy"
          />
        </div>
        <p className="text-[10px] text-[#BFB5AA] mt-2 px-1">Точки приблизительные в моке; точные адреса — после подключения Яндекс Геокодера.</p>
        <div className="space-y-2.5 mt-3.5 stagger">
          {venues.map(v => (
            <div key={v.n} className="card-s p-4 flex items-center gap-3 fade-up">
              <Tile icon={v.icon} tile={v.tile} size={44} />
              <div className="flex-1 min-w-0">
                <b className="text-[13px] block truncate">{v.n}</b>
                <span className="text-[10px] text-[#93897F]">{v.d} · от {fmt(v.p)}</span>
              </div>
              <a href={`https://yandex.ru/maps/?rtext=~${v.ll}`} target="_blank" rel="noreferrer" className="press w-10 h-10 rounded-full grad text-white flex items-center justify-center shrink-0" aria-label="Маршрут"><Navigation size={15} /></a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
