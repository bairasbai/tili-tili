import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Check, ChevronRight, Eye, MessageCircle, CalendarDays, TrendingUp, Plus, Star } from 'lucide-react'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { CityPicker } from '@/components/CityPicker'
import { usePersist } from '@/lib/usePersist'
import { cn } from '@/lib/utils'

/* Кабинет подрядчика: дашборд */
export function VendorDashboard() {
  const nav = useNavigate()
  const [busyDays, setBusyDays] = usePersist<number[]>('tt_vendor_busy', [5, 6, 14, 26])
  const toggleDay = (day: number) => setBusyDays(d => d.includes(day) ? d.filter(x => x !== day) : [...d, day].sort((a, b) => a - b))
  return (
    <div className="pb-28">
      <TopBar title="Елена Смирнова" sub="Фотограф · анкета заполнена на 90%" right={
        <button onClick={() => nav('/vendor-app/profile')} className="press h-10 px-4 rounded-full grad text-white text-[11.5px] font-bold">Анкета</button>
      } />
      <div className="px-5 mt-2">
        <div className="card p-4">
          <div className="flex justify-between text-[12px] mb-2"><span className="text-[#93897F]">Заполненность анкеты</span><b>90%</b></div>
          <Bar pct={90} />
          <p className="text-[10.5px] text-[#93897F] mt-2.5">Анкеты с видео получают в 3 раза больше откликов — добавьте видео-визитку.</p>
        </div>
        <div className="grid grid-cols-3 gap-2.5 mt-3.5 stagger">
          {[
            ['7', 'новых заявок', MessageCircle, 'bg-[#F2DFDC]'],
            ['12', 'просмотров/день', Eye, 'bg-[#E6EEE2]'],
            ['3', 'свадьбы в июне', CalendarDays, 'bg-[#F0DCB8]'],
          ].map(([v, l, Icon, tile]: any) => (
            <div key={l} className="card-s p-3.5 text-center fade-up">
              <div className={cn('w-9 h-9 rounded-[12px] mx-auto flex items-center justify-center', tile)}><Icon size={16} className="text-[#5C554B]" /></div>
              <b className="text-[19px] block mt-2 tabular">{v}</b>
              <span className="text-[9px] text-[#93897F]">{l}</span>
            </div>
          ))}
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
                <span className="text-[9.5px] text-[#93897F] w-2">{s}</span>
                <div className="flex-1 h-1.5 rounded-full bg-[#F1E9E2] overflow-hidden"><div className="h-full rounded-full bg-[#E3C892]" style={{ width: `${p}%` }} /></div>
                <span className="text-[9px] text-[#BFB5AA] w-7 text-right tabular">{p}%</span>
              </div>
            ))}
          </div>
          <span className="text-[9px] font-bold text-[#7E9A74] shrink-0">Отзывы →</span>
        </button>

        {/* Аналитика */}
        <button onClick={() => nav('/vendor-app/analytics')} className="press w-full card-s p-4 mt-2.5 flex items-center gap-3 text-left">
          <Tile icon="📈" tile="bg-[#E6EEE2]" size={42} />
          <div className="flex-1">
            <b className="text-[13px]">Аналитика анкеты</b>
            <p className="text-[10.5px] text-[#93897F]">воронка: 1 240 просмотров → 34 заявки → 8 сделок</p>
          </div>
          <span className="text-[11px] font-bold text-[#7E9A74]">+38% ↑</span>
        </button>

        {/* Календарь июня */}
        <div className="card p-4 mt-3.5">
          <div className="flex justify-between items-baseline mb-2.5">
            <b className="text-[13px]">Июнь 2027</b>
            <span className="text-[10px] text-[#93897F]">занято {busyDays.length} даты · нажмите на день</span>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 30 }).map((_, k) => {
              const day = k + 1
              const busy = busyDays.includes(day)
              return <button key={day} onClick={() => toggleDay(day)} className={cn('press aspect-square rounded-lg flex items-center justify-center text-[10px]', busy ? 'grad text-white font-bold' : 'bg-[#FBF6F1] text-[#5C554B]')}>{day}</button>
            })}
          </div>
        </div>

        <div className="flex justify-between items-baseline px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">Входящие заявки</h2>
          <span className="text-[10px] font-bold text-[#7E9A74] flex items-center gap-1"><TrendingUp size={11} /> +3 за неделю</span>
        </div>
        <div className="space-y-2.5 stagger">
          {[
            { id: 'ch1', n: 'Алина и Тимур', d: '14 июня 2027 · до 90 тыс ₽', st: 'Новая', hot: true },
            { id: 'ch2', n: 'Дина и Руслан', d: '5 сентября 2027 · пакет «Полный день»', st: 'Hold 72 ч', hot: false },
            { id: 'ch3', n: 'Анна и Марк', d: '18 июля 2027 · церемония', st: 'Новая', hot: true },
          ].map(r => (
            <button key={r.n} onClick={() => nav(`/vendor-app/leads/${r.id}`)} className="press w-full card-s p-4 flex items-center gap-3 text-left fade-up">
              <div className="w-11 h-11 rounded-full grad flex items-center justify-center text-white font-serif-d text-[15px] shrink-0">{r.n[0]}</div>
              <div className="flex-1 min-w-0">
                <b className="text-[13.5px]">{r.n}</b>
                <p className="text-[10.5px] text-[#93897F] mt-0.5">{r.d}</p>
              </div>
              <span className={cn('text-[9px] font-bold px-2.5 py-1.5 rounded-full shrink-0', r.hot ? 'grad text-white' : 'bg-[#F7ECD9] text-[#B98A2F]')}>{r.st}</span>
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
  const [workCity, setWorkCity] = useState('Уфа')
  const [workRegion, setWorkRegion] = useState('Башкортостан')
  const [cityPick, setCityPick] = useState(false)
  const [cat, setCat] = useState('📸 Фотограф')
  const [packages, setPackages] = useState<string[][]>([['Утро и церемония', '45 000 ₽'], ['Полный день', '85 000 ₽'], ['Люкс', '130 000 ₽']])
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
  const steps = ['Категория', 'О себе', 'Услуги и цены', 'Портфолио', 'Календарь']
  if (published) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <div className="w-20 h-20 rounded-full grad flex items-center justify-center pop"><Check size={34} className="text-white" /></div>
      <h2 className="font-serif-d text-[26px] mt-6">Анкета опубликована!</h2>
      <p className="text-[12.5px] text-[#93897F] mt-2.5 leading-relaxed">Вы уже в каталоге и в фильтре «Свободны на дату». Первые заявки придут в пуш и в раздел «Сделки».</p>
      <div className="card-s px-4 py-3 mt-5 text-[11.5px] text-[#5C554B] w-full">✦ Тиль: добавьте видео-визитку — анкеты с видео получают в 3 раза больше откликов.</div>
      <button onClick={() => nav('/vendor-app')} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-6" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>В кабинет</button>
    </div>
  )
  return (
    <div className="min-h-dvh flex flex-col pb-10">
      <TopBar back title="Моя анкета" sub={`Шаг ${step + 1} из 5 · ${steps[step]}`} />
      <div className="px-5 mt-2 flex gap-1.5">
        {steps.map((_, k) => <span key={k} className={cn('flex-1 h-1.5 rounded-full', k <= step ? 'grad' : 'bg-[#F1E9E2]')} />)}
      </div>
      <div key={step} className="flex-1 px-5 mt-5 fade-up">
        <div className="card-s px-4 py-3 mb-4 flex gap-2.5">
          <span>✦</span>
          <p className="text-[11px] text-[#5C554B] leading-relaxed">{[
            'Смежные категории (например, «Фотограф» + «Свадебная съёмка») удваивают охват.',
            'Пары читают первые две строки — начните с главного: стиль и опыт.',
            'Пакеты с понятными названиями бронируют на 40% чаще, чем «индивидуально».',
            'Анкеты с видео получают в 3 раза больше откликов.',
            'Открытые даты = попадание в фильтр «Свободны на дату».',
          ][step]}</p>
        </div>
        {step === 0 && (
          <div className="grid grid-cols-2 gap-2.5">
            {['📸 Фотограф', '🎥 Видеограф', '🎤 Ведущий', '🌸 Флорист', '🎂 Кондитер', '✨ Декоратор'].map(c => (
              <button key={c} onClick={() => setCat(c)} className={cn('press card-s p-4 text-[13px] font-semibold text-left', cat === c && 'ring-2 ring-[#C98A8A]')}>{c}</button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="space-y-3">
            <div className="card p-4"><span className="text-[10px] tracking-[.14em] uppercase text-[#93897F] font-semibold">Имя / бренд</span><p className="text-[14px] font-medium mt-1">Елена Смирнова</p></div>
            <div className="card p-4"><span className="text-[10px] tracking-[.14em] uppercase text-[#93897F] font-semibold">Опыт</span><p className="text-[14px] font-medium mt-1">5 лет · 120+ свадеб</p></div>
            <div className="card p-4"><span className="text-[10px] tracking-[.14em] uppercase text-[#93897F] font-semibold">О себе</span><p className="text-[12.5px] text-[#5C554B] mt-1 font-light leading-relaxed">Светлый живой стиль, ловлю эмоции, а не постановку…</p></div>
            <button onClick={() => setCityPick(true)} className="press w-full card p-4 flex items-center gap-3 text-left">
              <span className="text-[18px]">📍</span>
              <div className="flex-1">
                <span className="text-[10px] tracking-[.14em] uppercase text-[#93897F] font-semibold block">Город работы</span>
                <p className="text-[13.5px] font-medium mt-0.5">{workCity}{workRegion ? ` · ${workRegion}` : ''}</p>
              </div>
              <span className="text-[10.5px] font-bold text-[#B57171]">Изменить</span>
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
                <input value={pkgName} onChange={e => setPkgName(e.target.value)} placeholder="Название пакета" className="w-full h-11 px-4 rounded-full bg-white text-[13px] outline-none" />
                <input value={pkgPrice} onChange={e => setPkgPrice(e.target.value)} inputMode="numeric" placeholder="Цена, ₽" className="w-full h-11 px-4 rounded-full bg-white text-[13px] outline-none" />
                <div className="flex gap-2">
                  <button onClick={() => setPkgForm(false)} className="press flex-1 h-11 rounded-full bg-white text-[12px] font-semibold text-[#93897F]">Отмена</button>
                  <button onClick={addPkg} className="press flex-1 h-11 rounded-full grad text-white text-[12px] font-bold">Добавить</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setPkgForm(true)} className="press w-full card-s py-4 text-[13px] font-semibold flex items-center justify-center gap-2"><Plus size={15} /> Добавить пакет</button>
            )}
          </div>
        )}
        {step === 3 && (
          <div>
            <div className="grid grid-cols-3 gap-2.5">
              {Array.from({ length: 5 }).map((_, k) => (
                <button key={k} onClick={() => setPhotos(Math.min(5, photos + (k >= photos ? 1 : 0)))} className={cn('press aspect-[0.8] rounded-[18px] flex items-center justify-center text-[22px]', k < photos ? 'bg-[#F2DFDC]' : 'border-[1.5px] border-dashed border-[#D8B4AE]')}>
                  {k < photos ? '📷' : '+'}
                </button>
              ))}
              <div className="aspect-[0.8] rounded-[18px] bg-[#E6EEE2] flex flex-col items-center justify-center gap-1">
                <span className="text-[20px]">▶</span><span className="text-[9px] text-[#7E9A74] font-bold">Видео 1:40</span>
              </div>
            </div>
            <p className="text-[10.5px] text-[#93897F] text-center mt-3">{photos} из 5 фото · видео до 3 минут · загрузка с триммером</p>
          </div>
        )}
        {step === 4 && (
          <div className="card p-4">
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-[#93897F] font-semibold mb-1">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => <span key={d}>{d}</span>)}</div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: 30 }).map((_, k) => {
                const day = k + 1
                const busy = busyDays.includes(day)
                return <button key={day} onClick={() => toggleDay(day)} className={cn('press aspect-square rounded-xl flex items-center justify-center text-[11.5px]', busy ? 'bg-[#F2DFDC] text-[#B57171] line-through font-bold' : 'bg-[#FBF6F1]')}>{day}</button>
              })}
            </div>
            <p className="text-[10.5px] text-[#93897F] mt-3">Нажмите на дату, чтобы закрыть/открыть. Занято: {busyDays.join(', ')}.</p>
          </div>
        )}
      </div>
      <div className="px-5 pt-5">
        <button onClick={() => step === 4 ? setPublished(true) : setStep(Math.min(4, step + 1))} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] flex items-center justify-center gap-2" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {step === 4 ? 'Опубликовать анкету ✨' : 'Далее'} <ChevronRight size={16} />
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
      <TopBar back title="Сделки" sub="Активные и архив" />
      <div className="px-5 mt-3 grid grid-cols-2 gap-2.5">
        <div className="card-s p-4"><b className="font-serif-d text-[20px] tabular block">215 000 ₽</b><span className="text-[9.5px] text-[#93897F]">ожидается по сделкам</span></div>
        <div className="card-s p-4"><b className="font-serif-d text-[20px] tabular block">3</b><span className="text-[9.5px] text-[#93897F]">активные · 1 в hold</span></div>
      </div>
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {[
          { n: 'Алина и Тимур', d: '14 июня 2027', sum: '85 000 ₽', st: 'Аванс получен', cls: 'bg-[#F7ECD9] text-[#B98A2F]', icon: '💍', tile: 'bg-[#F2DFDC]' },
          { n: 'Дина и Руслан', d: '5 сентября 2027', sum: '45 000 ₽', st: 'Hold 72 ч', cls: 'bg-[#D9CCE3] text-[#7A6899]', icon: '⏳', tile: 'bg-[#F0DCB8]' },
          { n: 'Анна и Марк', d: '18 июля 2027', sum: '85 000 ₽', st: 'Переговоры', cls: 'bg-[#C3D5E8] text-[#5B7A99]', icon: '💬', tile: 'bg-[#E6EEE2]' },
        ].map(dl => (
          <button key={dl.n} onClick={() => nav('/us/chats')} className="press w-full card-s p-4 flex items-center gap-3 fade-up text-left">
            <Tile icon={dl.icon} tile={dl.tile} size={44} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px]">{dl.n}</b>
              <p className="text-[10.5px] text-[#93897F]">{dl.d} · <b className="text-[#B57171]">{dl.sum}</b></p>
            </div>
            <span className={cn('text-[9px] font-bold px-2.5 py-1.5 rounded-full whitespace-nowrap', dl.cls)}>{dl.st}</span>
          </button>
        ))}
        {/* Завершённая сделка: сбор отзыва */}
        <div className="card-s p-4 fade-up">
          <div className="flex items-center gap-3">
            <Tile icon="✓" tile="bg-[#F2DFDC]" size={44} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px]">Гульнара и Тимур</b>
              <p className="text-[10.5px] text-[#93897F]">23 мая 2026 · <b className="text-[#B57171]">85 000 ₽</b></p>
            </div>
            <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[#E6EEE2] text-[#7E9A74]">Завершена</span>
          </div>
          {reviewAsked ? (
            <p className="mt-3 text-[11.5px] font-semibold text-[#7E9A74] flex items-center gap-1.5"><Star size={13} /> Запрос отзыва отправлен паре в чат ✓</p>
          ) : (
            <button onClick={() => setReviewAsked(true)} className="press mt-3 w-full h-10 rounded-full bg-[#E6EEE2] text-[#5F7C57] text-[12px] font-bold flex items-center justify-center gap-1.5"><Star size={13} /> Запросить отзыв у пары</button>
          )}
        </div>
      </div>
    </div>
  )
}
