import { useEffect, useRef, useState } from 'react'
import { MapPin, Clock3, Heart, CalendarPlus, UtensilsCrossed, Bus, Baby, ChevronDown } from 'lucide-react'
import { couple, timeline } from '@/lib/data'
import { inviteThemes } from '@/lib/inviteThemes'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

/* Гостевое приглашение: кинематографичная скролл-история (2026) */
export default function Invite() {
  const { inviteTpl } = useStore()
  const T = inviteThemes[inviteTpl] ?? inviteThemes[0]
  const [opened, setOpened] = useState(false)
  const [scrollY, setScrollY] = useState(0)
  const [progress, setProgress] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  const [rsvp, setRsvp] = useState<'yes' | 'no' | null>(null)
  const [plus, setPlus] = useState<boolean | null>(null)
  const [meal, setMeal] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<boolean | null>(null)
  const [sent, setSent] = useState(false)

  /* параллакс + прогресс */
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setScrollY(y)
      const h = document.documentElement.scrollHeight - innerHeight
      setProgress(h > 0 ? Math.min(1, y / h) : 0)
    }
    onScroll()
    addEventListener('scroll', onScroll, { passive: true })
    return () => removeEventListener('scroll', onScroll)
  }, [])

  /* scroll-reveal */
  useEffect(() => {
    if (!opened || !root.current) return
    const els = root.current.querySelectorAll('.rv')
    const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && e.target.classList.add('rv-in')), { threshold: 0.18 })
    els.forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [opened])

  const disp = T.serif ? 'font-serif-d' : ''
  const shadow = '0 18px 44px -18px rgba(46,42,38,.22)'

  return (
    <div ref={root} className="min-h-dvh relative overflow-x-hidden" style={{ background: T.bg, color: T.ink }}>

      {/* прогресс чтения */}
      {opened && (
        <div className="fixed top-0 left-0 right-0 h-[3px] z-40" style={{ background: 'rgba(0,0,0,.06)' }}>
          <div className="h-full transition-[width] duration-150" style={{ width: `${progress * 100}%`, background: T.accentGrad }} />
        </div>
      )}

      {/* ── Стартовая сцена ── */}
      <div className={cn('fixed inset-0 z-50 transition-opacity duration-700', opened && 'opacity-0 pointer-events-none')}>
        {(T.opening === 'curtains' || T.opening === 'doors') && (
          <>
            <div className={cn('absolute inset-y-0 left-0 w-1/2 transition-transform duration-[1500ms]', opened && '-translate-x-full')}
              style={{ background: T.overlay, transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)', boxShadow: 'inset -40px 0 80px -40px rgba(0,0,0,.55)' }} />
            <div className={cn('absolute inset-y-0 right-0 w-1/2 transition-transform duration-[1500ms]', opened && 'translate-x-full')}
              style={{ background: T.overlay, transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)', boxShadow: 'inset 40px 0 80px -40px rgba(0,0,0,.55)' }} />
          </>
        )}
        {T.opening === 'lift' && (
          <div className={cn('absolute inset-0 transition-transform duration-[1300ms]', opened && '-translate-y-full')}
            style={{ background: T.overlay, transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)' }} />
        )}
        {T.opening === 'fade' && (
          <div className={cn('absolute inset-0 transition-opacity duration-1000', opened && 'opacity-0')} style={{ background: T.overlay }} />
        )}
        {!opened && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8" style={{ color: T.overlayInk }}>
            <span className="text-[10px] tracking-[.34em] uppercase font-semibold opacity-80">Приглашение на свадьбу</span>
            <div className="w-[76px] h-[76px] rounded-full mt-8 flex items-center justify-center text-[20px] pop font-serif-d"
              style={{ background: T.accentGrad, color: '#FFF7F0', boxShadow: '0 14px 34px -10px rgba(0,0,0,.45), inset 0 0 0 3px rgba(255,255,255,.3)' }}>
              А♥Т
            </div>
            <h1 className={cn('text-[36px] mt-7 leading-tight', disp)}>Алина<br />&<br />Тимур</h1>
            <button onClick={() => setOpened(true)} className="press mt-10 px-9 h-[52px] rounded-full text-[13px] font-semibold tracking-wide"
              style={{ background: T.overlayInk, color: T.ink === T.overlayInk ? T.accent : T.ink }}>
              Открыть приглашение
            </button>
            <p className="text-[10px] mt-5 tracking-[.24em] uppercase opacity-60">{T.emoji} «{T.name}» · 14 · 06 · 2027</p>
          </div>
        )}
      </div>

      {/* ── История ── */}
      <div className={cn('max-w-[430px] mx-auto transition-opacity duration-700 pb-20 relative', opened ? 'opacity-100' : 'opacity-0')}>

        {/* парящий параллакс-декор */}
        <div className="pointer-events-none fixed inset-0 max-w-[430px] mx-auto z-0">
          {T.deco.map((d, k) => (
            <span key={k} className={cn('absolute text-[26px] opacity-30', k % 2 ? 'floaty' : 'floaty-slow')}
              style={{
                top: `${18 + k * 30}%`, left: k % 2 ? 'auto' : '4%', right: k % 2 ? '5%' : 'auto',
                transform: `translateY(${scrollY * (0.06 + k * 0.04)}px)`,
              }}>{d}</span>
          ))}
        </div>

        {/* Hero */}
        <div className="pt-24 pb-14 px-8 text-center relative z-10">
          <div className="rv rv-scale">
            <p className={cn('italic text-[15px] font-serif-d')} style={{ color: T.soft }}>Дорогая Марина Ивановна!</p>
            <p className="text-[10px] tracking-[.3em] uppercase font-semibold mt-9" style={{ color: T.accent }}>Мы женимся</p>
            <h1 className={cn('text-[46px] leading-[1.05] mt-4', disp)}>
              {couple.bride}<br /><em className="not-italic" style={{ color: T.accent }}>&</em> {couple.groom}
            </h1>
            <div className="flex items-center justify-center gap-3 mt-6">
              <span className="w-10 h-[1px]" style={{ background: T.soft }} />
              <p className="text-[11px] tracking-[.26em] uppercase font-semibold" style={{ color: T.soft }}>14 июня 2027 · Уфа</p>
              <span className="w-10 h-[1px]" style={{ background: T.soft }} />
            </div>
            <ChevronDown size={18} className="mx-auto mt-10 animate-bounce" style={{ color: T.soft }} />
          </div>
        </div>

        {/* Обращение */}
        <div className="px-8 rv relative z-10">
          <p className={cn('text-[17px] leading-relaxed text-center font-serif-d')} style={{ color: T.ink }}>
            «Мы хотим разделить с вами самый особенный день нашей жизни. Для нас будет честью видеть вас рядом в этот важный момент».
          </p>
        </div>

        {/* Детали дня */}
        <div className="px-6 mt-14 relative z-10">
          <div className="grid grid-cols-2 gap-3">
            {[['Церемония', '15:30', 'Усадьба «Липовый сад», шатёр у пруда', 'rv-left'], ['Банкет', '17:00', 'Большой зал усадьбы', 'rv-right']].map(([l, t, d, cls]) => (
              <div key={l} className={cn('rv rounded-[24px] p-5 text-center', cls)} style={{ background: T.card, boxShadow: shadow }}>
                <span className="text-[9px] tracking-[.2em] uppercase font-bold" style={{ color: T.accent }}>{l}</span>
                <b className={cn('text-[17px] block mt-2', disp)}>{t}</b>
                <p className="text-[10.5px] mt-1" style={{ color: T.soft }}>{d}</p>
              </div>
            ))}
          </div>
          <a href="https://yandex.ru/maps" target="_blank" rel="noreferrer" className="rv press mt-3 rounded-[24px] p-5 flex items-center gap-4" style={{ background: T.card, boxShadow: shadow }}>
            <MapPin size={20} style={{ color: T.accent }} />
            <div className="flex-1 text-left">
              <b className="text-[13px]">Построить маршрут</b>
              <p className="text-[10.5px]" style={{ color: T.soft }}>Яндекс Карты · 25 мин от центра · парковка у входа</p>
            </div>
            <span style={{ color: T.accent }}>→</span>
          </a>
        </div>

        {/* Программа */}
        <div className="px-6 mt-14 relative z-10">
          <h2 className={cn('rv text-[24px] text-center flex items-center justify-center gap-2', disp)}>
            <Clock3 size={18} style={{ color: T.accent }} /> Программа дня
          </h2>
          <div className="rv mt-5 rounded-[26px] px-5 py-2" style={{ background: T.card, boxShadow: shadow }}>
            {timeline.slice(3).map((e, i, arr) => (
              <div key={e.id} className="flex gap-4 py-3.5 items-baseline" style={{ borderBottom: i !== arr.length - 1 ? `1px solid ${T.bg}` : 'none' }}>
                <span className="text-[12px] font-bold w-[64px] shrink-0 tabular" style={{ color: T.accent }}>{e.time.split(' — ')[0]}</span>
                <div>
                  <b className="text-[13px]">{e.name}</b>
                  <p className="text-[10px] mt-0.5" style={{ color: T.soft }}>{e.loc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Дресс-код */}
        <div className="px-6 mt-14 text-center relative z-10 rv">
          <h2 className={cn('text-[24px]', disp)}>Дресс-код</h2>
          <div className="flex justify-center gap-3 mt-5">
            {['#C98A8A', '#A9BCA0', '#D9CCE3', '#F0DCB8', '#C3D5E8'].map((c, k) => (
              <span key={c} className={cn('w-10 h-10 rounded-full border-[3px]', k % 2 ? 'floaty' : 'floaty-slow')} style={{ background: c, borderColor: T.card, boxShadow: '0 8px 20px -8px rgba(0,0,0,.3)' }} />
            ))}
          </div>
          <p className="text-[11.5px] mt-4 font-light leading-relaxed" style={{ color: T.soft }}>
            Будем рады оттенкам пастели.<br />Белый — только для невесты 🤍
          </p>
        </div>

        {/* RSVP */}
        <div className="px-6 mt-14 relative z-10 rv rv-scale">
          <div className="rounded-[28px] p-6 relative overflow-hidden" style={{ background: T.card, boxShadow: shadow }}>
            <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: T.accentGrad }} />
            <h2 className={cn('text-[24px] text-center', disp)}>Вы придёте?</h2>
            <p className="text-[11px] text-center mt-1.5" style={{ color: T.soft }}>Ответьте до 1 мая — нам важно знать</p>

            {!sent ? (
              <>
                <div className="flex gap-2.5 mt-5">
                  <button onClick={() => setRsvp('yes')} className="press flex-1 h-[50px] rounded-full text-[13px] font-semibold transition-all"
                    style={rsvp === 'yes' ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>Приду с радостью</button>
                  <button onClick={() => setRsvp('no')} className="press flex-1 h-[50px] rounded-full text-[13px] font-semibold transition-all"
                    style={rsvp === 'no' ? { background: T.ink, color: T.bg } : { background: T.bg, color: T.soft }}>Не смогу</button>
                </div>

                {rsvp === 'yes' && (
                  <div className="mt-5 space-y-4 fade-up">
                    <div>
                      <p className="text-[11px] font-semibold flex items-center gap-1.5"><Heart size={12} style={{ color: T.accent }} /> Придёте с парой?</p>
                      <div className="flex gap-2 mt-2">
                        {['Один/одна', 'С +1'].map((o, k) => (
                          <button key={o} onClick={() => setPlus(k === 1)} className="press flex-1 h-[42px] rounded-full text-[12px] font-medium"
                            style={plus === (k === 1) ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>{o}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold flex items-center gap-1.5"><UtensilsCrossed size={12} style={{ color: T.accent }} /> Предпочтения по еде</p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {['Всё ем', 'Без рыбы', 'Вегетарианское', 'Детское меню'].map(o => (
                          <button key={o} onClick={() => setMeal(o)} className="press px-4 h-[38px] rounded-full text-[11.5px] font-medium"
                            style={meal === o ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>{o}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold flex items-center gap-1.5"><Bus size={12} style={{ color: T.accent }} /> Нужен трансфер из центра?</p>
                      <div className="flex gap-2 mt-2">
                        {['Да, нужен', 'Сам доберусь'].map((o, k) => (
                          <button key={o} onClick={() => setTransfer(k === 0)} className="press flex-1 h-[42px] rounded-full text-[12px] font-medium"
                            style={transfer === (k === 0) ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>{o}</button>
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] flex items-center gap-1.5" style={{ color: T.soft }}><Baby size={12} /> Детская зона с аниматором — будет</p>
                  </div>
                )}

                {rsvp && (
                  <button onClick={() => setSent(true)} className="press w-full h-[52px] rounded-full text-[13.5px] font-semibold mt-5"
                    style={{ background: T.accentGrad, color: '#FFF7F0', boxShadow: '0 16px 36px -12px rgba(0,0,0,.3)' }}>
                    Отправить ответ
                  </button>
                )}
              </>
            ) : (
              <div className="text-center py-6 pop">
                <div className="w-[72px] h-[72px] rounded-full mx-auto flex items-center justify-center text-[26px]" style={{ background: T.accentGrad, color: '#FFF7F0' }}>✓</div>
                <b className={cn('text-[20px] block mt-4', disp)}>{rsvp === 'yes' ? 'Ждём вас!' : 'Спасибо за честный ответ'}</b>
                <p className="text-[11.5px] mt-2" style={{ color: T.soft }}>
                  {rsvp === 'yes' ? 'Алина и Тимур уже видят ваш ответ в списке гостей.' : 'Алина и Тимур получили ваш ответ. ♥'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Календарь + подарки */}
        <div className="px-6 mt-6 space-y-3 relative z-10 rv">
          <button className="press w-full rounded-[24px] py-4 text-[13px] font-semibold flex items-center justify-center gap-2" style={{ background: T.card, boxShadow: shadow }}>
            <CalendarPlus size={16} style={{ color: T.accent }} /> Добавить в календарь (.ics)
          </button>
          <div className="rounded-[24px] p-5 text-center" style={{ background: T.card, boxShadow: shadow }}>
            <p className="text-[11.5px] leading-relaxed font-light" style={{ color: T.soft }}>
              🎁 Лучший подарок — ваше присутствие.<br />Если хотите порадовать нас иначе — конверт в копилку медового месяца 💛
            </p>
          </div>
        </div>

        <p className="text-center text-[10px] mt-12 tracking-[.2em] uppercase relative z-10" style={{ color: T.soft }}>Сделано в Тили-тили 💍</p>
      </div>
    </div>
  )
}
