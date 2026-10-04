/* eslint-disable react-refresh/only-export-components -- провайдер контекста и хук
   доступа к нему живут в одном файле: это стандартный паттерн React, а правило
   касается только скорости hot-reload, а не поведения приложения. */
import { createContext, startTransition, useCallback, useContext, useMemo, useRef, useState, type ReactNode, useEffect } from 'react'
import type { Slot, SlotState } from './types'
import type { components } from './api/schema'
import { setI18nLang, type Lang } from './i18n'
import { accessTokenForWs, isAuthorized, onSessionExpired } from './api/client'
import { offlineScope, sameOfflineScope } from './offlineAccess'
import { reconcileOfflineDay } from './offlineDay'
import { forgetLocally } from './api/auth'
import { listMyWeddings, pickMyWedding, setWeddingDateOnServer, type MyWedding } from './api/wedding'
import { getSlots, getWedding } from './api/weddingData'
import { advanceDeal, bookSlot, cancelSlot, paySlotAmount, addExternal, inviteExternalVendor, removeExternal, unmarkPrebookedSlot, type ServerSlot } from './api/slots'
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
  attentionMode?: components['schemas']['WeddingAttention']['mode']
  booked: string[]
}

export const EMPTY_QUIZ: QuizAnswers = {
  date: null, guests: null, budget: null, format: null, style: null, planner: null, booked: [],
}

interface Store {
  onboarded: boolean
  /** Сохраняет ответы как черновик, не утверждая, что свадьба уже создана. */
  saveQuizDraft: (answers: QuizAnswers) => void
  finishOnboarding: (answers?: QuizAnswers) => void
  /**
   * Забыть сессию в памяти после выхода (ревью RF-01).
   *
   * `forgetLocally()` чистит только хранилище, а переход на вход — SPA-переход
   * без перезагрузки: провайдер стоит над роутером и живёт дальше. В памяти
   * оставались свадьба, мозаика с телефонами подрядчиков, дата, избранное и
   * ответы квиза — и любой, кто взял телефон после «Выйти», открывал
   * `/wedding/slot/<id>` без токена и без единого запроса. Зовётся после
   * `forgetLocally()`: сначала устройство, потом память.
   */
  forgetSession: () => void
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
  /**
   * Чем кончилась сверка списка свадеб при запуске.
   *
   * `weddingId === null` означает три разных вещи: список ещё едет, сервер
   * не ответил, свадеб у человека нет. Главная без этого различия рисовала
   * «0% готово · 0 гостей» во всех трёх — ноль вместо «неизвестно» (R-178).
   * `idle` — без входа сверки не было и не будет.
   */
  weddingsState: 'idle' | 'loading' | 'ready' | 'error'
  /**
   * Сверка по списку, который принёс вход. Эффект сверки — один на запуск,
   * а выход сбрасывает её в `idle`: без этого после повторного входа стор
   * оставался в `idle` навсегда, и экраны без свадьбы обещали «Загружаем…»
   * при запросе, которого нет. `null` — список не пришёл (`error`).
   */
  adoptWeddings: (list: MyWedding[] | null) => void
  /** Дата свадьбы, `YYYY-MM-DD`. Null — ещё не выбрана, и это нормально. */
  weddingDate: string | null
  /** Перенос даты. Уходит на сервер: он проверяет занятость команды и пересчитывает сроки. */
  setWeddingDate: (iso: string | null) => Promise<void>
  quiz: QuizAnswers
  slots: Slot[]
  /**
   * Состояние загрузки мозаики.
   *
   * Пустой массив слотов означает три разных вещи: свадьбы нет, мозаика ещё
   * едет, сервер не ответил. Экраны выводили из длины массива «загружаем…» и
   * висели с этой надписью навсегда, когда сервер лежал. Ноль — не «пусто»,
   * и «пусто» — не «неизвестно».
   */
  slotsState: 'idle' | 'loading' | 'ready' | 'error'
  /** Забронировать подрядчика из каталога. Второй аргумент — идентификатор, а не имя: сервер бронирует по нему. */
  /** `packageId` — выбранный пакет: сделка помнит, что продано (`Deal.packageName`); без него — бронь без пакета. */
  bookVendor: (slotId: string, vendorId: string, price: number, packageId?: string) => Promise<void>
  bookExternal: (slotId: string, vendorName: string, price: number, phone?: string) => Promise<void>
  /** Позвать своего подрядчика: возвращает ссылку, выданную сервером. */
  inviteExternal: (slotId: string) => Promise<string | null>
  /** Двинуть сделку вперёд по цепочке состояний. */
  advanceDealTo: (dealId: string, state: string) => Promise<void>
  cancelBooking: (slotId: string) => Promise<void>
  /** Убрать своего подрядчика: гасит и выданную ему ссылку-приглашение. */
  removeExternalVendor: (slotId: string) => Promise<void>
  /** «Нет, ещё ищем»: снять отметку «уже забронировано вне приложения» (фича 018). */
  unmarkPrebooked: (slotId: string) => Promise<void>
  /** Зафиксировать оплату. Без суммы уходит вся цена сделки, как её понимает сервер. */
  paySlot: (slotId: string, amount?: number) => Promise<void>
  /** Перечитать мозаику: состояние плиток считает сервер. */
  refreshSlots: () => void
  favorites: string[]
  toggleFav: (id: string) => void
  lang: 'ru' | 'en'
  setLang: (l: 'ru' | 'en') => void
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
  negotiating: 'Переговоры',
  booked: 'Забронировано',
  paid_deposit: 'Аванс внесён',
  done: 'Выполнено',
}

/** Мозаика с сервера и чья она: список без свадьбы, к которой относится, — ничей. */
type SlotsSnapshot = { weddingId: string; list: ServerSlot[]; state: 'ready' | 'error' }
/* Один и тот же пустой список, а не `[]` на каждую отрисовку: от него зависит `useMemo` мозаики. */
const NO_SLOTS: ServerSlot[] = []

/*
 * Ключи, которые сеттеры `usePersist` пишут обратно при сбросе состояния:
 * `null` и пустой квиз ложатся в хранилище, которое `forgetLocally()` только
 * что очистил. После сброса они снимаются ещё раз — устройство после выхода
 * должно быть пустым, а не помнить «свадьбы нет» под ключом свадьбы.
 */
/* `tt_dayx_offline` — офлайн-копия дня X (`lib/offlineDay.ts`): личные данные свадьбы, уходят вместе с сессией. */
const SESSION_KEYS = ['tt_wedding_id', 'tt_wedding_date', 'tt_quiz', 'tt_dayx_offline'] as const

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  /* Здесь и ниже доступ к хранилищу только через safeGet/safeSet: инициализаторы
     выполняются в фазе рендера, и SecurityError от заблокированных данных сайта
     положил бы всё приложение на экран ошибки без выхода. */
  const [onboarded, setOnboarded] = useState(() => safeGet('tt_onboarded') === '1')
  const [weddingId, setWeddingIdState] = usePersist<string | null>('tt_wedding_id', null)
  /*
   * Сверка свадьбы с сервером при запуске — один запрос на оба вопроса.
   *
   * Первый: идентификатора нет вовсе. Он лежит на устройстве, и с чистым
   * хранилищем взять его больше неоткуда — новый телефон, приватный режим,
   * очищенный кэш.
   *
   * Второй: идентификатор есть, а свадьбы у человека уже нет. Её отменил
   * партнёр с другого устройства, и телефон помнит проект, которого не
   * существует: `GET /weddings` отдаёт только живые (`archived_at is null`),
   * а все экраны свадьбы получают «не найдено» — без выхода из этого
   * состояния (SC-002).
   *
   * Молча: не нашлось — значит свадьбы нет, это нормальное состояние до
   * квиза. Сервер недоступен — оставляем как есть до следующего запуска.
   */
  /* Что помнил телефон в момент запуска. Сверяем именно это значение:
     свадьбу, созданную квизом уже после отправки запроса, устаревший список
     не видит, и сравнение с ним стёрло бы её сразу после создания. */
  const remembered = useRef(weddingId)
  /* Запрос — один за запуск: держим сам промис, а не флаг «уже спрашивали».
     Под StrictMode эффект вызывается дважды подряд, и флаг отменил бы первый
     запрос, не сделав второго, — свадьба не восстановилась бы вовсе. */
  const myWeddings = useRef<Promise<MyWedding[]> | null>(null)
  const [weddingsState, setWeddingsState] = useState<Store['weddingsState']>('idle')
  useEffect(() => {
    if (!isAuthorized()) return
    myWeddings.current ??= listMyWeddings()
    const requestedScope = offlineScope(accessTokenForWs())
    let alive = true
    setWeddingsState(prev => prev === 'idle' ? 'loading' : prev)
    void myWeddings.current
      .then(list => {
        /* Ответ пришёл после выхода — он про чужой уже аккаунт: записывать
           его свадьбу на очищенное устройство нельзя (RF-01). */
        if (!alive || !isAuthorized()) return
        if (requestedScope && !sameOfflineScope(requestedScope, offlineScope(accessTokenForWs()))) return
        reconcileOfflineDay(list, offlineScope(accessTokenForWs()))
        setWeddingIdState(prev => {
          if (prev !== remembered.current) return prev
          if (prev && list.some(w => w.id === prev)) return prev
          return pickMyWedding(list)
        })
        setWeddingsState('ready')
      })
      .catch(() => {
        /* сервер недоступен — попробуем при следующем запуске; экран об этом
           узнаёт по состоянию, а не по пустому идентификатору */
        if (alive) setWeddingsState('error')
      })
    return () => { alive = false }
  }, [setWeddingIdState])
  const adoptWeddings = useCallback((list: MyWedding[] | null) => {
    if (!list) { setWeddingsState('error'); return }
    reconcileOfflineDay(list, offlineScope(accessTokenForWs()))
    myWeddings.current = Promise.resolve(list)
    setWeddingIdState(prev => (prev && list.some(w => w.id === prev) ? prev : pickMyWedding(list)))
    setWeddingsState('ready')
  }, [setWeddingIdState])
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
  /* Была ли свадьба на устройстве: кэш даты живёт ровно столько же, сколько
     идентификатор. Черновик даты из квиза сюда не попадает — у него
     идентификатора не было и раньше. */
  const hadWedding = useRef(Boolean(weddingId))
  useEffect(() => {
    if (!weddingId) {
      /* Идентификатор пропал — отмена свадьбы или сверка при запуске нашла,
         что её больше нет. Дата уходит вместе с ним: иначе главная считала бы
         дни до свадьбы, которой нет (живая проверка фичи 003). Микрозадача —
         чтобы не ставить состояние синхронно в теле эффекта. */
      if (hadWedding.current) {
        hadWedding.current = false
        void Promise.resolve().then(() => setWeddingDateState(null))
      }
      return
    }
    hadWedding.current = true
    if (!isAuthorized()) return
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
  /*
   * Слоты хранятся вместе с идентификатором свадьбы, к которой относятся
   * (ревью D2-10). Раньше список и его состояние жили отдельно от `weddingId`
   * и при смене свадьбы не сбрасывались: пара отменила свадьбу и прошла квиз
   * заново — до ответа `getSlots(newId)` мозаика показывала слоты отменённой
   * с ценами и телефонами подрядчиков как готовые данные новой; координатор,
   * у которого сверка при запуске подменила свадьбу, видел чужую. Снимок с
   * чужим идентификатором считается отсутствующим — сброс происходит в той же
   * отрисовке, что и смена свадьбы, без setState в эффекте.
   */
  const [slotsSnap, setSlotsSnap] = useState<SlotsSnapshot | null>(null)
  const [slotsTick, setSlotsTick] = useState(0)
  useEffect(() => {
    /* Пока свадьбы нет, спрашивать нечего — просто ничего не запрашиваем. */
    if (!weddingId || !isAuthorized()) return
    let alive = true
    void getSlots(weddingId)
      .then(list => { if (alive) setSlotsSnap({ weddingId, list: list ?? [], state: 'ready' }) })
      /* Отказ раньше глотался молча. Мозаика оставалась пустой — и экраны
         слота и сделки говорили «Загружаем…» до конца сеанса, потому что
         выводили загрузку из нулевой длины списка. Прежний список той же
         свадьбы при отказе перечитывания остаётся — он её, а не чужой. */
      .catch(() => {
        if (alive) setSlotsSnap(prev => ({ weddingId, list: prev?.weddingId === weddingId ? prev.list : [], state: 'error' }))
      })
    return () => { alive = false }
  }, [weddingId, slotsTick])
  /** Перечитать мозаику после действия: состояние плитки считает сервер. */
  const refreshSlots = useCallback(() => setSlotsTick(n => n + 1), [])

  const currentSnap = slotsSnap && slotsSnap.weddingId === weddingId ? slotsSnap : null
  const serverSlots = currentSnap?.list ?? NO_SLOTS

  /* «Грузим» ставим здесь, а не в эффекте: синхронный setState в теле эффекта
     запрещён линтом, а знать об этом экранам надо с первой отрисовки. */
  const slotsPhase: 'idle' | 'loading' | 'ready' | 'error' =
    !weddingId || !isAuthorized() ? 'idle' : currentSnap ? currentSnap.state : 'loading'

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
       предусмотрена, а прятать факт оплаты нельзя. Отметка «уже забронировано
       вне приложения» (фича 018) бывает только у слота без сделки, у которого
       `tileState` — `empty`: своё состояние, чтобы счётчики не считали его пустым. */
    const state: SlotState = s.prebooked === true ? 'prebooked'
      : s.tileState === 'paid' ? 'booked'
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
      /* Сколько уже внесено. Сервер считает это по платежам: сумма, посчитанная
         на клиенте, разошлась бы с его расчётом на первом же возврате. */
      paid: d?.paid?.amount,
      paidAt: d?.paidAt ?? undefined,
      /* Подпись берём из состояния сделки, а не из плитки: `paid` в мозаике —
         это и внесённый аванс, и выполненная работа, а на экране сделки это
         разные вещи. */
      status: DEAL_LABEL[d?.state ?? ''],
      external: !!d?.externalName,
      phone: d?.externalPhone ?? undefined,
      dealId: d?.id,
      dealState: d?.state,
      /* Пакет — только когда сервер его назвал (контракт v0.29.0, фича 005). */
      packageName: d?.packageName ?? undefined,
      packageIncludes: d?.packageIncludes ?? undefined,
      comparisonTerms: d?.comparisonTerms,
    }
  }), [serverSlots])
  /* Пустой список, а не `['v1']`: подрядчика с таким номером не существует —
     он остался от мок-каталога. Сердечко на пустом месте показывало
     избранным то, чего в каталоге нет. */
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(safeGet('tt_fav') ?? '[]')
      return Array.isArray(parsed) ? (parsed as string[]) : []
    } catch { return [] }
  })

  /* Избранное с сервера при запуске: на новом устройстве локальный список
     пуст, а аккаунт свой список помнит. И после входа без перезагрузки —
     по `weddingsState === 'ready'`, которое ставит `adoptWeddings` при входе:
     до ревью 015 эффект шёл один раз на монтировании, и вошедший видел
     сердечки прежнего гостя до перезагрузки страницы. */
  useEffect(() => {
    if (!isAuthorized() || weddingsState !== 'ready') return
    let alive = true
    void getFavorites()
      .then(list => {
        /* После выхода поздний ответ не должен положить чужое избранное на
           очищенное устройство (RF-01). */
        if (!alive || !list || !isAuthorized()) return
        const ids = list.map(v => v.id).filter((x): x is string => !!x)
        setFavorites(ids)
        safeSet('tt_fav', JSON.stringify(ids))
      })
      .catch(() => { /* offline — остаётся локальная копия */ })
    return () => { alive = false }
  }, [weddingsState])
  const [lang, setLangState] = useState<Lang>(() => (safeGet('tt_lang') === 'en' ? 'en' : 'ru'))
  setI18nLang(lang)
  const [city, setCityState] = useState(() => safeGet('tt_city') ?? 'Уфа')
  const [cityRegion, setCityRegion] = useState(() => safeGet('tt_city_region') ?? 'Башкортостан')
  const [theme, setThemeState] = useState<'light' | 'dark'>(() =>
    safeGet('tt_theme') === 'dark' ? 'dark' : 'light')

  /*
   * Сброс памяти после выхода (RF-01, см. описание в `Store`). Тема, язык и
   * город остаются: это свойства устройства, а не аккаунта. `hadWedding`
   * снимается до сброса идентификатора, иначе эффект даты записал бы `null`
   * обратно в хранилище микрозадачей уже после очистки ключей.
   */
  const [forgotten, setForgotten] = useState(0)
  const forgetSession = useCallback(() => {
    hadWedding.current = false
    setWeddingIdState(null)
    setWeddingDateState(null)
    setQuiz(EMPTY_QUIZ)
    setSlotsSnap(null)
    setFavorites([])
    setOnboarded(false)
    setWeddingsState('idle')
    /* Промис сверки — про прежний аккаунт: следующему входу он не годится. */
    myWeddings.current = null
    setForgotten(n => n + 1)
  }, [setWeddingIdState, setWeddingDateState, setQuiz])
  /* Уже после того, как сеттеры `usePersist` отработали (они пишут в том же
     проходе отрисовки, эффект идёт следом): хранилище снова пустое. */
  useEffect(() => {
    if (!forgotten) return
    for (const key of SESSION_KEYS) {
      try { localStorage.removeItem(key) } catch { /* приватный режим */ }
    }
  }, [forgotten])
  /*
   * Смерть сессии (сервер отверг refresh: выход с другого устройства, 30 дней
   * бездействия) — та же уборка, что и кнопка «Выйти»: сначала устройство
   * (`forgetLocally()` — токены и всё, кроме темы/языка/города), потом память
   * (`forgetSession()`). До ERR-0277/R-277 здесь звалась только память —
   * `tt_fav`, `tt_onboarded` и гостевой токен переживали отказ refresh и
   * всплывали снова после перезагрузки; свадьба и мозаика с телефонами
   * подрядчиков жили в памяти до неё же (тот же класс, что RF-01/FA1, только
   * на этой из трёх дверей выхода). Экран сам покажет «войдите снова» по
   * `session_expired`.
   *
   * Память сбрасывается переходом (`startTransition`), а не обычным
   * обновлением (F4-F-G6r5-01/02): тот, кто ведёт человека на вход после
   * смерти сессии (гейт согласия, `pages/Consent.tsx`), подписан на то же
   * событие, и его `nav('/auth')` в том же синхронном вызове попадает в тот же
   * transition-кадр. Обычное обновление рисовалось раньше перехода роутера —
   * кадром со старым адресом (`/home`) и сброшенным `onboarded`, и маршрут
   * уводил на `/` поверх `/auth`. Устройство (`forgetLocally()`) чистится сразу.
   */
  useEffect(() => onSessionExpired(() => {
    forgetLocally()
    startTransition(() => forgetSession())
  }), [forgetSession])
  /*
   * Выход в соседней вкладке того же браузера (ERR-0277/R-277, третья дверь).
   *
   * `storage` — событие только ЧУЖИХ документов того же источника: своя
   * вкладка его никогда не получает (стандарт), поэтому кнопка «Выйти» и
   * отказ refresh в этой же вкладке идут своими путями выше и повторно сюда
   * не заходят. `forgetLocally()` здесь не нужен — устройство уже пусто (его
   * очистила чужая вкладка, хранилище общее на источник); не хватает только
   * сброса памяти: без него мозаика, свадьба и телефоны подрядчиков
   * оставались на экране этой вкладки до `F5`. `key === null` — чужая вкладка
   * вызвала `localStorage.clear()` целиком (кнопка «Выйти»); `key === 'tt_auth'`
   * — точечное снятие токена (смерть сессии в той вкладке). Проверка
   * `!isAuthorized()` — на случай постороннего события с тем же именем ключа:
   * своя вкладка убирает память, только если сама уже не авторизована.
   */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if ((e.key === null || e.key === 'tt_auth') && !isAuthorized()) forgetSession()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [forgetSession])

  const value = useMemo<Store>(() => ({
    onboarded,
    weddingId,
    setWeddingId: setWeddingIdState,
    weddingsState,
    adoptWeddings,
    forgetSession,
    saveQuizDraft: (answers: QuizAnswers) => {
      setQuiz(answers)
    },
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
    slotsState: slotsPhase,
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
    bookVendor: async (slotId, vendorId, price, packageId) => {
      await bookSlot(needWedding(), slotId, vendorId, price, packageId)
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
    unmarkPrebooked: async (slotId) => {
      await unmarkPrebookedSlot(needWedding(), slotId)
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
      /* Откат — только этого сердечка, а не всего списка на момент нажатия:
         два быстрых тапа по разным анкетам иначе откатывали и второе, если
         первый запрос не прошёл (ревью 015). */
      void (wasFav ? removeFavorite(id) : addFavorite(id)).catch(() => {
        setFavorites(cur => {
          const rolled = wasFav ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter(x => x !== id)
          safeSet('tt_fav', JSON.stringify(rolled))
          return rolled
        })
      })
    },
    lang,
    setLang: (l: Lang) => { safeSet('tt_lang', l); setI18nLang(l); setLangState(l) },
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
  }), [onboarded, weddingId, setWeddingIdState, weddingsState, adoptWeddings, forgetSession, weddingDate, setWeddingDateState, quiz, setQuiz, slots, slotsPhase, refreshSlots, needWedding, favorites, lang, city, cityRegion, theme])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}
