import { createElement, useEffect, useState } from 'react'
import { ArrowLeft, Heart, Home, Search, User, Sparkles } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { useStore } from '@/lib/store'
import { t } from '@/lib/i18n'
import type { Vendor as ServerVendor } from '@/lib/api/catalog'
import { useServerHealth } from '@/lib/api/health'
import { fmt } from '@/lib/money'
import { useT } from '@/lib/useT'
import { cn, goBack } from '@/lib/utils'
import { catIcon } from '@/lib/icons'

/* Верхняя шапка страницы */
export function TopBar({ title, sub, back, right }: { title: string; sub?: string; back?: boolean; right?: React.ReactNode }) {
  const nav = useNavigate()
  const back2 = () => goBack(n => nav(n), (to, o) => nav(to, o))
  return (
    <div className="px-5 pt-6 pb-2 flex items-start justify-between gap-3 fade-in">
      <div className="flex items-center gap-3 min-w-0">
        {back && (
          <button onClick={back2} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center shrink-0" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="min-w-0">
          <h1 className="font-serif-d text-[26px] leading-tight truncate">{title}</h1>
          {sub && <p className="text-[12px] text-[var(--soft)] mt-0.5">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  )
}

/* Нижняя стеклянная навигация */
const tabs = [
  { to: '/home', label: t('Главная'), icon: Home },
  { to: '/search', label: t('Поиск'), icon: Search },
  { to: '/wedding', label: '', icon: null }, // центральная кнопка
  { to: '/us/chats', label: t('Чаты'), icon: Sparkles },
  { to: '/us', label: t('Мы'), icon: User },
]

export function TabBar() {
  const nav = useNavigate()
  const loc = useLocation()
  const tt = useT()
  const active = (to: string) => (to === '/wedding' ? loc.pathname.startsWith('/wedding') : loc.pathname.startsWith(to))
  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] glass-tab z-40">
      <div className="flex items-end justify-around px-2 pt-2 pb-[max(14px,env(safe-area-inset-bottom))]">
        {tabs.map(tb => {
          if (tb.icon === null)
            return (
              <button key="w" onClick={() => nav('/wedding')} className="press halo relative -mt-8 w-[58px] h-[58px] rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[22px] border-4 border-[var(--bg)]" style={{ boxShadow: '0 12px 28px -8px rgba(201,138,138,.7)' }} aria-label={t('Свадьба')}>
                💍
                <span className="halo-label">{t('Свадьба')}</span>
              </button>
            )
          const Icon = tb.icon
          const on = active(tb.to)
          return (
            <button key={tb.to} onClick={() => nav(tb.to)} className={cn('press flex flex-col items-center gap-1 w-16 py-1', on ? 'text-[var(--rose-deep)]' : 'text-[var(--soft)]')}>
              <Icon size={21} strokeWidth={on ? 2.4 : 1.8} />
              <span className="text-[9.5px] font-medium tracking-wide">{tt(tb.label)}</span>
              {on && <span className="tab-dot" />}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

/* Карточка подрядчика в выдаче */
/*
 * Карточка подрядчика из каталога сервера.
 *
 * Раньше принимала мок-запись со своими полями: цветом плитки, годами опыта и
 * значком «✓ проверен», который стоял у всех подряд. Теперь поля приходят с
 * сервера, и «проверен» показывается только тем, у кого документы правда
 * сверены (`verified`): значок доверия, стоящий у каждого, доверия не значит.
 *
 * `freeOnDate` не поле, а следствие запроса: когда выдача спрошена с датой
 * свадьбы, занятых в ней уже нет — сервер их отфильтровал.
 */
export function VendorCard({ v, categoryTitle, categoryIcon, tile, freeOnDate, onOpen }: {
  v: ServerVendor
  categoryTitle?: string
  categoryIcon?: string
  tile?: string
  freeOnDate?: boolean
  onOpen: () => void
}) {
  const { favorites, toggleFav } = useStore()
  const id = v.id ?? ''
  const fav = favorites.includes(id)
  return (
    <div className="card overflow-hidden fade-up group">
      <button className="w-full text-left" onClick={onOpen}>
        <div className={cn('h-[104px] relative transition-transform duration-700 group-hover:scale-[1.03]', tile ?? 'bg-[var(--rose-soft)]')} style={{ transitionTimingFunction: 'var(--ease)' }}>
          <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 70% 25%, rgba(255,255,255,.65), transparent 55%)' }} />
          <span className="absolute top-3 left-3 text-[26px]">{categoryIcon}</span>
          {freeOnDate && <span className="absolute bottom-3 left-3 text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[#A9BCA0] text-[var(--on-grad)]">{t('● Свободен на вашу дату')}</span>}
          {v.hasVideo && <span className="absolute bottom-3 right-3 text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-black/45 text-white">{t('▶ Видео')}</span>}
        </div>
      </button>
      <div className="p-3.5 flex items-start justify-between gap-2">
        <button className="text-left min-w-0" onClick={onOpen}>
          <b className="font-serif-d text-[15px] block truncate">{v.name}</b>
          <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">
            {categoryTitle}
            {(v.reviewsCount ?? 0) > 0 ? ` · ★ ${v.rating} (${v.reviewsCount})` : t(' · Новый на платформе')}
            {v.verified && <i className="not-italic text-[var(--sage-deep)] font-bold"> {t('· ✓ проверен')}</i>}
          </span>
          {v.priceFrom?.amount != null && (
            <span className="font-serif-d text-[14px] text-[var(--rose-ink)] font-semibold block mt-1">{t('от')} {fmt(v.priceFrom.amount)}</span>
          )}
        </button>
        <button onClick={() => toggleFav(id)} className="press w-9 h-9 rounded-full bg-[var(--bg)] flex items-center justify-center shrink-0" aria-label={t('В избранное')}>
          <Heart size={16} className={fav ? 'fill-[#C98A8A] text-[var(--rose-ink)]' : 'text-[var(--soft)]'} />
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
        {link && <button onClick={onLink} className="text-[11.5px] text-[var(--rose-deep)] font-semibold press">{link}</button>}
      </div>
      {sub && <p className="text-[11.5px] text-[var(--soft)] px-1 mt-0.5">{sub}</p>}
    </div>
  )
}

/* Иконка-плитка */
export function Tile({ icon, tile, size = 46, cat }: { icon: string; tile: string; size?: number; cat?: string }) {
  return (
    <div className={cn('rounded-[14px] flex items-center justify-center shrink-0', tile)} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {cat ? createElement(catIcon(cat), { size: Math.round(size * 0.44), className: 'text-[var(--ink2)]' }) : icon}
    </div>
  )
}

/* Совет ИИ-координатора */
export function AiTip({ text, onPress }: { text: string; onPress?: () => void }) {
  const inner = (
    <>
      <div className="w-[30px] h-[30px] rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[13px] shrink-0">✦</div>
      <p className="text-[11.5px] leading-relaxed text-[var(--soft)]"><b className="text-[var(--ink)]">{t('Тиль:')}</b> {text}</p>
    </>
  )
  const cls = 'sheen w-full text-left card p-3.5 flex gap-3 items-start'
  const style = { background: 'linear-gradient(135deg,var(--card),var(--rose-soft))', border: '1px solid rgba(201,138,138,.25)' }
  // без обработчика — просто карточка, не выглядит кликабельной и не «глотает» тапы
  if (!onPress) return <div className={cls} style={style}>{inner}</div>
  return <button onClick={onPress} className={cn(cls, 'press')} style={style}>{inner}</button>
}

/* Прогресс-полоска */
export function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="h-2 rounded-full bg-[var(--track)] overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, pct)}%`, background: color ?? 'var(--grad)' }} />
    </div>
  )
}

/* Баннер офлайна: приложение работает без сети, данные сохранятся */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine)
  /* Сеть и сервер — разные поломки: при живом Wi-Fi и лежащем бэкенде
     navigator.onLine говорит «онлайн», а приложение показывает пустоту. */
  const server = useServerHealth()
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  if (online && server !== 'down') return null
  return (
    <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] z-50 px-5 pt-2">
      <div className="rounded-2xl bg-[var(--ink)] text-[var(--bg)] text-[11.5px] font-semibold px-4 py-2.5 text-center" style={{ boxShadow: 'var(--shadow-lift)' }}>
        {online
          ? t('Сервер не отвечает — показываем, что сохранено на устройстве')
          : t('Нет сети — работаем офлайн, всё сохранится на устройстве')}
      </div>
    </div>
  )
}

/* Плашка живой синхронизации с подрядчиком */
export function SyncNote({ to }: { to: string }) {
  return (
    <div className="card-s px-4 py-3 flex items-center gap-2.5">
      <span className="relative flex w-2.5 h-2.5 shrink-0">
        <span className="absolute inline-flex w-full h-full rounded-full bg-[#7E9A74] opacity-60 animate-ping" />
        <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-[#7E9A74]" />
      </span>
      <p className="text-[11px] text-[var(--soft)] leading-snug">{t('Изменения мгновенно видны:')} <b className="text-[var(--ink)]">{to}</b> {t('— подрядчик получает обновление и подтверждает ✓')}</p>
    </div>
  )
}
