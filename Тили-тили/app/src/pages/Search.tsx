import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Search as SearchIcon, SlidersHorizontal, Play, MapPin, Calendar, Check, Phone } from 'lucide-react'
import { fmt } from '@/lib/money'
import { CATEGORY_TILE, DEFAULT_TILE } from '@/lib/categoryTiles'
import { getAvailability, getCategories, getVendors, getVendor, reviewsPendingRating, type Vendor, type VendorFilters } from '@/lib/api/catalog'
import { useApi, explainError } from '@/lib/api/useApi'
import { formatWeddingDate, monthGrid, monthTitle } from '@/lib/weddingDate'
import { TopBar, VendorCard } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { getVendorReviews } from '@/lib/api/reviews'
import type { components } from '@/lib/api/schema'
import { useStore } from '@/lib/store'
import { cn, copyText, plural } from '@/lib/utils'
import { chatRouteForVendor } from '@/lib/api/chats'
import { t } from '@/lib/i18n'

/* Каталог категорий */
export function SearchCategories() {
  const nav = useNavigate()
  const { slots, city, weddingDate } = useStore()
  const [q, setQ] = useState('')
  const stateOf = (id: string) => slots.find(s => s.categoryId === id)?.state

  const cats = useApi(() => getCategories(), [])
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
      {cats.error && (
        <div className="px-5 mt-6">
          <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed">{cats.error}</p>
          <button onClick={cats.reload} className="press mt-3 px-5 h-[40px] rounded-full card-s text-[12px] font-semibold">{t('Повторить')}</button>
        </div>
      )}
      <div className="px-5 grid grid-cols-3 gap-2.5 mt-4 stagger">
        {list.map(c => {
          const st = stateOf(c.id ?? '')
          return (
            <button key={c.id} onClick={() => nav(`/search/${c.id}`)} className="press card-s p-3 text-center fade-up">
              <div className={cn('w-11 h-11 rounded-[14px] mx-auto flex items-center justify-center text-[19px]', CATEGORY_TILE[c.id ?? ''] ?? DEFAULT_TILE)}>{c.icon}</div>
              <b className="text-[11px] block mt-2 leading-tight">{c.title}</b>
              {st === 'booked' && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] mt-1.5">{t('✓ Есть')}</span>}
              {(st === 'hold' || st === 'candidate') && <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-[var(--honey)] text-[var(--honey-ink)] mt-1.5">{t('⏳ Ищем')}</span>}
            </button>
          )
        })}
      </div>
      {/* Поиск по имени — отдельный запрос со своими состояниями: раньше отказ
          на нём выглядел как «никого не нашлось». */}
      {search.length >= 2 && found.loading && <p className="px-5 mt-4 text-[12px] text-[var(--soft)]">{t('Ищем подрядчиков…')}</p>}
      {found.error && <p role="alert" className="px-5 mt-4 text-[12px] text-[var(--rose-ink)] leading-relaxed">{found.error}</p>}
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
      {!cats.loading && !cats.error && list.length === 0 && !foundVendors.length && (
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
  const { city, weddingDate } = useStore()
  const [filter, setFilter] = useState('free')
  const [showFilters, setShowFilters] = useState(true)

  const cats = useApi(() => getCategories(), [])
  const cat = (cats.data ?? []).find(c => c.id === catId)

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
  }
  const list = useApi(() => getVendors(filters), [catId, city, weddingDate, filter])

  /*
   * Страницы после первой.
   *
   * Сервер отдаёт тридцать анкет и `nextCursor`; раньше курсор не читался, и
   * категория из двух тысяч анкет заканчивалась на тридцатой без единого
   * слова об этом (ревью D5-05). Дочитанные страницы привязаны к ключу
   * запроса: сменился фильтр или город — первая страница едет заново, а
   * хвост прошлого запроса к ней не пришивается.
   */
  const pageKey = [catId, city, weddingDate ?? '', filter].join('|')
  const [more, setMore] = useState<{ key: string; items: Vendor[]; next: string | null }>({ key: '', items: [], next: null })
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreErr, setMoreErr] = useState<string | null>(null)
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
  const sub = ready(list)
    ? `${nextCursor ? `${t('первые')} ${shown.length}` : `${shown.length} ${t('рядом')}`} · ${t('сортировка:')} ${sortLabel}`
    : undefined

  return (
    <div className="pb-28">
      <TopBar back title={cat?.title ?? t('Категория')} sub={sub} right={
        <button onClick={() => setShowFilters(s => !s)} className={cn('press w-10 h-10 rounded-full flex items-center justify-center', showFilters ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)]')} style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Фильтры')}>
          <SlidersHorizontal size={16} />
        </button>
      } />
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
        <button onClick={() => nav(`/compare?cat=${catId}`)} className="press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap bg-[var(--card)] text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{t('⇄ Сравнить')}</button>
      </div>}
      <div className="px-5 mt-4 space-y-3.5 stagger">
        {list.loading && <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Загружаем каталог…')}</p>}
        {(list.error || cats.error) && (
          <div className="py-6 text-center">
            <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed">{list.error ?? cats.error}</p>
            {/* Перезапрашиваем оба: при недоступном сервере падает и список, и
                справочник категорий, а без второго у экрана нет даже названия. */}
            <button onClick={() => { list.reload(); cats.reload() }} className="press mt-3 px-5 h-[40px] rounded-full card-s text-[12px] font-semibold">{t('Повторить')}</button>
          </div>
        )}
        {shown.map(v => (
          <VendorCard key={v.id} v={v}
            categoryTitle={cat?.title}
            categoryIcon={cat?.icon}
            tile={CATEGORY_TILE[catId] ?? DEFAULT_TILE}
            freeOnDate={filter === 'free' && !!weddingDate}
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
        {!list.loading && !list.error && !cats.error && shown.length === 0 && (
          <div className="text-center py-10 fade-up">
            <b className="text-[14px]">{t('Под фильтр никто не подходит')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5">{t('Смягчите условия — или спросите Тиля, он расширит поиск')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/* Анкета подрядчика */
export function VendorDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { slots, bookVendor, city, weddingDate } = useStore()
  const [pkg, setPkg] = useState(0)
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const detail = useApi(() => id ? getVendor(id) : Promise.resolve(null), [id])
  const cats = useApi(() => getCategories(), [])
  const v = detail.data
  const cat = (cats.data ?? []).find(c => c.id === v?.categoryId)
  /* Занятость — с сервера, а не из хеша по идентификатору. Раньше «занятые»
     даты рисовались формулой от строки: календарь выглядел настоящим и врал. */
  const month = (weddingDate ?? '').slice(0, 7)
  const avail = useApi(
    () => id && month ? getAvailability(id, month) : Promise.resolve({ busyDates: [] as string[] }),
    [id, month],
  )
  const busyDates = avail.data?.busyDates ?? []
  /* Длина месяца и его первый день недели: тридцать клеток подряд врали в
     феврале и в месяцах на 31 день. */
  const grid = monthGrid(month)
  /* «Свободен на вашу дату» — только когда занятость пришла. Пустой список
     занятых дней при отказе сервера превращался в зелёный значок и «дата
     свободна» — по нему бронируют. */
  const availKnown = ready(avail)
  const freeOnDate = availKnown && !!weddingDate && !busyDates.includes(weddingDate)
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

  const similar = useApi(
    () => v?.categoryId ? getVendors({ categoryId: v.categoryId, city, limit: 6 }) : Promise.resolve({ items: [] }),
    [v?.categoryId, city],
  )
  const slot = slots.find(s => s.categoryId === v?.categoryId)
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
   * Мозаика — 12 слотов, а категорий в каталоге 35. Для подрядчика из
   * категории вне мозаики места нет, и добавить слот контракт не умеет:
   * честнее сказать это словами, чем сделать вид, что бронь прошла.
   */
  const add = async () => {
    const price = v?.packages?.[pkg]?.price?.amount
    if (!slot) { setErr(t('Эта категория пока не входит в мозаику свадьбы')); return }
    if (!v?.id || price == null) { setErr(t('У этого подрядчика не указана цена пакета')); return }
    setErr(null)
    setBusy(true)
    try {
      await bookVendor(slot.id, v.id, price)
      setAdded(true)
    } catch (e) {
      setErr(explainError(e))
    } finally {
      setBusy(false)
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
    <div className="pb-28">
      <TopBar back title={t('Анкета подрядчика')} sub={city} />
      <div className="px-5 mt-8 text-center fade-up">
        {detail.loading && <p className="text-[12.5px] text-[var(--soft)]">{t('Загружаем анкету…')}</p>}
        {detail.error && (
          <>
            <p role="alert" className="text-[12.5px] text-[var(--rose-ink)] leading-relaxed">{detail.error}</p>
            <button onClick={() => { detail.reload(); cats.reload() }} className="press mt-4 px-5 h-[40px] rounded-full card-s text-[12px] font-semibold">{t('Повторить')}</button>
          </>
        )}
        {!detail.loading && !detail.error && <p className="text-[12.5px] text-[var(--soft)]">{t('Анкета не найдена')}</p>}
      </div>
    </div>
  )

  return (
    <div className="pb-32">
      <TopBar back title={cat?.title ?? t('Анкета подрядчика')} sub={t('Анкета подрядчика')} right={
        <button onClick={() => {
          const data = { title: `${v.name}${t(' — Тили-тили')}`, text: `${cat?.title ?? ''} · ${t(city)}${v.priceFrom?.amount != null ? `${t(' · от ')}${fmt(v.priceFrom.amount)}` : ''}`, url: location.href }
          if (navigator.share) navigator.share(data).catch(() => {})
          else { copyText(`${data.title}\n${data.text}\n${data.url}`) }
        }} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[11.5px] font-semibold text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{t('Поделиться')}</button>
      } />
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
            <button key={p.name} onClick={() => setPkg(k)} className={cn('press w-full card p-4 text-left', pkg === k && 'ring-2 ring-[#C98A8A]')}>
              <div className="flex justify-between items-center">
                <b className="text-[14px]">{p.name}</b>
                <span className="font-serif-d text-[17px] text-[var(--rose-ink)] font-semibold tabular">{p.price?.amount != null ? fmt(p.price.amount) : ''}</span>
              </div>
              <ul className="mt-2 space-y-1">
                {(p.includes ?? []).map(it => (
                  <li key={it} className="text-[11.5px] text-[var(--soft)] flex items-center gap-1.5"><Check size={11} className="text-[var(--sage-deep)]" />{it}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
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
          {!availKnown && month ? <AsyncState q={avail} /> : (
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
              return (
                <div key={day} className={cn('aspect-square rounded-xl flex items-center justify-center text-[11.5px] font-medium',
                  isWedding && !busy ? 'grad text-[var(--on-grad)] font-bold' : busy ? 'bg-[var(--rose-soft)] text-[var(--rose-ink)] line-through' : isWedding ? 'ring-2 ring-[#C98A8A] text-[var(--rose-ink)] font-bold' : 'text-[var(--ink)]')}>
                  {day}
                </div>
              )
            })}
          </div>
          )}
          <p className="text-[10px] text-[var(--soft)] mt-3 flex items-center gap-1.5"><Calendar size={11} />{!weddingDate ? t('Дата свадьбы не выбрана — показаны занятые дни месяца') : !availKnown ? (avail.loading ? t('Загружаем занятость…') : t('Занятость не загрузилась — свободна ли дата, пока неизвестно')) : freeOnDate ? t('Ваша дата свободна · зачёркнуты занятые') : t('Ваша дата занята — посмотрите похожих свободных ниже')}</p>
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
        {similar.error && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] px-1 leading-relaxed">{similar.error}</p>}
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
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] glass-tab px-5 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] flex gap-2.5 z-40">
        {/* Раньше кнопка вела на выдуманный чат `ch1` — один и тот же у всех
            подрядчиков. Теперь переписка создаётся на сервере и открывается
            своя. Создание — запрос (`POST /chats/vendor/{id}`), и отказ на
            нём показывается словами: плавающий промис без catch молча не
            делал ничего при 401/403/429 и обрыве сети (ревью D5-15). */}
        <button disabled={chatBusy} onClick={openChat} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13.5px] disabled:opacity-60" style={{ boxShadow: 'var(--shadow)' }}>{chatBusy ? t('Открываем чат…') : t('Написать')}</button>
        <button onClick={add} disabled={busy || added} className="press flex-[1.4] h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] disabled:opacity-60" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {added ? t('✓ В моей свадьбе!') : busy ? t('Бронируем…') : t('Добавить в свадьбу')}
        </button>
      </div>
      {err && (
        <div className="fixed bottom-[92px] left-1/2 -translate-x-1/2 w-full max-w-[430px] px-5 z-40">
          <p className="rounded-2xl bg-[var(--card)] px-4 py-3 text-[12.5px] text-[var(--rose-ink)]" style={{ boxShadow: 'var(--shadow)' }}>{err}</p>
        </div>
      )}
    </div>
  )
}
