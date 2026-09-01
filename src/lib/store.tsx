import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { initialGifts, initialSlots, type Gift, type Slot } from './data'
import { setI18nLang, t, type Lang } from './i18n'

interface Store {
  onboarded: boolean
  finishOnboarding: () => void
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
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('tt_onboarded') === '1')
  const [slots, setSlots] = useState<Slot[]>(initialSlots)
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('tt_fav') ?? '["v1"]')
      return Array.isArray(parsed) ? parsed : ['v1']
    } catch { return ['v1'] }
  })
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem('tt_lang') === 'en' ? 'en' : 'ru'))
  setI18nLang(lang)
  const [inviteTpl, setInviteTplState] = useState(() => Number(localStorage.getItem('tt_invite_tpl') ?? 0))
  const [inviteText, setInviteTextState] = useState(() => localStorage.getItem('tt_invite_text') ?? 'Мы хотим разделить с вами самый особенный день нашей жизни. Для нас будет честью видеть вас рядом в этот важный момент.')
  const [city, setCityState] = useState(() => localStorage.getItem('tt_city') ?? 'Уфа')
  const [cityRegion, setCityRegion] = useState(() => localStorage.getItem('tt_city_region') ?? 'Башкортостан')
  const [theme, setThemeState] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('tt_theme') === 'dark' ? 'dark' : 'light')
  const [gifts, setGifts] = useState<Gift[]>(() => {
    try {
      const raw = localStorage.getItem('tt_gifts')
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p }
    } catch { /* noop */ }
    return initialGifts
  })
  const [myGifts, setMyGifts] = useState<string[]>(() => {
    try { const p = JSON.parse(localStorage.getItem('tt_my_gifts') ?? '[]'); return Array.isArray(p) ? p : [] } catch { return [] }
  })
  const persistGifts = (next: Gift[]) => { localStorage.setItem('tt_gifts', JSON.stringify(next)); return next }
  const persistMine = (next: string[]) => { localStorage.setItem('tt_my_gifts', JSON.stringify(next)); return next }

  const value = useMemo<Store>(() => ({
    onboarded,
    finishOnboarding: () => { localStorage.setItem('tt_onboarded', '1'); setOnboarded(true) },
    slots,
    bookVendor: (slotId, vendorName, price) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, state: 'booked', vendor: vendorName, price, status: 'Забронировано' } : sl)),
    cancelBooking: (slotId) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, state: 'empty', vendor: undefined, price: undefined, status: undefined, external: undefined, invited: undefined, phone: undefined } : sl)),
    bookExternal: (slotId, vendorName, price, phone) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, state: 'booked', vendor: vendorName, price, status: t('Свой подрядчик'), external: true, phone } : sl)),
    inviteExternal: (slotId) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, invited: true } : sl)),
    paySlot: (slotId) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, status: 'Оплачено полностью' } : sl)),
    favorites,
    toggleFav: id => setFavorites(f => {
      const next = f.includes(id) ? f.filter(x => x !== id) : [...f, id]
      localStorage.setItem('tt_fav', JSON.stringify(next))
      return next
    }),
    lang,
    setLang: (l: Lang) => { localStorage.setItem('tt_lang', l); setI18nLang(l); setLangState(l) },
    inviteTpl,
    setInviteTpl: (t: number) => { localStorage.setItem('tt_invite_tpl', String(t)); setInviteTplState(t) },
    inviteText,
    setInviteText: (t: string) => { localStorage.setItem('tt_invite_text', t); setInviteTextState(t) },
    city, cityRegion,
    theme,
    setTheme: (t) => { localStorage.setItem('tt_theme', t); setThemeState(t) },
    setCity: (name: string, region: string) => {
      localStorage.setItem('tt_city', name); localStorage.setItem('tt_city_region', region)
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
  }), [onboarded, slots, favorites, lang, inviteTpl, inviteText, city, cityRegion, theme, gifts, myGifts])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}
