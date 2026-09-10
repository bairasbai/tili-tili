import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Check, ChevronRight, MessageCircle, CalendarDays, Plus, Star } from 'lucide-react'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { AsyncState, num, ready } from '@/components/AsyncState'
import { CityPicker } from '@/components/CityPicker'
import { ApiError } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import {
  ackVendorUpdate,
  getVendorCalendar,
  getVendorLeads,
  getVendorProfile,
  getVendorReviews,
  getVendorUpdates,
  getVerificationStatus,
  publishVendorProfile,
  getVendorDeals,
  saveVendorProfile,
  setVendorBusy,
  type VendorDraft,
} from '@/lib/api/vendor'
import { getCategories } from '@/lib/api/catalog'
import { cn, plural } from '@/lib/utils'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt, rub } from '@/lib/money'
import { formatWeddingDate, monthGrid, monthTitle, shortWeddingDate } from '@/lib/weddingDate'

/*
 * Кабинет подрядчика: дашборд.
 *
 * Экран был витриной целиком: «Елена Смирнова · анкета заполнена на 90%»,
 * семь заявок, двенадцать просмотров в день, рейтинг 4.9 с распределением
 * звёзд, три выдуманных обновления от пар и календарь июня из тридцати клеток
 * в `tt_vendor_busy`. Ни одна цифра не относилась к тому, кто смотрел.
 *
 * Теперь всё приходит с сервера, а чего сервер не считает — того на экране
 * нет. Заполненность анкеты считается тут же по её полям: это не данные, а
 * подсказка «что ещё заполнить».
 */
export function VendorDashboard() {
  const nav = useNavigate()
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [busyErr, setBusyErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const profile = useApi(() => getVendorProfile().catch(noProfile), [])
  const leads = useApi(() => getVendorLeads(), [])
  const reviews = useApi(() => getVendorReviews(), [])
  const updates = useApi(() => getVendorUpdates(), [])
  const calendar = useApi(() => getVendorCalendar(month), [month])

  const p = profile.data
  const leadList = leads.data ?? []
  const reviewList = reviews.data ?? []
  const updateList = (updates.data ?? []).filter(u => !u.ackAt)
  const days = calendar.data ?? []

  /* Заполненность — подсказка, а не оценка: показываем, чего не хватает. */
  const filled = [!!p?.name, !!p?.categoryId, !!p?.city, !!p?.about, !!p?.phone, !!(p?.packages?.length), !!(p?.gallery?.length)]
  const donePct = Math.round(filled.filter(Boolean).length / filled.length * 100)

  const stars = reviewList.length
    ? Math.round(reviewList.reduce((sum, r) => sum + (r.rating ?? 0), 0) / reviewList.length * 10) / 10
    : null
  const newLeads = leadList.filter(l => l.status === 'new').length

  const toggleDay = (date: string, busy: boolean) => void (async () => {
    setSaving(date)
    setBusyErr(null)
    try { await setVendorBusy([date], busy ? 'free' : 'busy'); calendar.reload() }
    catch (e) { setBusyErr(explainError(e)) } finally { setSaving(null) }
  })()

  /* Пока анкета не пришла, кабинет не рисуем: иначе на секунду показываются
     нули и «анкета не опубликована» — то есть неправда о чужом состоянии. */
  if (!ready(profile)) return (
    <div className="pb-28">
      <TopBar title={t('Кабинет подрядчика')} />
      <AsyncState q={profile} />
    </div>
  )
  if (!p) return <VendorNoProfile />

  return (
    <div className="pb-28">
      <TopBar title={p?.name ?? t('Кабинет подрядчика')} sub={p?.city ?? ''} right={
        <button onClick={() => nav('/vendor-app/profile')} className="press h-10 px-4 rounded-full grad text-[var(--on-grad)] text-[11.5px] font-bold">{t('Анкета')}</button>
      } />
      <AsyncState q={profile} />
      <div className="px-5 mt-2">
        <div className="card p-4">
          <div className="flex justify-between text-[12px] mb-2"><span className="text-[var(--soft)]">{t('Заполненность анкеты')}</span><b>{donePct}%</b></div>
          <Bar pct={donePct} />
          {donePct < 100 && (
            /* Называем недостающее поле, а не советуем «добавить видео» вообще:
               прежняя подсказка стояла константой и не зависела от анкеты. */
            <p className="text-[10.5px] text-[var(--soft)] mt-2.5">
              {t('Не хватает:')} {[!p?.about && t('рассказа о себе'), !p?.phone && t('рабочего телефона'), !p?.packages?.length && t('пакетов услуг'), !p?.gallery?.length && t('фотографий')].filter(Boolean).join(', ')}
            </p>
          )}
          {/* Опубликована или нет — главный факт кабинета: пока нет, заявок
              не будет, сколько ни заполняй поля. */}
          <p className="text-[10.5px] mt-2">
            {p?.published
              ? <span className="text-[var(--sage-deep)] font-semibold">{t('Анкета опубликована — вы в каталоге')}</span>
              : <span className="text-[var(--honey-deep)] font-semibold">{t('Анкета не опубликована — пары её не видят')}</span>}
          </p>
        </div>

        {/* Плитки — по своим запросам: анкета пришла, а заявки или календарь
            могли и не прийти. «0 новых заявок» при их отказе — не факт. */}
        <div className="grid grid-cols-3 gap-2.5 mt-3.5 stagger">
          {([
            [num(leads, newLeads), t('новых заявок'), MessageCircle, 'bg-[var(--rose-soft)]'],
            [stars === null ? '—' : String(stars), t('средняя оценка'), Star, 'bg-[var(--honey)]'],
            [num(calendar, days.filter(d => d.status === 'busy' || d.status === 'hold').length), t('занятых дней'), CalendarDays, 'bg-[var(--sage-soft)]'],
          ] as const).map(([v, l, Icon, tile]) => (
            <div key={l} className="card-s p-3.5 text-center fade-up">
              <div className={cn('w-9 h-9 rounded-[12px] mx-auto flex items-center justify-center', tile)}><Icon size={16} className="text-[var(--ink2)]" /></div>
              <b className="text-[19px] block mt-2 tabular">{v}</b>
              <span className="text-[9px] text-[var(--soft)]">{l}</span>
            </div>
          ))}
        </div>

        {/* Обновления от пар: настоящие правки по забронированным свадьбам.
            Раньше здесь стояли три строки про «Алину & Тимура» — у любого
            подрядчика одни и те же. */}
        <div className="card p-4 mt-3.5">
          <div className="flex items-center gap-2.5">
            <b className="text-[13px]">{t('Обновления от пар')}</b>
            {updateList.length > 0 && <span className="ml-auto text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{updateList.length}</span>}
          </div>
          <AsyncState q={updates} />
          {!updateList.length && ready(updates) && (
            <p className="text-[11px] text-[var(--soft)] mt-2.5">{t('Новых изменений нет')}</p>
          )}
          <div className="mt-3 space-y-2">
            {updateList.map(u => (
              <div key={u.id} className="flex items-start gap-3 bg-[var(--bg)] rounded-xl px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[9.5px] font-bold text-[var(--soft2)] uppercase tracking-wide">{u.wedding}{u.weddingDate ? ` · ${shortWeddingDate(u.weddingDate)}` : ''}</p>
                  <p className="text-[11.5px] mt-0.5">{u.text}</p>
                </div>
                <button onClick={() => void (async () => { await ackVendorUpdate(u.id ?? ''); updates.reload() })()} className="press text-[9.5px] font-bold text-[var(--sage-deep)] shrink-0 pt-0.5">{t('Учтено')}</button>
              </div>
            ))}
          </div>
        </div>

        <button onClick={() => nav('/vendor-app/reviews')} className="press w-full card p-4 mt-3.5 flex items-center gap-4 text-left">
          <div className="text-center">
            <b className="font-serif-d text-[30px] tabular">{stars ?? '—'}</b>
            <p className="text-[9.5px] text-[var(--honey-deep)]">{stars ? '★'.repeat(Math.round(stars)) : ''}</p>
          </div>
          <div className="flex-1">
            <b className="text-[13px]">{t('Отзывы')}</b>
            <p className="text-[10.5px] text-[var(--soft)]">
              {/* «пока ни одного» — утверждение об отзывах, и без списка его
                  нет: при отказе сервера оно стояло у подрядчика с сотней. */}
              {!ready(reviews)
                ? (reviews.loading ? t('Загружаем…') : t('Отзывы не загрузились'))
                : reviewList.length
                  ? `${reviewList.length} ${plural(reviewList.length, t('отзыв'), t('отзыва'), t('отзывов'))} · ${t('без ответа')} ${reviewList.filter(r => !r.reply).length}`
                  : t('пока ни одного')}
            </p>
          </div>
          <span className="text-[9px] font-bold text-[var(--sage-deep)] shrink-0">→</span>
        </button>

        <button onClick={() => nav('/vendor-app/analytics')} className="press w-full card-s p-4 mt-2.5 flex items-center gap-3 text-left">
          <Tile icon="📈" tile="bg-[var(--sage-soft)]" size={42} />
          <div className="flex-1">
            <b className="text-[13px]">{t('Аналитика анкеты')}</b>
            <p className="text-[10.5px] text-[var(--soft)]">{t('просмотры, заявки, сделки и доход')}</p>
          </div>
          <ChevronRight size={16} className="text-[var(--soft)]" />
        </button>

        <button onClick={() => nav('/vendor-app/verification')} className="press w-full card-s p-4 mt-2.5 flex items-center gap-3 text-left">
          <Tile icon={p?.verified ? '✓' : '🛡'} tile={p?.verified ? 'bg-[var(--sage-soft)]' : 'bg-[var(--honey)]'} size={42} />
          <div className="flex-1">
            <b className="text-[13px]">{p?.verified ? t('Вы проверены') : t('Пройти верификацию')}</b>
            <p className="text-[10.5px] text-[var(--soft)]">{p?.verified ? t('галочка видна парам в каталоге') : t('пары чаще пишут проверенным')}</p>
          </div>
          <ChevronRight size={16} className="text-[var(--soft)]" />
        </button>

        {/* Календарь занятости. Раньше это были тридцать клеток «июня» без
            смещения по дням недели и без связи с сервером (ERR-0130). */}
        <div className="card p-4 mt-3.5">
          <div className="flex justify-between items-center mb-2.5">
            <button onClick={() => setMonth(shiftMonth(month, -1))} className="press w-7 h-7 rounded-full bg-[var(--bg)] text-[12px]" aria-label={t('Прошлый месяц')}>‹</button>
            <b className="text-[13px]">{monthTitle(month)}</b>
            <button onClick={() => setMonth(shiftMonth(month, 1))} className="press w-7 h-7 rounded-full bg-[var(--bg)] text-[12px]" aria-label={t('Следующий месяц')}>›</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[9px] text-[var(--soft)] font-semibold mb-1">
            {[t('Пн'), t('Вт'), t('Ср'), t('Чт'), t('Пт'), t('Сб'), t('Вс')].map(d => <span key={d}>{d}</span>)}
          </div>
          {/* Сетка — только с пришедшим месяцем: без ответа каждый день
              выглядит свободным, и тап по нему «закрывал» бы дату вслепую. */}
          {!ready(calendar) ? <AsyncState q={calendar} /> : (
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: monthGrid(month).blanks }).map((_, k) => <span key={`b${k}`} />)}
            {Array.from({ length: monthGrid(month).days }).map((_, k) => {
              const date = `${month}-${String(k + 1).padStart(2, '0')}`
              const day = days.find(d => d.date === date)
              const busy = day?.status === 'busy'
              const hold = day?.status === 'hold'
              /* День под сделкой не снимается: сервер такую дату держит, и
                 предлагать «открыть» её значит обещать чужой отказ. Мягкая
                 бронь — тоже не ваша: она уйдёт сама, если пара не подтвердит. */
              const locked = hold || day?.source === 'deal'
              return (
                <button key={date} disabled={saving === date || locked} onClick={() => toggleDay(date, busy)}
                  title={locked ? (hold ? t('Пара держит дату — ждём подтверждения сделки') : t('Дата занята сделкой')) : undefined}
                  className={cn('press aspect-square rounded-lg flex items-center justify-center text-[10px] disabled:opacity-100',
                    hold ? 'bg-[var(--honey)] text-[var(--honey-ink)] font-bold' : busy ? 'grad text-[var(--on-grad)] font-bold' : 'bg-[var(--bg)] text-[var(--ink2)]',
                    locked && 'ring-2 ring-[var(--ink)]/15')}>
                  {k + 1}
                </button>
              )
            })}
          </div>
          )}
          {busyErr && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-2">{busyErr}</p>}
          {/* День под сделкой закрыт сервером: открыть его значило бы увести у
              пары дату, о которой договорились. */}
          <p className="text-[10px] text-[var(--soft2)] mt-2.5">{t('Тап — закрыть или открыть дату. Дни в рамке заняты сделкой или мягкой бронью: их снимает не календарь, а сама сделка.')}</p>
        </div>

        <div className="flex justify-between items-baseline px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">{t('Входящие заявки')}</h2>
          <button onClick={() => nav('/vendor-app/deals')} className="press text-[10.5px] font-bold text-[var(--sage-deep)]">{t('Сделки →')}</button>
        </div>
        <AsyncState q={leads} />
        {!leadList.length && ready(leads) && (
          <p className="text-[12px] text-[var(--soft)] py-3">{t('Заявок пока нет. Они приходят из каталога, когда пара пишет или бронирует.')}</p>
        )}
        <div className="space-y-2.5 stagger">
          {leadList.map(l => (
            <button key={l.id} onClick={() => nav(`/vendor-app/leads/${l.id}`)} className="press w-full card-s p-4 flex items-center gap-3 text-left fade-up">
              <div className="w-11 h-11 rounded-full grad flex items-center justify-center text-[var(--on-grad)] font-serif-d text-[15px] shrink-0">{(l.coupleName ?? '?')[0]}</div>
              <div className="flex-1 min-w-0">
                <b className="text-[13.5px]">{l.coupleName}</b>
                <p className="text-[10.5px] text-[var(--soft)] mt-0.5 truncate">
                  {[l.weddingDate ? formatWeddingDate(l.weddingDate) : t('дата не назначена'), l.city].filter(Boolean).join(' · ')}
                </p>
              </div>
              <span className={cn('text-[9px] font-bold px-2.5 py-1.5 rounded-full shrink-0', LEAD_TILE[l.status ?? 'new'])}>{t(LEAD_LABEL[l.status ?? 'new'] ?? '')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Подписи и цвета состояний заявки — те же слова, что у сервера. */
const LEAD_LABEL: Record<string, string> = {
  new: 'Новая',
  replied: 'Отвечено',
  hold: 'Держим дату',
  declined: 'Отклонена',
  won: 'Сделка',
}

const LEAD_TILE: Record<string, string> = {
  new: 'grad text-[var(--on-grad)]',
  replied: 'bg-[var(--blue)] text-[var(--blue-ink)]',
  hold: 'bg-[var(--honey)] text-[var(--honey-ink)]',
  declined: 'bg-[var(--track)] text-[var(--track-ink)]',
  won: 'bg-[var(--sage-soft)] text-[var(--sage-ink)]',
}

/** `2027-06` ± месяц. Без библиотеки: нужен один сдвиг, а не арифметика дат. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Анкеты ещё нет.
 *
 * 404 на своей анкете — не ошибка, а состояние: подрядчик только зашёл.
 * Показывать ему пустой кабинет с нулями значит делать вид, что анкета есть.
 */
function VendorNoProfile() {
  const nav = useNavigate()
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p className="font-serif-d text-[22px]">{t('Анкеты ещё нет')}</p>
      <p className="text-[12.5px] text-[var(--soft)] mt-3 leading-relaxed">
        {t('Заполните её — категория, город, пакеты и цены. После публикации вы появитесь в каталоге и в фильтре «свободен на дату».')}
      </p>
      <button onClick={() => nav('/vendor-app/profile')} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] mt-6">{t('Заполнить анкету')}</button>
    </div>
  )
}

/** 404 на своей анкете — «её ещё нет», а не поломка. Остальные ошибки летят дальше. */
const noProfile = (e: unknown) => {
  if (e instanceof ApiError && e.status === 404) return null
  throw e
}

/*
 * Мастер анкеты.
 *
 * Прежний мастер ничего не сохранял: имя, опыт и рассказ о себе стояли в
 * разметке константами («Елена Смирнова», «5 лет · 120+ свадеб»), категория
 * выбиралась из шести эмодзи, пакеты жили в состоянии экрана, календарь — в
 * `tt_vendor_busy`, а «Опубликовать» переключал локальный флаг. Подрядчик
 * заполнял анкету, видел «Опубликовано» и не попадал никуда.
 *
 * Теперь каждый шаг — это поля настоящей анкеты, а «Опубликовать» уходит в
 * `POST /vendor/profile/publish` и ставит анкету в каталог.
 */
export function VendorProfileWizard() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [publishedNow, setPublishedNow] = useState(false)

  const profile = useApi(() => getVendorProfile().catch(noProfile), [])
  const cats = useApi(() => getCategories(), [])

  /* Поля заполняются ответом сервера один раз — дальше ими владеет форма.
     Без этого каждое перечитывание анкеты затирало бы то, что человек печатает. */
  const [form, setForm] = useState<VendorDraft | null>(null)
  const p = profile.data
  if (form === null && ready(profile)) {
    setForm({
      name: p?.name ?? '',
      categoryId: p?.categoryId ?? '',
      /* Регион приходит отдельным полем: в `city` только название, а
         справочник различает одноимённые города по региону. Без него правка
         анкеты падала с «городом не найден». */
      city: { name: p?.city ?? '', ...(p?.cityRegion ? { region: p.cityRegion } : {}) },
      about: p?.about ?? '',
      phone: p?.phone ?? '',
      priceFrom: p?.priceFrom?.amount,
      packages: (p?.packages ?? []).map(x => ({ name: x.name ?? '', price: x.price?.amount ?? 0 })),
    })
  }

  const [cityPick, setCityPick] = useState(false)
  const [pkgForm, setPkgForm] = useState(false)
  const [pkgName, setPkgName] = useState('')
  const [pkgPrice, setPkgPrice] = useState('')

  const steps = [t('Категория'), t('О себе'), t('Услуги и цены'), t('Портфолио'), t('Публикация')]
  const set = (patch: Partial<VendorDraft>) => setForm(f => (f ? { ...f, ...patch } : f))

  /* Сохранение — на каждом переходе: мастер длинный, и потерять введённое на
     пятом шаге из-за закрытой вкладки нельзя. */
  const saveAnd = (next: () => void | Promise<void>) => void (async () => {
    if (!form) return
    if (!form.name.trim() || !form.categoryId || !form.city.name) {
      setErr(t('Имя, категория и город обязательны — без них анкету не показать паре'))
      setStep(form.categoryId ? 1 : 0)
      return
    }
    setBusy(true)
    setErr(null)
    try { await saveVendorProfile(form); await next() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  /* Сохранение и публикация — одна операция для человека, значит и один
     признак занятости: раньше `saveAnd` снимал его, не дождавшись публикации,
     и второе нажатие уходило на сервер. */
  const publish = () => saveAnd(async () => {
    await publishVendorProfile()
    setPublishedNow(true)
  })

  const addPkg = () => {
    const rubles = parseInt(pkgPrice.replace(/\D/g, ''), 10)
    if (!pkgName.trim() || !rubles) return
    set({ packages: [...(form?.packages ?? []), { name: pkgName.trim(), price: rub(rubles) }] })
    setPkgName(''); setPkgPrice(''); setPkgForm(false)
  }

  if (publishedNow) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <div className="w-20 h-20 rounded-full grad flex items-center justify-center pop"><Check size={34} className="text-white" /></div>
      {/* Публикация и правка — разные события. Опубликованной анкете «Анкета
          опубликована!» сообщает о том, чего не происходило. */}
      <h2 className="font-serif-d text-[26px] mt-6">{p?.published ? t('Изменения сохранены') : t('Анкета опубликована!')}</h2>
      <p className="text-[12.5px] text-[var(--soft)] mt-2.5 leading-relaxed">
        {p?.published
          ? t('Пары видят анкету в новом виде — обновлять ничего не нужно.')
          : t('Вы в каталоге и в фильтре «свободен на дату». Заявки придут в кабинет.')}
      </p>
      <button onClick={() => nav('/vendor-app')} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] mt-6" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('В кабинет')}</button>
    </div>
  )

  return (
    <div className="min-h-dvh flex flex-col pb-10">
      <TopBar back title={t('Моя анкета')} sub={`${t('Шаг ')}${step + 1}${t(' из 5 · ')}${steps[step]}`} />
      <AsyncState q={profile} />
      <div className="px-5 mt-2 flex gap-1.5">
        {steps.map((_, k) => <span key={k} className={cn('flex-1 h-1.5 rounded-full', k <= step ? 'grad' : 'bg-[var(--track)]')} />)}
      </div>
      <div key={step} className="flex-1 px-5 mt-5 fade-up">
        {step === 0 && (
          <>
            {/* Категории — те же 35, что в каталоге и в базе. Шесть эмодзи в
                разметке значили, что подрядчик из седьмой категории не мог
                завести анкету вовсе. */}
            <AsyncState q={cats} />
            <div className="grid grid-cols-2 gap-2.5">
              {(cats.data ?? []).map(c => (
                <button key={c.id} onClick={() => set({ categoryId: c.id ?? '' })}
                  className={cn('press card-s p-4 text-[12.5px] font-semibold text-left', form?.categoryId === c.id && 'ring-2 ring-[#C98A8A]')}>
                  {c.icon} {c.title}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 1 && form && (
          <div className="space-y-3">
            <label className="card p-4 block">
              <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('Имя / бренд')}</span>
              <input value={form.name} onChange={e => set({ name: e.target.value })} placeholder={t('Как вас искать парам')}
                className="w-full mt-1.5 h-11 px-4 rounded-full bg-[var(--bg)] text-[14px] font-medium outline-none" />
            </label>
            <label className="card p-4 block">
              <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('О себе')}</span>
              <textarea value={form.about ?? ''} onChange={e => set({ about: e.target.value })} rows={4} placeholder={t('Стиль, опыт, чем вы отличаетесь')}
                className="w-full mt-1.5 px-4 py-3 rounded-[18px] bg-[var(--bg)] text-[12.5px] outline-none resize-none" />
            </label>
            <div className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('Рабочий телефон')}</span>
                <span className="text-[9.5px] text-[var(--soft2)]">{t('Виден парам после брони')}</span>
              </div>
              {/* Телефон — поле анкеты, а не номер входа: заполняя его,
                  подрядчик соглашается показать номер забронировавшей паре. */}
              <input value={form.phone ?? ''} onChange={e => set({ phone: e.target.value })} type="tel" inputMode="tel" aria-label={t('Рабочий телефон')}
                className="w-full mt-1.5 h-11 px-4 rounded-full bg-[var(--bg)] text-[14px] font-medium tabular outline-none" />
            </div>
            <button onClick={() => setCityPick(true)} className="press w-full card p-4 flex items-center gap-3 text-left">
              <span className="text-[18px]">📍</span>
              <div className="flex-1">
                <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold block">{t('Город работы')}</span>
                <p className="text-[13.5px] font-medium mt-0.5">{form.city.name || t('не выбран')}</p>
              </div>
              <span className="text-[10.5px] font-bold text-[var(--rose-deep)]">{t('Изменить')}</span>
            </button>
            {cityPick && <CityPicker onClose={() => setCityPick(false)} onPick={c => { set({ city: { name: c.n, region: c.r } }); setCityPick(false) }} />}
          </div>
        )}

        {step === 2 && form && (
          <div className="space-y-3">
            <label className="card p-4 block">
              <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('Цена «от», ₽')}</span>
              <input value={form.priceFrom ? String(Math.round(form.priceFrom / 100)) : ''} onChange={e => set({ priceFrom: rub(Number(e.target.value.replace(/\D/g, '')) || 0) })}
                inputMode="numeric" placeholder={t('С какой суммы начинается работа')}
                className="w-full mt-1.5 h-11 px-4 rounded-full bg-[var(--bg)] text-[14px] font-medium tabular outline-none" />
            </label>
            {(form.packages ?? []).map((pkg, k) => (
              <div key={`${pkg.name}-${k}`} className="card p-4 flex justify-between items-center">
                <b className="text-[13px]">{pkg.name}</b>
                <span className="flex items-center gap-2.5">
                  <span className="font-serif-d text-[15px] text-[var(--rose-deep)] font-semibold tabular">{fmt(pkg.price)}</span>
                  <button onClick={() => set({ packages: (form.packages ?? []).filter((_, i) => i !== k) })} className="press text-[var(--rose-deep)] text-[13px]" aria-label={t('Удалить')}>×</button>
                </span>
              </div>
            ))}
            {pkgForm ? (
              <div className="card-s p-4 space-y-2.5 fade-up">
                <input value={pkgName} onChange={e => setPkgName(e.target.value)} placeholder={t('Название пакета')} className="w-full h-11 px-4 rounded-full bg-[var(--card)] text-[13px] outline-none" />
                <input value={pkgPrice} onChange={e => setPkgPrice(e.target.value)} inputMode="numeric" placeholder={t('Цена, ₽')} className="w-full h-11 px-4 rounded-full bg-[var(--card)] text-[13px] outline-none" />
                <div className="flex gap-2">
                  <button onClick={() => setPkgForm(false)} className="press flex-1 h-11 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
                  <button onClick={addPkg} className="press flex-1 h-11 rounded-full grad text-[var(--on-grad)] text-[12px] font-bold">{t('Добавить')}</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setPkgForm(true)} className="press w-full card-s py-4 text-[13px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить пакет')}</button>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="card p-4">
            {/* Загрузка фото упирается в объектное хранилище: сервер отвечает
                `storage_not_configured`. Прежний шаг рисовал пять рамок и
                «видео 1:40», хотя ни одного файла никуда не уходило. */}
            <p className="text-[13px] font-semibold">{t('Портфолио пока не загружается')}</p>
            <p className="text-[11px] text-[var(--soft)] leading-relaxed mt-1">
              {t('Фото и видео появятся здесь, когда будет подключено файловое хранилище. Анкету это не блокирует — опубликовать её можно уже сейчас.')}
            </p>
            {!!p?.gallery?.length && (
              <div className="grid grid-cols-3 gap-2 mt-3">
                {p.gallery.map(src => <img key={src} src={src} alt="" className="aspect-[0.8] w-full object-cover rounded-[16px]" loading="lazy" />)}
              </div>
            )}
          </div>
        )}

        {step === 4 && form && (
          <div className="space-y-3">
            <div className="card p-4">
              <b className="text-[14px]">{form.name || t('Без имени')}</b>
              <p className="text-[11.5px] text-[var(--soft)] mt-1">
                {(cats.data ?? []).find(c => c.id === form.categoryId)?.title ?? t('категория не выбрана')} · {form.city.name || t('город не выбран')}
              </p>
              {form.priceFrom ? <p className="text-[12px] mt-1.5">{t('от')} <b className="tabular">{fmt(form.priceFrom)}</b></p> : null}
              <p className="text-[11.5px] text-[var(--ink2)] mt-2 leading-relaxed">{form.about || t('Рассказа о себе пока нет')}</p>
            </div>
            <p className="text-[11px] text-[var(--soft)] leading-relaxed px-1">
              {p?.published
                ? t('Анкета уже опубликована. Изменения видны парам сразу после сохранения.')
                : t('После публикации анкета появляется в каталоге сразу, модерация проверит её в течение суток.')}
            </p>
          </div>
        )}
      </div>

      {err && <p role="alert" className="px-5 text-[12px] text-[var(--rose-ink)]">{err}</p>}
      <div className="px-5 pt-5 space-y-2">
        <button disabled={busy || !form} onClick={() => step === 4 ? publish() : saveAnd(() => setStep(Math.min(4, step + 1)))}
          className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {busy ? t('Сохраняем…') : step === 4 ? (p?.published ? t('Сохранить изменения') : t('Опубликовать анкету ✨')) : t('Далее')} <ChevronRight size={16} />
        </button>
        {step > 0 && <button onClick={() => setStep(step - 1)} className="press w-full h-11 rounded-full bg-[var(--bg)] text-[12.5px] font-semibold text-[var(--soft)]">{t('Назад')}</button>}
      </div>
    </div>
  )
}

/*
 * Сделки подрядчика.
 *
 * Экран показывал три выдуманные пары, «215 000 ₽ ожидается» константой и
 * кнопку «Запросить отзыв у пары», которая только переключала флаг в браузере.
 * Ни одна строка не относилась к тому, кто смотрел.
 *
 * Заявка и сделка — разные вещи: у заявки нет ни суммы, ни мягкой брони.
 * Поэтому здесь только сделки, а заявки живут в кабинете отдельным списком.
 */
export function VendorDeals() {
  const q = useApi(() => getVendorDeals(), [])
  const items = q.data?.items ?? []
  const expected = q.data?.expected?.amount ?? 0
  const active = items.filter(d => d.state !== 'cancelled' && d.state !== 'done').length

  return (
    <div className="pb-28">
      <TopBar back title={t('Сделки')} sub={t('Активные и архив')} />
      <AsyncState q={q} />
      {/* Плитки — только по ответу сервера. «0 ₽ ожидается по сделкам» рядом
          с «Сервер недоступен» подрядчик читает как «денег не будет». */}
      {ready(q) && (
        <div className="px-5 mt-3 grid grid-cols-2 gap-2.5">
          <div className="card-s p-4">
            <b className="font-serif-d text-[20px] tabular block">{fmt(expected)}</b>
            <span className="text-[9.5px] text-[var(--soft)]">{t('ожидается по сделкам')}</span>
          </div>
          <div className="card-s p-4">
            <b className="font-serif-d text-[20px] tabular block">{active}</b>
            <span className="text-[9.5px] text-[var(--soft)]">{t('активных сделок')}</span>
          </div>
        </div>
      )}
      {!items.length && ready(q) && (
        <p className="px-5 mt-4 text-[12px] text-[var(--soft)]">{t('Сделок пока нет. Они появляются, когда пара бронирует вас из каталога.')}</p>
      )}
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {items.map(d => (
          <div key={d.id} className="card-s p-4 flex items-center gap-3 fade-up">
            <Tile icon={DEAL_ICON[d.state ?? ''] ?? '💬'} tile="bg-[var(--rose-soft)]" size={44} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px]">{d.coupleName}</b>
              <p className="text-[10.5px] text-[var(--soft)]">
                {d.weddingDate ? formatWeddingDate(d.weddingDate) : t('дата не назначена')}
                {d.price ? <> · <b className="text-[var(--rose-deep)]">{fmt(d.price.amount ?? 0)}</b></> : null}
              </p>
              {/* Мягкая бронь — срок, а не подпись: до него пара может
                  подтвердить сделку, после он сгорает сам. */}
              {d.holdUntil && <p className="text-[10px] text-[var(--honey-deep)] mt-0.5">{t('держим до')} {new Date(d.holdUntil).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>}
            </div>
            <span className={cn('text-[9px] font-bold px-2.5 py-1.5 rounded-full whitespace-nowrap', DEAL_TILE[d.state ?? ''] ?? 'bg-[var(--track)] text-[var(--track-ink)]')}>
              {t(DEAL_STATE_LABEL[d.state ?? ''] ?? d.state ?? '')}
            </span>
          </div>
        ))}
      </div>
      {/* Кнопка «Запросить отзыв у пары» убрана: пути для такого запроса нет,
          она лишь переключала флаг в браузере. Отзыв пара оставляет сама после
          завершённой сделки — сервер это и проверяет. */}
    </div>
  )
}

const DEAL_STATE_LABEL: Record<string, string> = {
  candidate: 'Кандидат',
  contacted: 'Написали',
  negotiating: 'Держим дату',
  booked: 'Забронировано',
  paid_deposit: 'Аванс получен',
  done: 'Завершена',
  cancelled: 'Отменена',
}

const DEAL_TILE: Record<string, string> = {
  negotiating: 'bg-[var(--lav)] text-[var(--lav-ink)]',
  booked: 'bg-[var(--blue)] text-[var(--blue-ink)]',
  paid_deposit: 'bg-[var(--honey)] text-[var(--honey-ink)]',
  done: 'bg-[var(--sage-soft)] text-[var(--sage-ink)]',
  cancelled: 'bg-[var(--track)] text-[var(--track-ink)]',
}

const DEAL_ICON: Record<string, string> = {
  negotiating: '⏳',
  booked: '💍',
  paid_deposit: '💰',
  done: '✓',
  cancelled: '×',
}

/**
 * Нет анкеты — нет и заявки.
 *
 * `GET /vendor/verification` отвечает 403 подрядчику без анкеты, как и все
 * пути кабинета. Для экрана это «заявок не подавали», а не поломка: 404 —
 * то же самое. Остальные ошибки летят дальше и показываются как ошибки.
 */
const noRequest = (e: unknown) => {
  if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null
  throw e
}

/** Дата с сервера словами. Пусто — значит сервер её не прислал, и выдумывать нечего. */
function fmtRequestDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

/*
 * Верификация.
 *
 * Галочка «Проверен» даётся за сверку документов с ФНС, и рисовать её без
 * документов нельзя. Сами файлы кладутся в объектное хранилище, которого пока
 * нет: сервер отвечает `storage_not_configured`. Экран говорит это словами и
 * показывает, что именно понадобится, — вместо кнопки, которая молча падает.
 *
 * Подавший документы раньше видел ровно то же, что и не подававший: галочки
 * нет — и гадай, дошло ли. Теперь состояние заявки приходит с сервера и
 * называется словами. Пока ответа нет, никакого статуса на экране не
 * появляется: «заявок нет» без ответа — такая же выдумка, как ноль (R-178).
 */
export function VendorVerification() {
  const nav = useNavigate()
  const q = useApi(() => getVendorProfile().catch(noProfile), [])
  const st = useApi(() => getVerificationStatus().catch(noRequest), [])
  const [kind, setKind] = useState<'passport' | 'ip' | 'company'>('passport')
  /* Статус читаем только из ответа: пока его нет, `status` — undefined, и ни
     одна из веток ниже не срабатывает. */
  const status = st.data?.status
  /* Галочка и одобренная заявка — одно и то же состояние с двух сторон:
     галочку могли поставить и решением по анкете, без заявки. */
  const proven = q.data?.verified === true || status === 'approved'

  return (
    <div className="pb-28">
      <TopBar back title={t('Верификация')} sub={proven ? t('пройдена') : t('галочка «Проверен» в каталоге')} />
      <AsyncState q={q} />
      {/* Пока анкета не пришла, «пройти верификацию» не предлагаем: без ответа
          «не проверен» — догадка. */}
      {ready(q) && <div className="px-5 mt-3 space-y-3">
        {proven ? (
          <div className="card p-5 text-center">
            <span className="text-[28px]">✓</span>
            <p className="text-[13.5px] font-semibold mt-2">{t('Вы проверены')}</p>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Галочка видна парам в каталоге. Документы не публикуются никогда.')}</p>
          </div>
        ) : (
          <>
            {/* Ни статуса, ни формы подачи, пока запрос о заявке не завершён
                или упал. Форма — такое же утверждение, как статус: она говорит
                «заявок от вас не было». При 500 и лежащей сети ответа нет, и
                подавший документы читал бы приглашение подать их заново
                (R-178, R-180). 403 и 404 сюда не попадают: их снимает
                `noRequest` — это ответ сервера «заявки нет», а не сбой. */}
            <AsyncState q={st} />
            {ready(st) && <>
            {/* Отказ — первым: подрядчик пришёл узнать, что с документами, а
                не читать, зачем нужна галочка. Причина живёт в уведомлении:
                у заявки своего поля причины нет. */}
            {status === 'rejected' && (
              <div className="card p-4">
                <p className="text-[13px] font-semibold text-[var(--rose-ink)]">{t('Документы не подтверждены')} {fmtRequestDate(st.data?.checkedAt)}</p>
                <p className="text-[11.5px] text-[var(--soft)] leading-relaxed mt-1.5">{t('Причина — в уведомлениях.')}</p>
                <button onClick={() => nav('/notifications')} className="press w-full h-[44px] rounded-full card-s text-[12.5px] font-semibold mt-3">{t('Открыть уведомления')}</button>
              </div>
            )}
            <div className="card p-4">
              <p className="text-[12px] text-[var(--soft)] leading-relaxed">
                {t('Проверенные подрядчики получают больше заявок: пара видит, что за анкетой стоит живой человек с документами. Документы уходят только модератору и не публикуются никогда.')}
              </p>
            </div>
            {status === 'pending' ? (
              /* Заявка уже в очереди: выбирать вид документа и читать, что
                 понадобится, поздно — понадобилось и ушло. */
              <div className="card p-4">
                <p className="text-[13px] font-semibold">{t('Заявка на проверке с')} {fmtRequestDate(st.data?.submittedAt)}</p>
                <p className="text-[11.5px] text-[var(--soft)] leading-relaxed mt-1.5">{t('Решение придёт уведомлением. Документы уходят только модератору и не публикуются никогда.')}</p>
              </div>
            ) : (
              <>
                <div className="card p-4">
                  <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('Кто вы')}</span>
                  <div className="flex gap-2 mt-2">
                    {([['passport', t('Физлицо')], ['ip', t('ИП')], ['company', t('Компания')]] as const).map(([id, label]) => (
                      <button key={id} onClick={() => setKind(id)} className={cn('press flex-1 h-10 rounded-full text-[12px] font-semibold', kind === id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)] text-[var(--soft)]')}>{label}</button>
                    ))}
                  </div>

                </div>
                <div className="card p-4">
                  <p className="text-[13px] font-semibold">{t('Загрузка документов пока не подключена')}</p>
                  <p className="text-[11px] text-[var(--soft)] leading-relaxed mt-1">
                    {kind === 'passport'
                      ? t('Понадобится разворот паспорта. Файл уйдёт в защищённое хранилище, как только оно будет подключено.')
                      : t('Понадобится выписка из ЕГРЮЛ или ЕГРИП. Файл уйдёт в защищённое хранилище, как только оно будет подключено.')}
                  </p>
                  {/* Кнопки отправки здесь нет намеренно. Без файла запрос отвечает
                      «не прошёл проверку» — это правда про формат, но ложь про
                      причину: документ отправить некуда, пока нет хранилища.
                      Кнопка, у которой один исход — ошибка, хуже её отсутствия. */}
                  <p className="text-[11px] text-[var(--soft2)] mt-3">{t('Отправка появится вместе с хранилищем — тогда же, когда заработает загрузка портфолио.')}</p>
                </div>
              </>
            )}
            </>}
          </>
        )}
      </div>}
    </div>
  )
}
