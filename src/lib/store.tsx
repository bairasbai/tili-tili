import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { initialSlots, type Slot } from './data'

interface Store {
  onboarded: boolean
  finishOnboarding: () => void
  slots: Slot[]
  bookVendor: (slotId: string, vendorName: string, price: number) => void
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
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('tt_onboarded') === '1')
  const [slots, setSlots] = useState<Slot[]>(initialSlots)
  const [favorites, setFavorites] = useState<string[]>(['v1'])
  const [lang, setLang] = useState<'ru' | 'en'>('ru')
  const [inviteTpl, setInviteTplState] = useState(() => Number(localStorage.getItem('tt_invite_tpl') ?? 0))
  const [inviteText, setInviteTextState] = useState(() => localStorage.getItem('tt_invite_text') ?? 'Мы хотим разделить с вами самый особенный день нашей жизни. Для нас будет честью видеть вас рядом в этот важный момент.')
  const [city, setCityState] = useState(() => localStorage.getItem('tt_city') ?? 'Уфа')
  const [cityRegion, setCityRegion] = useState(() => localStorage.getItem('tt_city_region') ?? 'Башкортостан')

  const value = useMemo<Store>(() => ({
    onboarded,
    finishOnboarding: () => { localStorage.setItem('tt_onboarded', '1'); setOnboarded(true) },
    slots,
    bookVendor: (slotId, vendorName, price) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, state: 'booked', vendor: vendorName, price, status: 'Забронировано' } : sl)),
    cancelBooking: (slotId) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, state: 'empty', vendor: undefined, price: undefined, status: undefined } : sl)),
    paySlot: (slotId) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, status: 'Оплачено полностью' } : sl)),
    favorites,
    toggleFav: id => setFavorites(f => f.includes(id) ? f.filter(x => x !== id) : [...f, id]),
    lang, setLang,
    inviteTpl,
    setInviteTpl: (t: number) => { localStorage.setItem('tt_invite_tpl', String(t)); setInviteTplState(t) },
    inviteText,
    setInviteText: (t: string) => { localStorage.setItem('tt_invite_text', t); setInviteTextState(t) },
    city, cityRegion,
    setCity: (name: string, region: string) => {
      localStorage.setItem('tt_city', name); localStorage.setItem('tt_city_region', region)
      setCityState(name); setCityRegion(region)
    },
  }), [onboarded, slots, favorites, lang, inviteTpl, inviteText, city, cityRegion])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}
