import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { MapPin, Heart, CalendarPlus, UtensilsCrossed, Bus, Hotel, Clock3, Armchair, Phone, MessageCircle, ChevronLeft, Send, Gift } from 'lucide-react'
import { inviteThemes } from '@/lib/inviteThemes'
import { useApi, explainError } from '@/lib/api/useApi'
import { ApiError } from '@/lib/api/client'
import {
  bookHotelRoom, getGuestDay, getGuestDayMessages, getGuestHotels, getGuestMenu, getGuestShuttle, getRsvp, guestToken,
  joinShuttle, postGuestDayMessage, saveGuestToken, sendFamilyRsvp, sendRsvp, voteMenu,
} from '@/lib/api/guest'
import { dressPalettes } from '@/lib/dressPalettes'
import { formatTime, formatWeddingDate, todayIn } from '@/lib/weddingDate'
import { fmt } from '@/lib/money'
import { cn, goBack, plural } from '@/lib/utils'
import { getI18nLang, t } from '@/lib/i18n'

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
 * Программа дня появилась с фичей 009 и только с кануна: раздел «День
 * свадьбы» (`GuestDay`) берёт из `GET /join/{t}/day` блоки, которые пара
 * пометила «для гостей», стол, автобус, координатора и окно чата дня. До
 * кануна её нет — до этого гостю нужно приглашение, а не тайминг. Дресс-код
 * вернулся: пара хранила его в localStorage своего браузера, гость видел
 * палитру по умолчанию и принимал её за выбор пары — теперь палитра приходит
 * со свадьбы.
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

/*
 * Погасла ли ссылка — решает код ответа, а не факт ошибки.
 *
 * `useApi` отдаёт ошибку словами и стирает её причину, а здесь причина
 * решает судьбу токена: 401/410 — пара перевыпустила приглашение, и токен
 * мёртв; сеть, таймаут и 5xx — сервер, а не ссылка. До ревью D3-01 экран на
 * любую ошибку писал «Ссылка больше не действует» и предлагал «Понятно»,
 * которое стирало единственный ключ гостя к RSVP, подаркам и автобусу —
 * из-за мобильной сети, отвалившейся на пятнадцать секунд. Восстановить его
 * можно только новой ссылкой от пары, а перевыпуск снимает резерв подарка.
 */
const LINK_DEAD_STATUSES: ReadonlyArray<number> = [401, 410]

/** Ответ вместе с тем, на какой запрос он пришёл: ответ другого запроса на экран не попадает. */
type RsvpResult = { token: string; tick: number; page: RsvpPage | null; error: unknown }

function useRsvpPage(token: string | null) {
  const [result, setResult] = useState<RsvpResult | null>(null)
  const [tick, setTick] = useState(0)
  /* Запрос меняется с токеном и с каждым перечитыванием: пока ответа на этот
     запрос нет — ждём. Состояние выводится, а не выставляется в эффекте — так
     нет лишнего рендера и ответ устаревшего запроса отбрасывается. */

  useEffect(() => {
    if (!token) return
    let alive = true
    getRsvp(token)
      .then(p => { if (alive) setResult({ token, tick, page: (p ?? null) as RsvpPage | null, error: null }) })
      /* При отказе страницы нет: рядом с ошибкой она утверждала бы, что актуальна. */
      .catch((e: unknown) => { if (alive) setResult({ token, tick, page: null, error: e }) })
    return () => { alive = false }
  }, [token, tick])

  const reload = useCallback(() => setTick(n => n + 1), [])
  const current = result?.token === token && result.tick === tick ? result : null
  /*
   * Перечитывание того же токена держит прежнюю страницу до ответа, как
   * `useApi` на `reload()` (ревью RF-06). После «Приду» страница становилась
   * `null`, родитель рисовал «Открываем приглашение…» на весь экран, и
   * `InviteView` размонтировался: пропадали набранные поля, блоки меню и
   * автобуса уходили за данными заново, страница схлопывалась к началу, а
   * гость искал свой ответ внизу. Стирается страница только при смене токена
   * и при отказе.
   */
  const previous = current === null && result?.token === token && result.error === null ? result.page : null
  const page = current ? current.page : previous
  const error: unknown = current?.error ?? null
  const linkDead = error instanceof ApiError && LINK_DEAD_STATUSES.includes(error.status)
  return {
    page,
    /* Первая загрузка: показывать нечего и ответа ещё нет. */
    loading: !!token && current === null && page === null,
    /* Перечитывание за спиной у показанной страницы: кнопки ответа ждут его. */
    refreshing: !!token && current === null && page !== null,
    error, linkDead, reload,
  }
}

export default function Invite() {
  const nav = useNavigate()
  const token = guestToken()
  const q = useRsvpPage(token)
  const page = q.page

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
        * Недействительный токен (401/410) — это не поломка, а замена ссылки:
        * пара перевыпустила приглашение, и прежнее погасло. Голое «Ссылка
        * недействительна» оставляло гостя в тупике, поэтому объясняем, что
        * делать, и стираем мёртвый токен — иначе он мешает открыть новую
        * ссылку с этого же устройства.
        */}
      {q.linkDead && (
        <>
          <p role="alert" className="font-serif-d text-[20px]">{t('Ссылка больше не действует')}</p>
          <p className="text-[12.5px] text-[var(--soft)] mt-3 leading-relaxed">
            {t('Похоже, пара выслала новое приглашение — прежняя ссылка после этого гаснет. Попросите у неё свежую.')}
          </p>
          <button onClick={() => { saveGuestToken(null); nav('/', { replace: true }) }} className="press mt-5 px-5 h-[42px] rounded-full card-s text-[12.5px] font-semibold">{t('Понятно')}</button>
        </>
      )}
      {/*
        * Всё остальное — сеть, таймаут, 5xx, неожиданный отказ — не про
        * ссылку: токен остаётся на месте, а гость пробует ещё раз. Стирать
        * его здесь значило бы отнимать у гостя доступ за чужую поломку.
        */}
      {!q.loading && q.error !== null && !q.linkDead && (
        <>
          <p role="alert" className="font-serif-d text-[20px]">{explainError(q.error)}</p>
          <p className="text-[12.5px] text-[var(--soft)] mt-3 leading-relaxed">
            {t('Ссылка сохранена на этом устройстве — попробуйте ещё раз чуть позже.')}
          </p>
          <button onClick={q.reload} className="press mt-5 px-5 h-[42px] rounded-full card-s text-[12.5px] font-semibold">{t('Повторить')}</button>
        </>
      )}
    </div>
  )

  return <InviteView page={page} token={token} opened={opened} setOpened={setOpened} scrollY={scrollY} progress={progress} rootRef={root} onAnswered={q.reload} refreshing={q.refreshing} />
}

/* Ограничения по еде — те же значения, что в контракте (`Guest.diet`).
   Ключ словаря — русская подпись (R-07). */
const DIETS: [string | null, string][] = [
  [null, 'Без ограничений'], ['vegetarian', 'Вегетарианское'], ['vegan', 'Веганское'], ['halal', 'Халяль'],
  ['kosher', 'Кошер'], ['gluten_free', 'Без глютена'], ['other', 'Другое'],
]

interface RsvpMemberView {
  guestId: string
  name: string
  status: 'yes' | 'no' | 'pending'
  diet?: string | null
  dietNote?: string | null
  transfer?: 'need' | 'own' | null
  isPlaceholder?: boolean
}

interface RsvpPage {
  partyId?: string
  guestName?: string
  status?: string
  /* Свой ответ целиком (контракт v0.25): без него после «приду» гость не
     видел, что выбрал, и менял ответ вслепую. */
  plusOne?: boolean
  diet?: string | null
  dietNote?: string | null
  transfer?: string | null
  members?: RsvpMemberView[]
  wedding?: {
    title?: string
    date?: string | null
    city?: { name?: string }
    inviteText?: string
    inviteThemeId?: number
    venue?: string | null
    dressCode?: string | null
    dressNote?: string | null
    /* Пояс места (`WeddingPublic.tz`): сервер его в `/rsvp` пока не отдаёт,
       но контракт позволяет — раздел дня читает его, когда он есть. */
    tz?: string
  }
}

/* Тело вынесено отдельно: данные нужны до первого хука блоков гостя, а хуки
   нельзя объявлять после условного возврата. */
function InviteView({
  page, token, opened, setOpened, scrollY, progress, rootRef, onAnswered, refreshing,
}: {
  page: RsvpPage
  token: string
  opened: boolean
  setOpened: (v: boolean) => void
  scrollY: number
  progress: number
  rootRef: React.RefObject<HTMLDivElement | null>
  onAnswered: () => void
  /** Ответ ушёл, страница перечитывается: до свежей кнопки ответа заняты. */
  refreshing: boolean
}) {
  const nav = useNavigate()
  const familyMembers = page.members ?? []
  const familyMode = familyMembers.length > 1
  const familyAttending = familyMembers.length
    ? familyMembers.some((member) => member.status === 'yes')
    : page.status === 'yes'
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
  const [sending, setSending] = useState(false)
  /* «Отправляем…» держится и пока страница перечитывается после ответа:
     иначе между «отправлено» и «пришёл свежий ответ» форма на миг оживала. */
  const busy = sending || refreshing
  const [err, setErr] = useState<string | null>(null)
  /* Ответ уже есть на сервере: `pending` значит «ещё не отвечал». Локальной
     копии нет намеренно — гость мог ответить с другого устройства. */
  const answered = (page.status === 'yes' || page.status === 'no') && !editing

  /* Еда и трансфер уходят вместе с «приду»: раньше контракт их принимал, а
     форма не спрашивала — пара видела пустые поля у каждого гостя, а
     кейтеринг не узнавал об аллергиях никогда. */
  const answer = (status: 'yes' | 'no') => void (async () => {
    setSending(true)
    setErr(null)
    try {
      await sendRsvp(token, status, status === 'yes' ? (plus ?? false) : undefined, undefined,
        status === 'yes'
          ? { diet, ...(diet === 'other' && dietNote.trim() ? { dietNote: dietNote.trim() } : {}), ...(transfer ? { transfer } : {}) }
          : {})
      setEditing(false)
      onAnswered()
    } catch (e) { setErr(explainError(e)) } finally { setSending(false) }
  })()

  const dietLabel = (id: string | null | undefined, note: string | null | undefined) =>
    id === 'other' && note ? note : t(DIETS.find(d => d[0] === (id ?? null))?.[1] ?? 'Без ограничений')

  /* «Сейчас» — на монтировании: `Date.now()` в теле рендера нечист (R-04). */
  const [now] = useState(() => Date.now())
  /*
   * Раздел «День свадьбы» — всем, кроме ответивших «не приду», и не раньше
   * кануна (фича 014, A7: раньше — только «приду», и гость без ответа накануне
   * не видел ни программы, ни стола, хотя пара его ждёт; «не приду» — не
   * увидит: программа не для него). Точный пояс места приходит только вместе
   * с содержимым дня (`/rsvp` его пока не отдаёт), поэтому здесь решается лишь
   * «стоит ли спрашивать»: по поясу из `/rsvp`, а без него — по самому раннему
   * поясу Земли. Так запрос не уходит за месяцы до свадьбы, а показывать раздел
   * или нет, решает пояс из ответа.
   */
  const dayMayHaveCome = page.status !== 'no' && !!w.date && todayIn(w.tz ?? EARLIEST_TZ, now) >= eveOf(w.date)

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

        {/* День свадьбы — с кануна, всем, кроме «не приду» (фичи 009/014). Выше
            RSVP нарочно: в этот день гость открывает ссылку за программой и
            столом, а не за формой ответа. */}
        {dayMayHaveCome && <GuestDay token={token} city={w.city?.name} now={now} T={T} shadow={shadow} />}

        {/* RSVP */}
        <div className="px-6 mt-12 relative z-10 rv rv-scale">
          <div className="rounded-[28px] p-6 relative overflow-hidden" style={{ background: T.card, boxShadow: shadow }}>
            <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: T.accentGrad }} />
            <h2 className={cn('text-[24px] text-center', disp)}>{t('Вы придёте?')}</h2>

            {familyMode ? (
              <FamilyRsvpForm
                token={token}
                members={familyMembers}
                busy={busy}
                T={T}
                onSaved={onAnswered}
              />
            ) : !answered ? (
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
                  <button disabled={busy} onClick={() => setEditing(true)} className="press mt-3 text-[11.5px] font-semibold underline disabled:opacity-50" style={{ color: T.soft }}>{t('Изменить ответ')}</button>
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
        {familyAttending && (
          <>
            <GuestMenu token={token} T={T} shadow={shadow} />
            <GuestShuttle token={token} T={T} shadow={shadow} />
            <GuestHotels token={token} T={T} shadow={shadow} />
          </>
        )}

        {/* Подарки — с приглашения, а не по адресу, который гость должен
            угадать: экран `/gifts` (резерв, складчина, «не дарить») жил без
            единой ссылки на него (ревью 015, FB5). Виден и не ответившему:
            выбрать подарок можно до «приду». */}
        <div className="px-6 mt-6 relative z-10 rv">
          <button onClick={() => nav('/gifts')} className="press w-full rounded-[24px] py-4 text-[13px] font-semibold flex items-center justify-center gap-2" style={{ background: T.card, boxShadow: shadow }}>
            <Gift size={16} style={{ color: T.accent }} /> {t('Подарки и складчина')}
          </button>
        </div>

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

function FamilyRsvpForm({
  token, members, busy, T, onSaved,
}: {
  token: string
  members: RsvpMemberView[]
  busy: boolean
  T: Theme
  onSaved: () => void
}) {
  const [draft, setDraft] = useState(() => members.map((member) => ({ ...member })))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sending) setDraft(members.map((member) => ({ ...member })))
  }, [members, sending])

  const patch = (guestId: string, change: Partial<RsvpMemberView>) =>
    setDraft((current) => current.map((member) => member.guestId === guestId ? { ...member, ...change } : member))

  const save = () => void (async () => {
    setSending(true)
    setError(null)
    try {
      await sendFamilyRsvp(token, draft.map((member) => ({
        guestId: member.guestId,
        status: member.status === 'yes' ? 'yes' : 'no',
        ...(member.status === 'yes'
          ? {
              diet: member.diet ?? null,
              dietNote: member.diet === 'other' ? member.dietNote ?? null : null,
              transfer: member.transfer ?? null,
            }
          : {}),
      })))
      onSaved()
    } catch (e) {
      setError(explainError(e))
    } finally {
      setSending(false)
    }
  })()

  return (
    <div className="mt-5 space-y-4">
      <p className="text-[11.5px] text-center" style={{ color: T.soft }}>
        {t('Ответьте за каждого человека в приглашении отдельно')}
      </p>
      {draft.map((member) => (
        <div key={member.guestId} className="rounded-[18px] p-4" style={{ background: T.bg }}>
          <div className="flex items-center justify-between gap-3">
            <b className="text-[13px]">{member.name}</b>
            {member.isPlaceholder && <span className="text-[9px]" style={{ color: T.soft }}>{t('имя можно уточнить у пары')}</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <button
              disabled={busy || sending}
              onClick={() => patch(member.guestId, { status: 'yes' })}
              className="press h-[40px] rounded-full text-[11.5px] font-semibold disabled:opacity-50"
              style={member.status === 'yes' ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.card, color: T.ink }}
            >{t('Приду')}</button>
            <button
              disabled={busy || sending}
              onClick={() => patch(member.guestId, { status: 'no' })}
              className="press h-[40px] rounded-full text-[11.5px] font-semibold disabled:opacity-50"
              style={member.status === 'no' ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.card, color: T.ink }}
            >{t('Не смогу')}</button>
          </div>
          {member.status === 'yes' && (
            <>
              <p className="text-[10.5px] font-semibold mt-4">{t('Ограничения по еде')}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {DIETS.map(([id, label]) => (
                  <button
                    key={id ?? 'none'}
                    disabled={busy || sending}
                    onClick={() => patch(member.guestId, { diet: id })}
                    className="press px-3 h-[32px] rounded-full text-[10.5px] disabled:opacity-50"
                    style={(member.diet ?? null) === id ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.card, color: T.ink }}
                  >{t(label)}</button>
                ))}
              </div>
              {member.diet === 'other' && (
                <input
                  value={member.dietNote ?? ''}
                  onChange={(e) => patch(member.guestId, { dietNote: e.target.value.slice(0, 300) })}
                  placeholder={t('Например: аллергия на орехи')}
                  className="w-full mt-2 h-[38px] px-4 rounded-full text-[11px] outline-none"
                  style={{ background: T.card, color: T.ink }}
                />
              )}
              <p className="text-[10.5px] font-semibold mt-4">{t('Как доберётесь?')}</p>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {([['need', t('Нужен трансфер')], ['own', t('Доберусь сам(а)')]] as const).map(([id, label]) => (
                  <button
                    key={id}
                    disabled={busy || sending}
                    onClick={() => patch(member.guestId, { transfer: id })}
                    className="press h-[36px] rounded-full text-[10.5px] disabled:opacity-50"
                    style={member.transfer === id ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.card, color: T.ink }}
                  >{label}</button>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
      <button
        disabled={busy || sending || draft.some((member) => member.status === 'pending')}
        onClick={save}
        className="press w-full h-[48px] rounded-full text-[12.5px] font-semibold disabled:opacity-50"
        style={{ background: T.accentGrad, color: '#FFF7F0' }}
      >
        {sending ? t('Отправляем…') : t('Сохранить ответы семьи')}
      </button>
      {draft.some((member) => member.status === 'pending') && (
        <p className="text-[10.5px] text-center" style={{ color: T.soft }}>{t('Выберите ответ для каждого человека')}</p>
      )}
      {error && <p role="alert" className="text-[11.5px] text-center" style={{ color: T.accent }}>{error}</p>}
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

/**
 * Трансфер. Место занимается атомарно: при переполнении сервер отвечает отказом.
 *
 * Имя перевозчика — из `BusRoute.carrier` (контракт v0.30.0, фича 006): гость
 * узнаёт автобус на точке сбора. Только имя — ни телефона, ни цены сервер
 * гостю не отдаёт; без перевозчика маршрут подписан как раньше, без приписок.
 */
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
    /* `id` — якорь для «автобус не выбран» из раздела дня: гость записывается здесь. */
    <div id="transfer" className="px-6 mt-6 relative z-10 rv">
      <div className="rounded-[24px] p-5" style={{ background: T.card, boxShadow: shadow }}>
        <p className="text-[11px] font-semibold flex items-center gap-1.5"><Bus size={12} style={{ color: T.accent }} />{t('Трансфер')}</p>
        <div className="space-y-2 mt-3">
          {routes.map(r => {
            const mine = q.data?.myBusId === r.id
            const full = (r.taken ?? 0) >= (r.seats ?? 0)
            return (
              /* Свой автобус — состояние, а не действие: повторный тап слал тот же
                 POST в никуда (R-176; ревью 015). Снять запись гость не может —
                 контракт такого пути не даёт (вопрос владельцу). */
              <button key={r.id} disabled={busy || mine || (full && !mine)} aria-pressed={mine} onClick={() => join(r.id ?? '')} className={cn('press w-full rounded-[16px] px-4 py-3 flex items-center gap-3 text-left', !mine && 'disabled:opacity-50')}
                style={mine ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>
                <div className="flex-1 min-w-0">
                  <b className="text-[12.5px] block truncate">{r.carrier ? `${r.name} · ${r.carrier}` : r.name}</b>
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

/**
 * Отельные блоки: номер занимается так же атомарно, как место в автобусе.
 *
 * Свою бронь гость видит по `HotelBlock.mine` (контракт v0.29.0): без
 * признака он не знал, где записан, а тап по другому блоку переносил бронь
 * молча — сервер по POST освобождает прежний номер сам (D3-15, фича 005).
 * Теперь перенос идёт через подтверждение: первый тап показывает
 * «Перенести бронь?», второй — отправляет. Без своей брони тап занимает
 * номер сразу, как раньше.
 */
function GuestHotels({ token, T, shadow }: { token: string; T: Theme; shadow: string }) {
  const q = useApi(() => getGuestHotels(token), [token])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* Блок, перенос в который ждёт второго тапа. */
  const [moveTo, setMoveTo] = useState<string | null>(null)
  const blocks = q.data ?? []
  if (q.error) return <GuestBlockError title={t('Где остановиться')} error={q.error} onRetry={q.reload} T={T} shadow={shadow} />
  if (!blocks.length) return null

  const booked = blocks.some(h => h.mine)
  const book = (hotelId: string) => void (async () => {
    setBusy(true)
    setErr(null)
    setMoveTo(null)
    try { await bookHotelRoom(token, hotelId); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()
  const tap = (hotelId: string) => {
    if (booked && moveTo !== hotelId) { setMoveTo(hotelId); return }
    book(hotelId)
  }

  return (
    <div className="px-6 mt-6 relative z-10 rv">
      <div className="rounded-[24px] p-5" style={{ background: T.card, boxShadow: shadow }}>
        <p className="text-[11px] font-semibold flex items-center gap-1.5"><Hotel size={12} style={{ color: T.accent }} />{t('Где остановиться')}</p>
        <div className="space-y-2 mt-3">
          {blocks.map(h => {
            const full = (h.booked ?? 0) >= (h.rooms ?? 0)
            const left = (h.rooms ?? 0) - (h.booked ?? 0)
            const inner = (
              <>
                <div className="flex-1 min-w-0">
                  <b className="text-[12.5px] block truncate">{h.name}</b>
                  <span className="text-[10.5px] opacity-80">
                    {[h.price?.amount != null ? fmt(h.price.amount) : '', h.promo].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <span className="text-[10px] font-bold shrink-0">
                  {h.mine ? t('Вы здесь') : moveTo === h.id ? t('Перенести бронь?') : full ? t('мест нет') : `${left} ${plural(left, t('номер'), t('номера'), t('номеров'))}`}
                </span>
              </>
            )
            /* Свой блок — состояние, а не кнопка: занимать его заново нечем. */
            if (h.mine) return (
              <div key={h.id} className="w-full rounded-[16px] px-4 py-3 flex items-center gap-3 text-left" style={{ background: T.accentGrad, color: '#FFF7F0' }}>
                {inner}
              </div>
            )
            return (
              <button key={h.id} disabled={busy || full} onClick={() => tap(h.id ?? '')} className="press w-full rounded-[16px] px-4 py-3 flex items-center gap-3 text-left disabled:opacity-50"
                style={moveTo === h.id ? { background: T.accentGrad, color: '#FFF7F0' } : { background: T.bg, color: T.ink }}>
                {inner}
              </button>
            )
          })}
        </div>
        {err && <p role="alert" className="text-[11.5px] mt-2" style={{ color: T.accent }}>{err}</p>}
      </div>
    </div>
  )
}

/* ── День свадьбы (фича 009) ─────────────────────────────────────────── */

/** Канун: дата свадьбы минус день, `YYYY-MM-DD`. Календарная арифметика в UTC — пояс тут не участвует. */
function eveOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10)
}

/*
 * Самый ранний пояс Земли, UTC+14. Раздел дня решается по поясу места, а
 * `GET /rsvp/{t}` его пока не отдаёт — точный пояс приходит только с ответом
 * `GET /join/{t}/day`. Пока его нет, «канун мог наступить» считается по этому
 * поясу: запрос уходит не раньше чем за сутки с небольшим до кануна, а не
 * месяцами, и без выдумывания пояса за сервер.
 */
const EARLIEST_TZ = 'Etc/GMT-14'

/** «13 июня, 09:00» в поясе места — срок открытия чата дня. */
function formatWhen(iso: string, tz: string): string {
  const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
  const opts = { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' } as const
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz }).format(new Date(iso))
  } catch {
    return new Intl.DateTimeFormat(locale, opts).format(new Date(iso))
  }
}

/*
 * Раздел «День свадьбы» (План §8.8, экран 59; фича 009).
 *
 * Всё — из одного ответа `GET /join/{t}/day`: программа (только блоки «для
 * гостей», время в поясе места), свой стол, свой автобус с перевозчиком,
 * координатор с кнопкой «Позвонить» («не жениху»), дресс-код, адрес с маршрутом
 * и вход в чат дня. Раздел виден с кануна по поясу места: сравниваем
 * календарную дату «сегодня там» с датой свадьбы минус день. До ответа сервера
 * ничего не утверждаем — «стол пока не назначен» появляется только вместе с
 * `table: null` (инвариант 13), а отказ показан словами с «Повторить», как у
 * соседних блоков.
 */
function GuestDay({ token, city, now, T, shadow }: { token: string; city?: string; now: number; T: Theme; shadow: string }) {
  const nav = useNavigate()
  const q = useApi(() => getGuestDay(token), [token])
  const disp = T.serif ? 'font-serif-d' : ''
  if (q.error) return <GuestBlockError title={t('День свадьбы')} error={q.error} onRetry={q.reload} T={T} shadow={shadow} />
  const day = q.data
  if (!day) {
    if (!q.loading) return null
    return (
      <div className="px-6 mt-12 relative z-10">
        <div className="rounded-[24px] p-5" style={{ background: T.card, boxShadow: shadow }}>
          <p className="text-[11px] font-semibold">{t('День свадьбы')}</p>
          <p className="text-[11.5px] mt-2" style={{ color: T.soft }}>{t('Загружаем…')}</p>
        </div>
      </div>
    )
  }
  /* Без даты кануна не бывает; до кануна по поясу места раздела нет — как раньше. */
  if (!day.date || todayIn(day.tz, now) < eveOf(day.date)) return null

  const address = [day.venue, city].filter(Boolean).join(', ')
  const palette = day.dressCode ? dressPalettes.find(x => x.id === day.dressCode) : undefined
  const closesAt = day.chat.closesAt ? Date.parse(day.chat.closesAt) : NaN
  return (
    <div className="px-6 mt-12 relative z-10 rv rv-scale">
      <div className="rounded-[28px] p-6 relative overflow-hidden" style={{ background: T.card, boxShadow: shadow }}>
        <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: T.accentGrad }} />
        <h2 className={cn('text-[24px] text-center', disp)}>{t('День свадьбы')}</h2>

        <p className="text-[11px] font-semibold flex items-center gap-1.5 mt-5"><Clock3 size={12} style={{ color: T.accent }} />{t('Программа')}</p>
        {day.timeline.length ? (
          <ul className="mt-2 space-y-2">
            {day.timeline.map(e => (
              <li key={e.id} className="flex gap-3 text-[12.5px]">
                <b className="tabular shrink-0 w-[46px]" style={{ color: T.accent }}>{e.startsAt ? formatTime(e.startsAt, day.tz) : '—'}</b>
                <span className="min-w-0">
                  <span className="font-medium">{e.name}</span>
                  {e.location && <span className="block text-[10.5px]" style={{ color: T.soft }}>{e.location}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          /* Пустой список — ответ сервера, а не его отсутствие: пара ещё не
             открыла гостям ни одного блока. */
          <p className="text-[11.5px] mt-2" style={{ color: T.soft }}>{t('Программу для гостей пара ещё не открыла')}</p>
        )}

        <p className="text-[12.5px] mt-5 flex items-center gap-1.5">
          <Armchair size={12} style={{ color: T.accent }} />
          {day.table ? <span>{t('Ваш стол:')} <b>{day.table.name}</b></span> : <span style={{ color: T.soft }}>{t('стол пока не назначен')}</span>}
        </p>
        <p className="text-[12.5px] mt-2 flex items-center gap-1.5">
          <Bus size={12} style={{ color: T.accent }} />
          {day.bus
            ? <span>{t('Ваш автобус:')} <b>{[day.bus.name, day.bus.time, day.bus.carrier].filter(Boolean).join(' · ')}</b></span>
            /* Записаться можно ниже, в блоке трансфера — туда и ведёт ссылка. */
            : <span style={{ color: T.soft }}>{t('автобус не выбран')} · <a href="#transfer" className="underline" style={{ color: T.accent }}>{t('к трансферу')}</a></span>}
        </p>

        {/* Координатор — тот, кому звонить в день X (План §8.8): телефон приходит
            с кануна, кнопка — прямой `tel:`. Нет координатора — нет блока. */}
        {day.coordinator && (
          <div className="mt-4 flex items-center gap-3">
            <p className="text-[12.5px] flex-1 min-w-0">{t('Координатор:')} <b>{day.coordinator.name}</b></p>
            {day.coordinator.phone && (
              <a href={`tel:${day.coordinator.phone}`} className="press shrink-0 px-4 h-[36px] rounded-full text-[11.5px] font-semibold flex items-center gap-1.5" style={{ background: T.accentGrad, color: '#FFF7F0' }}>
                <Phone size={12} />{t('Позвонить')}
              </a>
            )}
          </div>
        )}

        {palette && (
          <p className="text-[12.5px] mt-4">
            {t('Дресс-код:')} <b>{t(palette.name)}</b>
            {day.dressNote && <span className="block text-[10.5px]" style={{ color: T.soft }}>{day.dressNote}</span>}
          </p>
        )}

        {address && (
          <div className="mt-4 flex items-center gap-3">
            <p className="text-[12.5px] flex-1 min-w-0 flex items-center gap-1.5"><MapPin size={12} style={{ color: T.accent }} />{address}</p>
            <a href={`https://yandex.ru/maps/?text=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer" className="press shrink-0 text-[11.5px] font-semibold underline" style={{ color: T.accent }}>{t('Построить маршрут')}</a>
          </div>
        )}

        {/* Окно чата называет сервер (`chat.open`, `opensAt`, `closesAt`): срок —
            его слова в поясе места, а не выдуманные 09:00 на экране. */}
        {day.chat.open ? (
          <button onClick={() => nav('/invite/day-chat')} className="press w-full h-[46px] rounded-full mt-5 text-[13px] font-semibold flex items-center justify-center gap-2" style={{ background: T.accentGrad, color: '#FFF7F0' }}>
            <MessageCircle size={15} />{t('Открыть чат дня')}
          </button>
        ) : (
          <p className="text-[11.5px] mt-5 text-center" style={{ color: T.soft }}>
            {Number.isFinite(closesAt) && now > closesAt
              ? t('Чат дня закрыт — свадьба прошла')
              : day.chat.opensAt ? `${t('Чат дня откроется')} ${formatWhen(day.chat.opensAt, day.tz)}` : t('Чат дня откроется накануне свадьбы')}
          </p>
        )}
      </div>
    </div>
  )
}

/* ── Чат дня глазами гостя (фича 009, экран 60) ──────────────────────── */

type DayMessage = NonNullable<NonNullable<Awaited<ReturnType<typeof getGuestDayMessages>>>['items']>[number]
/** Хвост ленты — либо причина, по которой его нет: окно закрыто (словами сервера) или ссылка мертва. */
type DayTail = { items: DayMessage[] } | { locked: string } | { dead: true }

/** Хронологический порядок: сервер отдаёт свежие первыми, в переписке последняя реплика внизу. */
const bySentAt = (a: DayMessage, b: DayMessage) =>
  (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || (a.id ?? '').localeCompare(b.id ?? '')

/*
 * Чат дня X глазами гостя: та же лента, что у пары и команды, по токену
 * гостя — читать и писать «автобус задерживается» всем сразу, а не жениху
 * (План §8.8, §13.1 п. 4; решение владельца В3 — общий чат дня).
 *
 * Живого канала у гостя нет: сокет требует токен аккаунта, — поэтому только
 * опрос раз в 30 с, и это `reload()` того же запроса: лента остаётся на
 * экране, «Загружаем…» не мигает (ERR-0244). У гостя нет идентификатора, и
 * свою реплику называет сервер — `Message.mine` по строке гостя (фича 014,
 * A8): до этого экран сравнивал имена, и реплика тёзки (две Марины на одной
 * свадьбе) рисовалась «своей». Вне окна сервер отвечает 423 — его текст на
 * экран, поле закрыто; 410 — ссылка отозвана.
 */
export function GuestDayChat() {
  const nav = useNavigate()
  const token = guestToken()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* Окно закрылось под рукой: 423 на отправку — текст сервера, поле закрыто. */
  const [closed, setClosed] = useState<string | null>(null)
  /* Свои реплики из ответов POST: в ленте сразу, а не через полминуты опроса. */
  const [posted, setPosted] = useState<DayMessage[]>([])

  const q = useApi<DayTail | null>(
    () => token
      ? getGuestDayMessages(token)
        .then((page): DayTail => ({ items: page?.items ?? [] }))
        .catch((e: unknown): DayTail => {
          if (e instanceof ApiError && e.status === 423) return { locked: e.message }
          if (e instanceof ApiError && LINK_DEAD_STATUSES.includes(e.status)) return { dead: true }
          throw e
        })
      : Promise.resolve(null),
    [token],
  )
  const reload = q.reload
  useEffect(() => {
    if (!token) return
    const poll = window.setInterval(reload, 30_000)
    return () => window.clearInterval(poll)
  }, [token, reload])

  const tail = q.data && 'items' in q.data ? q.data.items : null
  const locked = closed ?? (q.data && 'locked' in q.data ? q.data.locked : null)
  const dead = !!q.data && 'dead' in q.data
  /* Хвост и свои отправленные — по идентификатору: реплика из ответа POST и
     та же реплика из следующего опроса — одна строка, не две. */
  const merged: Record<string, DayMessage> = {}
  for (const m of [...posted, ...(tail ?? [])]) if (m.id) merged[m.id] = m
  const messages = Object.values(merged).sort(bySentAt)

  /* Прокрутка к последней реплике — по новой реплике, как в чате пары. */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastId = messages[messages.length - 1]?.id
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId])

  const send = () => void (async () => {
    const body = text.trim()
    if (!token || !body || sending) return
    setSending(true)
    setErr(null)
    try {
      const m = await postGuestDayMessage(token, body)
      if (m?.id) setPosted(prev => [...prev, m])
      setText('')
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) setClosed(e.message)
      else setErr(explainError(e))
    } finally { setSending(false) }
  })()

  if (!token) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p className="font-serif-d text-[22px]">{t('Нужна ссылка из приглашения')}</p>
    </div>
  )

  const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => goBack(n => nav(n), (to, o) => nav(to, o), '/invite')} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
          <ChevronLeft size={17} />
        </button>
        <div className="flex-1 min-w-0">
          <b className="text-[14px] block truncate">{t('Чат дня свадьбы')}</b>
          <span className="text-[10px] text-[var(--soft)]">{t('обновление раз в 30 секунд')}</span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
        {dead && <p role="alert" className="text-center text-[12.5px] text-[var(--soft)] px-6 mt-6 leading-relaxed">{t('Ссылка недействительна')}</p>}
        {!dead && q.loading && <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Загружаем…')}</p>}
        {q.error && (
          <div className="py-6 text-center">
            <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed px-6">{q.error}</p>
            <button onClick={q.reload} className="press mt-3 px-5 h-[40px] rounded-full card-s text-[12px] font-semibold">{t('Повторить')}</button>
          </div>
        )}
        {tail && !messages.length && (
          <p className="text-center text-[12px] text-[var(--soft)] py-6">{t('Сообщений пока нет — напишите первым')}</p>
        )}
        {messages.map(m => {
          /* Системная запись — по признаку сервера, как в чате пары (D4-15). */
          if (m.system === true) return (
            <p key={m.id} className="text-center text-[11px] text-[var(--soft)] leading-relaxed px-6 py-2">⚠ {m.text}</p>
          )
          /* Своя ли — говорит сервер; своя отправка из ответа POST несёт `mine: true` тем же полем. */
          const mine = m.mine === true
          return (
            <div key={m.id} className={cn('flex fade-up', mine ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[78%] px-4 py-3 text-[13px] leading-relaxed',
                mine ? 'grad text-[var(--on-grad)] rounded-br-[6px]' : 'card rounded-bl-[6px] text-[var(--ink)]')}
                style={{ borderRadius: 18 }}>
                {/* Автор: у гостя — имя из ответа; у людей имени в ответе нет —
                    это команда свадьбы. */}
                {!mine && <span className="block text-[9.5px] text-[var(--soft)] mb-1">{m.guestName ?? t('Команда')}</span>}
                {m.text}
                <span className={cn('block text-[9px] mt-1 text-right', mine ? 'text-white/70' : 'text-[var(--soft)]')}>
                  {m.sentAt ? new Date(m.sentAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : ''}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {err && <p role="alert" className="px-5 pb-2 text-[12px] text-[var(--rose-ink)]">{err}</p>}
      {dead ? null : locked ? (
        <p className="glass-tab border-t-0 border-b-0 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] text-center text-[11.5px] text-[var(--soft)] leading-relaxed">{locked}</p>
      ) : (
        <div className="glass-tab border-t-0 border-b-0 px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] flex gap-2.5">
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
            placeholder={t('Сообщение…')} className="flex-1 bg-[var(--card)] rounded-full px-5 h-[48px] text-[13.5px] outline-none placeholder:text-[var(--soft2)]" style={{ boxShadow: 'var(--shadow)' }} />
          <button disabled={sending || !text.trim()} onClick={send} className="press w-[48px] h-[48px] rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0 disabled:opacity-40" aria-label={t('Отправить')}><Send size={17} /></button>
        </div>
      )}
    </div>
  )
}
