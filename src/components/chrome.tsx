import { ArrowLeft, Heart, Home, Search, User, Sparkles } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { useStore } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/* Верхняя шапка страницы */
export function TopBar({ title, sub, back, right }: { title: string; sub?: string; back?: boolean; right?: React.ReactNode }) {
  const nav = useNavigate()
  return (
    <div className="px-5 pt-6 pb-2 flex items-start justify-between gap-3 fade-in">
      <div className="flex items-center gap-3 min-w-0">
        {back && (
          <button onClick={() => nav(-1)} className="press w-10 h-10 rounded-full bg-white flex items-center justify-center shrink-0" style={{ boxShadow: 'var(--shadow)' }} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="min-w-0">
          <h1 className="font-serif-d text-[26px] leading-tight truncate">{title}</h1>
          {sub && <p className="text-[12px] text-[#93897F] mt-0.5">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  )
}

/* Нижняя стеклянная навигация */
const tabs = [
  { to: '/home', label: 'Главная', icon: Home },
  { to: '/search', label: 'Поиск', icon: Search },
  { to: '/wedding', label: '', icon: null }, // центральная кнопка
  { to: '/us/chats', label: 'Чаты', icon: Sparkles },
  { to: '/us', label: 'Мы', icon: User },
]

export function TabBar() {
  const nav = useNavigate()
  const loc = useLocation()
  const tt = useT()
  const active = (to: string) => (to === '/wedding' ? loc.pathname.startsWith('/wedding') : loc.pathname.startsWith(to))
  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] glass-tab z-40">
      <div className="flex items-end justify-around px-2 pt-2 pb-[max(14px,env(safe-area-inset-bottom))]">
        {tabs.map(t => {
          if (t.icon === null)
            return (
              <button key="w" onClick={() => nav('/wedding')} className="press halo relative -mt-8 w-[58px] h-[58px] rounded-full grad flex items-center justify-center text-white text-[22px] border-4 border-[#FBF6F1]" style={{ boxShadow: '0 12px 28px -8px rgba(201,138,138,.7)' }} aria-label="Свадьба">
                💍
              </button>
            )
          const Icon = t.icon
          const on = active(t.to)
          return (
            <button key={t.to} onClick={() => nav(t.to)} className={cn('press flex flex-col items-center gap-1 w-16 py-1', on ? 'text-[#B57171]' : 'text-[#93897F]')}>
              <Icon size={21} strokeWidth={on ? 2.4 : 1.8} />
              <span className="text-[9.5px] font-medium tracking-wide">{tt(t.label)}</span>
              {on && <span className="tab-dot" />}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

/* Карточка подрядчика в выдаче */
export function VendorCard({ v, onOpen }: { v: import('@/lib/data').Vendor; onOpen: () => void }) {
  const { favorites, toggleFav } = useStore()
  const fav = favorites.includes(v.id)
  return (
    <div className="card overflow-hidden fade-up group">
      <button className="w-full text-left" onClick={onOpen}>
        <div className={cn('h-[104px] relative transition-transform duration-700 group-hover:scale-[1.03]', v.tile)} style={{ transitionTimingFunction: 'var(--ease)' }}>
          <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 70% 25%, rgba(255,255,255,.65), transparent 55%)' }} />
          <span className="absolute top-3 left-3 text-[26px]">{v.categoryIcon}</span>
          {v.freeOnDate
            ? <span className="absolute bottom-3 left-3 text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[#A9BCA0] text-white">● Свободен на вашу дату</span>
            : <span className="absolute bottom-3 left-3 text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-white/80 text-[#93897F]">Дата занята</span>}
          {v.hasVideo && <span className="absolute bottom-3 right-3 text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-black/45 text-white">▶ Видео</span>}
        </div>
      </button>
      <div className="p-3.5 flex items-start justify-between gap-2">
        <button className="text-left min-w-0" onClick={onOpen}>
          <b className="font-serif-d text-[15px] block truncate">{v.name}</b>
          <span className="text-[10.5px] text-[#93897F] block mt-0.5">
            {v.category}{v.years ? ` · ${v.years} лет опыта` : ''}
            {v.reviews > 0 ? ` · ★ ${v.rating} (${v.reviews})` : ' · Новый на платформе'}
          </span>
          <span className="font-serif-d text-[14px] text-[#B57171] font-semibold block mt-1">от {v.priceFrom.toLocaleString('ru-RU')} ₽</span>
        </button>
        <button onClick={() => toggleFav(v.id)} className="press w-9 h-9 rounded-full bg-[#FBF6F1] flex items-center justify-center shrink-0" aria-label="В избранное">
          <Heart size={16} className={fav ? 'fill-[#C98A8A] text-[#C98A8A]' : 'text-[#93897F]'} />
        </button>
      </div>
    </div>
  )
}

/* Заголовок секции */
export function SectionHead({ title, sub, link, onLink }: { title: string; sub?: string; link?: string; onLink?: () => void }) {
  return (
    <div className="mt-6 mb-1">
      <div className="flex justify-between items-baseline px-1">
        <h2 className="font-serif-d text-[19px]">{title}</h2>
        {link && <button onClick={onLink} className="text-[11.5px] text-[#B57171] font-semibold press">{link}</button>}
      </div>
      {sub && <p className="text-[11.5px] text-[#93897F] px-1 mt-0.5">{sub}</p>}
    </div>
  )
}

/* Иконка-плитка */
export function Tile({ icon, tile, size = 46 }: { icon: string; tile: string; size?: number }) {
  return (
    <div className={cn('rounded-[14px] flex items-center justify-center shrink-0', tile)} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {icon}
    </div>
  )
}

/* Совет ИИ-координатора */
export function AiTip({ text, onPress }: { text: string; onPress?: () => void }) {
  return (
    <button onClick={onPress} className="press sheen w-full text-left card p-3.5 flex gap-3 items-start" style={{ background: 'linear-gradient(135deg,#fff,#F2DFDC)', border: '1px solid rgba(201,138,138,.25)' }}>
      <div className="w-[30px] h-[30px] rounded-full grad flex items-center justify-center text-white text-[13px] shrink-0">✦</div>
      <p className="text-[11.5px] leading-relaxed text-[#93897F]"><b className="text-[#2E2A26]">Тиль:</b> {text}</p>
    </button>
  )
}

/* Прогресс-полоска */
export function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="h-2 rounded-full bg-[#F1E9E2] overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, pct)}%`, background: color ?? 'var(--grad)' }} />
    </div>
  )
}
