import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Heart, MapPin, Users, Wallet, ChevronRight, Navigation } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { getInspoLikes, getVendors, likeStory, unlikeStory } from '@/lib/api/catalog'
import { AsyncState, ready } from '@/components/AsyncState'
import { isAuthorized } from '@/lib/api/client'
import { useApi } from '@/lib/api/useApi'
import { cn } from '@/lib/utils'
import { fmt, rub } from '@/lib/money'
import { t, key } from '@/lib/i18n'
import { useEscape } from '@/lib/useEscape'

/*
 * «Вдохновение» — подборка сценариев свадеб региона.
 *
 * Истории живут во фронте намеренно: контракт говорит это прямо — на сервере
 * только идентификаторы отмеченных (`/inspiration/likes`). Это контент, а не
 * данные пары.
 *
 * Подписи «реальные свадьбы пар Башкортостана» здесь больше нет: пары и суммы
 * собраны редакцией как примеры, а выдавать их за конкретные чужие свадьбы
 * значит врать читателю. Заменить на настоящие истории — задача владельца,
 * она в списке блокеров.
 */
/*
 * `budget` — в копейках, как все деньги в коде (`money.ts`): литерал в рублях
 * оборачивается в `rub()`. До этого суммы стояли рублями, а печатались через
 * `fmt()` как копейки — «9 500 ₽» вместо «950 000 ₽», и разбор «Куда ушёл
 * бюджет» делил сумму в сто раз меньше настоящей (ревью D5-07).
 */
type Story = { id: string; pair: string; style: string; styleName: string; place: string; guests: number; budget: number; photo: string; tip: string; grad: string; split: [string, number][]; season: string }
const STORIES: Story[] = [
  { id: 'w1', pair: key('Дина и Руслан'), style: 'boho', styleName: key('🌾 Бохо'), place: key('Шатёр у реки · Стерлитамак'), guests: 60, budget: rub(950000), photo: '🌾', season: key('Август 2025'), tip: key('Сэкономили на площадке — вложились в декор и живую музыку'), grad: 'from-[#A9BCA0] to-[#7E9A74]', split: [[key('Площадка и кейтеринг'), 42], [key('Декор и флористика'), 18], [key('Фото и видео'), 16], [key('Музыка и ведущий'), 12], [key('Образы и детали'), 12]] },
  { id: 'w2', pair: key('Регина и Артур'), style: 'classic', styleName: key('🤍 Классика'), place: key('Банкетный зал «Маркони» · Уфа'), guests: 120, budget: rub(1800000), photo: '🤍', season: key('Июнь 2025'), tip: key('Первый танец с дымом — гости до сих пор вспоминают'), grad: 'from-[#D9A8A0] to-[#C98A8A]', split: [[key('Площадка и кейтеринг'), 50], [key('Декор и флористика'), 14], [key('Фото и видео'), 12], [key('Музыка и ведущий'), 12], [key('Образы и детали'), 12]] },
  { id: 'w3', pair: key('Алсу и Марат'), style: 'minimal', styleName: key('◻️ Минимализм'), place: key('Лофт «Этажи» · Уфа'), guests: 40, budget: rub(620000), photo: '◻️', season: key('Сентябрь 2025'), tip: key('Камерный формат: только самые близкие, ноль лишнего'), grad: 'from-[var(--soft2)] to-[var(--soft)]', split: [[key('Площадка и кейтеринг'), 45], [key('Декор и флористика'), 10], [key('Фото и видео'), 20], [key('Музыка и ведущий'), 10], [key('Образы и детали'), 15]] },
  { id: 'w4', pair: key('Гузель и Ильяс'), style: 'boho', styleName: key('🌿 Рустик'), place: key('База отдыха · Караидельский район'), guests: 80, budget: rub(780000), photo: '🌿', season: key('Июль 2025'), tip: key('Выездная церемония на закате — фото получились космос'), grad: 'from-[#7E9A74] to-[var(--ink2)]', split: [[key('Площадка и кейтеринг'), 38], [key('Декор и флористика'), 22], [key('Фото и видео'), 15], [key('Музыка и ведущий'), 13], [key('Образы и детали'), 12]] },
  { id: 'w5', pair: key('Лейсан и Тимур'), style: 'classic', styleName: key('🏛 Палаты'), place: key('Ресторан «Белая речка» · Сибай'), guests: 90, budget: rub(1150000), photo: '🏛', season: key('Май 2026'), tip: key('Национальные мотивы в декоре — бабушки плакали от счастья'), grad: 'from-[#C9A96A] to-[#B57171]', split: [[key('Площадка и кейтеринг'), 48], [key('Декор и флористика'), 16], [key('Фото и видео'), 13], [key('Музыка и ведущий'), 12], [key('Образы и детали'), 11]] },
  { id: 'w6', pair: key('Влада и Егор'), style: 'minimal', styleName: key('🌆 Урбан'), place: key('Смотровая площадка · Баймак'), guests: 30, budget: rub(480000), photo: '🌆', season: key('Август 2026'), tip: key('Церемония на рассвете над степью — 30 гостей и ни одного лишнего'), grad: 'from-[var(--blue)] to-[var(--soft)]', split: [[key('Площадка и кейтеринг'), 35], [key('Декор и флористика'), 8], [key('Фото и видео'), 25], [key('Музыка и ведущий'), 12], [key('Образы и детали'), 20]] },
  { id: 'w7', pair: key('Айгуль и Данис'), style: 'boho', styleName: key('🍇 Усадьба'), place: key('Усадьба «Липовый сад» · Уфа'), guests: 150, budget: rub(2400000), photo: '🍇', season: key('Июнь 2026'), tip: key('Два дня праздника: первый — семья, второй — друзья'), grad: 'from-[var(--lav)] to-[#B57171]', split: [[key('Площадка и кейтеринг'), 52], [key('Декор и флористика'), 15], [key('Фото и видео'), 12], [key('Музыка и ведущий'), 11], [key('Образы и детали'), 10]] },
  { id: 'w8', pair: key('Камилла и Арслан'), style: 'classic', styleName: key('🕯 Вечерняя'), place: key('Шатёр «Речной берег» · Уфа'), guests: 70, budget: rub(890000), photo: '🕯', season: key('Сентябрь 2026'), tip: key('Свадьба при свечах после заката — без единого прожектора'), grad: 'from-[var(--ink2)] to-[var(--ink)]', split: [[key('Площадка и кейтеринг'), 44], [key('Декор и флористика'), 20], [key('Фото и видео'), 14], [key('Музыка и ведущий'), 12], [key('Образы и детали'), 10]] },
]

export function Inspiration() {
  const nav = useNavigate()
  const [style, setStyle] = useState('all')
  const [budget, setBudget] = useState('all')
  const [open, setOpen] = useState<Story | null>(null)
  useEscape(() => setOpen(null), open !== null)
  /*
   * Отметки — аккаунта, а не браузера. Раньше они лежали в `tt_inspo_likes`:
   * на втором устройстве сердечки были пустые, а смена телефона стирала их.
   */
  const likes = useApi(() => isAuthorized() ? getInspoLikes() : Promise.resolve({ storyIds: [] }), [])
  /* Ответ сервера — источник правды, поверх него лежат отметки этого сеанса:
     сердечко должно отзываться сразу, а не через круг до сервера. Отказ
     снимает наложение, и экран снова показывает то, что есть на сервере. */
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const liked = (id: string) => touched[id] ?? (likes.data?.storyIds ?? []).includes(id)

  const toggleLike = (id: string) => {
    const next = !liked(id)
    setTouched(m => ({ ...m, [id]: next }))
    if (!isAuthorized()) return
    void (next ? likeStory(id) : unlikeStory(id)).catch(() => {
      setTouched(m => { const rest = { ...m }; delete rest[id]; return rest })
    })
  }
  const budgetOk = (b: number) => budget === 'all' || (budget === 'low' && b <= rub(700_000)) || (budget === 'mid' && b > rub(700_000) && b <= rub(1_200_000)) || (budget === 'high' && b > rub(1_200_000))
  const shown = STORIES.filter(s => (style === 'all' || s.style === style) && budgetOk(s.budget))
  return (
    <div className="pb-28">
      <TopBar back title={t('Вдохновение')} sub={t('Сценарии свадеб региона: стили, бюджеты и на чём экономят')} />
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {[['all', t('Все стили')], ['classic', t('🤍 Классика')], ['boho', t('🌾 Бохо')], ['minimal', t('◻️ Минимализм')]].map(([id, l]) => (
          <button key={id} onClick={() => setStyle(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', style === id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 flex gap-2 mt-2.5 overflow-x-auto no-scrollbar">
        {[['all', t('Любой бюджет')], ['low', t('до 700 тыс')], ['mid', t('700 тыс – 1,2 млн')], ['high', t('1,2 млн+')]].map(([id, l]) => (
          <button key={id} onClick={() => setBudget(id)} className={cn('press px-4 py-2 rounded-full text-[10.5px] font-semibold whitespace-nowrap border', budget === id ? 'border-[#C98A8A] text-[var(--rose-ink)] bg-[var(--rose-soft)]/50' : 'border-transparent bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <p className="px-6 mt-3 text-[10.5px] text-[var(--soft2)]">{t('Найдено историй:')}{shown.length}</p>
      {/* Отметки — с сервера; отказ на них раньше выглядел как «ничего не
          отмечено». */}
      {likes.error && <p role="alert" className="px-6 mt-1 text-[10.5px] text-[var(--rose-ink)]">{t('Отметки «нравится» не загрузились:')} {likes.error}</p>}
      <div className="px-5 mt-2 space-y-4 stagger">
        {shown.map(s => (
          <div key={s.id} className="card overflow-hidden fade-up !p-0">
            <button className="w-full text-left" onClick={() => setOpen(s)}>
              <div className={cn('h-36 bg-gradient-to-br flex items-center justify-center text-[54px] relative', s.grad)}>
                {s.photo}
                <span className="absolute bottom-2.5 right-3 text-[9px] font-bold px-2.5 py-1 rounded-full bg-black/30 text-white backdrop-blur-sm">{t(s.season)}</span>
              </div>
            </button>
            <div className="p-4">
              <div className="flex items-start justify-between">
                <button className="text-left" onClick={() => setOpen(s)}>
                  <b className="font-serif-d text-[17px]">{t(s.pair)}</b>
                  <p className="text-[10.5px] text-[var(--soft)] mt-0.5 flex items-center gap-1"><MapPin size={10} /> {t(s.place)}</p>
                </button>
                <button onClick={() => toggleLike(s.id)} className="press w-9 h-9 rounded-full bg-[var(--bg)] flex items-center justify-center" aria-label={t('Нравится')}>
                  <Heart size={15} className={liked(s.id) ? 'text-[var(--rose-deep)] fill-[#C98A8A]' : 'text-[var(--soft2)]'} />
                </button>
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--bg)] flex items-center gap-1"><Users size={10} /> {s.guests} {t('гостей')}</span>
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--bg)] flex items-center gap-1"><Wallet size={10} /> {fmt(s.budget)}</span>
                <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--bg)]">{t(s.styleName)}</span>
              </div>
              <p className="text-[11.5px] text-[var(--ink2)] mt-3 leading-relaxed font-light">💡 {t(s.tip)}</p>
              <div className="flex items-center justify-between mt-3">
                <button onClick={() => setOpen(s)} className="press text-[11px] font-bold text-[var(--ink)] flex items-center gap-1">{t('Разбор бюджета')}<ChevronRight size={12} /></button>
                <button onClick={() => nav('/search/venue')} className="press text-[11px] font-bold text-[var(--rose-deep)] flex items-center gap-1">{t('Похожая площадка')}<ChevronRight size={12} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* Истории — примеры редакции, не реальные пары: подпись «публикуются с
          согласия пар» обещала согласие людей, которых не существует.
          Настоящие истории — задача владельца (RELEASE-BLOCKERS). */}
      <p className="text-center text-[10px] text-[var(--soft2)] mt-6 px-8 leading-relaxed">{t('Истории собраны редакцией как примеры: имена и суммы — иллюстрация, а не реальные свадьбы.')}</p>

      {/* Детальный разбор истории — bottom sheet */}
      {open && (
        <div role="dialog" aria-modal="true" aria-label={t('Разбор свадьбы')} className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setOpen(null)}>
          <div className="absolute inset-0 bg-[var(--ink)]/45 backdrop-blur-sm fade-in" />
          <div className="relative w-full max-w-[430px] bg-[var(--bg)] rounded-t-[28px] p-6 pb-10 pop max-h-[85dvh] overflow-y-auto no-scrollbar" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full bg-[var(--line)] mx-auto mb-4" />
            <div className={cn('h-28 rounded-[20px] bg-gradient-to-br flex items-center justify-center text-[46px]', open.grad)}>{open.photo}</div>
            <b className="font-serif-d text-[20px] block mt-3">{t(open.pair)}</b>
            <p className="text-[11px] text-[var(--soft)] mt-0.5">{t(open.place)} · {t(open.season)}</p>
            <div className="flex gap-2 mt-3">
              <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)]"><Users size={10} className="inline" /> {open.guests}</span>
              <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)]"><Wallet size={10} className="inline" /> {fmt(open.budget)}</span>
              <span className="text-[9.5px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)]">{t(open.styleName)}</span>
            </div>
            <h3 className="font-serif-d text-[15px] mt-5 mb-3">{t('Куда ушёл бюджет')}</h3>
            {open.split.map(([label, pct]) => (
              <div key={label} className="mb-2.5">
                <div className="flex justify-between text-[11px] mb-1"><span className="text-[var(--ink2)]">{t(label)}</span><b className="tabular">{pct}% · {fmt(Math.round(open.budget * pct / 100))}</b></div>
                <div className="h-1.5 rounded-full bg-[var(--track)] overflow-hidden"><div className="h-full rounded-full grad" style={{ width: `${pct}%` }} /></div>
              </div>
            ))}
            <p className="text-[11.5px] text-[var(--ink2)] mt-4 leading-relaxed font-light">💡 {t(open.tip)}</p>
            <button onClick={() => nav('/search')} className="press sheen w-full mt-5 py-4 rounded-full grad text-[var(--on-grad)] font-semibold text-[13px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Собрать такую же команду ✨')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/*
 * Площадки города.
 *
 * Экран был картой из четырёх выдуманных площадок с выдуманными координатами
 * и ценами: «Усадьба «Липовый сад» · 54.8690,55.9210 · от 250 000 ₽». Подпись
 * под картой признавалась сама: «Точки приблизительные в моке». Кнопка
 * «Маршрут» вела в Яндекс.Карты по этим же придуманным координатам — человек
 * поехал бы в поле.
 *
 * Координат в контракте нет вовсе (геокодер не подключён), поэтому карты
 * здесь больше нет: показываем настоящие площадки каталога своего города, а
 * «Найти на карте» ищет по названию, а не ставит точку, которой мы не знаем.
 */
export function VenuesMap() {
  const nav = useNavigate()
  const { city } = useStore()
  const q = useApi(() => getVendors({ categoryId: 'venue', city, limit: 20 }), [city])
  const venues = q.data?.items ?? []

  return (
    <div className="pb-28">
      <TopBar back title={t('Площадки')} sub={`${t(city)}${t(' и окрестности')}`} />
      <div className="px-5 mt-3">
        <AsyncState q={q} />
        {ready(q) && !venues.length && (
          <p className="text-[12px] text-[var(--soft)] py-8 text-center leading-relaxed">{t('В вашем городе площадок пока нет. Мы добавляем их постоянно.')}</p>
        )}
        <div className="space-y-2.5 stagger">
          {venues.map(v => (
            <div key={v.id} className="card-s p-4 flex items-center gap-3 fade-up">
              <button onClick={() => nav(`/vendor/${v.id}`)} className="press flex items-center gap-3 flex-1 min-w-0 text-left">
                <Tile icon="🏛" tile="bg-[var(--honey)]" size={44} />
                <span className="flex-1 min-w-0">
                  <b className="text-[13px] block truncate">{v.name}</b>
                  <span className="text-[10px] text-[var(--soft)]">
                    {v.priceFrom ? `${t('от')} ${fmt(v.priceFrom.amount ?? 0)}` : t('цена по запросу')}
                  </span>
                </span>
              </button>
              {/* Поиск по названию, а не маршрут к выдуманной точке. */}
              <a
                href={`https://yandex.ru/maps/?text=${encodeURIComponent(`${v.name} ${v.city ?? city}`)}`}
                target="_blank"
                rel="noreferrer"
                className="press w-10 h-10 rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0"
                aria-label={t('Найти на карте')}
              ><Navigation size={15} /></a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
