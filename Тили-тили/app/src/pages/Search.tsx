import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { Search as SearchIcon, SlidersHorizontal, Play, MapPin, Calendar, Check, Phone } from 'lucide-react'
import { fmt, rub } from '@/lib/money'
import { CATEGORY_TILE, DEFAULT_TILE } from '@/lib/categoryTiles'
import { getAvailability, getCategories, getVendors, getVendor, requestConcierge, reviewsPendingRating, type Vendor, type VendorFilters } from '@/lib/api/catalog'
import { useApi, explainError } from '@/lib/api/useApi'
import { formatWeddingDate, monthGrid, monthTitle } from '@/lib/weddingDate'
import { ShortlistReplaceDialog, TopBar, VendorCard } from '@/components/chrome'
import { AsyncState, ErrorState, ready } from '@/components/AsyncState'
import { ComplaintSheet } from '@/components/ComplaintSheet'
import { getVendorReviews } from '@/lib/api/reviews'
import { getVendorProfile } from '@/lib/api/vendor'
import { getWedding } from '@/lib/api/weddingData'
import { bookSlot, cancelSlot, ensureSlotForCategory, removeExternal } from '@/lib/api/slots'
import { addShortlistCandidate, getShortlist, type ShortlistEntry } from '@/lib/api/shortlist'
import type { components } from '@/lib/api/schema'
import { useStore } from '@/lib/store'
import { cn, copyText, currentMonth, plural } from '@/lib/utils'
import { chatRouteForVendor } from '@/lib/api/chats'
import { ApiError, isAuthorized } from '@/lib/api/client'
import { listMyWeddings } from '@/lib/api/wedding'
import { t } from '@/lib/i18n'
import { OfferRequestComposer } from '@/components/OfferRequestComposer'
import { OfferSummary } from '@/components/OfferSummary'

function shortlistFromError(error: unknown): ShortlistEntry[] | null {
  if (!(error instanceof ApiError) || error.code !== 'shortlist_full') return null
  const entries = error.details.shortlist
  return Array.isArray(entries) ? entries as ShortlistEntry[] : null
}

function candidateError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'slot_missing')
    return t('Сначала пара должна добавить это место в свадьбу')
  return explainError(error)
}

/** Явное подтверждение, какую существующую отметку заменить при лимите в три. */
function CandidateControl({ weddingId, slotId, vendorId, vendorName, entries, canAdd, onAdded, onSettled }: {
  weddingId: string | null
  slotId?: string
  vendorId: string
  vendorName: string
  entries: ShortlistEntry[]
  canAdd: boolean
  onAdded: (entry: ShortlistEntry) => void
  onSettled: () => void
}) {
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const [replace, setReplace] = useState<ShortlistEntry[] | null>(null)
  const [replaceErr, setReplaceErr] = useState<string | null>(null)
  const existing = entries.find(entry => entry.vendor?.id === vendorId)

  const add = async () => {
    if (!weddingId || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setErr(null)
    try {
      const entry = await addShortlistCandidate(weddingId, vendorId)
      onAdded(entry)
      onSettled()
    } catch (error) {
      const full = shortlistFromError(error)
      if (full) {
        setReplace(full)
        setReplaceErr(null)
        onSettled()
      } else {
        setErr(candidateError(error))
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const replaceEntry = async (entry: ShortlistEntry) => {
    if (!weddingId || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setReplaceErr(null)
    try {
      /* Сервер проверяет stable entryId и меняет запись под одной блокировкой.
         Клиент не может оставить список без кандидата между DELETE и PUT. */
      const added = await addShortlistCandidate(weddingId, vendorId, entry.id)
      onAdded(added)
      setReplace(null)
      onSettled()
    } catch (error) {
      const full = shortlistFromError(error)
      if (full) {
        setReplace(full)
        setReplaceErr(t('Кандидаты изменились. Выберите, кого заменить'))
      } else {
        setReplaceErr(candidateError(error))
      }
      onSettled()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  if (existing) return slotId === existing.slotId
    ? <button type="button" onClick={() => nav(`/wedding/slot/${existing.slotId}`)} className="press text-[10.5px] font-semibold text-[var(--sage-ink)] underline underline-offset-2">{t('✓ Уже в кандидатах')}</button>
    : <span role="status" className="text-[10.5px] font-semibold text-[var(--sage-ink)]">{t('✓ Добавлено — обновляем место…')}</span>
  if (!weddingId || (!canAdd && !replace && !err)) return null

  return (
    <>
      {canAdd && <button type="button" disabled={busy} onClick={() => void add()} className="press px-3.5 h-9 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[11px] font-semibold disabled:opacity-50">
        {busy ? t('Добавляем…') : t('В кандидаты')}
      </button>}
      {err && <p role="alert" className="text-[10.5px] text-[var(--rose-ink)] mt-1.5">{err}</p>}
      {replace && <ShortlistReplaceDialog
        entries={replace}
        incomingName={vendorName}
        busy={busy}
        error={replaceErr}
        onClose={() => { if (!busy) { setReplace(null); setReplaceErr(null) } }}
        onReplace={entry => void replaceEntry(entry)}
      />}
    </>
  )
}

/** Кандидатские действия не притворяются пустыми, пока права и места ещё неизвестны. */
function CandidateLoadState({ active, slotsState, roles, shortlist, readsShortlist, hasSlot, retrySlots }: {
  active: boolean
  slotsState: 'idle' | 'loading' | 'ready' | 'error'
  roles: ReturnType<typeof useApi>
  shortlist: ReturnType<typeof useApi>
  readsShortlist: boolean
  hasSlot: boolean
  retrySlots: () => void
}) {
  if (!active) return null
  if (!ready(roles)) return <div className="mt-2"><AsyncState q={roles} /></div>
  if (slotsState === 'error') return <div className="mt-2"><ErrorState error={t('Сервер недоступен. Попробуйте позже')} retry={retrySlots} /></div>
  if (slotsState !== 'ready') return <p className="mt-2 py-2 text-center text-[11px] text-[var(--soft)]">{t('Проверяем доступ…')}</p>
  if (readsShortlist && hasSlot && (!ready(shortlist) || shortlist.refreshing)) {
    if (shortlist.refreshing) return <p className="mt-2 py-2 text-center text-[11px] text-[var(--soft)]">{t('Проверяем доступ…')}</p>
    return <div className="mt-2"><AsyncState q={shortlist} /></div>
  }
  return null
}

/* Каталог категорий */
export function SearchCategories() {
  const nav = useNavigate()
  const { slots, city, weddingDate } = useStore()
  const [q, setQ] = useState('')
  const stateOf = (id: string) => slots.find(s => s.categoryId === id)?.state

  /* С городом свадьбы: под категорией — сколько опубликованных анкет в нём
     (план миграции §2.7). Раньше число было выдумкой мока, потом его сняли;
     теперь его считает сервер, и без ответа строки нет (R-178). */
  const cats = useApi(() => getCategories(city), [city])
  /* Подрядчиков ищем на сервере, а не фильтруем загруженное: в базе их
     полторы тысячи, и «показать всех, потом отфильтровать» здесь не работает.
     Спрашиваем от двух символов — на одном выдача бессмысленна. */
  const search = q.trim()
  const found = useApi(
    () => search.length >= 2
      ? getVendors({ q: search, city, date: weddingDate, limit: 5 })
      : Promise.resolve({ items: [] }),
    [search, city, weddingDate],
  )

  const list = (cats.data ?? []).filter(c => (c.title ?? '').toLowerCase().includes(q.toLowerCase()))
  const foundVendors = found.data?.items ?? []

  return (
    <div className="pb-28">
      <TopBar title={t('Все специалисты')} sub={ready(cats) ? `${cats.data?.length ?? 0}${t(' категорий · ')}${t(city)}` : t(city)} />
      <div className="px-5 mt-2">
        <div className="card-s flex items-center gap-2.5 px-4 py-3.5">
          <SearchIcon size={17} className="text-[var(--soft)]" />
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('Фотограф, торт, шатёр…')} className="bg-transparent outline-none text-[14px] w-full placeholder:text-[var(--soft2)]" />
        </div>
      </div>
      {cats.loading && <p className="px-5 mt-6 text-[12px] text-[var(--soft)]">{t('Загружаем каталог…')}</p>}
      {cats.error && <ErrorState error={cats.error} retry={cats.reload} />}
      {cats.forbidden && (
        <div className="py-6 text-center">
          <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed px-6">{cats.forbiddenText}</p>
          <button onClick={() => nav('/auth')} className="press mt-3 px-5 h-[40px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Войти')}</button>
        </div>
      )}
      <div className="px-5 grid grid-cols-3 gap-2.5 mt-4 stagger">
        {list.map(c => {
          const st = stateOf(c.id ?? '')
          return (
            <button key={c.id} onClick={() => nav(`/search/${c.id}`)} className="press card-s p-3 text-center fade-up">
              <div className={cn('w-11 h-11 rounded-[14px] mx-auto flex items-center justify-center text-[19px]', CATEGORY_TILE[c.id ?? ''] ?? DEFAULT_TILE)}>{c.icon}</div>
              <b className="text-[11px] block mt-2 leading-tight">{c.title}</b>
              {typeof c.vendorsCount === 'number' && c.vendorsCount > 0 && (
                <span className="block text-[9.5px] text-[var(--soft)] mt-0.5 tabular">{c.vendorsCount} {t('рядом')}</span>
              )}
              {st === 'booked' && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] mt-1.5">{t('✓ Есть')}</span>}
              {(st === 'hold' || st === 'candidate') && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[var(--honey)] text-[var(--honey-ink)] mt-1.5">{t('⏳ Ищем')}</span>}
            </button>
          )
        })}
      </div>
      {/* Поиск по имени — отдельный запрос со своими состояниями: раньше отказ
          на нём выглядел как «никого не нашлось». */}
      {search.length >= 2 && found.loading && <p className="px-5 mt-4 text-[12px] text-[var(--soft)]">{t('Ищем подрядчиков…')}</p>}
      {found.error && <ErrorState error={found.error} retry={found.reload} />}
      {found.forbidden && (
        <div className="py-6 text-center">
          <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed px-6">{found.forbiddenText}</p>
          <button onClick={() => nav('/auth')} className="press mt-3 px-5 h-[40px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Войти')}</button>
        </div>
      )}
      {foundVendors.length > 0 && (
        <div className="px-5 mt-5">
          <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1">{t('Подрядчики')}</span>
          <div className="space-y-2.5 mt-2 stagger">
            {foundVendors.map(v => (
              <VendorCard key={v.id} v={v} onOpen={() => nav(`/vendor/${v.id}`)} />
            ))}
          </div>
        </div>
      )}
      {!cats.loading && !cats.error && !cats.forbidden && !found.forbidden && list.length === 0 && !foundVendors.length && (
        <div className="px-5 mt-10 text-center fade-up">
          <div className="w-16 h-16 rounded-[22px] bg-[var(--rose-soft)] mx-auto flex items-center justify-center text-[26px]">🔍</div>
          <b className="text-[15px] block mt-4">{t('Ничего не нашлось')}</b>
          <p className="text-[12px] text-[var(--soft)] mt-1.5">{t('Попробуйте другое слово — или спросите Тиля — он подскажет категорию')}</p>
          <button onClick={() => nav('/assistant')} className="press mt-5 px-6 h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Спросить Тиля')}</button>
        </div>
      )}
    </div>
  )
}
export function VendorList() {
  const { catId = 'photo' } = useParams()
  const nav = useNavigate()
  const { city, weddingDate, weddingId, slots, slotsState, refreshSlots } = useStore()
  const [filter, setFilter] = useState('free')
  const [showFilters, setShowFilters] = useState(true)
  /* Радиус поиска (фича 011, блокер №16). Умолчание 100 — ровно то, что сервер
     делал и молча: анкета из Бирска приходила в выдачу «Уфа» без единого
     слова об этом. Теперь радиус виден и меняется: «только город» → 0. */
  const [radius, setRadius] = useState(100)

  const cats = useApi(() => getCategories(), [])
  const cat = (cats.data ?? []).find(c => c.id === catId)
  const slot = slots.find(s => s.categoryId === catId)
  const myWeddings = useApi(() => weddingId ? listMyWeddings() : Promise.resolve([]), [weddingId])
  const role = myWeddings.data?.find(w => w.id === weddingId)?.role
  const canReadShortlist = role === 'couple' || role === 'helper' || role === 'coordinator'
  const shortlist = useApi(
    () => weddingId && slot?.id && canReadShortlist ? getShortlist(weddingId, slot.id) : Promise.resolve([] as ShortlistEntry[]),
    [weddingId, slot?.id, canReadShortlist],
  )
  const candidateAccessReady = ready(myWeddings) && slotsState === 'ready'
  const canManageCandidates = candidateAccessReady
    && (role === 'couple' || (role === 'helper' && !!slot))
  const canAddCandidate = canManageCandidates
    && !shortlist.refreshing
    && (!slot || ready(shortlist))
  const [justAdded, setJustAdded] = useState<{ scope: string; entry: ShortlistEntry } | null>(null)
  const shortlistScope = `${weddingId ?? ''}:${catId}`
  const shortlistEntries = [
    ...(shortlist.data ?? []),
    ...(justAdded?.scope === shortlistScope && !shortlist.data?.some(entry => entry.id === justAdded.entry.id) ? [justAdded.entry] : []),
  ]

  /*
   * Фильтры отрабатывает сервер, а не браузер.
   *
   * «Свободны на дату» — параметр `date`: сервер убирает из выдачи занятых.
   * Раньше это делалось по мок-полю `freeOnDate`, которого на сервере нет и
   * быть не может — занятость живёт в календарях подрядчиков.
   * Сортировка по рейтингу и цене — тоже параметр: фильтровать локально
   * страницу из тридцати записей значит показывать «топ» из случайной
   * тридцатки, а не из полутора тысяч.
   */
  const filters: VendorFilters = {
    categoryId: catId,
    city,
    date: filter === 'free' ? weddingDate : null,
    hasVideo: filter === 'video' ? true : undefined,
    ratingMin: filter === 'top' ? 4.8 : undefined,
    priceMax: filter === 'budget' ? 10_000_000 : undefined,
    sort: filter === 'budget' ? 'price_asc' : 'rating',
    limit: 30,
    radiusKm: radius,
  }
  const list = useApi(() => getVendors(filters), [catId, city, weddingDate, filter, radius])

  /*
   * Страницы после первой.
   *
   * Сервер отдаёт тридцать анкет и `nextCursor`; раньше курсор не читался, и
   * категория из двух тысяч анкет заканчивалась на тридцатой без единого
   * слова об этом (ревью D5-05). Дочитанные страницы привязаны к ключу
   * запроса: сменился фильтр или город — первая страница едет заново, а
   * хвост прошлого запроса к ней не пришивается.
   */
  const pageKey = [catId, city, weddingDate ?? '', filter, radius].join('|')
  const [more, setMore] = useState<{ key: string; items: Vendor[]; next: string | null }>({ key: '', items: [], next: null })
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreErr, setMoreErr] = useState<string | null>(null)
  /*
   * Заявка консьержу (План §18.12, фича 008, экран 18). Пока анкет в городе
   * мало, пустая выдача честно предлагает подбор руками за сутки: путь
   * `POST /catalog/concierge` был в контракте, а экрана к нему не было —
   * пустая категория предлагала лишь спросить Тиля. Состояние привязано к
   * категории: экран один на все `/search/:catId`, и принятая заявка
   * фотографа не должна закрывать форму декоратору. После 201 форма закрыта,
   * вместо кнопки — итог: второе нажатие было бы второй заявкой и 409.
   */
  const [concierge, setConcierge] = useState<{ cat: string; step: 'closed' | 'open' | 'sent'; budget: string; comment: string }>({ cat: '', step: 'closed', budget: '', comment: '' })
  const cz = concierge.cat === catId ? concierge : { cat: catId, step: 'closed' as const, budget: '', comment: '' }
  const setCz = (patch: Partial<typeof cz>) => setConcierge({ ...cz, ...patch })
  const [czBusy, setCzBusy] = useState(false)
  const [czErr, setCzErr] = useState<string | null>(null)
  /* Город заявки — город СВАДЬБЫ, если она есть (фича 014, A6): консьерж
     ищет подрядчика туда, где свадьба, а не туда, где телефон. Стор — запас:
     без свадьбы или пока её карточка не пришла. Отказ на этом запросе экран
     каталога не роняет — он не про каталог. */
  const wedding = useApi(() => (weddingId ? getWedding(weddingId).catch(() => null) : Promise.resolve(null)), [weddingId])
  const conciergeCity = wedding.data?.city?.name || city
  const sendConcierge = async () => {
    setCzBusy(true)
    setCzErr(null)
    try {
      /* Бюджет вводится целыми рублями, уходит копейками (`Money`, инвариант §5.7). */
      const budget = cz.budget ? rub(Number(cz.budget)) : undefined
      const comment = cz.comment.trim()
      await requestConcierge(catId, { ...(budget !== undefined ? { budget } : {}), ...(comment ? { comment } : {}), ...(conciergeCity ? { city: conciergeCity } : {}) })
      setCz({ step: 'sent' })
    } catch (e) { setCzErr(explainError(e)) } finally { setCzBusy(false) }
  }
  const tail = more.key === pageKey ? more : null
  const nextCursor = tail ? tail.next : (list.data?.nextCursor ?? null)
  const shown = [...(list.data?.items ?? []), ...(tail?.items ?? [])]

  const loadMore = async () => {
    if (!nextCursor || moreBusy) return
    setMoreBusy(true)
    setMoreErr(null)
    try {
      const page = await getVendors({ ...filters, cursor: nextCursor })
      setMore(m => ({
        key: pageKey,
        items: [...(m.key === pageKey ? m.items : []), ...(page?.items ?? [])],
        next: page?.nextCursor ?? null,
      }))
    } catch (e) {
      setMoreErr(explainError(e))
    } finally {
      setMoreBusy(false)
    }
  }

  /* Подпись — по фактическому параметру запроса, а не «рекомендованные»:
     уходит `sort=rating`, для чипа «до 100 тыс» — `price_asc`. Число «рядом»
     называется только когда список дочитан до конца; пока есть курсор, это
     размер страницы, а не число подрядчиков. */
  const sortLabel = filter === 'budget' ? t('сначала дешевле') : t('по рейтингу')
  /* Радиус в подписи — тот, что ушёл в запрос: «рядом» без километров
     читалось как «в городе», а сервер искал в сотне. */
  const radiusLabel = radius === 0 ? t('только город') : `${t('до')} ${radius} ${t('км')}`
  const sub = ready(list)
    ? `${nextCursor ? `${t('первые')} ${shown.length}` : `${shown.length} ${t('рядом')}`} · ${radiusLabel} · ${t('сортировка:')} ${sortLabel}`
    : undefined

  return (
    <div className="pb-28">
      <TopBar back title={cat?.title ?? t('Категория')} sub={sub} right={
        <button onClick={() => setShowFilters(s => !s)} className={cn('press w-10 h-10 rounded-full flex items-center justify-center', showFilters ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)]')} style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Фильтры')}>
          <SlidersHorizontal size={16} />
        </button>
      } />
      {/* Описание категории — из справочника (миграция 39): что делает
          подрядчик и что у него спросить. Нет описания — нет строки. */}
      {cat?.description && <p className="px-5 mt-1 text-[11.5px] text-[var(--soft)] leading-relaxed">{cat.description}</p>}
      {showFilters && <div className="px-5 flex gap-2 mt-2 overflow-x-auto no-scrollbar">
        {/* Подпись «свободны» — по выбранной дате, а не по вшитому 14.06: дату
            выбирает пара, и чип с чужим числом врёт. Без даты чип не нужен. */}
        {[
          ...(weddingDate ? [['free', `${t('Свободны ')}${formatWeddingDate(weddingDate)}`]] : []),
          ['video', t('С видео')], ['top', t('Рейтинг 4.8+')], ['budget', t('до 100 тыс ₽')],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', filter === id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>
            {label}
          </button>
        ))}
        {/* Сравниваем ту категорию, которую человек и открыл: без неё экран
            сравнения показывал бы избранное, а он пришёл из списка фотографов. */}
        <button onClick={() => nav(slot?.id ? `/compare?slot=${slot.id}` : `/compare?cat=${catId}`)} className="press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap bg-[var(--card)] text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{t('⇄ Сравнить')}</button>
        {/* Радиус — отдельным выбором, не чипом-переключателем: он сочетается с
            любым чипом. Смена — новый запрос и новая первая страница (ключ). */}
        <select value={radius} onChange={e => setRadius(Number(e.target.value))} aria-label={t('Радиус поиска')}
          className="press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap bg-[var(--card)] text-[var(--soft)] outline-none" style={{ boxShadow: 'var(--shadow)' }}>
          <option value={0}>{t('только город')}</option>
          {[50, 100, 300].map(km => <option key={km} value={km}>{`${t('до')} ${km} ${t('км')}`}</option>)}
        </select>
      </div>}
      <div className="px-5">
        <CandidateLoadState
          active={!!weddingId}
          slotsState={slotsState}
          roles={myWeddings}
          shortlist={shortlist}
          readsShortlist={canReadShortlist}
          hasSlot={!!slot}
          retrySlots={refreshSlots}
        />
      </div>
      <div className="px-5 mt-4 space-y-3.5 stagger">
        {list.loading && <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Загружаем каталог…')}</p>}
        {/* Перезапрашиваем оба: при недоступном сервере падает и список, и
            справочник категорий, а без второго у экрана нет даже названия. */}
        {(list.error || cats.error) && (
          <ErrorState error={(list.error ?? cats.error)!} retry={() => { list.reload(); cats.reload() }} />
        )}
        {(list.forbidden || cats.forbidden) && (
          <div className="py-6 text-center">
            <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed px-6">{list.forbiddenText ?? cats.forbiddenText}</p>
            <button onClick={() => nav('/auth')} className="press mt-3 px-5 h-[40px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Войти')}</button>
          </div>
        )}
        {shown.map(v => (
          <VendorCard key={v.id} v={v}
            categoryTitle={cat?.title}
            categoryIcon={cat?.icon}
            tile={CATEGORY_TILE[catId] ?? DEFAULT_TILE}
            freeOnDate={filter === 'free' && !!weddingDate}
            candidateAction={v.id && (canManageCandidates || shortlistEntries.some(entry => entry.vendor?.id === v.id)) ? <CandidateControl
              weddingId={weddingId}
              slotId={slot?.id}
              vendorId={v.id}
              vendorName={v.name ?? t('Подрядчик')}
              entries={shortlistEntries}
              canAdd={canAddCandidate}
              onAdded={entry => setJustAdded({ scope: shortlistScope, entry })}
              onSettled={() => { shortlist.reload(); refreshSlots() }}
            /> : undefined}
            candidateStatus={candidateAccessReady && role === 'helper' && !slot ? t('Сначала пара должна добавить это место в свадьбу') : undefined}
            onOpen={() => nav(`/vendor/${v.id}`)} />
        ))}
        {/* Кнопка стоит, пока сервер отдаёт курсор: без него список дочитан. */}
        {ready(list) && nextCursor && (
          <div className="text-center pt-1">
            {moreErr && <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed mb-2">{moreErr}</p>}
            <button disabled={moreBusy} onClick={() => void loadMore()} className="press px-6 h-[44px] rounded-full card-s text-[12.5px] font-semibold disabled:opacity-50">
              {moreBusy ? t('Загружаем ещё…') : t('Показать ещё')}
            </button>
          </div>
        )}
        {!list.loading && !list.error && !cats.error && !list.forbidden && !cats.forbidden && shown.length === 0 && (
          <div className="text-center py-10 fade-up">
            <b className="text-[14px]">{t('Под фильтр никто не подходит')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5">{t('Смягчите условия — или спросите Тиля, он расширит поиск')}</p>
            {/* Только вошедшему: путь требует токен, кнопка с заведомым 401
                равна кнопке без действия (R-176). Слова итога — ровно те, что
                обещает контракт: подбор вручную, ответ в течение суток. */}
            {isAuthorized() && (
              cz.step === 'sent' ? (
                <p className="text-[12px] font-semibold text-[var(--sage-deep)] mt-4">{t('Заявка принята — свяжемся в течение суток')}</p>
              ) : cz.step === 'open' ? (
                <div className="card p-4 mt-4 text-left space-y-2.5">
                  <p className="text-[12.5px] font-semibold">{t('Заявка консьержу')}</p>
                  <p className="text-[11px] text-[var(--soft)]">{t('Бюджет и пожелания — необязательно, но с ними подбор точнее')}</p>
                  <div className="flex items-center gap-2 h-11 px-4 rounded-full bg-[var(--bg)]">
                    <input value={cz.budget} onChange={e => setCz({ budget: e.target.value.replace(/\D/g, '').slice(0, 9) })} inputMode="numeric" aria-label={t('Бюджет, ₽')} placeholder={t('Бюджет, ₽')} className="flex-1 bg-transparent text-[13px] outline-none tabular" />
                    <span className="text-[13px] text-[var(--soft)]">₽</span>
                  </div>
                  <textarea value={cz.comment} onChange={e => setCz({ comment: e.target.value })} maxLength={2000} rows={3} aria-label={t('Комментарий')} placeholder={t('Что важно: стиль, пожелания, сроки')}
                    className="w-full rounded-2xl bg-[var(--bg)] px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] resize-y" />
                  {czErr && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed">{czErr}</p>}
                  <div className="flex gap-2.5">
                    <button onClick={() => setCz({ step: 'closed' })} className="press flex-1 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
                    <button disabled={czBusy} onClick={() => void sendConcierge()} className="press flex-1 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{czBusy ? t('Отправляем…') : t('Отправить')}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setCz({ step: 'open' })} className="press mt-4 px-6 h-[44px] rounded-full grad text-[var(--on-grad)] text-[12.5px] font-semibold">{t('Оставить заявку консьержу')}</button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* Анкета подрядчика */
/*
 * Обёртка с `key` по идентификатору: состояние экрана — выбранный пакет,
 * «в моей свадьбе», ошибка, хвост отзывов — принадлежит одной анкете. Переход
 * с анкеты на похожую снизу менял только `id`, и галочка «добавлен» с ошибкой
 * прежнего подрядчика оставались на новом (ревью 015).
 */
export function VendorDetail() {
  const { id } = useParams()
  return <VendorDetailView key={id ?? ''} id={id} />
}

function VendorDetailView({ id }: { id: string | undefined }) {
  const nav = useNavigate()
  const location = useLocation()
  const { slots, slotsState, bookVendor, city, weddingDate, weddingId, refreshSlots } = useStore()
  const [pkg, setPkg] = useState(0)
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [replaceBusy, setReplaceBusy] = useState(false)
  const [replaceError, setReplaceError] = useState<string | null>(null)
  const [replaced, setReplaced] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* Жалоба на анкету (§18.2) — своя шторка, `POST /complaints`. */
  const [complaint, setComplaint] = useState(false)
  /* «Поделиться» без Web Share (десктоп) копирует текст молча — как и в
     других местах, подтверждаем словом (живой обход ролей). */
  const [shared, setShared] = useState(false)

  const detail = useApi(() => id ? getVendor(id) : Promise.resolve(null), [id])
  const cats = useApi(() => getCategories(), [])
  const v = detail.data
  const cat = (cats.data ?? []).find(c => c.id === v?.categoryId)
  /* Занятость — с сервера, а не из хеша по идентификатору. Раньше «занятые»
     даты рисовались формулой от строки: календарь выглядел настоящим и врал. */
  /* Без даты свадьбы календарь показывает ТЕКУЩИЙ месяц — и занятость за
     него действительно запрашивается. Раньше `month` был пустой строкой:
     заголовок пустой, сетка в ноль клеток, запроса нет вовсе — а подпись под
     карточкой обещала «показаны занятые дни месяца». Обещание без данных
     (R-174/R-178, F-RL-8-09). Месяц — местный (R-293). */
  const month = weddingDate ? weddingDate.slice(0, 7) : currentMonth()
  const avail = useApi(
    () => id && month ? getAvailability(id, month) : Promise.resolve({ busyDates: [] as string[], holdDates: [] as string[] }),
    [id, month],
  )
  const busyDates = avail.data?.busyDates ?? []
  /* Мягкая бронь другой пары (`holdDates`, План §18.3): дата не занята и не
     свободна — переговоры идут. До ревью 015 экран смотрел только на занятые
     и ставил «Свободен на вашу дату» под днём, который вот-вот уйдёт (FB2). */
  const holdDates = avail.data?.holdDates ?? []
  /* Длина месяца и его первый день недели: тридцать клеток подряд врали в
     феврале и в месяцах на 31 день. */
  const grid = monthGrid(month)
  /* «Свободен на вашу дату» — только когда занятость пришла. Пустой список
     занятых дней при отказе сервера превращался в зелёный значок и «дата
     свободна» — по нему бронируют. */
  const availKnown = ready(avail)
  const heldOnDate = availKnown && !!weddingDate && holdDates.includes(weddingDate)
  const freeOnDate = availKnown && !!weddingDate && !busyDates.includes(weddingDate) && !heldOnDate
  /* Отзывы — публичная лента этого подрядчика, а не общая заготовка. */
  const reviews = useApi(() => id ? getVendorReviews(id) : Promise.resolve(null), [id])
  /*
   * Страницы отзывов после первой. Лента отдаётся по десять с курсором;
   * раньше курсор не читался, и «47 отзывов» в шапке кончались на десятом
   * без кнопки «ещё» (ревью D5-26а). Хвост привязан к анкете: открыли другую
   * — он не пришивается к её первой странице.
   */
  const [moreReviews, setMoreReviews] = useState<{ vendorId: string; items: components['schemas']['Review'][]; next: string | null }>({ vendorId: '', items: [], next: null })
  const [reviewsBusy, setReviewsBusy] = useState(false)
  const [reviewsErr, setReviewsErr] = useState<string | null>(null)
  const reviewsTail = moreReviews.vendorId === id ? moreReviews : null
  const reviewsCursor = reviewsTail ? reviewsTail.next : (reviews.data?.nextCursor ?? null)
  const reviewItems = [...(reviews.data?.items ?? []), ...(reviewsTail?.items ?? [])]

  const loadMoreReviews = async () => {
    if (!id || !reviewsCursor || reviewsBusy) return
    setReviewsBusy(true)
    setReviewsErr(null)
    try {
      const page = await getVendorReviews(id, 10, reviewsCursor)
      setMoreReviews(m => ({
        vendorId: id,
        items: [...(m.vendorId === id ? m.items : []), ...(page?.items ?? [])],
        next: page?.nextCursor ?? null,
      }))
    } catch (e) {
      setReviewsErr(explainError(e))
    } finally {
      setReviewsBusy(false)
    }
  }

  /* Похожие — свободные на дату свадьбы: подпись под календарём обещает
     «похожих свободных ниже», а список без даты показывал и занятых (ревью 015). */
  const similar = useApi(
    () => v?.categoryId ? getVendors({ categoryId: v.categoryId, city, date: weddingDate, limit: 6 }) : Promise.resolve({ items: [] }),
    [v?.categoryId, city, weddingDate],
  )
  /*
   * Своя анкета глазами пары (фича 007). Владельца сервер пускает и к
   * неопубликованной — с `published`/`blocked` в ответе (контракт v0.30.1);
   * опубликованная своя приходит как любая другая, и узнать её можно только
   * по своей анкете кабинета (`GET /vendor/profile` → `id`). Отказ на этом
   * запросе — 404 у пары без анкеты, 403, лежащий сервер — не про этот экран:
   * пока владелец не опознан, экран остаётся экраном пары. Кнопки самому себе
   * («Написать», «Добавить в свадьбу») заменяются ссылкой на мастер.
   */
  const own = useApi(() => getVendorProfile().catch(() => null), [])
  const mine = !!v?.id && ((!!own.data?.id && own.data.id === v.id) || v.published !== undefined || v.blocked !== undefined)
  const replaceSlotId = new URLSearchParams(location.search).get('replaceSlot')
  const replaceIntent = !!replaceSlotId
  const slot = slots.find(s => s.categoryId === v?.categoryId)
  const requestedReplaceSlot = replaceSlotId ? slots.find(s => s.id === replaceSlotId) : undefined
  const myWeddings = useApi(() => weddingId ? listMyWeddings() : Promise.resolve([]), [weddingId])
  const role = myWeddings.data?.find(w => w.id === weddingId)?.role
  const canReadShortlist = role === 'couple' || role === 'helper' || role === 'coordinator'
  const shortlistSlot = replaceIntent ? requestedReplaceSlot : slot
  const shortlist = useApi(
    () => weddingId && shortlistSlot?.id && canReadShortlist ? getShortlist(weddingId, shortlistSlot.id) : Promise.resolve([] as ShortlistEntry[]),
    [weddingId, shortlistSlot?.id, canReadShortlist],
  )
  const candidateAccessReady = ready(myWeddings) && slotsState === 'ready'
  const canManageCandidates = candidateAccessReady
    && (role === 'couple' || (role === 'helper' && !!slot))
  const canAddCandidate = canManageCandidates
    && !shortlist.refreshing
    && (!slot || ready(shortlist))
  const [justAdded, setJustAdded] = useState<{ scope: string; entry: ShortlistEntry } | null>(null)
  const shortlistScope = `${weddingId ?? ''}:${v?.categoryId ?? ''}`
  const shortlistEntries = [
    ...(shortlist.data ?? []),
    ...(justAdded?.scope === shortlistScope && !shortlist.data?.some(entry => entry.id === justAdded.entry.id) ? [justAdded.entry] : []),
  ]
  const candidateEntry = v?.id ? shortlistEntries.find(entry => entry.vendor?.id === v.id) : undefined
  const alreadyCandidate = !!candidateEntry
  const replaceEntry = replaceIntent && v?.id
    ? shortlistEntries.find(entry => entry.vendor?.id === v.id && entry.available === true && entry.occupancy !== 'busy')
    : undefined
  const replaceReady = candidateAccessReady && ready(shortlist) && ready(detail)
  const canReplace = replaceReady
    && role === 'couple'
    && !!replaceSlotId
    && !!requestedReplaceSlot
    && requestedReplaceSlot.categoryId === v?.categoryId
    && requestedReplaceSlot.state === 'booked'
    && !!requestedReplaceSlot.dealId
    && requestedReplaceSlot.dealState !== 'done'
    && requestedReplaceSlot.vendorId !== v?.id
    && !!replaceEntry
  const replaceIntentError = !replaceIntent || replaceError || replaced || !replaceReady ? null
    : role !== 'couple' ? t('Замену брони может подтвердить только пара')
    : !requestedReplaceSlot || requestedReplaceSlot.categoryId !== v?.categoryId
      || requestedReplaceSlot.state !== 'booked' || !requestedReplaceSlot.dealId
      || requestedReplaceSlot.dealState === 'done' || requestedReplaceSlot.vendorId === v?.id
      ? t('Это место больше нельзя заменить из этой анкеты')
      : !replaceEntry ? t('Этот кандидат больше не доступен для замены')
      : null
  /* Этот подрядчик уже в слоте свадьбы (кандидат, бронь, оплата): кнопка
     «Добавить в свадьбу» вела бы в 409 `slot_taken` с советом «сначала
     отмените сделку» — про сделку с ним же. Вместо неё — путь к сделке
     (живой обход ролей). Занят ли слот другим — решает сервер, как и раньше. */
  const dealHere = slot && slot.state !== 'empty' && slot.vendorId === v?.id && slot.dealId ? slot.dealId : null
  /* Телефон показывается только тому, кто этого подрядчика забронировал
   * (решение владельца 2026-09-03). До брони разговор идёт в чате: номер
   * в открытом каталоге — это готовая база для обзвона.
   * Решает сервер, а не экран: `phone` приходит заполненным только паре с
   * бронью, иначе null. Поэтому блок контакта смотрит на само поле, а не на
   * состояние слота в браузере — иначе локальная запись могла бы обещать
   * номер, которого сервер не прислал, или скрыть присланный. */

  /*
   * Бронь необратима: она занимает дату в календаре подрядчика. Поэтому
   * галочка «в моей свадьбе» ставится только после ответа сервера, а не
   * сразу по нажатию. Раньше `setAdded(true)` стоял безусловно — экран
   * рапортовал об успехе даже тогда, когда бронировать было нечего.
   *
   * Мозаика — 12 слотов из шаблона, а категорий в каталоге 35. Подрядчику из
   * категории вне шаблона слот заводится тут же (`POST …/slots`, фича 014, A1):
   * раньше кнопка упиралась в надпись «категория не входит в мозаику», и
   * аниматора было некуда забронировать. Слот уже есть — сервер называет его
   * (409 `slot_exists`), бронь идёт в него.
   */
  const add = async () => {
    const price = v?.packages?.[pkg]?.price?.amount
    if (!v?.id || price == null) { setErr(t('У этого подрядчика не указана цена пакета')); return }
    if (!v.categoryId || !weddingId) { setErr(t('Сначала заведите свадьбу')); return }
    setErr(null)
    setBusy(true)
    try {
      const slotId = slot?.id ?? (await ensureSlotForCategory(weddingId, v.categoryId))
      /* Выбранный пакет уходит в бронь: сделка помнит, что именно продано
         (`Deal.packageName`, фича 005). До ревью 015 цена бралась из пакета,
         а сам пакет — нет, и в кабинете подрядчика стояло «без пакета» (FB1). */
      await bookVendor(slotId, v.id, price, v.packages?.[pkg]?.id)
      setAdded(true)
    } catch (e) {
      setErr(explainError(e))
    } finally {
      setBusy(false)
    }
  }

  const replaceBooking = async () => {
    const price = v?.packages?.[pkg]?.price?.amount
    const replaceWeddingId = weddingId
    if (!canReplace || !replaceWeddingId || !requestedReplaceSlot || !v?.id || price == null || replaceBusy) return
    setReplaceError(null)
    setReplaceBusy(true)
    let oldBookingCancelled = false
    try {
      await (requestedReplaceSlot.external
        ? removeExternal(replaceWeddingId, requestedReplaceSlot.id)
        : cancelSlot(replaceWeddingId, requestedReplaceSlot.id))
      oldBookingCancelled = true
      await bookSlot(replaceWeddingId, requestedReplaceSlot.id, v.id, price, v.packages?.[pkg]?.id)
      setReplaced(true)
    } catch (error) {
      const detail = explainError(error)
      setReplaceError(oldBookingCancelled
        ? `${t('Старая бронь уже отменена, но новую подтвердить не удалось')}: ${detail}`
        : detail)
    } finally {
      setReplaceBusy(false)
      /* Сначала завершены обе операции, поэтому только один перечитанный
         снимок состояния может обновить форму после замены. */
      refreshSlots()
    }
  }

  const openChat = async () => {
    if (!v?.id) return
    setErr(null)
    setChatBusy(true)
    try {
      nav(await chatRouteForVendor(v.id))
    } catch (e) {
      setErr(explainError(e))
    } finally {
      setChatBusy(false)
    }
  }

  /* Переход после галочки — эффектом с отменой, а не голым setTimeout в
     обработчике. Несмонтированный экран не должен через 900 мс утащить
     человека на /wedding со страницы, которую он за это время открыл сам. */
  useEffect(() => {
    if (!added) return
    const id = setTimeout(() => nav('/wedding'), 900)
    return () => clearTimeout(id)
  }, [added, nav])

  /* Пока анкеты нет — состояние, а не пустой экран. Раньше отсутствие
     подрядчика подменялось первым из мок-списка: открыв чужую ссылку,
     человек видел чью-то чужую анкету вместо «не нашлось». */
  if (!v) return (
    <div className="pb-44">
      <TopBar back title={t('Анкета подрядчика')} sub={city} />
      <div className="px-5 mt-8 text-center fade-up">
        {detail.loading && <p className="text-[12.5px] text-[var(--soft)]">{t('Загружаем анкету…')}</p>}
        {detail.error && <ErrorState error={detail.error} retry={() => { detail.reload(); cats.reload() }} />}
        {detail.forbidden && (
          <>
            <p role="alert" className="text-[12.5px] text-[var(--rose-ink)] leading-relaxed">{detail.forbiddenText}</p>
            <button onClick={() => nav('/auth')} className="press mt-3 px-5 h-[40px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Войти')}</button>
          </>
        )}
        {!detail.loading && !detail.error && !detail.forbidden && <p className="text-[12.5px] text-[var(--soft)]">{t('Анкета не найдена')}</p>}
      </div>
    </div>
  )

  return (
    <div className="pb-32">
      <TopBar back title={cat?.title ?? t('Анкета подрядчика')} sub={t('Анкета подрядчика')} right={
        <button onClick={() => {
          const data = { title: `${v.name}${t(' — Тили-тили')}`, text: `${cat?.title ?? ''} · ${t(city)}${v.priceFrom?.amount != null ? `${t(' · от ')}${fmt(v.priceFrom.amount)}` : ''}`, url: window.location.href }
          if (navigator.share) navigator.share(data).catch(() => {})
          else { copyText(`${data.title}\n${data.text}\n${data.url}`); setShared(true); setTimeout(() => setShared(false), 1500) }
        }} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[11.5px] font-semibold text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{shared ? t('Скопировано') : t('Поделиться')}</button>
      } />
      {/* Что видят пары на самом деле: `published`/`blocked` приходят только
          владельцу, и его надо предупредить прежде, чем он начнёт проверять
          цены. Блокировка — сильнее «не опубликована»: публикация закрыта. */}
      {v.blocked ? (
        <p role="alert" className="mx-5 mt-2 rounded-2xl bg-[var(--rose-soft)] px-4 py-3 text-[12px] font-semibold text-[var(--rose-ink)] leading-relaxed">{t('Анкета заблокирована модератором — в каталоге её нет, публикация закрыта')}</p>
      ) : v.published === false ? (
        <p role="alert" className="mx-5 mt-2 rounded-2xl bg-[var(--honey)] px-4 py-3 text-[12px] font-semibold text-[var(--honey-ink)] leading-relaxed">{t('Анкета не опубликована — пары её пока не видят')}</p>
      ) : null}
      {/* Галерея */}
      <div className="px-5 mt-2">
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {Array.from({ length: Math.max(1, v.gallery?.length ?? 1) }).map((_, k) => (
            <div key={k} className={cn('relative w-[200px] h-[250px] rounded-[22px] shrink-0', CATEGORY_TILE[v.categoryId ?? ''] ?? DEFAULT_TILE)} style={{ boxShadow: 'var(--shadow)' }}>
              <div className="absolute inset-0 rounded-[22px]" style={{ background: `radial-gradient(circle at ${30 + k * 15}% ${25 + k * 10}%, rgba(255,255,255,.7), transparent 60%)` }} />
              <span className="absolute inset-0 flex items-center justify-center text-[44px]">{cat?.icon}</span>
              {/* Длительность ролика сервер не отдаёт — «1:40» стояло у всех
                  одинаковым. Значок говорит только то, что известно: видео есть. */}
              {k === 0 && v.hasVideo && (
                <span className="absolute bottom-3 left-3 flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1.5 rounded-full bg-black/50 text-white"><Play size={10} /> {t('видео')}</span>
              )}
            </div>
          ))}
        </div>
        {/* Подпись считает настоящие кадры. «5 фото · видео до 3 минут» стояло
            константой и у анкеты без единого файла. */}
        <p className="text-[10px] text-[var(--soft)] mt-2 text-center">
          {v.gallery?.length
            ? `${v.gallery.length} ${plural(v.gallery.length, t('фото'), t('фото'), t('фото'))}${v.hasVideo ? t(' · видео') : ''}`
            : t('Фото появятся, когда подрядчик их загрузит')}
        </p>
      </div>

      <div className="px-5 mt-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="font-serif-d text-[26px]">{v.name}</h1>
            <p className="text-[12px] text-[var(--soft)] mt-1 flex items-center gap-1.5">
              {/* Город — из анкеты; «+ 100 км» стояло константой у всех: радиуса
                  выезда сервер не знает, а каталог ищет по точному городу. */}
              <MapPin size={12} /> {v.city ?? t(city)}
              {/* Ветка — по самой оценке: сервер прячет её до третьего отзыва,
                  и у анкеты с двумя отзывами здесь стояла пустая звезда и
                  «2 отзывов» (ревью D5-02). */}
              {v.rating != null
                ? <span>· ★ {v.rating}{v.reviewsCount != null ? ` · ${v.reviewsCount} ${plural(v.reviewsCount, t('отзыв'), t('отзыва'), t('отзывов'))}` : ''}</span>
                : (v.reviewsCount ?? 0) > 0
                  ? <span>· {reviewsPendingRating(v.reviewsCount ?? 0)}</span>
                  : <span>{t('· Новый на платформе')}</span>}
            </p>
          </div>
          {freeOnDate && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] whitespace-nowrap">{t('● Свободен на вашу дату')}</span>}
        </div>
        <p className="text-[13px] text-[var(--ink2)] leading-relaxed mt-3 font-light">{v.about}</p>

        {/* Контакт: только своим — тем, кто уже забронировал */}
        <div className="card-s p-4 mt-3.5 flex items-center gap-3">
          <span className="w-9 h-9 rounded-full bg-[var(--sage-soft)] flex items-center justify-center shrink-0"><Phone size={15} className="text-[var(--sage-ink)]" /></span>
          {v.phone ? (
            <>
              <div className="flex-1 min-w-0">
                <span className="text-[9.5px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold block">{t('Телефон подрядчика')}</span>
                <a href={`tel:${(v.phone ?? '').replace(/[^+\d]/g, '')}`} className="text-[14px] font-semibold tabular">{v.phone}</a>
              </div>
              <a href={`tel:${(v.phone ?? '').replace(/[^+\d]/g, '')}`} className="press h-10 px-4 rounded-full grad text-[var(--on-grad)] text-[11.5px] font-bold flex items-center">{t('Позвонить')}</a>
            </>
          ) : (
            <p className="text-[11.5px] text-[var(--soft)] leading-relaxed">
              {t('Телефон откроется после брони — до неё пишите в чат: переписка остаётся в приложении вместе с договором.')}
            </p>
          )}
        </div>
      </div>

      {/* Проверка подрядчика.
          Карточка «Проверен · ✓ верифицирован» стояла у КАЖДОЙ анкеты, а
          признак `verified` сервер ставит только после сверки документов
          модератором. Галочка без документов — та же выдумка, что чужой
          отзыв: по ней доверяют деньги. */}
      <div className="px-5 mt-4">
        {v.verified ? (
        <div className="card p-4" style={{ border: '1.5px solid rgba(126,154,116,.4)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-[var(--sage-soft)] flex items-center justify-center text-[14px]">🛡</span>
            <b className="text-[13px]">{t('Проверен «Тили-тили»')}</b>
            <span className="ml-auto text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('✓ верифицирован')}</span>
          </div>
          <div className="mt-3 space-y-1.5 text-[11.5px] text-[var(--soft)]">
            {/*
              Здесь стояли два обещания, которых нет ни в коде, ни в контракте:
              «Оплата через эскроу: деньги заморожены до дня X» и «За отмену в
              последний момент — штраф рейтинга». Эскроу не существует —
              платёжный провайдер не подключён, и в разделе «Поддержка» то же
              приложение отвечает обратное: «оплата — напрямую подрядчику по
              договору, мы агрегатор и не являемся стороной сделки». Рейтинг
              считается только по отзывам, за отмену он не меняется. Обещать
              человеку защиту денег, которой нет, — худшее, что может сделать
              этот экран.
            */}
            <p>✓ {t('Паспорт / ИП сверены модератором')}</p>
            {/* Ниже на этом же экране сервер отдаёт отзывы с бейджем «Гость
                свадьбы» (§15): «только от пар» было неправдой (ревью D5-18). */}
            <p>✓ {t('Отзывы пар — только после сделки; отзывы гостей отмечены отдельно')}</p>
            <p>✓ {t('Договор из шаблона: предмет, сроки и стоимость письменно')}</p>
            <p>✓ {t('Отменил в последний момент — каталог сразу покажет свободных на вашу дату')}</p>
          </div>
        </div>
        ) : (
          <p className="text-[11px] text-[var(--soft)] px-1 leading-relaxed">{t('Документы этого подрядчика модератор ещё не сверял — договор и переписка остаются в приложении.')}</p>
        )}
      </div>

      {/* Пакеты */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Пакеты и цены')}</h2>
        <div className="space-y-2.5">
          {(v.packages ?? []).map((p, k) => (
            <button key={p.id ?? `${k}-${p.name}`} onClick={() => setPkg(k)} className={cn('press w-full card p-4 text-left', pkg === k && 'ring-2 ring-[var(--rose)]')}>
              <div className="flex justify-between items-center">
                <b className="text-[14px]">{p.name}</b>
                <span className={cn('font-serif-d text-[17px] font-semibold tabular', p.price?.amount != null ? 'text-[var(--rose-ink)]' : 'text-[var(--soft)] text-[12px]')}>{p.price?.amount != null ? fmt(p.price.amount) : t('цена не названа')}</span>
              </div>
              <ul className="mt-2 space-y-1">
                {(p.includes ?? []).map((it, index) => (
                  <li key={`${index}-${it}`} className="text-[11.5px] text-[var(--soft)] flex items-center gap-1.5"><Check size={11} className="text-[var(--sage-deep)]" />{it}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
        <CandidateLoadState
          active={!!weddingId}
          slotsState={slotsState}
          roles={myWeddings}
          shortlist={shortlist}
          readsShortlist={canReadShortlist}
          hasSlot={!!shortlistSlot}
          retrySlots={refreshSlots}
        />
        {replaceIntent && replaceIntentError && <p role="alert" className="mt-3 text-[11px] text-[var(--rose-ink)]">{replaceIntentError}</p>}
        {replaceIntent && !mine && (canReplace || !!replaceError || replaced) && (
          <div className="mt-3">
            {replaceError && <p role="alert" className="mb-2 text-[11px] text-[var(--rose-ink)]">{replaceError}</p>}
            {replaced ? (
              <p role="status" className="text-[11px] font-semibold text-[var(--sage-ink)]">{t('Подрядчик заменён в свадьбе')}</p>
            ) : canReplace ? (
              <button type="button" disabled={replaceBusy || v.packages?.[pkg]?.price?.amount == null} onClick={() => void replaceBooking()} className="press px-4 h-10 rounded-full grad text-[var(--on-grad)] text-[11px] font-semibold disabled:opacity-50">
                {replaceBusy ? t('Заменяем подрядчика…') : t('Заменить в свадьбе')}
              </button>
            ) : null}
          </div>
        )}
        {!replaceIntent && v.id && !mine && (canManageCandidates || alreadyCandidate) && (
          <div className="mt-3">
            <div className="flex items-center gap-3">
              <CandidateControl
                weddingId={weddingId}
                slotId={slot?.id}
                vendorId={v.id}
                vendorName={v.name ?? t('Подрядчик')}
                entries={shortlistEntries}
                canAdd={canAddCandidate}
                onAdded={entry => setJustAdded({ scope: shortlistScope, entry })}
                onSettled={() => { shortlist.reload(); refreshSlots() }}
              />
            </div>
            {role === 'couple' && weddingId && candidateEntry && (
              <>
                {candidateEntry.request && <div className="card-s rounded-[16px] p-3 mt-3 text-[11px]"><OfferSummary request={candidateEntry.request} currentWeddingDate={weddingDate} /></div>}
                <OfferRequestComposer weddingId={weddingId} slotId={candidateEntry.slotId} entries={[candidateEntry]} onChanged={shortlist.reload} />
              </>
            )}
          </div>
        )}
        {v.id && !mine && candidateAccessReady && role === 'helper' && !slot && (
          <p className="mt-3 text-[11px] text-[var(--soft)]">{t('Сначала пара должна добавить это место в свадьбу')}</p>
        )}
      </div>

      {/* Календарь */}
      <div className="px-5 mt-5">
        {/* Заголовок — тот месяц, который и нарисован. Здесь стояло «Июнь 2027»
            константой, а сетка строилась по месяцу свадьбы. */}
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{monthTitle(month)}</h2>
        <div className="card p-4">
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-[var(--soft)] font-semibold mb-1">
            {[t('Пн'),t('Вт'),t('Ср'),t('Чт'),t('Пт'),t('Сб'),t('Вс')].map(d => <span key={d}>{d}</span>)}
          </div>
          {/* Сетка — только с пришедшей занятостью: без неё каждый день
              выглядит свободным, а это и есть решение, которое здесь принимают. */}
          {!availKnown ? <AsyncState q={avail} /> : (
          <div className="grid grid-cols-7 gap-1">
            {/* Занятость приходит с сервера. Раньше «занятые» дни считались
                формулой от идентификатора: календарь выглядел настоящим и
                показывал выдуманные даты — худший вид заглушки, потому что
                по нему принимают решение. */}
            {/* Пустые клетки до первого числа: без них числа стоят не под
                своими днями недели, и «занят в субботу» читается по чужой
                колонке. */}
            {Array.from({ length: grid.blanks }).map((_, k) => <div key={`blank-${k}`} />)}
            {Array.from({ length: grid.days }).map((_, k) => {
              const day = k + 1
              const iso = month ? `${month}-${String(day).padStart(2, '0')}` : ''
              const isWedding = !!weddingDate && iso === weddingDate
              const busy = busyDates.includes(iso)
              const held = !busy && holdDates.includes(iso)
              return (
                <div key={day} className={cn('aspect-square rounded-xl flex items-center justify-center text-[11.5px] font-medium',
                  isWedding && !busy && !held ? 'grad text-[var(--on-grad)] font-bold' : busy ? 'bg-[var(--rose-soft)] text-[var(--rose-ink)] line-through' : held ? 'bg-[var(--honey)] text-[var(--honey-ink)]' : isWedding ? 'ring-2 ring-[var(--rose)] text-[var(--rose-ink)] font-bold' : 'text-[var(--ink)]')}>
                  {day}
                </div>
              )
            })}
          </div>
          )}
          <p className="text-[10px] text-[var(--soft)] mt-3 flex items-center gap-1.5"><Calendar size={11} />{!availKnown ? (avail.loading ? t('Загружаем занятость…') : t('Занятость не загрузилась — свободна ли дата, пока неизвестно')) : !weddingDate ? t('Дата свадьбы не выбрана — показаны занятые дни текущего месяца') : freeOnDate ? t('Ваша дата свободна · зачёркнуты занятые') : heldOnDate ? t('На вашу дату идут переговоры с другой парой — напишите, чтобы узнать, свободен ли он') : t('Ваша дата занята — посмотрите похожих свободных ниже')}</p>
        </div>
      </div>

      {/* Отзывы.
          Раньше здесь у КАЖДОГО подрядчика стояли одни и те же три отзыва,
          написанные в коде, — «Гульнара и Тимур», «Дина и Руслан» и «Гость
          свадьбы Алины и Тимура», — да ещё с пометкой «сделка через
          «Тили-тили» — отзыв подтверждён». Пара выбирала человека по чужой
          выдумке, а подрядчику приписывались слова, которых о нём никто не
          говорил. */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Отзывы')}</h2>
        <AsyncState q={reviews} />
        {ready(reviews) && !reviewItems.length && (
          <p className="text-[11.5px] text-[var(--soft)] px-1 leading-relaxed">{t('Отзывов пока нет. Они появляются после завершённых сделок и от гостей свадеб.')}</p>
        )}
        <div className="space-y-2.5">
          {reviewItems.map(r => (
            <div key={r.id} className="card-s p-4">
              <div className="flex justify-between items-center gap-2">
                <b className="text-[12.5px]">{r.authorName}</b>
                <span className="text-[10px] text-[var(--honey-deep)] tracking-wide">{'★'.repeat(r.rating ?? 0)}</span>
              </div>
              <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed mt-1.5 font-light">{r.text}</p>
              {/* Источник ставит сервер: у пары договор, у гостя впечатление. */}
              {r.source === 'couple' ? (
                <p className="text-[9px] font-bold text-[var(--sage-deep)] mt-2">✓ {t('сделка через «Тили-тили» — отзыв подтверждён')}</p>
              ) : (
                <span className="inline-block text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--blue)] text-[var(--blue-ink)] mt-2">{t('Гость свадьбы')}</span>
              )}
              {r.reply?.text && (
                <div className="mt-2.5 pl-3 border-l-2 border-[var(--track)]">
                  <p className="text-[10px] font-bold text-[var(--soft)]">{t('Ответ подрядчика')}</p>
                  <p className="text-[11px] text-[var(--ink2)] leading-relaxed font-light">{r.reply.text}</p>
                </div>
              )}
            </div>
          ))}
        </div>
        {/* Жалоба на анкету: чужую и опубликованную — свою и черновик
            модерации показывать незачем. */}
        {!mine && v.published !== false && !v.blocked && (
          <button onClick={() => setComplaint(true)} className="press mt-4 text-[11px] font-semibold text-[var(--soft)] underline underline-offset-2">
            {t('Пожаловаться на анкету')}
          </button>
        )}
        {complaint && <ComplaintSheet target="vendor" targetId={v.id ?? ''} title={v.name ?? t('Анкета подрядчика')} onClose={() => setComplaint(false)} />}
        {/* Пока сервер отдаёт курсор, лента не дочитана — кнопка стоит. */}
        {ready(reviews) && reviewsCursor && (
          <div className="text-center mt-3">
            {reviewsErr && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed mb-2">{reviewsErr}</p>}
            <button disabled={reviewsBusy} onClick={() => void loadMoreReviews()} className="press px-5 h-[40px] rounded-full card-s text-[12px] font-semibold disabled:opacity-50">
              {reviewsBusy ? t('Загружаем ещё…') : t('Показать ещё отзывы')}
            </button>
          </div>
        )}
      </div>

      {/* Похожие */}
      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Похожие специалисты')}</h2>
        {/* Пустая полоса без объяснения одинаково выглядела при отказе сервера
            и при единственном подрядчике в городе. */}
        {similar.error && <ErrorState error={similar.error} retry={similar.reload} />}
        {ready(similar) && !(similar.data?.items ?? []).some(x => x.id !== v.id) && (
          <p className="text-[11.5px] text-[var(--soft)] px-1 leading-relaxed">{t('Похожих в вашем городе пока нет')}</p>
        )}
        <div className="flex gap-2.5 overflow-x-auto no-scrollbar">
          {/* Похожие — из той же категории и города, с сервера. */}
          {(similar.data?.items ?? []).filter(x => x.id !== v.id).slice(0, 4).map(x => (
            <button key={x.id} onClick={() => nav(`/vendor/${x.id}`)} className={cn('press w-[120px] shrink-0 card-s p-3 text-center', CATEGORY_TILE[x.categoryId ?? ''] ?? DEFAULT_TILE)}>
              <span className="text-[24px]">{cat?.icon}</span>
              <b className="text-[10.5px] block mt-1.5 leading-tight truncate">{x.name}</b>
              {x.priceFrom?.amount != null && <span className="text-[9.5px] text-[var(--rose-ink)] font-bold tabular">{t('от')} {fmt(x.priceFrom.amount)}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* CTA */}
      {mine ? (
        /* Своя анкета: писать и бронировать самого себя нельзя — сервер
           ответил бы отказом, а кнопка с одним исходом хуже её отсутствия.
           Вместо них — путь в мастер, где анкету и правят. */
        <div className="action-bar fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] glass-tab px-5 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] flex items-center gap-3 z-40">
          <span className="flex-1 text-[12.5px] font-semibold text-[var(--ink2)]">{t('Это ваша анкета')}</span>
          <button onClick={() => nav('/vendor-app/profile')} className="press h-[48px] px-6 rounded-full grad text-[var(--on-grad)] font-semibold text-[13px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Редактировать')}</button>
        </div>
      ) : (
      <div className="action-bar fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] glass-tab px-5 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] flex gap-2.5 z-40">
        {/* Раньше кнопка вела на выдуманный чат `ch1` — один и тот же у всех
            подрядчиков. Теперь переписка создаётся на сервере и открывается
            своя. Создание — запрос (`POST /chats/vendor/{id}`), и отказ на
            нём показывается словами: плавающий промис без catch молча не
            делал ничего при 401/403/429 и обрыве сети (ревью D5-15). */}
        <button disabled={chatBusy} onClick={openChat} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13.5px] disabled:opacity-60" style={{ boxShadow: 'var(--shadow)' }}>{chatBusy ? t('Открываем чат…') : t('Написать')}</button>
        {!replaceIntent && (dealHere && !added ? (
          <button onClick={() => nav(`/deal/${dealHere}`)} className="press flex-[1.4] h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('✓ В моей свадьбе · открыть сделку')}</button>
        ) : (
        <button onClick={add} disabled={busy || added} className="press flex-[1.4] h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] disabled:opacity-60" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {added ? t('✓ В моей свадьбе!') : busy ? t('Бронируем…') : t('Добавить в свадьбу')}
        </button>
        ))}
      </div>
      )}
      {err && (
        <div className="fixed bottom-[176px] left-1/2 -translate-x-1/2 w-full max-w-[430px] px-5 z-40">
          <p className="rounded-2xl bg-[var(--card)] px-4 py-3 text-[12.5px] text-[var(--rose-ink)]" style={{ boxShadow: 'var(--shadow)' }}>{err}</p>
        </div>
      )}
    </div>
  )
}
