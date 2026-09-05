/* eslint-disable react-refresh/only-export-components -- провайдер контекста и хук
   доступа к нему живут в одном файле: это стандартный паттерн React, а правило
   касается только скорости hot-reload, а не поведения приложения. */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode, useEffect } from 'react'
import { type Slot, type SlotState } from './data'
import { setI18nLang, type Lang } from './i18n'
import { isAuthorized } from './api/client'
import { findMyWedding, setWeddingDateOnServer } from './api/wedding'
import { getSlots, getWedding } from './api/weddingData'
import { advanceDeal, bookSlot, cancelSlot, paySlotAmount, addExternal, inviteExternalVendor, removeExternal, type ServerSlot } from './api/slots'
import { CATEGORY_TILE, DEFAULT_TILE } from './categoryTiles'
import { addFavorite, getFavorites, removeFavorite } from './api/catalog'
import { safeGet, safeSet, usePersist } from './usePersist'

/** Что человек ответил в квизе. Раньше ответы просто выбрасывались. */
export interface QuizAnswers {
  /** `YYYY-MM-DD` или null: «ещё не решили» — это тоже ответ. */
  date: string | null
  guests: string | null
  budget: string | null
  format: string | null
  style: string | null
  planner: string | null
  booked: string[]
}

export const EMPTY_QUIZ: QuizAnswers = {
  date: null, guests: null, budget: null, format: null, style: null, planner: null, booked: [],
}

interface Store {
  onboarded: boolean
  finishOnboarding: (answers?: QuizAnswers) => void
  /**
   * Идентификатор активной свадьбы на сервере. Null — свадьбы ещё нет
   * или человек не вошёл.
   *
   * Живёт на устройстве, но не является источником правды: с чистым
   * хранилищем восстанавливается через `GET /weddings` (см. описание пути
   * в контракте). Без него не работает ни один путь `/weddings/{weddingId}/…`,
   * а на них висит большая часть действий приложения.
   */
  weddingId: string | null
  setWeddingId: (id: string | null) => void
  /** Дата свадьбы, `YYYY-MM-DD`. Null — ещё не выбрана, и это нормально. */
  weddingDate: string | null
  /** Перенос даты. Уходит на сервер: он проверяет занятость команды и пересчитывает сроки. */
  setWeddingDate: (iso: string | null) => Promise<void>
  quiz: QuizAnswers
  slots: Slot[]
  /** Забронировать подрядчика из каталога. Второй аргумент — идентификатор, а не имя: сервер бронирует по нему. */
  bookVendor: (slotId: string, vendorId: string, price: number) => Promise<void>
  bookExternal: (slotId: string, vendorName: string, price: number, phone?: string) => Promise<void>
  /** Позвать своего подрядчика: возвращает ссылку, выданную сервером. */
  inviteExternal: (slotId: string) => Promise<string | null>
  /** Двинуть сделку вперёд по цепочке состояний. */
  advanceDealTo: (dealId: string, state: string) => Promise<void>
  cancelBooking: (slotId: string) => Promise<void>
  /** Убрать своего подрядчика: гасит и выданную ему ссылку-приглашение. */
  removeExternalVendor: (slotId: string) => Promise<void>
  /** Зафиксировать оплату. Без суммы уходит вся цена сделки, как её понимает сервер. */
  paySlot: (slotId: string, amount?: number) => Promise<void>
  /** Перечитать мозаику: состояние плиток считает сервер. */
  refreshSlots: () => void
  favorites: string[]
  toggleFav: (id: string) => void
  lang: 'ru' | 'en'
  setLang: (l: 'ru' | 'en') => void
  inviteTpl: number
  setInviteTpl: (t: number) => void
  inviteText: string
  setInviteText: (t: string) => void
  city: string
  cityRegion: string
  setCity: (name: string, region: string) => void
  theme: 'light' | 'dark'
  setTheme: (t: 'light' | 'dark') => void
}

/*
 * Подписи состояний сделки. Ключ — русская строка словаря (R-07): перевод
 * происходит при рендере, а в состоянии лежит русский ключ.
 */
const DEAL_LABEL: Record<string, string | undefined> = {
  negotiating: 'Бронь держится 72 часа',
  booked: 'Забронировано',
  paid_deposit: 'Аванс внесён',
  done: 'Выполнено',
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  /* Здесь и ниже доступ к хранилищу только через safeGet/safeSet: инициализаторы
     выполняются в фазе рендера, и SecurityError от заблокированных данных сайта
     положил бы всё приложение на экран ошибки без выхода. */
  const [onboarded, setOnboarded] = useState(() => safeGet('tt_onboarded') === '1')
  const [weddingId, setWeddingIdState] = usePersist<string | null>('tt_wedding_id', null)
  /*
   * Восстановление свадьбы после переустановки.
   *
   * Идентификатор лежит на устройстве, и с чистым хранилищем взять его больше
   * неоткуда — новый телефон, приватный режим, очищенный кэш. Спрашиваем
   * сервер один раз при запуске, если человек вошёл, а идентификатора нет.
   * Молча: не нашлось — значит свадьбы ещё нет, это нормальное состояние
   * до квиза, и пугать сообщением тут нечем.
   */

  useEffect(() => {
    if (weddingId || !isAuthorized()) return
    let alive = true
    void findMyWedding()
      .then(id => { if (alive && id) setWeddingIdState(id) })
      .catch(() => { /* сервер недоступен — попробуем при следующем запуске */ })
    return () => { alive = false }
  }, [weddingId, setWeddingIdState])
  /* Дата хранится строкой `YYYY-MM-DD` — тем же видом, что принимает сервер.
   * Объект Date в localStorage превращается в строку с часовым поясом, и
   * свадьба «14 июня» у человека восточнее Москвы читалась бы как 13-е. */
  const [weddingDate, setWeddingDateState] = usePersist<string | null>('tt_wedding_date', null)
  /*
   * Дата свадьбы — общая, а не настройка устройства.
   *
   * От неё считаются сроки задач, тайминг дня, занятость подрядчиков и время
   * открытия чата дня X. Пока она лежала только в `tt_wedding_date`, ничего из
   * этого не происходило, а второй из пары видел старую дату.
   *
   * Локальная копия остаётся: она нужна до ответа сервера и гостю без входа.
   * Но источник правды — сервер, и при расхождении выигрывает он.
   */
  useEffect(() => {
    if (!weddingId || !isAuthorized()) return
    let alive = true
    void getWedding(weddingId)
      .then(w => { if (alive && w?.date !== undefined) setWeddingDateState(w.date ?? null) })
      .catch(() => { /* сервер недоступен — покажем последнюю известную дату */ })
    return () => { alive = false }
  }, [weddingId, setWeddingDateState])
  const [quiz, setQuiz] = usePersist<QuizAnswers>('tt_quiz', EMPTY_QUIZ)
  /*
   * Мозаика команды приходит с сервера.
   *
   * Прежде она собиралась из `initialSlots` и локальных заплаток: двенадцать
   * выдуманных слотов, три из которых «уже забронированы» у всех подряд.
   * Состояние плитки (`tileState`) считает сервер и помечает readOnly —
   * повторять эту логику здесь значит завести второй набор правил, который
   * разойдётся с серверным на первом же непредусмотренном переходе.
   */
  const [serverSlots, setServerSlots] = useState<ServerSlot[]>([])
  const [slotsTick, setSlotsTick] = useState(0)
  useEffect(() => {
    /* Сброс делаем не синхронно в теле эффекта, а внутри ответа: синхронный
       setState в эффекте даёт каскад перерисовок и запрещён линтом. Пока
       свадьбы нет, спрашивать нечего — просто ничего не запрашиваем. */
    if (!weddingId || !isAuthorized()) return
    let alive = true
    void getSlots(weddingId)
      .then(list => { if (alive) setServerSlots(list ?? []) })
      .catch(() => { /* сервер недоступен — мозаика останется пустой, а не выдуманной */ })
    return () => { alive = false }
  }, [weddingId, slotsTick])
  /** Перечитать мозаику после действия: состояние плитки считает сервер. */
  const refreshSlots = useCallback(() => setSlotsTick(n => n + 1), [])

  /*
   * Без свадьбы записывать некуда.
   *
   * Молчаливый выход отсюда стоил бы дороже отказа: экран показал бы галочку
   * «забронировано», а на сервере не было бы ничего.
   */
  const needWedding = useCallback(() => {
    if (!weddingId) throw new Error('Свадьба ещё не создана')
    return weddingId
  }, [weddingId])

  const slots: Slot[] = useMemo(() => serverSlots.map(s => {
    const d = s.deal
    /* Пять состояний сервера против четырёх на экране: `paid` показываем как
       `booked` с подписью об оплате — плитка «оплачено» в мозаике не
       предусмотрена, а прятать факт оплаты нельзя. */
    const state: SlotState = s.tileState === 'paid' ? 'booked'
      : s.tileState === 'booked' ? 'booked'
      : s.tileState === 'hold' ? 'hold'
      : s.tileState === 'candidate' ? 'candidate'
      : 'empty'
    return {
      id: s.id ?? '',
      categoryId: s.categoryId ?? '',
      label: s.label ?? '',
      icon: '',
      tile: CATEGORY_TILE[s.categoryId ?? ''] ?? DEFAULT_TILE,
      state,
      vendor: d?.vendor?.name ?? d?.externalName ?? undefined,
      /* Идентификатор нужен там, где речь о самом подрядчике, а не о строке
         мозаики: отзыв уходит по `vendorId`. У своего подрядчика (§11) его нет
         вовсе — он не из каталога, и оценивать его в каталоге негде. */
      vendorId: d?.vendor?.id,
      price: d?.price?.amount,
      /* Подпись берём из состояния сделки, а не из плитки: `paid` в мозаике —
         это и внесённый аванс, и выполненная работа, а на экране сделки это
         разные вещи. */
      status: DEAL_LABEL[d?.state ?? ''],
      external: !!d?.externalName,
      phone: d?.externalPhone ?? undefined,
      dealId: d?.id,
      dealState: d?.state,
    }
  }), [serverSlots])
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(safeGet('tt_fav') ?? '["v1"]')
      return Array.isArray(parsed) ? parsed : ['v1']
    } catch { return ['v1'] }
  })

  /* Избранное с сервера при запуске: на новом устройстве локальный список
     пуст, а аккаунт свой список помнит. */
  useEffect(() => {
    if (!isAuthorized()) return
    let alive = true
    void getFavorites()
      .then(list => {
        if (!alive || !list) return
        const ids = list.map(v => v.id).filter((x): x is string => !!x)
        setFavorites(ids)
        safeSet('tt_fav', JSON.stringify(ids))
      })
      .catch(() => { /* offline — остаётся локальная копия */ })
    return () => { alive = false }
  }, [])
  const [lang, setLangState] = useState<Lang>(() => (safeGet('tt_lang') === 'en' ? 'en' : 'ru'))
  setI18nLang(lang)
  const [inviteTpl, setInviteTplState] = useState(() => Number(safeGet('tt_invite_tpl') ?? 0))
  const [inviteText, setInviteTextState] = useState(() => safeGet('tt_invite_text') ?? 'Мы хотим разделить с вами самый особенный день нашей жизни. Для нас будет честью видеть вас рядом в этот важный момент.')
  const [city, setCityState] = useState(() => safeGet('tt_city') ?? 'Уфа')
  const [cityRegion, setCityRegion] = useState(() => safeGet('tt_city_region') ?? 'Башкортостан')
  const [theme, setThemeState] = useState<'light' | 'dark'>(() =>
    safeGet('tt_theme') === 'dark' ? 'dark' : 'light')

  const value = useMemo<Store>(() => ({
    onboarded,
    weddingId,
    setWeddingId: setWeddingIdState,
    finishOnboarding: (answers?: QuizAnswers) => {
      // Ответы квиза — это план свадьбы, ради которого его и проходят.
      // Раньше они терялись между последним «Далее» и главным экраном.
      if (answers) {
        setQuiz(answers)
        if (answers.date) setWeddingDateState(answers.date)
      }
      safeSet('tt_onboarded', '1')
      setOnboarded(true)
    },
    weddingDate,
    /* Сначала сервер, потом экран: перенос может не пройти (409 `team_busy` —
       дата занята у забронированной команды), и показывать новую дату до
       ответа значит обещать перенос, которого не было. */
    setWeddingDate: async (iso: string | null) => {
      if (iso && weddingId && isAuthorized()) await setWeddingDateOnServer(weddingId, iso)
      setWeddingDateState(iso)
    },
    quiz,
    slots,
    refreshSlots,
    /*
     * Действия над слотом уходят на сервер и перечитывают мозаику.
     *
     * Перечитываем, а не правим состояние у себя: `tileState` — производная,
     * которую считает сервер, и подставлять её вручную значит гадать, что он
     * решит. Бронь ещё и меняет бюджет — его пересчитывает та же сторона.
     *
     * Ошибку не глотаем и не откатываем на месте: бронь необратима, и «сделали
     * вид, что получилось» здесь опаснее честного отказа. Экран узнаёт о ней
     * из проброшенного исключения.
     */
    bookVendor: async (slotId, vendorId, price) => {
      await bookSlot(needWedding(), slotId, vendorId, price)
      refreshSlots()
    },
    cancelBooking: async (slotId) => {
      await cancelSlot(needWedding(), slotId)
      refreshSlots()
    },
    /*
     * Свой подрядчик убирается своим путём, а не общей отменой.
     *
     * Отмена только закрывает сделку, а удаление ещё и гасит выданную
     * ссылку-приглашение. Через отмену человек, которого убрали из свадьбы,
     * продолжал бы видеть дату, тайминг и чат по живому токену.
     */
    removeExternalVendor: async (slotId) => {
      await removeExternal(needWedding(), slotId)
      refreshSlots()
    },
    bookExternal: async (slotId, vendorName, price, phone) => {
      await addExternal(needWedding(), slotId, vendorName, price, phone)
      refreshSlots()
    },
    inviteExternal: async (slotId) => {
      /* Ссылку возвращаем экрану: собрать её на клиенте нельзя — это
         одноразовый токен сервера, а не адрес из идентификатора слота. */
      const res = await inviteExternalVendor(needWedding(), slotId)
      refreshSlots()
      return res?.url ?? null
    },
    paySlot: async (slotId, amount) => {
      await paySlotAmount(needWedding(), slotId, amount)
      refreshSlots()
    },
    advanceDealTo: async (dealId, state) => {
      await advanceDeal(dealId, state)
      refreshSlots()
    },
    favorites,
    /*
     * Избранное — данные аккаунта, а не устройства.
     *
     * Сначала меняем на экране, потом отправляем: сердечко должно отзываться
     * мгновенно, а не через круг до сервера. Если запрос не прошёл — возвращаем
     * как было, иначе экран показывает то, чего на сервере нет.
     * Локальная копия остаётся: она нужна, пока список не загрузился, и
     * гостю без входа, у которого сервер избранное не хранит.
     */
    toggleFav: id => {
      const wasFav = favorites.includes(id)
      const next = wasFav ? favorites.filter(x => x !== id) : [...favorites, id]
      setFavorites(next)
      safeSet('tt_fav', JSON.stringify(next))
      if (!isAuthorized()) return
      void (wasFav ? removeFavorite(id) : addFavorite(id)).catch(() => {
        setFavorites(favorites)
        safeSet('tt_fav', JSON.stringify(favorites))
      })
    },
    lang,
    setLang: (l: Lang) => { safeSet('tt_lang', l); setI18nLang(l); setLangState(l) },
    inviteTpl,
    setInviteTpl: (t: number) => { safeSet('tt_invite_tpl', String(t)); setInviteTplState(t) },
    inviteText,
    setInviteText: (t: string) => { safeSet('tt_invite_text', t); setInviteTextState(t) },
    city, cityRegion,
    theme,
    setTheme: (t) => { safeSet('tt_theme', t); setThemeState(t) },
    setCity: (name: string, region: string) => {
      safeSet('tt_city', name); safeSet('tt_city_region', region)
      setCityState(name); setCityRegion(region)
    },
    /*
     * Подарков здесь больше нет: резерв — общее состояние пары и всех гостей,
     * а не настройка устройства. В `tt_gifts` он жил только в одном браузере,
     * и два гостя спокойно занимали одну вещь, каждый в своей копии списка.
     * Экраны подарков ходят на сервер напрямую (`lib/api/gifts.ts`).
     */
  }), [onboarded, weddingId, setWeddingIdState, weddingDate, setWeddingDateState, quiz, setQuiz, slots, refreshSlots, needWedding, favorites, lang, inviteTpl, inviteText, city, cityRegion, theme])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}
