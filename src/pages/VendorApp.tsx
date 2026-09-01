import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Check, ChevronRight, Eye, MessageCircle, CalendarDays, TrendingUp, Plus, Star } from 'lucide-react'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { CityPicker } from '@/components/CityPicker'
import { usePersist } from '@/lib/usePersist'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* Кабинет подрядчика: дашборд */
export function VendorDashboard() {
  const nav = useNavigate()
  const [busyDays, setBusyDays] = usePersist<number[]>('tt_vendor_busy', [5, 6, 14, 26])
  const toggleDay = (day: number) => setBusyDays(d => d.includes(day) ? d.filter(x => x !== day) : [...d, day].sort((a, b) => a - b))
  return (
    <div className="pb-28">
      <TopBar title={t('Елена Смирнова')} sub={t('Фотограф · анкета заполнена на 90%')} right={
        <button onClick={() => nav('/vendor-app/profile')} className="press h-10 px-4 rounded-full grad text-white text-[11.5px] font-bold">{t('Анкета')}</button>
      } />
      <div className="px-5 mt-2">
        <div className="card p-4">
          <div className="flex justify-between text-[12px] mb-2"><span className="text-[var(--soft)]">{t('Заполненность анкеты')}</span><b>90%</b></div>
          <Bar pct={90} />
          <p className="text-[10.5px] text-[var(--soft)] mt-2.5">{t('Анкеты с видео получают в 3 раза больше откликов — добавьте видео-визитку.')}</p>
        </div>
        <div className="grid grid-cols-3 gap-2.5 mt-3.5 stagger">
          {[
            ['7', t('новых заявок'), MessageCircle, 'bg-[var(--rose-soft)]'],
            ['12', t('просмотров/день'), Eye, 'bg-[var(--sage-soft)]'],
            ['3', t('свадьбы в июне'), CalendarDays, 'bg-[var(--honey)]'],
          ].map(([v, l, Icon, tile]: any) => (
            <div key={l} className="card-s p-3.5 text-center fade-up">
              <div className={cn('w-9 h-9 rounded-[12px] mx-auto flex items-center justify-center', tile)}><Icon size={16} className="text-[var(--ink2)]" /></div>
              <b className="text-[19px] block mt-2 tabular">{v}</b>
              <span className="text-[9px] text-[var(--soft)]">{l}</span>
            </div>
          ))}
        </div>

        {/* Живые обновления от пар по забронированным свадьбам */}
        <div className="card p-4 mt-3.5">
          <div className="flex items-center gap-2.5">
            <span className="relative flex w-2.5 h-2.5 shrink-0">
              <span className="absolute inline-flex w-full h-full rounded-full bg-[#7E9A74] opacity-60 animate-ping" />
              <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-[#7E9A74]" />
            </span>
            <b className="text-[13px]">{t('Обновления от пар')}</b>
            <span className="ml-auto text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--sage-soft)] text-[#4C5B45]">{t('живая связь')}</span>
          </div>
          <div className="mt-3 space-y-2">
            {[
              [t('Алина & Тимур · 14.06'), t('Рассадка обновлена: стол 4, +2 гостя'), t('10 мин назад')],
              [t('Алина & Тимур · 14.06'), t('Меню: мясо 24 · рыба 11 · вег 4'), t('1 ч назад')],
              [t('Дина & Руслан · 21.06'), t('Тайминг сдвинут: банкет на 15 мин позже'), t('вчера')],
            ].map(([w, txt, when]) => (
              <div key={String(txt)} className="flex items-start gap-3 bg-[var(--bg)] rounded-xl px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[9.5px] font-bold text-[var(--soft2)] uppercase tracking-wide">{w}</p>
                  <p className="text-[11.5px] mt-0.5">{txt}</p>
                </div>
                <span className="text-[9px] text-[var(--soft2)] shrink-0 pt-0.5">{when}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[var(--soft2)] mt-2.5">{t('Вы видите изменения мгновенно — переспрашивать пару не нужно. Подтвердите получение одним тапом.')}</p>
        </div>

        {/* Рейтинг и отзывы */}
        <button onClick={() => nav('/vendor-app/reviews')} className="press w-full card p-4 mt-3.5 flex items-center gap-4 text-left">
          <div className="text-center">
            <b className="font-serif-d text-[30px] tabular">4.9</b>
            <p className="text-[9.5px] text-[#B98A2F]">★★★★★</p>
          </div>
          <div className="flex-1 space-y-1.5">
            {[['5', 90], ['4', 8], ['3', 2]].map(([s, p]) => (
              <div key={String(s)} className="flex items-center gap-2">
                <span className="text-[9.5px] text-[var(--soft)] w-2">{s}</span>
                <div className="flex-1 h-1.5 rounded-full bg-[var(--track)] overflow-hidden"><div className="h-full rounded-full bg-[var(--gold-soft)]" style={{ width: `${p}%` }} /></div>
                <span className="text-[9px] text-[var(--soft2)] w-7 text-right tabular">{p}%</span>
              </div>
            ))}
          </div>
          <span className="text-[9px] font-bold text-[#7E9A74] shrink-0">{t('Отзывы →')}</span>
        </button>

        {/* Аналитика */}
        <button onClick={() => nav('/vendor-app/analytics')} className="press w-full card-s p-4 mt-2.5 flex items-center gap-3 text-left">
          <Tile icon="📈" tile="bg-[var(--sage-soft)]" size={42} />
          <div className="flex-1">
            <b className="text-[13px]">{t('Аналитика анкеты')}</b>
            <p className="text-[10.5px] text-[var(--soft)]">{t('воронка: 1 240 просмотров → 34 заявки → 8 сделок')}</p>
          </div>
          <span className="text-[11px] font-bold text-[#7E9A74]">+38% ↑</span>
        </button>

        {/* Календарь июня */}
        <div className="card p-4 mt-3.5">
          <div className="flex justify-between items-baseline mb-2.5">
            <b className="text-[13px]">{t('Июнь 2027')}</b>
            <span className="text-[10px] text-[var(--soft)]">{t('занято')}{busyDays.length}{t('даты · нажмите на день')}</span>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 30 }).map((_, k) => {
              const day = k + 1
              const busy = busyDays.includes(day)
              return <button key={day} onClick={() => toggleDay(day)} className={cn('press aspect-square rounded-lg flex items-center justify-center text-[10px]', busy ? 'grad text-white font-bold' : 'bg-[var(--bg)] text-[var(--ink2)]')}>{day}</button>
            })}
          </div>
        </div>

        <div className="flex justify-between items-baseline px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">{t('Входящие заявки')}</h2>
          <span className="text-[10px] font-bold text-[#7E9A74] flex items-center gap-1"><TrendingUp size={11} />{t('+3 за неделю')}</span>
        </div>
        <div className="space-y-2.5 stagger">
          {[
            { id: 'ch1', n: t('Алина и Тимур'), d: t('14 июня 2027 · до 90 тыс ₽'), st: t('Новая'), hot: true },
            { id: 'ch2', n: t('Дина и Руслан'), d: t('5 сентября 2027 · пакет «Полный день»'), st: t('Hold 72 ч'), hot: false },
            { id: 'ch3', n: t('Анна и Марк'), d: t('18 июля 2027 · церемония'), st: t('Новая'), hot: true },
          ].map(r => (
            <button key={r.n} onClick={() => nav(`/vendor-app/leads/${r.id}`)} className="press w-full card-s p-4 flex items-center gap-3 text-left fade-up">
              <div className="w-11 h-11 rounded-full grad flex items-center justify-center text-white font-serif-d text-[15px] shrink-0">{r.n[0]}</div>
              <div className="flex-1 min-w-0">
                <b className="text-[13.5px]">{r.n}</b>
                <p className="text-[10.5px] text-[var(--soft)] mt-0.5">{r.d}</p>
              </div>
              <span className={cn('text-[9px] font-bold px-2.5 py-1.5 rounded-full shrink-0', r.hot ? 'grad text-white' : 'bg-[var(--honey)] text-[#B98A2F]')}>{r.st}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* Мастер анкеты: 5 шагов */
export function VendorProfileWizard() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [photos, setPhotos] = useState(3)
  const [published, setPublished] = useState(false)
  const [busyDays, setBusyDays] = usePersist<number[]>('tt_vendor_busy', [5, 6, 20, 26])
  const [workCity, setWorkCity] = useState(t('Уфа'))
  const [workRegion, setWorkRegion] = useState(t('Башкортостан'))
  const [cityPick, setCityPick] = useState(false)
  const [cat, setCat] = useState(t('📸 Фотограф'))
  const [packages, setPackages] = useState<string[][]>([[t('Утро и церемония'), '45 000 ₽'], [t('Полный день'), '85 000 ₽'], [t('Люкс'), '130 000 ₽']])
  const [pkgForm, setPkgForm] = useState(false)
  const [pkgName, setPkgName] = useState('')
  const [pkgPrice, setPkgPrice] = useState('')
  const addPkg = () => {
    const p = parseInt(pkgPrice.replace(/\D/g, ''), 10)
    if (!pkgName.trim() || !p) return
    setPackages(pk => [...pk, [pkgName.trim(), `${p.toLocaleString('ru-RU')} ₽`]])
    setPkgName(''); setPkgPrice(''); setPkgForm(false)
  }
  const toggleDay = (day: number) => setBusyDays(d => d.includes(day) ? d.filter(x => x !== day) : [...d, day].sort((a, b) => a - b))
  const steps = [t('Категория'), t('О себе'), t('Услуги и цены'), t('Портфолио'), t('Календарь')]
  if (published) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <div className="w-20 h-20 rounded-full grad flex items-center justify-center pop"><Check size={34} className="text-white" /></div>
      <h2 className="font-serif-d text-[26px] mt-6">{t('Анкета опубликована!')}</h2>
      <p className="text-[12.5px] text-[var(--soft)] mt-2.5 leading-relaxed">{t('Вы уже в каталоге и в фильтре «Свободны на дату». Первые заявки придут в пуш и в раздел «Сделки».')}</p>
      <div className="card-s px-4 py-3 mt-5 text-[11.5px] text-[var(--ink2)] w-full">{t('✦ Тиль: добавьте видео-визитку — анкеты с видео получают в 3 раза больше откликов.')}</div>
      <button onClick={() => nav('/vendor-app')} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-6" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('В кабинет')}</button>
    </div>
  )
  return (
    <div className="min-h-dvh flex flex-col pb-10">
      <TopBar back title={t('Моя анкета')} sub={`${t('Шаг ')}${step + 1}${t(' из 5 · ')}${steps[step]}`} />
      <div className="px-5 mt-2 flex gap-1.5">
        {steps.map((_, k) => <span key={k} className={cn('flex-1 h-1.5 rounded-full', k <= step ? 'grad' : 'bg-[var(--track)]')} />)}
      </div>
      <div key={step} className="flex-1 px-5 mt-5 fade-up">
        <div className="card-s px-4 py-3 mb-4 flex gap-2.5">
          <span>✦</span>
          <p className="text-[11px] text-[var(--ink2)] leading-relaxed">{[
            t('Смежные категории (например, «Фотограф» + «Свадебная съёмка») удваивают охват.'),
            t('Пары читают первые две строки — начните с главного: стиль и опыт.'),
            t('Пакеты с понятными названиями бронируют на 40% чаще, чем «индивидуально».'),
            t('Анкеты с видео получают в 3 раза больше откликов.'),
            t('Открытые даты = попадание в фильтр «Свободны на дату».'),
          ][step]}</p>
        </div>
        {step === 0 && (
          <div className="grid grid-cols-2 gap-2.5">
            {[t('📸 Фотограф'), t('🎥 Видеограф'), t('🎤 Ведущий'), t('🌸 Флорист'), t('🎂 Кондитер'), t('✨ Декоратор')].map(c => (
              <button key={c} onClick={() => setCat(c)} className={cn('press card-s p-4 text-[13px] font-semibold text-left', cat === c && 'ring-2 ring-[#C98A8A]')}>{c}</button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="space-y-3">
            <div className="card p-4"><span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('Имя / бренд')}</span><p className="text-[14px] font-medium mt-1">{t('Елена Смирнова')}</p></div>
            <div className="card p-4"><span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('Опыт')}</span><p className="text-[14px] font-medium mt-1">{t('5 лет · 120+ свадеб')}</p></div>
            <div className="card p-4"><span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('О себе')}</span><p className="text-[12.5px] text-[var(--ink2)] mt-1 font-light leading-relaxed">{t('Светлый живой стиль, ловлю эмоции, а не постановку…')}</p></div>
            <button onClick={() => setCityPick(true)} className="press w-full card p-4 flex items-center gap-3 text-left">
              <span className="text-[18px]">📍</span>
              <div className="flex-1">
                <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold block">{t('Город работы')}</span>
                <p className="text-[13.5px] font-medium mt-0.5">{workCity}{workRegion ? ` · ${workRegion}` : ''}</p>
              </div>
              <span className="text-[10.5px] font-bold text-[#B57171]">{t('Изменить')}</span>
            </button>
            {cityPick && <CityPicker onClose={() => setCityPick(false)} onPick={(c) => { setWorkCity(c.n); setWorkRegion(c.r); setCityPick(false) }} />}
          </div>
        )}
        {step === 2 && (
          <div className="space-y-3">
            {packages.map(([n, p]) => (
              <div key={n} className="card p-4 flex justify-between items-center">
                <b className="text-[13px]">{n}</b><span className="font-serif-d text-[15px] text-[#B57171] font-semibold tabular">{p}</span>
              </div>
            ))}
            {pkgForm ? (
              <div className="card-s p-4 space-y-2.5 fade-up">
                <input value={pkgName} onChange={e => setPkgName(e.target.value)} placeholder={t('Название пакета')} className="w-full h-11 px-4 rounded-full bg-[var(--card)] text-[13px] outline-none" />
                <input value={pkgPrice} onChange={e => setPkgPrice(e.target.value)} inputMode="numeric" placeholder={t('Цена, ₽')} className="w-full h-11 px-4 rounded-full bg-[var(--card)] text-[13px] outline-none" />
                <div className="flex gap-2">
                  <button onClick={() => setPkgForm(false)} className="press flex-1 h-11 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
                  <button onClick={addPkg} className="press flex-1 h-11 rounded-full grad text-white text-[12px] font-bold">{t('Добавить')}</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setPkgForm(true)} className="press w-full card-s py-4 text-[13px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить пакет')}</button>
            )}
          </div>
        )}
        {step === 3 && (
          <div>
            <div className="grid grid-cols-3 gap-2.5">
              {Array.from({ length: 5 }).map((_, k) => (
                <button key={k} onClick={() => setPhotos(Math.min(5, photos + (k >= photos ? 1 : 0)))} className={cn('press aspect-[0.8] rounded-[18px] flex items-center justify-center text-[22px]', k < photos ? 'bg-[var(--rose-soft)]' : 'border-[1.5px] border-dashed border-[#D8B4AE]')}>
                  {k < photos ? '📷' : '+'}
                </button>
              ))}
              <div className="aspect-[0.8] rounded-[18px] bg-[var(--sage-soft)] flex flex-col items-center justify-center gap-1">
                <span className="text-[20px]">▶</span><span className="text-[9px] text-[#7E9A74] font-bold">{t('Видео 1:40')}</span>
              </div>
            </div>
            <p className="text-[10.5px] text-[var(--soft)] text-center mt-3">{photos}{t('из 5 фото · видео до 3 минут · загрузка с триммером')}</p>
          </div>
        )}
        {step === 4 && (
          <div className="card p-4">
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-[var(--soft)] font-semibold mb-1">{[t('Пн'),t('Вт'),t('Ср'),t('Чт'),t('Пт'),t('Сб'),t('Вс')].map(d => <span key={d}>{d}</span>)}</div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: 30 }).map((_, k) => {
                const day = k + 1
                const busy = busyDays.includes(day)
                return <button key={day} onClick={() => toggleDay(day)} className={cn('press aspect-square rounded-xl flex items-center justify-center text-[11.5px]', busy ? 'bg-[var(--rose-soft)] text-[#B57171] line-through font-bold' : 'bg-[var(--bg)]')}>{day}</button>
              })}
            </div>
            <p className="text-[10.5px] text-[var(--soft)] mt-3">{t('Нажмите на дату, чтобы закрыть/открыть. Занято:')}{busyDays.join(', ')}.</p>
          </div>
        )}
      </div>
      <div className="px-5 pt-5">
        <button onClick={() => step === 4 ? setPublished(true) : setStep(Math.min(4, step + 1))} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] flex items-center justify-center gap-2" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {step === 4 ? t('Опубликовать анкету ✨') : t('Далее')} <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

/* Сделки подрядчика */
export function VendorDeals() {
  const [reviewAsked, setReviewAsked] = useState(false)
  const nav = useNavigate()
  return (
    <div className="pb-28">
      <TopBar back title={t('Сделки')} sub={t('Активные и архив')} />
      <div className="px-5 mt-3 grid grid-cols-2 gap-2.5">
        <div className="card-s p-4"><b className="font-serif-d text-[20px] tabular block">215 000 ₽</b><span className="text-[9.5px] text-[var(--soft)]">{t('ожидается по сделкам')}</span></div>
        <div className="card-s p-4"><b className="font-serif-d text-[20px] tabular block">3</b><span className="text-[9.5px] text-[var(--soft)]">{t('активные · 1 в hold')}</span></div>
      </div>
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {[
          { n: t('Алина и Тимур'), d: t('14 июня 2027'), sum: '85 000 ₽', st: t('Аванс получен'), cls: 'bg-[var(--honey)] text-[#B98A2F]', icon: '💍', tile: 'bg-[var(--rose-soft)]' },
          { n: t('Дина и Руслан'), d: t('5 сентября 2027'), sum: '45 000 ₽', st: t('Hold 72 ч'), cls: 'bg-[var(--lav)] text-[#7A6899]', icon: '⏳', tile: 'bg-[var(--honey)]' },
          { n: t('Анна и Марк'), d: t('18 июля 2027'), sum: '85 000 ₽', st: t('Переговоры'), cls: 'bg-[var(--blue)] text-[#5B7A99]', icon: '💬', tile: 'bg-[var(--sage-soft)]' },
        ].map(dl => (
          <button key={dl.n} onClick={() => nav('/us/chats')} className="press w-full card-s p-4 flex items-center gap-3 fade-up text-left">
            <Tile icon={dl.icon} tile={dl.tile} size={44} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px]">{dl.n}</b>
              <p className="text-[10.5px] text-[var(--soft)]">{dl.d} · <b className="text-[#B57171]">{dl.sum}</b></p>
            </div>
            <span className={cn('text-[9px] font-bold px-2.5 py-1.5 rounded-full whitespace-nowrap', dl.cls)}>{dl.st}</span>
          </button>
        ))}
        {/* Завершённая сделка: сбор отзыва */}
        <div className="card-s p-4 fade-up">
          <div className="flex items-center gap-3">
            <Tile icon="✓" tile="bg-[var(--rose-soft)]" size={44} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px]">{t('Гульнара и Тимур')}</b>
              <p className="text-[10.5px] text-[var(--soft)]">{t('23 мая 2026 ·')}<b className="text-[#B57171]">85 000 ₽</b></p>
            </div>
            <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[#7E9A74]">{t('Завершена')}</span>
          </div>
          {reviewAsked ? (
            <p className="mt-3 text-[11.5px] font-semibold text-[#7E9A74] flex items-center gap-1.5"><Star size={13} />{t('Запрос отзыва отправлен паре в чат ✓')}</p>
          ) : (
            <button onClick={() => setReviewAsked(true)} className="press mt-3 w-full h-10 rounded-full bg-[var(--sage-soft)] text-[#5F7C57] text-[12px] font-bold flex items-center justify-center gap-1.5"><Star size={13} />{t('Запросить отзыв у пары')}</button>
          )}
        </div>
      </div>
    </div>
  )
}
