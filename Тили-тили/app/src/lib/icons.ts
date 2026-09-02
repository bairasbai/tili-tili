import { Landmark, Camera, Clapperboard, Mic, Flower2, CakeSlice, Sparkles, Disc3, Lamp, CarFront, Shirt, Gem, type LucideIcon } from 'lucide-react'

/** Единая иконка категории слота (Lucide) — вместо разнобойных эмодзи. */
export const catIcons: Record<string, LucideIcon> = {
  venue: Landmark,
  photo: Camera,
  video: Clapperboard,
  host: Mic,
  florist: Flower2,
  cake: CakeSlice,
  stylist: Sparkles,
  dj: Disc3,
  decor: Lamp,
  transport: CarFront,
  dress: Shirt,
  rings: Gem,
}

export function catIcon(id: string): LucideIcon {
  return catIcons[id] ?? Sparkles
}
