import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Check, MapPin, Search, CalendarDays, Heart } from 'lucide-react'
import { useStore, EMPTY_QUIZ, type QuizAnswers } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CityPicker } from '@/components/CityPicker'
import { DatePicker } from '@/components/DatePicker'
import { formatWeddingDate } from '@/lib/weddingDate'
import { t } from '@/lib/i18n'
import { ApiError } from '@/lib/api/client'
import { budgetFromRange, createWedding, guestsFromRange, listMyWeddings } from '@/lib/api/wedding'

interface Step {
  q: string
  hint?: string
  opts: string[]
  /** Строка под названием: что этот вариант вообще значит. */
  desc?: Record<string, string>
  multi?: boolean
}

/*
 * Стили — с объяснением. Название вроде «Рустик» ничего не говорит тому,
 * кто первый раз выбирает свадьбу, а выбор влияет на всю выдачу каталога.
 *
 * Список собран из того, что уже живёт в продукте: шесть прежних, три
 * из историй «Вдохновения» (Усадьба, Урбан, Вечерняя) и три из тем
 * приглашений (Морская, Театральная, Средиземноморская). Ничего не
 * придумано на пустом месте — иначе стиль был бы в квизе и нигде больше.
 */
const STYLES: [string, string][] = [
  ['🤍 Классика', 'Белое платье, живые цветы, банкетный зал. Ничего лишнего и всегда уместно'],
  ['🌿 Бохо', 'Пампасная трава, макраме, свободная посадка. Много воздуха и мало правил'],
  ['◻️ Минимализм', 'Пустые стены, одна фактура, короткий список гостей. Красота за счёт пропорций'],
  ['✨ Люкс', 'Хрусталь, золото, живой оркестр. Вечер, где всё дорого — и это видно'],
  ['🌾 Рустик', 'Дерево, лён, полевые цветы. Амбар или база отдыха вместо банкетного зала'],
  ['🖤 Модерн', 'Графика, чёрный, необычные ракурсы. Свадьба, похожая на съёмку для журнала'],
  ['🍇 Усадьба', 'Старый дом, парк, два дня праздника. Гости остаются ночевать'],
  ['🌆 Урбан', 'Лофт, крыша, смотровая площадка. Город вместо декораций'],
  ['🕯 Вечерняя', 'Церемония после заката, свечи вместо прожекторов. Камерно и тепло'],
  ['⚓️ Морская', 'Синий, канаты, открытая вода. Причал, яхта или берег'],
  ['🎭 Театральная', 'Бархат, кулисы, выход под музыку. Праздник как спектакль'],
  ['🍋 Средиземноморская', 'Лимоны, терракота, длинный стол под небом. Итальянское лето'],
]

/* Шаг даты и шаг города — со своими экранами: в первом календарь,
 * во втором поиск по справочнику. Остальные — список вариантов. */
const DATE_STEP = 0
const CITY_STEP = 1
/* Шаг имени — последний: добавленный в конец, он не сдвигает индексы
   прежних ответов, на которые опирается сборка `collected`. */
const NAME_STEP = 8

/*
 * Ключи — русские строки, перевод только при отрисовке (`t()` в разметке).
 * До ревью 015 варианты переводились здесь, при загрузке модуля: в ответах
 * квиза и в свадьбе на сервере оседали английские строки, и «Классика» на
 * другом языке становилась другим ответом (инвариант R-07, FB4). Текст про
 * стиль — честный: каталог по стилю не фильтрует, его учитывает Тиль (R-174).
 */
const NOT_DECIDED = 'Ещё не решили'
const steps: Step[] = [
  { q: 'Когда ваша свадьба?', hint: 'Дату можно изменить позже', opts: [] },
  { q: 'Сколько гостей?', opts: ['До 30', '30–60', '60–100', '100+'] },
  { q: 'Общий бюджет?', hint: 'Можно примерно — поможем распределить', opts: ['До 500 тыс ₽', '500 тыс — 1 млн ₽', '1–2 млн ₽', '2 млн+ ₽', 'Пока не знаем'] },
  { q: 'Какой формат?', opts: ['Классика: ЗАГС + банкет', 'Выездная церемония', 'Камерная свадьба', 'Банкет+ на 2 дня'] },
  {
    q: 'Стиль и настроение?',
    hint: 'Стиль запишется в свадьбу — Тиль учитывает его в подсказках',
    opts: STYLES.map(([name]) => name),
    desc: Object.fromEntries(STYLES),
  },
  { q: 'Кто планирует?', opts: ['Сами', 'С помощью агентства', 'Ищем координатора'] },
  { q: 'Что уже забронировано?', multi: true, opts: ['Площадка', 'Фотограф', 'Видеограф', 'Ведущий', 'Пока ничего'] },
  /* Имя партнёра спрашивается последним и обязательно: из него складывается
     название свадьбы («Алина ♥ Тимур»), и без него сервер её не создаст.
     В Плане ч. 6 этого шага нет — расхождение вынесено владельцу. */
  { q: 'Как зовут вашего партнёра?', hint: 'Из имён сложится название вашей свадьбы', opts: [] },
]

export default function Quiz() {
  const nav = useNavigate()
  const { finishOnboarding, city, cityRegion, setCity, setWeddingId, adoptWeddings } = useStore()
  const [i, setI] = useState(0)
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const [picker, setPicker] = useState(false)
  const [datePicker, setDatePicker] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const [partner, setPartner] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* «Сегодня» снимается один раз за жизнь экрана: время в теле компонента
   * запрещено (R-04), а квиз не переживает полуночи. */
  const [today] = useState(() => new Date())
  const total = steps.length + 1 // + шаг города
  const cityDone = i === CITY_STEP && !!answers[CITY_STEP]
  const s = i < CITY_STEP ? steps[i] : steps[i - 1]
  const sel = answers[i] ?? []
  const last = i === total - 1
  // На шаге даты «дальше» открыт и без даты: «ещё не решили» — тоже ответ.
  const canNext = i === DATE_STEP ? date !== null || sel.includes(NOT_DECIDED) : i === CITY_STEP ? cityDone : i === NAME_STEP ? partner.trim().length > 0 : sel.length > 0

  const pick = (o: string) => {
    setAnswers(a => {
      const cur = a[i] ?? []
      if (s?.multi) return { ...a, [i]: cur.includes(o) ? cur.filter(x => x !== o) : [...cur, o] }
      return { ...a, [i]: [o] }
    })
  }
  const next = () => {
    if (!last) return setI(i + 1)
    void create()
  }

  /*
   * Свадьба заводится на сервере, а не только в состоянии.
   *
   * Раньше квиз просто складывал ответы в localStorage. Теперь из них
   * создаётся свадьба: сервер заводит её вместе с мозаикой слотов,
   * чек-листом и таймингом одной транзакцией. Её идентификатор нужен всему
   * дальнейшему — на путях `/weddings/{weddingId}/…` висит большая часть
   * приложения.
   *
   * Локальные ответы сохраняются в любом случае, в том числе когда сервер не
   * ответил: человек прошёл девять шагов, и терять их из-за сети нельзя.
   */
  const create = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    const one = (step: number) => answers[step]?.[0] ?? null
    const collected: QuizAnswers = {
      ...EMPTY_QUIZ,
      date,
      guests: one(2),
      budget: one(3),
      format: one(4),
      style: one(5),
      planner: one(6),
      booked: answers[7] ?? [],
    }
    finishOnboarding(collected)
    try {
      const id = await createWedding({
        partnerName: partner.trim(),
        city: { name: city, region: cityRegion },
        date,
        guestsPlanned: guestsFromRange(collected.guests),
        budgetTotal: budgetFromRange(collected.budget),
        style: collected.style ?? undefined,
        quizAnswers: { ...collected },
      })
      setWeddingId(id)
      nav('/home')
    } catch (e) {
      /*
       * 409 `wedding_exists` (контракт v0.29.0): живая свадьба уже есть —
       * партнёр завёл её с другого устройства, или телефон её не помнил.
       * Вторую сервер не заводит; экран открывает первую по `weddingId` из
       * `details`, а не оставляет человека с текстом отказа на последнем
       * шаге квиза (фича 005). Список свадеб — стору: сверка при запуске
       * могла пройти, когда свадьбы ещё не было; не пришёл — свадьба всё
       * равно известна из ответа, сверка остаётся какой была.
       */
      if (e instanceof ApiError && e.code === 'wedding_exists') {
        const existing = typeof e.details.weddingId === 'string' ? e.details.weddingId : null
        if (existing) {
          setErr(t('У вас уже есть свадьба — открываем её'))
          setWeddingId(existing)
          try { adoptWeddings(await listMyWeddings()) } catch { /* см. выше */ }
          nav('/home')
          return
        }
      }
      setErr(e instanceof ApiError
        ? (e.isDown ? t('Сервер недоступен. Попробуйте позже') : e.message)
        : t('Что-то пошло не так'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh flex flex-col">
      <div className="flex items-center gap-3 px-5 pt-6">
        {i > 0 ? (
          <button onClick={() => setI(i - 1)} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
            <ChevronLeft size={18} />
          </button>
        ) : <div className="w-10" />}
        <div className="flex-1 h-1.5 rounded-full bg-[var(--track)] overflow-hidden">
          <div className="h-full grad rounded-full transition-all duration-500" style={{ width: `${((i + 1) / total) * 100}%` }} />
        </div>
        <span className="text-[11px] text-[var(--soft)] font-semibold w-8 text-right tabular">{i + 1}/{total}</span>
      </div>

      {i === DATE_STEP ? (
        <div key="date" className="flex-1 px-6 pt-8 fade-up">
          <h1 className="font-serif-d text-[30px] leading-tight">{t(steps[DATE_STEP]!.q)}</h1>
          <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('Дату можно изменить позже')}</p>
          <button onClick={() => setDatePicker(true)} className="press w-full mt-6 card-s p-4 flex items-center gap-3 text-left">
            <CalendarDays size={16} className="text-[var(--soft2)]" />
            {date ? (
              <b className="flex-1 text-[14px]">{formatWeddingDate(date)}</b>
            ) : (
              <span className="flex-1 text-[13.5px] text-[var(--soft2)]">{t('Выбрать день в календаре')}</span>
            )}
          </button>
          <button
            onClick={() => { setDate(null); setAnswers(a => ({ ...a, [DATE_STEP]: [NOT_DECIDED] })) }}
            className={cn('press w-full mt-2.5 card-s p-4 flex items-center justify-between text-left text-[14px]',
              !date && sel.includes(NOT_DECIDED) && 'ring-2 ring-[var(--rose)]')}
          >
            <span className="font-medium">{t('Ещё не решили')}</span>
            <span className={cn('w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all',
              !date && sel.includes(NOT_DECIDED) ? 'bg-[#C98A8A] border-[#C98A8A]' : 'border-[#EAD9CF]')}>
              {!date && sel.includes(NOT_DECIDED) && <Check size={13} color="#fff" strokeWidth={3} />}
            </span>
          </button>
          <p className="text-[10.5px] text-[var(--soft2)] mt-5 leading-relaxed">
            {t('💡 Без даты тоже работает: чек-лист и бюджет соберутся, а сроки появятся, как только дата будет.')}
          </p>
        </div>
      ) : i === NAME_STEP ? (
        <div key="name" className="flex-1 px-6 pt-8 fade-up">
          <h1 className="font-serif-d text-[30px] leading-tight">{t('Как зовут вашего партнёра?')}</h1>
          <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('Из имён сложится название вашей свадьбы')}</p>
          <div className="card-s flex items-center gap-3 px-5 py-4 mt-6">
            <Heart size={16} className="text-[var(--rose-ink)]" />
            <input
              value={partner}
              onChange={e => setPartner(e.target.value.slice(0, 120))}
              autoComplete="off"
              placeholder={t('Имя')}
              className="bg-transparent outline-none text-[15px] w-full placeholder:text-[var(--soft2)]"
            />
          </div>
          <p className="text-[10.5px] text-[var(--soft2)] mt-5 leading-relaxed">
            {t('💡 Ваше имя подставится из профиля — его можно изменить в настройках.')}
          </p>
        </div>
      ) : i === CITY_STEP ? (
        <div key="city" className="flex-1 px-6 pt-8 fade-up">
          <h1 className="font-serif-d text-[30px] leading-tight">{t('Город праздника?')}</h1>
          <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('Работаем по всей России — от Уфы до райцентров вроде Сибая и Баймака')}</p>
          <button onClick={() => setPicker(true)} className="press w-full mt-6 card-s p-4 flex items-center gap-3 text-left">
            <Search size={16} className="text-[var(--soft2)]" />
            {cityDone ? (
              <span className="flex-1 flex items-center gap-2">
                <b className="text-[14px]">{city}</b>
                <span className="text-[10.5px] text-[var(--soft)]">{cityRegion}</span>
              </span>
            ) : (
              <span className="flex-1 text-[13.5px] text-[var(--soft2)]">{t('Начните вводить название…')}</span>
            )}
            <MapPin size={15} className="text-[var(--rose-deep)]" />
          </button>
          <div className="flex flex-wrap gap-2 mt-4">
            {['Уфа', 'Сибай', 'Баймак', 'Стерлитамак', 'Москва', 'Казань'].map(n => (
              <button key={n} onClick={() => { setCity(n, n === 'Москва' ? 'Москва' : n === 'Казань' ? 'Татарстан' : 'Башкортостан'); setAnswers(a => ({ ...a, [i]: [n] })) }}
                className={cn('press px-3.5 py-2 rounded-full text-[11.5px] font-semibold', sel.includes(n) ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--ink2)]')}
                style={{ boxShadow: 'var(--shadow)' }}>{t(n)}</button>
            ))}
          </div>
          {/* Каталог ищет по городу свадьбы: радиус и отметка «выезд» были
              обещанием, которого в выдаче нет (сервер умеет радиус, экран его
              не запрашивает — решение владельца, RELEASE-BLOCKERS). */}
          <p className="text-[10.5px] text-[var(--soft2)] mt-5 leading-relaxed">{t('💡 В каталоге — подрядчики города свадьбы. Город можно поменять в настройках в любой момент.')}</p>
        </div>
      ) : (
      <div key={i} className="flex-1 px-6 pt-8 fade-up">
        <h1 className="font-serif-d text-[30px] leading-tight">{t(s.q)}</h1>
        {s.hint && <p className="text-[12.5px] text-[var(--soft)] mt-2">{t(s.hint)}</p>}
        {s.multi && <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('Можно выбрать несколько')}</p>}
        <div className="mt-6 space-y-2.5 stagger">
          {s.opts.map(o => {
            const on = sel.includes(o)
            return (
              <button key={o} onClick={() => pick(o)} className={cn('press w-full card-s p-4 flex items-center justify-between gap-3 text-left text-[14px] fade-up', on && 'ring-2 ring-[var(--rose)]')}>
                <span className="min-w-0">
                  <span className="font-medium block">{t(o)}</span>
                  {/* Объяснение всегда видно: раскрывать его тапом значит просить
                      действие ровно там, где человек и так не понимает выбора. */}
                  {s.desc?.[o] && (
                    <span className="block text-[11.5px] text-[var(--soft)] leading-snug mt-1">{t(s.desc[o])}</span>
                  )}
                </span>
                <span className={cn('w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all', on ? 'bg-[#C98A8A] border-[#C98A8A]' : 'border-[#EAD9CF]')}>
                  {on && <Check size={13} color="#fff" strokeWidth={3} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      )}

      <div className="px-6 pb-[max(28px,env(safe-area-inset-bottom))] pt-4">
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] text-center mb-3 leading-relaxed">{err}</p>}
        <button
          onClick={next}
          disabled={!canNext || busy}
          className={cn('press w-full h-[54px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px] tracking-wide transition-opacity', (!canNext || busy) && 'opacity-40')}
          style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
        >
          {busy ? t('Создаём…') : last ? t('Создать мою свадьбу ✨') : t('Далее')}
        </button>
        {!last && <button onClick={next} className="w-full text-center text-[12px] text-[var(--soft)] mt-3 press">{t('Пропустить вопрос')}</button>}
      </div>

      {datePicker && (
        <DatePicker
          value={date}
          now={today}
          onPick={(iso) => { setDate(iso); setAnswers(a => ({ ...a, [DATE_STEP]: [iso] })); setDatePicker(false) }}
          onClose={() => setDatePicker(false)}
        />
      )}

      {picker && (
        <CityPicker
          onClose={() => setPicker(false)}
          onPick={(c) => { setCity(c.n, c.r); setAnswers(a => ({ ...a, [i]: [c.n] })); setPicker(false) }}
        />
      )}
    </div>
  )
}
