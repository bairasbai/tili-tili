/* eslint-disable react-refresh/only-export-components -- провайдер контекста и хук
   доступа к нему живут в одном файле: это стандартный паттерн React, а правило
   касается только скорости hot-reload, а не поведения приложения. */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode, useEffect } from 'react'
import { initialGifts, initialSlots, type Gift, type Slot, type SlotState } from './data'
import { setI18nLang, type Lang } from './i18n'
import { isAuthorized } from './api/client'
import { findMyWedding } from './api/wedding'
import { safeGet, safeSet, usePersist } from './usePersist'

/*
 * Слоты команды переживают перезагрузку. Сохраняется только изменяемая часть слота:
 * подписи, иконки и плитки берутся из initialSlots на каждом запуске, поэтому смена
 * языка не «замораживает» старые переводы. Статус хранится русским ключом i18n
 * (перевод — при рендере через t()), иначе EN-строка застряла бы в localStorage.
 * Все поля патча всегда присутствуют: undefined исчезает при JSON-сериализации,
 * и слот «воскресал» бы из базовых данных после отмены брони.
 */
export interface SlotPatch {
  state: SlotState
  vendor: string | null
  price: number | null
  status: string | null
  external: boolean
  invited: boolean
  phone: string | null
}

const patchOf = (s: Slot): SlotPatch => ({
  state: s.state,
  vendor: s.vendor ?? null,
  price: s.price ?? null,
  status: s.status ?? null,
  external: !!s.external,
  invited: !!s.invited,
  phone: s.phone ?? null,
})

const applyPatch = (s: Slot, p: SlotPatch): Slot => ({
  ...s,
  state: p.state,
  vendor: p.vendor ?? undefined,
  price: p.price ?? undefined,
  status: p.status ?? undefined,
  external: p.external || undefined,
  invited: p.invited || undefined,
  phone: p.phone ?? undefined,
})

const EMPTY_PATCH: SlotPatch = { state: 'empty', vendor: null, price: null, status: null, external: false, invited: false, phone: null }

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
  setWeddingDate: (iso: string | null) => void
  quiz: QuizAnswers
  slots: Slot[]
  bookVendor: (slotId: string, vendorName: string, price: number) => void
  bookExternal: (slotId: string, vendorName: string, price: number, phone?: string) => void
  inviteExternal: (slotId: string) => void
  cancelBooking: (slotId: string) => void
  paySlot: (slotId: string) => void
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
  gifts: Gift[]
  reserveGift: (id: string) => void
  releaseGift: (id: string) => void
  fundGift: (id: string, amount: number) => void
  addGift: (g: Omit<Gift, 'id' | 'funded' | 'reserved'>) => void
  removeGift: (id: string) => void
  myGifts: string[]
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
  const [quiz, setQuiz] = usePersist<QuizAnswers>('tt_quiz', EMPTY_QUIZ)
  const [slotPatch, setSlotPatch] = usePersist<Record<string, SlotPatch>>('tt_slots', {})
  const slots = useMemo(
    () => initialSlots.map(s => (slotPatch[s.id] ? applyPatch(s, slotPatch[s.id]) : s)),
    [slotPatch],
  )
  const updateSlot = useCallback((id: string, fn: (p: SlotPatch) => SlotPatch) =>
    setSlotPatch(prev => {
      const src = initialSlots.find(s => s.id === id)
      const base = prev[id] ?? (src ? patchOf(src) : EMPTY_PATCH)
      return { ...prev, [id]: fn(base) }
    }), [setSlotPatch])
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(safeGet('tt_fav') ?? '["v1"]')
      return Array.isArray(parsed) ? parsed : ['v1']
    } catch { return ['v1'] }
  })
  const [lang, setLangState] = useState<Lang>(() => (safeGet('tt_lang') === 'en' ? 'en' : 'ru'))
  setI18nLang(lang)
  const [inviteTpl, setInviteTplState] = useState(() => Number(safeGet('tt_invite_tpl') ?? 0))
  const [inviteText, setInviteTextState] = useState(() => safeGet('tt_invite_text') ?? 'Мы хотим разделить с вами самый особенный день нашей жизни. Для нас будет честью видеть вас рядом в этот важный момент.')
  const [city, setCityState] = useState(() => safeGet('tt_city') ?? 'Уфа')
  const [cityRegion, setCityRegion] = useState(() => safeGet('tt_city_region') ?? 'Башкортостан')
  const [theme, setThemeState] = useState<'light' | 'dark'>(() =>
    safeGet('tt_theme') === 'dark' ? 'dark' : 'light')
  const [gifts, setGifts] = useState<Gift[]>(() => {
    try {
      const raw = safeGet('tt_gifts')
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p }
    } catch { /* noop */ }
    return initialGifts
  })
  const [myGifts, setMyGifts] = useState<string[]>(() => {
    try { const p = JSON.parse(safeGet('tt_my_gifts') ?? '[]'); return Array.isArray(p) ? p : [] } catch { return [] }
  })
  const persistGifts = (next: Gift[]) => { safeSet('tt_gifts', JSON.stringify(next)); return next }
  const persistMine = (next: string[]) => { safeSet('tt_my_gifts', JSON.stringify(next)); return next }

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
    setWeddingDate: setWeddingDateState,
    quiz,
    slots,
    bookVendor: (slotId, vendorName, price) =>
      updateSlot(slotId, () => ({ state: 'booked', vendor: vendorName, price, status: 'Забронировано', external: false, invited: false, phone: null })),
    cancelBooking: (slotId) => updateSlot(slotId, () => ({ ...EMPTY_PATCH })),
    bookExternal: (slotId, vendorName, price, phone) =>
      updateSlot(slotId, () => ({ state: 'booked', vendor: vendorName, price, status: 'Свой подрядчик', external: true, invited: false, phone: phone ?? null })),
    inviteExternal: (slotId) => updateSlot(slotId, p => ({ ...p, invited: true })),
    paySlot: (slotId) => updateSlot(slotId, p => ({ ...p, status: 'Оплачено полностью' })),
    favorites,
    toggleFav: id => setFavorites(f => {
      const next = f.includes(id) ? f.filter(x => x !== id) : [...f, id]
      safeSet('tt_fav', JSON.stringify(next))
      return next
    }),
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
    gifts, myGifts,
    reserveGift: (id) => {
      setGifts(gs => persistGifts(gs.map(g => g.id === id && !g.reserved ? { ...g, reserved: true } : g)))
      setMyGifts(m => persistMine(m.includes(id) ? m : [...m, id]))
    },
    releaseGift: (id) => {
      setGifts(gs => persistGifts(gs.map(g => g.id === id ? { ...g, reserved: false } : g)))
      setMyGifts(m => persistMine(m.filter(x => x !== id)))
    },
    fundGift: (id, amount) =>
      setGifts(gs => persistGifts(gs.map(g => {
        if (g.id !== id || !g.group || g.reserved) return g
        const funded = Math.min(g.price, g.funded + Math.max(0, amount))
        return { ...g, funded, reserved: funded >= g.price }
      }))),
    addGift: (g) => setGifts(gs => persistGifts([...gs, { ...g, id: 'gf' + Date.now(), funded: 0, reserved: false }])),
    removeGift: (id) => {
      setGifts(gs => persistGifts(gs.filter(g => g.id !== id)))
      setMyGifts(m => persistMine(m.filter(x => x !== id)))
    },
  }), [onboarded, weddingId, setWeddingIdState, weddingDate, setWeddingDateState, quiz, setQuiz, slots, updateSlot, favorites, lang, inviteTpl, inviteText, city, cityRegion, theme, gifts, myGifts])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}
