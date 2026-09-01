import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { initialSlots, type Slot } from './data'

interface Store {
  onboarded: boolean
  finishOnboarding: () => void
  slots: Slot[]
  bookVendor: (slotId: string, vendorName: string, price: number) => void
  favorites: string[]
  toggleFav: (id: string) => void
  lang: 'ru' | 'en'
  setLang: (l: 'ru' | 'en') => void
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('tt_onboarded') === '1')
  const [slots, setSlots] = useState<Slot[]>(initialSlots)
  const [favorites, setFavorites] = useState<string[]>(['v1'])
  const [lang, setLang] = useState<'ru' | 'en'>('ru')

  const value = useMemo<Store>(() => ({
    onboarded,
    finishOnboarding: () => { localStorage.setItem('tt_onboarded', '1'); setOnboarded(true) },
    slots,
    bookVendor: (slotId, vendorName, price) =>
      setSlots(s => s.map(sl => sl.id === slotId ? { ...sl, state: 'booked', vendor: vendorName, price, status: 'Забронировано' } : sl)),
    favorites,
    toggleFav: id => setFavorites(f => f.includes(id) ? f.filter(x => x !== id) : [...f, id]),
    lang, setLang,
  }), [onboarded, slots, favorites, lang])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}
