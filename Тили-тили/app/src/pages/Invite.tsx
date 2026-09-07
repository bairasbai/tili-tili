import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { MapPin, Heart, CalendarPlus, UtensilsCrossed, Bus, Hotel } from 'lucide-react'
import { inviteThemes } from '@/lib/inviteThemes'
import { useApi, explainError } from '@/lib/api/useApi'
import {
  bookHotelRoom, getGuestHotels, getGuestMenu, getGuestShuttle, getRsvp, guestToken,
  joinShuttle, saveGuestToken, sendRsvp, voteMenu,
} from '@/lib/api/guest'
import { dressPalettes } from '@/lib/dressPalettes'
import { formatWeddingDate } from '@/lib/weddingDate'
import { fmt } from '@/lib/money'
import { cn, plural } from '@/lib/utils'
import { t } from '@/lib/i18n'

/*
 * Гостевое приглашение.
 *
 * Гость не входит в приложение: его опознаёт персональный токен, полученный по
 * одноразовой ссылке (см. `pages/InviteRedeem.tsx`). Всё на этой странице
 * приходит с сервера по этому токену — имя гостя, свадьба, текст приглашения,
 * его собственный ответ.
 *
 * Раньше страница была витриной: «Дорогая Марина Ивановна», «Алина и Тимур»,
 * «14 июня 2027 · Уфа», программа дня из мока и ответ, который сохранялся в
 * `tt_guest_rsvp` на телефоне гостя — то есть никуда. Пара его не видела.
 *
 * Чего здесь намеренно нет: программы дня. Тайминг гостю контракт не отдаёт —
 * его видит только свой подрядчик по своему токену. Дресс-код вернулся: пара
 * хранила его в localStorage своего браузера, гость видел палитру по умолчанию
 * и принимал её за выбор пары — теперь палитра приходит со свадьбы.
 */

/** Скачивание .ics: событие календаря у гостя. */
function downloadICS(title: string, date: string, location: string) {
  const day = date.replace(/-/g, '')
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TiliTili//RU', 'BEGIN:VEVENT',
    `UID:${day}-${Math.round(Date.now() / 1000)}@tili-tili.ru`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, '').slice(0, 15)}Z`,
    /* Дата без времени: часа церемонии контракт гостю не отдаёт, а выдуманный
       час в календаре хуже отсутствующего — по нему выедут из дома. */
    `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${day}`,
    `SUMMARY:${title}`, `LOCATION:${location}`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
  a.download = 'svadba.ics'
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function Invite() {
  const nav = useNavigate()
  const token = guestToken()
  const q = useApi(() => token ? getRsvp(token) : Promise.resolve(null), [token])
  const page = q.data

  const [opened, setOpened] = useState(false)
  const [scrollY, setScrollY] = useState(0)
  const [progress, setProgress] = useState(0)
  const root = useRef<HTMLDivElement>(null)

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
  }, [opened, page])

  if (!token) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p className="font-serif-d text-[22px]">{t('Нужна ссылка из приглашения')}</p>
      <p className="text-[12.5px] text-[var(--soft)] mt-3 leading-relaxed">
        {t('Эта страница открывается по личной ссылке, которую присылает пара: по ней приложение узнаёт, кто вы.')}
      </p>
    </div>
  )

  if (!page) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      {q.loading && <p className="text-[13px] text-[var(--soft)]">{t('Открываем приглашение…')}</p>}
      {/*
        * Недействительный токен — это не поломка, а замена ссылки: пара
        * перевыпустила приглашение, и прежнее погасло. Голое «Ссылка
        * недействительна» оставляло гостя в тупике, поэтому объясняем, что
        * делать, и стираем мёртвый токен — иначе он мешает открыть новую
        * ссылку с этого же устройства.
        */}
      {q.error && (
        <>
          <p role="alert" className="font-serif-d text-[20px]">{t('Ссылка больше не действует')}</p>
          <p className="text-[12.5px] text-[var(--soft)] mt-3 leading-relaxed">
            {t('Похоже, пара выслала новое приглашение — прежняя ссылка после этого гаснет. Попросите у неё свежую.')}
          </p>
          <button onClick={() => { saveGuestToken(null); nav('/', { replace: true }) }} className="press mt-5 px-5 h-[42px] rounded-full card-s text-[12.5px] font-semibold">{t('Понятно')}</button>
        </>
      )}
    </div>
  )

  return <InviteView page={page} token={token} opened={opened} setOpened={setOpened} scrollY={scrollY} progress={progress} rootRef={root} onAnswered={q.reload} />
}

/* Ограничения по еде — те же значения, что в контракте (`Guest.diet`).
   Ключ словаря — русская подпись (R-07). */
const DIETS: [string | null, string][] = [
  [null, 'Без ограничений'], ['vegetarian', 'Вегетарианское'], ['vegan', 'Веганское'], ['halal', 'Халяль'],
  ['kosher', 'Кошер'], ['gluten_free', 'Без глютена'], ['other', 'Другое'],
]

interface RsvpPage {
  guestName?: string
  status?: string
  /* Свой ответ целиком (контракт v0.25): без него после «приду» гость не
     видел, что выбрал, и менял ответ вслепую. */
  plusOne?: boolean
  diet?: string | null
  dietNote?: string | null
  transfer?: string | null
  wedding?: {
    title?: string
    date?: string | null
    city?: { name?: string }
    inviteText?: string
    inviteThemeId?: number
    venue?: string | null
    dressCode?: string | null
    dressNote?: string | null
  }
}

/* Тело вынесено отдельно: данные нужны до первого хука блоков гостя, а хуки
   нельзя объявлять после условного возврата. */
function InviteView({
  page, token, opened, setOpened, scrollY, progress, rootRef, onAnswered,
}: {
  page: RsvpPage
  token: string
  opened: boolean
  setOpened: (v: boolean) => void
  scrollY: number
  progress: number
  rootRef: React.RefObject<HTMLDivElement | null>
  onAnswered: () => void
}) {
  const w = page.wedding ?? {}
  const T = inviteThemes[w.inviteThemeId ?? 0] ?? inviteThemes[0]!
  const disp = T.serif ? 'font-serif-d' : ''
  const shadow = '0 18px 44px -18px rgba(46,42,38,.22)'
  const place = [w.venue, w.city?.name].filter(Boolean).join(', ')

  /* Форма начинается с того, что гость уже ответил: правка — поверх своего
     ответа, а не с чистого листа. */
  const [plus, setPlus] = useState<boolean | null>(page.plusOne ?? null)
  const [diet, setDiet] = useState<string | null>(page.diet ?? null)
  const [dietNote, setDietNote] = useState(page.dietNote ?? '')
  const [transfer, setTransfer] = useState<'need' | 'own' | null>(page.transfer === 'need' || page.transfer === 'own' ? page.transfer : null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* Ответ уже есть на сервере: `pending` значит «ещё не отвечал». Локальной
     копии нет намеренно — гость мог ответить с другого устройства. */
  const answered = (page.status === 'yes' || page.status === 'no') && !editing

  /* Еда и трансфер уходят вместе с «приду»: раньше контракт их принимал, а
     форма не спрашивала — пара видела пустые поля у каждого гостя, а
     кейтеринг не узнавал об аллергиях никогда. */
  const answer = (status: 'yes' | 'no') => void (async () => {
    setBusy(true)
    setErr(null)
    try {
      await sendRsvp(token, status, status === 'yes' ? (plus ?? false) : undefined, undefined,
        status === 'yes'
          ? { diet, ...(diet === 'other' && dietNote.trim() ? { dietNote: dietNote.trim() } : {}), ...(transfer ? { transfer } : {}) }
          : {})
      setEditing(false)
      onAnswered()
    } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  const dietLabel = (id: string | null | undefined, note: string | null | undefined) =>
    id === 'other' && note ? note : t(DIETS.find(d => d[0] === (id ?? null))?.[1] ?? 'Без ограничений')

  return (
    <div ref={rootRef} className="min-h-dvh relative overflow-x-hidden" style={{ background: T.bg, color: T.ink }}>
      {opened && (
        <div className="fixed top-0 left-0 right-0 h-[3px] z-40" style={{ background: 'rgba(0,0,0,.06)' }}>
          <div className="h-full transition-[width] duration-150" style={{ width: `${progress * 100}%`, background: T.accentGrad }} />
        </div>
      )}

      {/* ── Стартовая сцена ── */}
      <div className={cn('fixed inset-0 z-50 transition-opacity duration-700', opened && 'opacity-0 pointer-events-none')}>
        {(T.opening === 'curtains' || T.opening === 'doors') && (
          <>
            {/* Длительность — стилем, а не классом с миллисекундами в скобках:
                Tailwind такой класс считал неоднозначным, не собирал и
                предупреждал на каждой сборке — даже встретив его в комментарии. */}
            <div className={cn('absolute inset-y-0 left-0 w-1/2 transition-transform', opened && '-translate-x-full')}
              style={{ background: T.overlay, transitionDuration: '1500ms', transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)', boxShadow: 'inset -40px 0 80px -40px rgba(0,0,0,.55)' }} />
            <div className={cn('absolute inset-y-0 right-0 w-1/2 transition-transform', opened && 'translate-x-full')}
              style={{ background: T.overlay, transitionDuration: '1500ms', transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)', boxShadow: 'inset 40px 0 80px -40px rgba(0,0,0,.55)' }} />
          </>
        )}
        {T.opening === 'lift' && (
          <div className={cn('absolute inset-0 transition-transform', opened && '-translate-y-full')}
            style={{ background: T.overlay, transitionDuration: '1300ms', transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)' }} />
        )}
        {T.opening === 'fade' && (
          <div className={cn('absolute inset-0 transition-opacity duration-1000', opened && 'opacity-0')} style={{ background: T.overlay }} />
        )}
        {!opened && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8" style={{ color: T.overlayInk }}>
            <span className="text-[10px] tracking-[.34em] uppercase font-semibold opacity-80">{t('Приглашение на свадьбу')}</span>
            <div className="w-[76px] h-[76px] rounded-full mt-8 flex items-center justify-center text-[20px] pop font-serif-d"
              style={{ background: T.accentGrad, color: '#FFF7F0', boxShadow: '0 14px 34px -10px rgba(0,0,0,.45), inset 0 0 0 3px rgba(255,255,255,.3)' }}>
              ♥
            </div>
            <h1 className={cn('text-[36px] mt-7 leading-tight', disp)}>{w.title}</h1>
            <button onClick={() => setOpened(true)} className="press mt-10 px-9 h-[52px] rounded-full text-[13px] font-semibold tracking-wide"
              style={{ background: T.overlayInk, color: T.ink === T.overlayInk ? T.accent : T.ink }}>
              {t('Открыть приглашение')}
            </button>
            {w.date && <p className="text-[10px] mt-5 tracking-[.24em] uppercase opacity-60">{T.emoji} {formatWeddingDate(w.date)}</p>}
          </div>
        )}
      </div>

      {/* ── История ── */}
      <div className={cn('max-w-[430px] mx-auto transition-opacity duration-700 pb-20 relative', opened ? 'opacity-100' : 'opacity-0')}>
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
            {page.guestName && <p className="italic text-[15px] font-serif-d" style={{ color: T.soft }}>{page.guestName}!</p>}
            <p className="text-[10px] tracking-[.3em] uppercase font-semibold mt-9" style={{ color: T.accent }}>{t('Мы женимся')}</p>
            <h1 className={cn('text-[46px] leading-[1.05] mt-4', disp)}>{w.title}</h1>
            {(w.date || place) && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <span className="w-10 h-[1px]" style={{ background: T.soft }} />
                <p className="text-[11px] tracking-[.26em] uppercase font-semibold" style={{ color: T.soft }}>
                  {[w.date ? formatWeddingDate(w.date) : '', place].filter(Boolean).join(' · ')}
                </p>
                <span className="w-10 h-[1px]" style={{ background: T.soft }} />
              </div>
            )}
          </div>
        </div>

        {/* Обращение пары */}
        {w.inviteText && (
          <div className="px-8 rv relative z-10">
            <p className="text-[17px] leading-relaxed text-center font-serif-d" style={{ color: T.ink }}>«{w.inviteText}»</p>
          </div>
        )}

        {/* Место */}
        {place && (
          <div className="px-6 mt-12 relative z-10">
            <a href={`https://yandex.ru/maps/?text=${encodeURIComponent(place)}`} target="_blank" rel="noreferrer" className="rv press rounded-[24px] p-5 flex items-center gap-4" style={{ background: T.card, boxShadow: shadow }}>
              <MapPin size={20} style={{ color: T.accent }} />
              <div className="flex-1 text-left">
                <b className="text-[13px]">{w.venue ?? w.city?.name}</b>
                <p className="text-[10.5px]" style={{ color: T.soft }}>{t('Открыть на карте')}</p>
              </div>
              <span style={{ color: T.accent }}>→</span>
            </a>
          </div>
        )}

        {/* RSVP */}
        <div className="px-6 mt-12 relative z-10 rv rv-scale">
          <div className="rounded-[28px] p-6 relative overflow-hidden" style={{ background: T.card, boxShadow: shadow }}>
            <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: T.accentGrad }} />
            <h2 className={cn('text-[24px] text-center', disp)}>{t('Вы придёте?')}</h2>

            {!answered ? (
              <>
                <div className="mt-5">
                  <p className="text-[11px] font-semibold flex items-center gap-1.5"><Heart size={12} style={{ color: T.accent }} />{t('Придёте с парой?')}</p>
                  <div className="flex gap-2 mt-2">
                    {[t('Один/одна'), t('С +1')].map((o, k) => (
                      <button key={o} onClick={() => setPlus(k === 1)} className="press flex-1 h-[42px] rounded-full text-[12px] font-medium"
                        style={plus === (k === 1) ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>{o}</button>
                    ))}
                  </div>
                </div>
                {/* Еда и трансфер — то, что просит кейтеринг и логистика; поля
                    контракта v0.24, до сих пор без формы. */}
                <div className="mt-4">
                  <p className="text-[11px] font-semibold flex items-center gap-1.5"><UtensilsCrossed size={12} style={{ color: T.accent }} />{t('Ограничения по еде')}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {DIETS.map(([id, label]) => (
                      <button key={id ?? 'none'} onClick={() => setDiet(id)} className="press px-3.5 h-[36px] rounded-full text-[11.5px] font-medium"
                        style={diet === id ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>{t(label)}</button>
                    ))}
                  </div>
                  {diet === 'other' && (
                    <input value={dietNote} onChange={e => setDietNote(e.target.value.slice(0, 300))} placeholder={t('Например: аллергия на орехи')}
                      className="w-full mt-2 h-[40px] px-4 rounded-full text-[12px] outline-none" style={{ background: T.bg, color: T.ink }} />
                  )}
                </div>
                <div className="mt-4">
                  <p className="text-[11px] font-semibold flex items-center gap-1.5"><Bus size={12} style={{ color: T.accent }} />{t('Как доберётесь?')}</p>
                  <div className="flex gap-2 mt-2">
                    {([['need', t('Нужен трансфер')], ['own', t('Доберусь сам(а)')]] as const).map(([id, label]) => (
                      <button key={id} onClick={() => setTransfer(id)} className="press flex-1 h-[42px] rounded-full text-[12px] font-medium"
                        style={transfer === id ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>{label}</button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2.5 mt-5">
                  <button disabled={busy} onClick={() => answer('yes')} className="press flex-1 h-[50px] rounded-full text-[13px] font-semibold transition-all disabled:opacity-50"
                    style={{ background: T.accentGrad, color: '#FFF7F0' }}>{busy ? t('Отправляем…') : t('Приду с радостью')}</button>
                  <button disabled={busy} onClick={() => answer('no')} className="press flex-1 h-[50px] rounded-full text-[13px] font-semibold transition-all disabled:opacity-50"
                    style={{ background: T.bg, color: T.soft }}>{t('Не смогу')}</button>
                </div>
                {err && <p role="alert" className="text-[12px] mt-3 text-center" style={{ color: T.accent }}>{err}</p>}
              </>
            ) : (
              <div className="text-center py-6 pop">
                <div className="w-[72px] h-[72px] rounded-full mx-auto flex items-center justify-center text-[26px]" style={{ background: T.accentGrad, color: '#FFF7F0' }}>✓</div>
                <b className={cn('text-[20px] block mt-4', disp)}>{page.status === 'yes' ? t('Ждём вас!') : t('Спасибо за честный ответ')}</b>
                <p className="text-[11.5px] mt-2" style={{ color: T.soft }}>
                  {page.status === 'yes' ? t('Ваш ответ уже виден паре в списке гостей.') : t('Пара получила ваш ответ. ♥')}
                </p>
                {/* Что именно сказал гость — с сервера, а не из памяти вкладки:
                    ответ с другого устройства здесь тот же. */}
                {page.status === 'yes' && (
                  <p className="text-[11.5px] mt-2 font-medium">
                    {[page.plusOne ? t('С +1') : t('Один/одна'), dietLabel(page.diet, page.dietNote), page.transfer === 'need' ? t('Нужен трансфер') : page.transfer === 'own' ? t('Доберусь сам(а)') : null].filter(Boolean).join(' · ')}
                  </p>
                )}
                {page.status === 'yes' && (
                  <button onClick={() => setEditing(true)} className="press mt-3 text-[11.5px] font-semibold underline" style={{ color: T.soft }}>{t('Изменить ответ')}</button>
                )}
                {/* Планы меняются, и сервер принимает новый ответ поверх
                    старого. Экран, который этого не позволял, заставлял бы
                    гостя звонить паре, чтобы его переписали руками. */}
                <button disabled={busy} onClick={() => answer(page.status === 'yes' ? 'no' : 'yes')} className="press mt-4 text-[11.5px] font-semibold underline disabled:opacity-50" style={{ color: T.soft }}>
                  {busy ? t('Отправляем…') : page.status === 'yes' ? t('Не смогу прийти') : t('Всё-таки приду')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Дресс-код. Блок вернулся: палитру и пожелание теперь хранит свадьба,
            а не браузер пары — раньше гость видел палитру по умолчанию и
            принимал её за выбор пары. */}
        {w.dressCode && (() => {
          const palette = dressPalettes.find(x => x.id === w.dressCode)
          if (!palette) return null
          return (
            <div className="px-6 mt-12 text-center relative z-10 rv">
              <h2 className={cn('text-[24px]', disp)}>{t('Дресс-код')}</h2>
              <p className="text-[11px] mt-1.5" style={{ color: T.soft }}>{t(palette.name)}</p>
              <div className="flex justify-center gap-3 mt-4">
                {palette.colors.map((c, k) => (
                  <span key={c} className={cn('w-10 h-10 rounded-full border-[3px]', k % 2 ? 'floaty' : 'floaty-slow')} style={{ background: c, borderColor: T.card, boxShadow: '0 8px 20px -8px rgba(0,0,0,.3)' }} />
                ))}
              </div>
              {w.dressNote && <p className="text-[11.5px] mt-4 font-light leading-relaxed" style={{ color: T.soft }}>{w.dressNote}</p>}
            </div>
          )
        })()}

        {/* Дальше — только тем, кто придёт: меню, трансфер, отель */}
        {page.status === 'yes' && (
          <>
            <GuestMenu token={token} T={T} shadow={shadow} />
            <GuestShuttle token={token} T={T} shadow={shadow} />
            <GuestHotels token={token} T={T} shadow={shadow} />
          </>
        )}

        {/* Календарь */}
        {w.date && (
          <div className="px-6 mt-6 relative z-10 rv">
            <button onClick={() => downloadICS(w.title ?? t('Свадьба'), w.date!, place)} className="press w-full rounded-[24px] py-4 text-[13px] font-semibold flex items-center justify-center gap-2" style={{ background: T.card, boxShadow: shadow }}>
              <CalendarPlus size={16} style={{ color: T.accent }} /> {t('Добавить в календарь (.ics)')}
            </button>
          </div>
        )}

        <p className="text-center text-[10px] mt-12 tracking-[.2em] uppercase relative z-10" style={{ color: T.soft }}>{t('Сделано в Тили-тили 💍')}</p>
      </div>
    </div>
  )
}

type Theme = (typeof inviteThemes)[number]

/*
 * Блок гостя не дошёл с сервера.
 *
 * Раньше меню, трансфер и отель при отказе просто исчезали: гость не узнавал,
 * что автобус вообще был, и ехал сам. Пустой блок и блок с ошибкой — разные
 * вещи, и второй должен быть виден.
 */
function GuestBlockError({ title, error, onRetry, T, shadow }: { title: string; error: string; onRetry: () => void; T: Theme; shadow: string }) {
  return (
    <div className="px-6 mt-6 relative z-10 rv">
      <div className="rounded-[24px] p-5" style={{ background: T.card, boxShadow: shadow }}>
        <p className="text-[11px] font-semibold">{title}</p>
        <p role="alert" className="text-[11.5px] mt-2" style={{ color: T.accent }}>{error}</p>
        <button onClick={onRetry} className="press mt-3 px-4 h-[36px] rounded-full text-[11.5px] font-semibold" style={{ background: T.bg, color: T.ink }}>{t('Повторить')}</button>
      </div>
    </div>
  )
}

/** Опрос по горячему. Варианты задаёт пара — гость их видит, а не угадывает. */
function GuestMenu({ token, T, shadow }: { token: string; T: Theme; shadow: string }) {
  const q = useApi(() => getGuestMenu(token), [token])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const options = q.data?.options ?? []
  if (q.error) return <GuestBlockError title={t('Что на горячее?')} error={q.error} onRetry={q.reload} T={T} shadow={shadow} />
  if (!options.length) return null

  const pick = (optionId: string) => void (async () => {
    setBusy(true)
    setErr(null)
    try { await voteMenu(token, optionId); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <div className="px-6 mt-6 relative z-10 rv">
      <div className="rounded-[24px] p-5" style={{ background: T.card, boxShadow: shadow }}>
        <p className="text-[11px] font-semibold flex items-center gap-1.5"><UtensilsCrossed size={12} style={{ color: T.accent }} />{q.data?.question || t('Что на горячее?')}</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {options.map(o => (
            <button key={o.id} disabled={busy} onClick={() => pick(o.id ?? '')} className="press px-4 h-[38px] rounded-full text-[11.5px] font-medium disabled:opacity-50"
              style={q.data?.chosenOptionId === o.id ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>{o.name}</button>
          ))}
        </div>
        {err && <p role="alert" className="text-[11.5px] mt-2" style={{ color: T.accent }}>{err}</p>}
      </div>
    </div>
  )
}

/** Трансфер. Место занимается атомарно: при переполнении сервер отвечает отказом. */
function GuestShuttle({ token, T, shadow }: { token: string; T: Theme; shadow: string }) {
  const q = useApi(() => getGuestShuttle(token), [token])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const routes = q.data?.routes ?? []
  if (q.error) return <GuestBlockError title={t('Трансфер')} error={q.error} onRetry={q.reload} T={T} shadow={shadow} />
  if (!routes.length) return null

  const join = (busId: string) => void (async () => {
    setBusy(true)
    setErr(null)
    try { await joinShuttle(token, busId); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <div className="px-6 mt-6 relative z-10 rv">
      <div className="rounded-[24px] p-5" style={{ background: T.card, boxShadow: shadow }}>
        <p className="text-[11px] font-semibold flex items-center gap-1.5"><Bus size={12} style={{ color: T.accent }} />{t('Трансфер')}</p>
        <div className="space-y-2 mt-3">
          {routes.map(r => {
            const mine = q.data?.myBusId === r.id
            const full = (r.taken ?? 0) >= (r.seats ?? 0)
            return (
              <button key={r.id} disabled={busy || (full && !mine)} onClick={() => join(r.id ?? '')} className="press w-full rounded-[16px] px-4 py-3 flex items-center gap-3 text-left disabled:opacity-50"
                style={mine ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>
                <div className="flex-1 min-w-0">
                  <b className="text-[12.5px] block truncate">{r.name}</b>
                  <span className="text-[10.5px] opacity-80">{[r.from, r.time].filter(Boolean).join(' · ')}</span>
                </div>
                <span className="text-[10px] font-bold shrink-0">
                  {mine ? t('вы записаны') : full ? t('мест нет') : `${(r.seats ?? 0) - (r.taken ?? 0)} ${plural((r.seats ?? 0) - (r.taken ?? 0), t('место'), t('места'), t('мест'))}`}
                </span>
              </button>
            )
          })}
        </div>
        {err && <p role="alert" className="text-[11.5px] mt-2" style={{ color: T.accent }}>{err}</p>}
      </div>
    </div>
  )
}

/** Отельные блоки: номер занимается так же атомарно, как место в автобусе. */
function GuestHotels({ token, T, shadow }: { token: string; T: Theme; shadow: string }) {
  const q = useApi(() => getGuestHotels(token), [token])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const blocks = q.data ?? []
  if (q.error) return <GuestBlockError title={t('Где остановиться')} error={q.error} onRetry={q.reload} T={T} shadow={shadow} />
  if (!blocks.length) return null

  const book = (hotelId: string) => void (async () => {
    setBusy(true)
    setErr(null)
    try { await bookHotelRoom(token, hotelId); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <div className="px-6 mt-6 relative z-10 rv">
      <div className="rounded-[24px] p-5" style={{ background: T.card, boxShadow: shadow }}>
        <p className="text-[11px] font-semibold flex items-center gap-1.5"><Hotel size={12} style={{ color: T.accent }} />{t('Где остановиться')}</p>
        <div className="space-y-2 mt-3">
          {blocks.map(h => {
            const full = (h.booked ?? 0) >= (h.rooms ?? 0)
            return (
              <button key={h.id} disabled={busy || full} onClick={() => book(h.id ?? '')} className="press w-full rounded-[16px] px-4 py-3 flex items-center gap-3 text-left disabled:opacity-50"
                style={{ background: T.bg, color: T.ink }}>
                <div className="flex-1 min-w-0">
                  <b className="text-[12.5px] block truncate">{h.name}</b>
                  <span className="text-[10.5px] opacity-80">
                    {[h.price?.amount != null ? fmt(h.price.amount) : '', h.promo].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <span className="text-[10px] font-bold shrink-0">
                  {full ? t('мест нет') : `${(h.rooms ?? 0) - (h.booked ?? 0)} ${plural((h.rooms ?? 0) - (h.booked ?? 0), t('номер'), t('номера'), t('номеров'))}`}
                </span>
              </button>
            )
          })}
        </div>
        {err && <p role="alert" className="text-[11.5px] mt-2" style={{ color: T.accent }}>{err}</p>}
      </div>
    </div>
  )
}
