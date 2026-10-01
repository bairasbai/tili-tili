import { createElement, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Wallet, ListChecks, Clock3, Users, FileText, Plus, Send, Download, Armchair, Heart, NotebookPen, Wine, Gift, Camera, Bus, UtensilsCrossed, ShieldCheck, ListPlus, RefreshCw, Pencil, LockKeyhole } from 'lucide-react'
import { contractTemplates } from '@/lib/contractTemplates'
import { fmt } from '@/lib/money'
import type { Slot } from '@/lib/types'
import { useApi, explainError, noWedding, NO_WEDDING } from '@/lib/api/useApi'
import { formatTime, formatWeddingDate, isoAtWeddingTime, shortWeddingDate } from '@/lib/weddingDate'
import { AsyncState, num, ready } from '@/components/AsyncState'
import { getBudget, getDocuments, getGuests, getMembers, getSlots, getTasks, getTimelineSnapshot, getTips, getWedding } from '@/lib/api/weddingData'
import { getAlbum, setAlbumApproved, setPhotoApproved } from '@/lib/api/gifts'
import { addBudgetItem, addGuest, addGuestMember, addTask as addTaskApi, autogenTimeline, deleteBudgetItem, deleteGuest, deleteTask, importGuests, patchGuest, patchTask, putTimeline, remindGuests, renameTask, resetBudgetCategoryLimit, setBudgetCategoryLimit, setBudgetReserve, setTaskDone, toTimelineDraft, type GuestImportRow, type TimelineDraft } from '@/lib/api/weddingWrite'
import { guestNameKey, normalizeRuPhone, parseGuestList } from '@/lib/guestsImport'
import { listMyWeddings, setBudgetTotal } from '@/lib/api/wedding'
import { getShortlist, removeShortlistCandidate } from '@/lib/api/shortlist'
import { rub } from '@/lib/money'
import { AiTip, Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { PrebookedSlotCard } from '@/components/PrebookedSlot'
import { useIsCouple } from '@/lib/useIsCouple'
import { useStore } from '@/lib/store'
import { committedTotal } from '@/lib/budget'
import { useBusy } from '@/lib/useBusy'
import { catIcon } from '@/lib/icons'
import { cn, copyText, pct, plural } from '@/lib/utils'
import { chatRouteForVendor } from '@/lib/api/chats'
import { ApiError, isAuthorized } from '@/lib/api/client'
import { getI18nLang, t, key } from '@/lib/i18n'
import { getMe } from '@/lib/api/auth'
import { parseReservePercent, parseWholeRubles } from '@/lib/paymentAmount'
import { TaskPlanningFields, TaskPlanningEditor, type TaskPlanningValue } from '@/components/TaskPlanning'
import { OfferRequestComposer } from '@/components/OfferRequestComposer'
import { OfferAcceptance } from '@/components/OfferAcceptance'
import { OfferSummary } from '@/components/OfferSummary'
import { TimelinePlanningEditor, type TimelineChoice } from '@/components/TimelinePlanning'
import { TimelineAcknowledgments } from '@/components/TimelineAcknowledgments'

/* Навигация раздела «Свадьба» */
function WeddingNav() {
  const nav = useNavigate()
  const items = [
    { to: '/wedding/budget', icon: Wallet, label: t('Бюджет'), tile: 'bg-[var(--rose-soft)]' },
    { to: '/wedding/checklist', icon: ListChecks, label: t('Чек-лист'), tile: 'bg-[var(--sage-soft)]' },
    { to: '/wedding/timeline', icon: Clock3, label: t('Тайминг'), tile: 'bg-[var(--honey)]' },
    { to: '/wedding/guests', icon: Users, label: t('Гости'), tile: 'bg-[var(--lav)]' },
    { to: '/wedding/documents', icon: FileText, label: t('Документы'), tile: 'bg-[var(--blue)]' },
    { to: '/favorites', icon: Heart, label: t('Избранное'), tile: 'bg-[var(--rose-soft)]' },
    { to: '/notes', icon: NotebookPen, label: t('Заметки'), tile: 'bg-[var(--peach)]' },
    { to: '/wedding/wishlist', icon: Gift, label: t('Желания'), tile: 'bg-[var(--rose-soft)]' },
    { to: '/wedding/album', icon: Camera, label: t('Альбом'), tile: 'bg-[var(--blue)]' },
    { to: '/wedding/logistics', icon: Bus, label: t('Логистика'), tile: 'bg-[var(--blue)]' },
    { to: '/wedding/catering', icon: UtensilsCrossed, label: t('Меню'), tile: 'bg-[var(--honey)]' },
    { to: '/wedding/seating', icon: Armchair, label: t('Рассадка'), tile: 'bg-[var(--lav)]' },
    { to: '/wedding/planb', icon: ShieldCheck, label: t('План Б'), tile: 'bg-[var(--sage-soft)]' },
    { to: '/tools/alcohol', icon: Wine, label: t('Алко-кальк.'), tile: 'bg-[var(--sage-soft)]' },
  ]
  return (
    <div className="grid grid-cols-4 md:grid-cols-7 gap-2 px-5 mt-3">
      {items.map(it => (
        <button key={it.to} onClick={() => nav(it.to)} className="press flex flex-col items-center gap-1.5">
          <div className={cn('w-[52px] h-[52px] rounded-[18px] flex items-center justify-center', it.tile)} style={{ boxShadow: 'var(--shadow)' }}>
            <it.icon size={20} className="text-[var(--ink2)]" />
          </div>
          <span className="text-[9px] text-[var(--soft)] font-medium">{it.label}</span>
        </button>
      ))}
    </div>
  )
}

/* Команда (мозаика слотов) */
export function WeddingTeam() {
  const nav = useNavigate()
  const { slots, slotsState, weddingId } = useStore()
  /* «Уже забронировано вне приложения» (фича 018) считается бронью: в подписи, в сводке
     «Команда собрана» и мимо подсказки «Пустой слот» — пара сказала, что подрядчик есть. */
  const booked = slots.filter(s => s.state === 'booked' || s.state === 'prebooked').length
  const progress = slots.filter(s => s.state !== 'empty').length
  const isCouple = useIsCouple(slots.some(s => s.state === 'prebooked'))
  /* Общий бюджет — с сервера. Здесь стояло `couple.budgetTotal` из мока:
     полоса «забронировано на сумму» считалась от чужого миллиона двухсот и
     врала у каждой пары, кроме выдуманной. */
  const budget = useApi(() => weddingId ? getBudget(weddingId) : noWedding(), [weddingId])
  /* Дефицит категории и блокирующий слот (§3.14 п. 1–2) — с сервера: подсказка
     о пустом слоте ниже берёт их первыми, общее «подобрать свободных» — когда
     сервер поводов не назвал. */
  /* Отметка «уже забронировано» меняет ответ подсказок (FR-017): снята — перечитать. */
  const prebookedKey = slots.filter(s => s.state === 'prebooked').map(s => s.id).join(',')
  const tipsQ = useApi(() => weddingId ? getTips(weddingId) : noWedding(), [weddingId, prebookedKey])
  /* Ноль здесь — «итог не задан», а не сумма: полоса «от нуля» была бы
     процентом от неизвестного (R-178, ревью D2-09). */
  const budgetTotal = budget.data?.total?.amount ?? 0

  return (
    <div className="pb-28">
      {/* Пока мозаика не пришла, подписи нет вовсе: «0 забронировано · 0 в
          работе · 0 пустых» при лежащем сервере читается как факт о своей
          свадьбе. */}
      <TopBar
        title={t('Наш день')}
        sub={slotsState === 'ready'
          ? `${booked}${t(' забронировано · ')}${progress - booked}${t(' в работе · ')}${slots.length - progress}${t(' пустых')}`
          : slotsState === 'error' ? t('Сервер недоступен — команда не загрузилась') : undefined}
      />
      <WeddingNav />
      <div className="px-5 mt-3.5">
        {/* Контрастная карточка токенами: в тёмной теме «чернила» светлеют,
            а фон темнеет — читается в обеих (R-01). */}
        <button onClick={() => nav('/dayx')} className="press w-full rounded-[22px] p-4 flex items-center gap-3 text-left bg-[var(--ink)] text-[var(--bg)]" style={{ boxShadow: 'var(--shadow)' }}>
          <span className="text-[22px]">🎬</span>
          <span className="flex-1">
            <b className="text-[13px] block">{t('Режим дня X')}</b>
            {/* Ни «демо», ни SOS здесь больше нет: экран дня X работает на
                серверном тайминге, а отдельной кнопки «позвать координатора»
                контракт не знает — вместо неё командный чат (R-163). */}
            <span className="text-[10px] opacity-70">{t('Тайминг, сдвиг всей программы, план Б и чат команды')}</span>
          </span>
        </button>
      </div>
      <div className="px-5 mt-5">
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5 stagger">
          {slots.map(s => {
            /* Отметка из квиза — не плитка, а вопрос к паре с двумя ответами: во всю строку мозаики. */
            if (s.state === 'prebooked') return <PrebookedSlotCard key={s.id} slot={s} canAct={isCouple} className="col-span-3 md:col-span-6" />
            return (
            <button
              key={s.id}
              onClick={() => nav(`/wedding/slot/${s.id}`)}
              className={cn('press rounded-[18px] p-3 flex flex-col items-center justify-center gap-1.5 aspect-[0.85] md:aspect-auto md:py-5 fade-up',
                s.state === 'empty' ? 'border-[1.5px] border-dashed border-[var(--rose)] bg-[var(--rose-soft)]/30' : 'card-s')}
            >
              <span className={cn('w-9 h-9 rounded-[12px] flex items-center justify-center', s.state === 'empty' ? '' : s.tile)}>
                {s.state === 'empty' ? <Plus size={20} className="text-[var(--rose-ink)]" /> : createElement(catIcon(s.categoryId), { size: 18, className: 'text-[var(--ink2)]' })}
              </span>
              <b className="text-[10.5px] text-center leading-tight">{s.label}</b>
              {s.state === 'booked' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[var(--sage-deep)]">{t('забронирован')}</span>}
              {s.state === 'hold' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[var(--honey-deep)]">{s.status && t(s.status)}</span>}
              {s.state === 'candidate' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[var(--rose-deep)]">{t('Не связывались')}</span>}
            </button>
            )
          })}
        </div>
        {/* Подсказка называет настоящие пустые слоты, а не «DJ и Декоратор»
            константой, и не обещает дату 14.06, которой у этой пары может не
            быть. Когда пустых слотов нет — подсказки тоже нет. */}
        {(() => {
          const urgent = (tipsQ.data?.items ?? []).find(x => x.kind === 'deficit' || x.kind === 'blocking_slot')
          if (urgent) return <div className="mt-4"><AiTip text={`${urgent.title}. ${urgent.body}`} onPress={() => nav(urgent.link ?? '/search')} /></div>
          const empty = slots.filter(s => s.state === 'empty')
          if (!empty.length) return null
          const names = empty.slice(0, 2).map(s => `«${t(s.label)}»`).join(t(' и '))
          return <div className="mt-4"><AiTip text={`${t('Пустой слот')} ${names}${t(' — подобрать свободных под ваш бюджет?')}`} onPress={() => nav(`/search/${empty[0]!.categoryId}`)} /></div>
        })()}
      </div>

      <div className="px-5">
        <SectionHead title={t('Сводка')} />
        {/* Сводка — только по пришедшей мозаике. «0 из 0» и «0 ₽» при лежащем
            сервере читаются как «команды нет и денег не отложено». Полоса
            бюджета ждёт ещё и бюджет: без него «0%» — тоже выдумка. */}
        <div className="card p-5 mt-2">
          <div className="flex justify-between text-[12px] mb-1.5"><span className="text-[var(--soft)]">{t('Команда собрана')}</span><b>{slotsState === 'ready' ? `${booked} ${t('из')} ${slots.length}` : '—'}</b></div>
          {slotsState === 'ready' && <Bar pct={pct(booked, slots.length)} />}
          <div className="flex justify-between text-[12px] mb-1.5 mt-4"><span className="text-[var(--soft)]">{t('Забронировано на сумму')}</span><b className="tabular">{slotsState === 'ready' ? fmt(committedTotal(slots)) : '—'}</b></div>
          {slotsState === 'ready' && ready(budget) && budgetTotal > 0 && <Bar pct={pct(committedTotal(slots), budgetTotal)} />}
          {/* Свадьбы нет — те же слова и кнопка в квиз, что у остальных разделов
              (FB6): красной строкой без выхода это читалось как поломка. */}
          {budget.error === t(NO_WEDDING)
            ? <AsyncState q={budget} />
            : budget.error && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-2">{budget.error}</p>}
        </div>
      </div>
    </div>
  )
}

/* Деталь слота */
export function SlotDetail() {
  const { slots, slotsState, weddingsState, weddingId } = useStore()
  /* Идентификатор — из маршрута, а не разбором `location.pathname`: разбор
     руками ломается на первом же вложенном адресе. Подмены «не нашли — покажем
     первый слот» здесь нет: чужая ссылка должна открывать «не найдено», а не
     чужой слот. */
  const { id } = useParams()
  const s = slots.find(x => x.id === id)
  /* Мозаика приходит с сервера, и до ответа слот не «пустой», а неизвестный:
     разница видна человеку — пустой предлагает выбрать подрядчика, неизвестный
     просит подождать, а недоступный сервер — сказать об этом прямо. */
  if (!s) return (
    <div className="pb-28">
      <TopBar back title={t('Слот команды')} />
      {/* Три разных случая, и раньше все три выглядели как «Загружаем…»:
          при лежащем сервере экран обещал загрузку до конца сеанса. */}
      <p className="px-5 mt-6 text-[13px] text-[var(--soft)]">
        {slotsState === 'error'
          ? t('Сервер недоступен. Попробуйте позже')
          : slotsState === 'ready' ? t('Слот не найден')
          : slotsState === 'idle' ? noWeddingText(weddingsState) : t('Загружаем…')}
      </p>
    </div>
  )
  return <SlotView key={`${weddingId}:${s.id}`} s={s} />
}

/*
 * Мозаика не запрашивается (`idle`), и это четыре разных положения, а не
 * одно «без входа»: на новом устройстве свадьба не записана, пока список
 * свадеб едет; список мог не прийти; у вошедшего свадьбы может не быть
 * вовсе — партнёр отменил. Раньше все они читались как «Войдите» при живом
 * входе (ревью R3-03). Сюда попадает и «Назад» после выхода — ему «Войдите».
 * `idle` списка при живом входе — сверка ещё не началась, как на главной.
 * Те же слова — у экрана сделки (`Tools.tsx`): страницы экспортируют только
 * компоненты, общий модуль под пять строк не заводим.
 */
function noWeddingText(weddingsState: 'idle' | 'loading' | 'ready' | 'error'): string {
  if (!isAuthorized()) return t('Войдите, чтобы увидеть свою свадьбу')
  if (weddingsState === 'ready') return t('Свадьбы пока нет')
  if (weddingsState === 'error') return t('Сервер недоступен. Попробуйте позже')
  return t('Загружаем…')
}

function SlotCandidates({ s }: { s: Slot }) {
  const nav = useNavigate()
  const { weddingId, weddingDate, refreshSlots } = useStore()
  const q = useApi(() => weddingId ? getShortlist(weddingId, s.id) : noWedding(), [weddingId, s.id])
  const roles = useApi(() => listMyWeddings(), [weddingId])
  const currentWedding = roles.data?.find(w => w.id === weddingId)
  const role = currentWedding?.role
  const canRemove = ready(roles) && (role === 'couple' || role === 'helper')
  const canBook = ready(roles) && role === 'couple'
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({})
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removing = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const [error, setError] = useState<string | null>(null)
  const entries = ready(q) ? [...(q.data ?? [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) : []
  const selected = entries.filter(e => e.available === true && e.vendor && !unchecked[e.id])
  const blocked = !ready(q) || q.refreshing || removingId !== null

  const remove = async (entryId: string) => {
    if (!weddingId || !canRemove || blocked || removing.current) return
    removing.current = true
    setRemovingId(entryId)
    setError(null)
    try {
      await removeShortlistCandidate(weddingId, s.id, entryId)
      q.reload()
      heading.current?.focus()
    } catch (e) {
      setError(explainError(e))
    } finally {
      removing.current = false
      setRemovingId(null)
    }
  }

  return (
    <section className="card p-4 mt-3.5" aria-labelledby="slot-candidates-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 ref={heading} tabIndex={-1} id="slot-candidates-heading" className="font-serif-d text-[18px]">{t('Кандидаты')}</h2>
        <span className="text-[11px] text-[var(--soft)] tabular" aria-live="polite">{ready(q) ? `${entries.length} / 3` : '—'}</span>
      </div>
      <AsyncState q={q} />
      {ready(q) && entries.length === 0 && <p className="text-[12px] text-[var(--soft)] mt-3">{t('Кандидатов пока нет — добавьте их из каталога')}</p>}
      {ready(q) && entries.length > 0 && (
        <div className="space-y-2.5 mt-3">
          {entries.map(entry => {
            const vendor = entry.vendor
            const live = entry.available === true && vendor !== null
            const name = vendor?.name ?? t('Анкета недоступна')
            const occupancy = entry.occupancy === 'free' ? t('Свободен на вашу дату')
              : entry.occupancy === 'held' ? t('На вашу дату идут переговоры')
              : entry.occupancy === 'busy' ? t('Занят на вашу дату')
              : t('Занятость неизвестна')
            return (
              <div key={entry.id} className="card-s rounded-[16px] p-3">
                <div className="flex items-start gap-2.5">
                  {live ? (
                    <input
                      type="checkbox"
                      checked={!unchecked[entry.id]}
                      disabled={blocked}
                      onChange={e => setUnchecked(prev => ({ ...prev, [entry.id]: !e.target.checked }))}
                      aria-label={`${t('Сравнить кандидата')} ${name}`}
                      className="mt-1 h-4 w-4 accent-[var(--rose-deep)] shrink-0"
                    />
                  ) : <span className="w-4 shrink-0" aria-hidden="true" />}
                  <div className="flex-1 min-w-0">
                    <b className="text-[12.5px] block">{entry.position}. {name}</b>
                    {!live && vendor && <p className="text-[11px] text-[var(--rose-ink)] mt-1">{t('Анкета недоступна')}</p>}
                    {live && <p className="text-[11px] text-[var(--soft)] mt-1">{occupancy}</p>}
                    {entry.request && <div className="mt-2 text-[11px]"><OfferSummary request={entry.request} currentWeddingDate={weddingDate} weddingTz={currentWedding?.tz} /></div>}
                    {weddingId && <OfferAcceptance
                      key={`${weddingId}:${entry.request && 'id' in entry.request ? entry.request.offer?.id ?? entry.request.id : entry.id}`}
                      weddingId={weddingId} request={entry.request} currentWeddingDate={weddingDate} weddingTz={currentWedding?.tz}
                      canAccept={canBook && !roles.refreshing && !blocked && live && entry.occupancy !== 'busy' && !s.dealId}
                      onChanged={() => { q.reload(); refreshSlots() }}
                    />}
                  </div>
                </div>
                <div className="flex gap-2 mt-2.5 justify-end">
                  {canRemove && <button disabled={blocked} onClick={() => void remove(entry.id)} aria-label={`${t('Убрать кандидата')} ${entry.position}: ${name}`} className="press px-3 py-2 rounded-xl bg-[var(--track)] text-[11px] font-semibold text-[var(--rose-ink)] disabled:opacity-50">{removingId === entry.id ? t('Убираем…') : t('Убрать')}</button>}
                  {canBook && live && entry.occupancy !== 'busy' && !s.dealId && <button disabled={blocked} onClick={() => nav(`/vendor/${vendor.id}`)} aria-label={`${t('Забронировать кандидата')} ${name}`} className="press px-3 py-2 rounded-xl grad text-[var(--on-grad)] text-[11px] font-semibold disabled:opacity-50">{t('Забронировать')}</button>}
                  {canBook && live && entry.occupancy !== 'busy' && !!s.dealId && s.dealState !== 'done' && vendor.id !== s.vendorId && <button disabled={blocked} onClick={() => nav(`/vendor/${vendor.id}?${new URLSearchParams({ replaceSlot: s.id })}`)} aria-label={`${t('Заменить исполнителя на')} ${name}`} className="press px-3 py-2 rounded-xl grad text-[var(--on-grad)] text-[11px] font-semibold disabled:opacity-50">{t('Заменить')}</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {canBook && s.dealId && s.dealState !== 'done' && ready(q) && entries.some(e => e.available === true && e.vendor?.id !== s.vendorId) && <p className="text-[11px] text-[var(--soft)] mt-2">{t('Выберите кандидата для замены, затем подтвердите новую бронь в его анкете')}</p>}
      {ready(q) && entries.length > 0 && (
        <>
          <button
            disabled={blocked || selected.length < 2}
            onClick={() => nav(`/compare?${new URLSearchParams({ slot: s.id, entries: selected.map(e => e.id).join(',') })}`)}
            className="press w-full mt-3 py-3 rounded-[16px] card-s text-[12px] font-semibold disabled:opacity-50"
          >{t('Сравнить')} ({selected.length})</button>
          {selected.length < 2 && <p className="text-[11px] text-[var(--soft)] mt-2">{t('Отметьте хотя бы двух доступных кандидатов')}</p>}
          {canBook && weddingId && selected.length > 0 && (
            <OfferRequestComposer weddingId={weddingId} slotId={s.id} entries={selected} onChanged={q.reload} />
          )}
        </>
      )}
      {ready(q) && roles.loading && <p className="text-[11px] text-[var(--soft)] mt-2">{t('Проверяем доступ…')}</p>}
      {ready(q) && (roles.error || roles.forbidden) && <AsyncState q={roles} />}
      {error && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-2">{error}</p>}
    </section>
  )
}

/* Тело экрана вынесено отдельно: состояние слота нужно до первого хука, а
   хуки нельзя объявлять после условного возврата. */
function SlotView({ s }: { s: Slot }) {
  const nav = useNavigate()
  const location = useLocation()
  const { cancelBooking, removeExternalVendor, bookExternal, inviteExternal, unmarkPrebooked } = useStore()
  const [confirmCancel, setConfirmCancel] = useState(false)
  /* «Добавить подрядчика» на карточке «Уже забронировано» (фича 018) ведёт сюда с открытой
     формой своего подрядчика: пара уже сказала, что он есть, — искать его в каталоге незачем. */
  const [ownOpen, setOwnOpen] = useState(() => (location.state as { own?: boolean } | null)?.own === true)
  const [ownName, setOwnName] = useState('')
  const [ownPrice, setOwnPrice] = useState('')
  const [ownPhone, setOwnPhone] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  /* Ссылку выдаёт сервер — одноразовый токен на 30 дней. Собрать её из
     идентификатора слота нельзя: по такой ссылке никто никуда не войдёт.
     Пережить перезагрузку она не может — контракт не отдаёт уже выданную,
     и кнопка честно выпишет новую. */
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ownBusy, runOwn] = useBusy()
  /* Деньги сделки видит только пара — и только она отменяет бронь. У
     помощника и координатора в ответе нет ни `price`, ни `paid`. */
  const canCancel = s.price !== undefined || s.paid !== undefined
  /* У отметки «уже забронировано» сделки нет, и деньги роль не выдают — роль спрашивается. */
  const isCouple = useIsCouple(s.state === 'prebooked')

  /* Любое действие здесь уходит на сервер и меняет чужой календарь. Ошибку
     показываем словами, а не глотаем: «сделали вид, что получилось» на
     необратимом действии дороже честного отказа. */
  /* Пока действие в пути — второго нет: «Точно отменить?» по двойному тапу на
     медленной сети уходил дважды, второй получал 409 и строку ошибки под
     только что отменённой бронью (ревью 015, FB7). Флаг — по ответу, а не по
     таймеру `useBusy`: запрос может идти дольше 700 мс. */
  const [acting, setActing] = useState(false)
  const guard = async (fn: () => Promise<unknown>) => {
    if (acting) return
    setActing(true)
    setErr(null)
    try { await fn() } catch (e) { setErr(explainError(e)) } finally { setActing(false) }
  }

  /* Адрес переписки выдаёт сервер, и он может отказать (429, истёкшая сессия,
     сеть). Раньше «Написать» и «Чат по сделке» были промисом без `catch`:
     кнопка молча не делала ничего, а ошибка уходила в `unhandledrejection`
     (RF-04, R-148). У своего подрядчика идентификатора каталога нет: тогда
     ведём в список чатов, где его переписка отдельной строкой. */
  const [chatBusy, setChatBusy] = useState<'grid' | 'card' | null>(null)
  /* Отказ из нижней карточки — под ней же, а не под сеткой кнопок выше:
     экран длинный, и строка у сетки оттуда не видна. */
  const [cardErr, setCardErr] = useState<string | null>(null)
  const openChat = (from: 'grid' | 'card') => void (async () => {
    setErr(null); setCardErr(null)
    setChatBusy(from)
    try { nav(await chatRouteForVendor(s.vendorId)) } catch (e) { (from === 'grid' ? setErr : setCardErr)(explainError(e)) } finally { setChatBusy(null) }
  })()

  const addOwn = () => runOwn(async () => {
    if (!ownName.trim() || !Number(ownPrice)) return
    // поле «Цена, ₽» — рубли, на сервер уходят копейки
    await guard(async () => {
      await bookExternal(s.id, ownName.trim(), rub(Number(ownPrice)), ownPhone.trim() || undefined)
      setOwnOpen(false); setOwnName(''); setOwnPrice(''); setOwnPhone('')
    })
  })

  const errBlock = err && <p className="mt-3 text-[12px] text-[var(--rose-ink)]">{err}</p>

  /* Свой подрядчик: форма добавления/приглашения (пустой слот или внешний) */
  const ownBlock = (
    <div className="card p-4 mt-3.5">
      <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Свой подрядчик')}</span>
      <p className="text-[11px] text-[var(--soft)] leading-relaxed mt-1.5">
        {t('Нашли на Авито или по знакомству? Добавьте его сюда — он впишется в команду, бюджет и тайминг. Приложение ему не обязательно.')}
      </p>
      {!ownOpen ? (
        <button onClick={() => setOwnOpen(true)} className="press mt-3 w-full card-s py-3 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Plus size={14} />{t('Добавить своего специалиста')}</button>
      ) : (
        <div className="space-y-2.5 mt-3 fade-up">
          <input autoFocus value={ownName} onChange={e => setOwnName(e.target.value)} placeholder={t('Имя / название (напр. Фотограф Ирек)')} className="w-full h-11 px-4 rounded-[14px] bg-[var(--track)] text-[13px] outline-none" />
          {/* `min-w-0`: у поля ввода своя минимальная ширина (~20 знаков), и два поля в строке
              раздували страницу до 449 px на экране 390 px (ERR-0309). */}
          <div className="flex gap-2">
            <input value={ownPrice} onChange={e => setOwnPrice(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Цена, ₽')} className="flex-1 min-w-0 h-11 px-4 rounded-[14px] bg-[var(--track)] text-[13px] outline-none" />
            <input value={ownPhone} onChange={e => setOwnPhone(e.target.value)} inputMode="tel" placeholder={t('Телефон')} className="flex-1 min-w-0 h-11 px-4 rounded-[14px] bg-[var(--track)] text-[13px] outline-none" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setOwnOpen(false)} className="press flex-1 card-s py-3 text-[12px] font-semibold">{t('Отмена')}</button>
            <button disabled={ownBusy} onClick={addOwn} className="press flex-1 py-3 rounded-[16px] grad text-[var(--on-grad)] text-[12px] font-bold disabled:opacity-50">{t('Добавить в команду')}</button>
          </div>
        </div>
      )}
      {errBlock}
    </div>
  )

  /*
   * «Уже забронировано вне приложения» из квиза (фича 018). Сделки нет, подрядчик найден без
   * приложения. Два исхода, и за каждым запрос (R-176): вписать его своим подрядчиком (форма
   * ниже — её кнопка шлёт `POST …/external`, бронь снимает отметку) или «Нет, ещё ищем»
   * (`DELETE …/prebooked`, слот становится пустым). Оба — только паре (R-270).
   */
  if (s.state === 'prebooked') {
    return (
      <div className="pb-28">
        <TopBar back title={t(s.label)} sub={t('Слот команды')} />
        <div className="px-5 mt-3">
          <div className="card p-5 text-center">
            <div className={cn('w-16 h-16 rounded-[20px] mx-auto flex items-center justify-center', s.tile)}>{createElement(catIcon(s.categoryId), { size: 28, className: 'text-[var(--ink2)]' })}</div>
            <b className="font-serif-d text-[19px] block mt-3">{t('Уже забронировано')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5">{t('Вы отметили в квизе, что этот подрядчик уже есть. Добавьте его — он впишется в команду, бюджет и тайминг.')}</p>
          </div>
          {isCouple === true && ownBlock}
          {isCouple === true && (
            <button disabled={acting} onClick={() => void guard(() => unmarkPrebooked(s.id))} className="press w-full mt-3 card-s py-3.5 text-[13px] font-semibold text-[var(--rose-deep)] disabled:opacity-50">
              {acting ? t('Снимаем отметку…') : t('Нет, ещё ищем')}
            </button>
          )}
          {isCouple === false && <p className="text-[11.5px] text-[var(--soft)] mt-3 text-center">{t('Отметку ведёт пара')}</p>}
        </div>
      </div>
    )
  }

  if (s.state === 'empty') {
    return (
      <div className="pb-28">
        <TopBar back title={s.label} sub={t('Слот команды')} />
        <div className="px-5 mt-3">
          <div className="card p-5 text-center">
            <div className={cn('w-16 h-16 rounded-[20px] mx-auto flex items-center justify-center', s.tile)}>{createElement(catIcon(s.categoryId), { size: 28, className: 'text-[var(--ink2)]' })}</div>
            <b className="font-serif-d text-[19px] block mt-3">{t('Исполнитель не выбран')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5">{t('Подберите в каталоге или добавьте своего')}</p>
          </div>
          <button onClick={() => nav(`/search/${s.categoryId}`)} className="press w-full mt-3 py-4 rounded-[20px] grad text-[var(--on-grad)] text-[14px] font-semibold">{t('Выбрать из каталога')}</button>
          <SlotCandidates s={s} />
          {ownBlock}
        </div>
      </div>
    )
  }

  return (
    <div className="pb-28">
      <TopBar back title={s.label} sub={t('Слот команды')} />
      <div className="px-5 mt-3">
        <div className="card p-5 text-center">
          <div className={cn('w-16 h-16 rounded-[20px] mx-auto flex items-center justify-center', s.tile)}>{createElement(catIcon(s.categoryId), { size: 28, className: 'text-[var(--ink2)]' })}</div>
          <b className="font-serif-d text-[19px] block mt-3">{s.vendor ?? t('Исполнитель не выбран')}</b>
          {s.price && <span className="font-serif-d text-[17px] text-[var(--rose-deep)] block mt-1 tabular">{fmt(s.price)}</span>}
          <div className="flex justify-center gap-1.5 mt-2">
            {s.status && <span className="inline-block text-[10px] font-bold px-3 py-1.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t(s.status)}</span>}
            {s.external && <span className="inline-block text-[10px] font-bold px-3 py-1.5 rounded-full bg-[var(--honey)] text-[var(--honey-ink)]">{t('не из каталога')}</span>}
          </div>
          {s.external && s.phone && <p className="text-[11px] text-[var(--soft)] mt-2">📞 {s.phone}</p>}
        </div>

        <SlotCandidates s={s} />

        {/* Приглашение внешнего подрядчика в приложение (гость-подрядчик) */}
        {s.external && (
          <div className="card p-4 mt-3.5">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Пригласить в приложение')}</span>
            <p className="text-[11px] text-[var(--soft)] leading-relaxed mt-1.5">
              {t('По ссылке он зайдёт как гость-подрядчик — без регистрации в каталоге: увидит дату, тайминг и чат с вами.')}
            </p>
            {inviteLink ? (
              <div className="flex items-center gap-2 mt-3">
                <code className="flex-1 text-[10.5px] bg-[var(--track)] rounded-[12px] px-3 py-2.5 truncate">{inviteLink}</code>
                <button onClick={() => { copyText(inviteLink); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500) }} className="press text-[11px] font-bold px-3.5 py-2.5 rounded-[12px] grad text-[var(--on-grad)]">{linkCopied ? '✓' : t('Копия')}</button>
              </div>
            ) : (
              <button disabled={acting} onClick={() => void guard(async () => setInviteLink(await inviteExternal(s.id)))} className="press mt-3 w-full py-3 rounded-[16px] grad text-[var(--on-grad)] text-[12.5px] font-bold disabled:opacity-50">{t('Создать ссылку-приглашение')}</button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 mt-3">
          <button disabled={chatBusy !== null} onClick={() => openChat('grid')} className="press card-s py-3.5 text-[13px] font-semibold disabled:opacity-50">{chatBusy === 'grid' ? t('Открываем чат…') : t('Написать')}</button>
          <button disabled={!s.dealId} onClick={() => nav(`/deal/${s.dealId}`)} className="press card-s py-3.5 text-[13px] font-semibold disabled:opacity-50">{t('Сделка')}</button>
          <button onClick={() => nav(`/search/${s.categoryId}`)} className="press card-s py-3.5 text-[13px] font-semibold">{t('Заменить')}</button>
          {/*
            * Отмена — только паре и только по незавершённой сделке. Помощнику
            * и координатору сервер не отдаёт денег сделки (`price`/`paid`
            * отсутствуют), и по этому же признаку видно, что отменять им
            * нечем — сервер ответил бы 403 (ревью D2-21). Выполненную сделку
            * не отменяют: работа сделана и оплачена (ревью D2-02).
            */}
          {s.dealState === 'done' ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">{t('Работа выполнена')}</div>
          ) : !canCancel ? null : confirmCancel ? (
            <button disabled={acting} onClick={() => void guard(async () => {
              /* У своего подрядчика удаление, а не отмена: только оно гасит
                 выданную ему ссылку-приглашение. */
              await (s.external ? removeExternalVendor(s.id) : cancelBooking(s.id))
              nav('/wedding')
            })} className="press card-s py-3.5 text-[13px] font-bold bg-[var(--rose-deep)] text-[var(--card)] disabled:opacity-50">{acting ? t('Отменяем…') : t('Точно отменить?')}</button>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="press card-s py-3.5 text-[13px] font-semibold text-[var(--rose-deep)]">{s.external ? t('Удалить подрядчика') : t('Отменить бронь')}</button>
          )}
        </div>
        {errBlock}

        {/*
          * Деньги показываем те, о которых знает сервер: сумму сделки и то,
          * внесён ли аванс. График «50% сейчас, 50% за неделю» здесь был
          * выдуман на клиенте — вместе с отметкой «✓ Оплачен», которая стояла
          * всегда, даже когда не платили ничего.
          */}
        {s.price != null && (
          <div className="card p-4 mt-3.5">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Деньги по сделке')}</span>
            <div className="flex items-center justify-between mt-3">
              <span className="text-[12px] text-[var(--ink2)]">{t('Сумма сделки')}</span>
              <b className="text-[12.5px] tabular">{fmt(s.price)}</b>
            </div>
            <div className="flex items-center justify-between mt-3">
              <span className="text-[12px] text-[var(--ink2)]">{t('Оплата')}</span>
              <span className={cn('text-[8.5px] font-bold px-2 py-1 rounded-full', s.dealState === 'paid_deposit' || s.dealState === 'done' ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : 'bg-[var(--honey)] text-[var(--honey-ink)]')}>
                {s.dealState === 'paid_deposit' || s.dealState === 'done' ? t('✓ Зафиксирована') : t('Ожидает')}
              </span>
            </div>
          </div>
        )}

        <div className="card px-4 py-1.5 mt-3.5">
          {[
            ['📄', 'bg-[var(--blue)]', t('Документы свадьбы'), '/wedding/documents'],
            ['🗓', 'bg-[var(--honey)]', t('Тайминг дня'), '/wedding/timeline'],
            /* Чат по сделке — переписка с этим же подрядчиком: адрес берём у
               сервера, как и у кнопки «Написать» выше. Прежний `ch1` вёл в
               выдуманную переписку. */
            ['💬', 'bg-[var(--sage-soft)]', t('Чат по сделке'), ''],
          ].map(([ic, tile, l, to], i) => (
            <button key={String(l)} disabled={!to && chatBusy !== null} onClick={() => (to ? nav(String(to)) : openChat('card'))} className={cn('press w-full flex items-center gap-3 py-3 text-left disabled:opacity-50', i !== 2 && 'border-b border-[var(--track)]')}>
              <Tile icon={String(ic)} tile={String(tile)} size={34} />
              <span className="flex-1 text-[12px] font-medium">{!to && chatBusy === 'card' ? t('Открываем чат…') : l}</span>
            </button>
          ))}
        </div>
        {cardErr && <p role="alert" className="mt-3 text-[12px] text-[var(--rose-ink)]">{cardErr}</p>}
      </div>
    </div>
  )
}

/*
 * Тысячи рублей из копеек.
 *
 * Здесь стояло `сумма / 1000` — деление копеек на тысячу, то есть число в сто
 * раз больше настоящего: категория на 480 000 ₽ показывалась как «48000К».
 * Ошибка жила и в моке, и пережила переход на сервер, потому что «48000К»
 * выглядит правдоподобно, пока не сравнишь с итогом рядом.
 */
const thousands = (kopecks: number) => Math.round(kopecks / 100 / 1000)

/* Бюджет */
const numberLocale = () => getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
/* Доля и рубли в полях бюджета — через Intl, с разделителем языка (инвариант 7; ревью 018, BF-10). */
const percentText = (bps: number) => new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: 2 }).format(bps / 100)
const wholeRubles = (kopecks: number) => new Intl.NumberFormat(numberLocale()).format(Math.round(kopecks / 100))

/* Бюджет */
export function Budget() {
  const nav = useNavigate()
  const { weddingId } = useStore()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [cat, setCat] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /* Где показать ошибку: у резерва и лимита — рядом с полем, остальное — под карточкой (ревью 018, BF-08). */
  const [errAt, setErrAt] = useState<string | null>(null)
  const [reserveDraft, setReserveDraft] = useState('')
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({})

  /*
   * Бюджет считает сервер, а не браузер.
   *
   * Он знает то, чего фронт знать не может: суммы сделок, внесённые авансы и
   * оплаты. Локальный расчёт из цен слотов был единственно возможным без
   * сервера, но повторяет его лишь до первой оплаты — дальше «потрачено»
   * расходится с тем, что реально ушло подрядчикам.
   */
  const q = useApi(() => weddingId ? getBudget(weddingId) : noWedding(), [weddingId])
  const tipsQ = useApi(() => weddingId ? getTips(weddingId) : noWedding(), [weddingId])
  const server = q.data
  /*
   * Общий бюджет может быть не задан: квиз с «пока не знаем» оставляет
   * колонку пустой, а сервер отдаёт `total: {amount: 0}` — контракт не
   * допускает `null`. Ноль здесь не сумма, а её отсутствие (R-178, ревью
   * D2-09): показывать «из 0 ₽ запланировано · 0%» значило бы говорить
   * паре, что денег нет. Вместо этого — «итог не задан» и поле ввода.
   */
  const budgetTotal = server?.total?.amount ?? 0
  const hasTotal = budgetTotal > 0
  /* Без ответа сервера показываем пусто, а не мок: подстановка мок-бюджета
     означала бы, что человек без свадьбы видит чужие 677 000 ₽ и верит им. */
  const cats = (server?.categories ?? []).map(c => {
    const items = (c.items ?? []).map(it => ({
      id: it.id ?? '',
      title: it.title ?? '',
      amount: it.amount?.amount ?? 0,
      custom: !!it.custom,
    }))
    return {
      id: c.id ?? '',
      name: c.title ?? '',
      /* Сумма категории — сделки плюс свои статьи, в одном месте (ревью
         D2-04): полоса и подсказка считаются от неё же. Раньше в строке
         стояли только сделки, и «Фейерверк» на 50 000 ₽ в «Прочем» давал
         «0К / 79К» при живой статье под той же строкой — категории не
         сходились с итогом на том же экране (ERR-0012, R-26). Сервер в
         `spent` статьи считает — считаем и здесь. */
      amount: (c.fromSlots ?? 0) + items.reduce((a, it) => a + it.amount, 0),
      limit: c.planned?.amount ?? 0,
      limitCustom: !!c.limitCustom,
      limitVersion: c.limitVersion ?? 0,
      color: c.color ?? 'var(--lav)',
      /* `live` в контракте — имена забронированной команды через разделитель,
         а не флаг: экран показывает их подписью «из команды». */
      live: c.live ?? undefined,
      items,
    }
  })
  /* Потрачено берём у сервера целиком: свои статьи он уже учёл. Раньше к
     серверной сумме прибавлялся локальный список `tt_budget_custom`, и одна и
     та же статья считалась дважды, как только доезжала на сервер. */
  const total = server?.spent?.amount ?? 0
  const spentPct = pct(total, budgetTotal)
  /* Резерв на непредвиденное считает сервер — 10% от общего бюджета (План
     ч. 283). Доля на клиенте разошлась бы с серверной на первой правке. */
  const reserve = server?.reserve?.amount ?? 0
  const [totalDraft, setTotalDraft] = useState('')

  const write = async (id: string, fn: () => Promise<unknown>) => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (busyId) return // второй запрос, пока идёт первый (Enter, двойной тап) — ревью 015
    setErrAt(id)
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — бюджет живёт в ней')); return }
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload() } catch (e) {
      /* Устаревшая версия резерва или лимита: бюджет перечитывается, черновик остаётся —
         иначе каждое следующее «Сохранить» шло со старой версией и снова получало 409
         (ревью 018, BF-08). */
      if (e instanceof ApiError && (e.code === 'stale_budget_settings' || e.code === 'stale_budget_limit')) {
        q.reload()
        setErr(t('Бюджет изменился на другом устройстве — данные обновлены. Проверьте и сохраните ещё раз.'))
      } else setErr(explainError(e))
    } finally { setBusyId(null) }
  }
  /* Итог задаётся здесь же: до этого `budgetTotal` уходил только из квиза,
     и паре, ответившей «пока не знаем», задать его было негде. */
  const saveTotal = () => void write('total', async () => {
    const rubles = parseInt(totalDraft.replace(/\D/g, ''), 10)
    if (!rubles) return
    // поле «Общий бюджет, ₽» — рубли, на сервер уходят копейки
    await setBudgetTotal(weddingId!, rub(rubles))
    setTotalDraft('')
  })
  const add = () => void write('new', async () => {
    const rubles = parseInt(amount.replace(/\D/g, ''), 10)
    const categoryId = cat || cats[0]?.id
    if (!name.trim() || !rubles || !categoryId) return
    // поле «Сумма, ₽» — рубли, на сервер уходят копейки
    await addBudgetItem(weddingId!, name.trim(), rub(rubles), categoryId)
    setName(''); setAmount(''); setAdding(false)
  })
  const removeItem = (id: string) => void write(id, () => deleteBudgetItem(weddingId!, id))
  const saveReserve = () => void write('reserve', async () => {
    if (!server) return
    const bps = parseReservePercent(reserveDraft)
    if (bps === null) { setErr(t('Резерв — число от 0 до 50, не больше двух знаков после запятой')); return }
    await setBudgetReserve(weddingId!, bps, server.settingsVersion)
    setReserveDraft('')
  })
  const saveLimit = (categoryId: string, version: number) => void write(`limit-${categoryId}`, async () => {
    const rubles = parseWholeRubles(limitDrafts[categoryId] ?? '')
    if (rubles === null) { setErr(t('Введите лимит целым числом рублей, например 150 000')); return }
    await setBudgetCategoryLimit(weddingId!, categoryId, { amount: rub(rubles), currency: 'RUB' }, version)
    setLimitDrafts(v => ({ ...v, [categoryId]: '' }))
  })
  const resetLimit = (categoryId: string, version: number) => void write(`limit-${categoryId}`, () => resetBudgetCategoryLimit(weddingId!, categoryId, version))

  return (
    <div className="pb-28">
      <TopBar back title={t('Бюджет')} sub={t('Распределение средств')} />
      {ready(q) && <div className="px-5 mt-3"><button className="press w-full card p-4 text-left font-semibold" onClick={() => nav('/wedding/payments')}>{t('График платежей')} →</button>
        {server?.paymentSummary && <p className="text-xs text-[var(--soft)] mt-2">{server.paymentSummary.amountIncomplete ? t('Известно оплачено, от') : t('Отмечено оплат')}: {fmt(server.paymentSummary.recorded.amount)} · {t('Осталось по сделкам')}: {fmt(server.paymentSummary.remaining.amount)}{/* Сделка без цены в остаток не входит: без оговорки «0 ₽» читался как «всё оплачено» (ревью 018, F-04; R-178). */}{server.paymentSummary.unknownPrices > 0 && <> ({t('без сделок, где цена не задана')}: {server.paymentSummary.unknownPrices})</>}. {server.paymentSummary.amountIncomplete && <>{t('Есть платежи с неизвестной суммой. Фактические расходы и остаток бюджета могут быть неполными.')} </>} {t('Плановые этапы не увеличивают смету.')}</p>}
      </div>}
      <AsyncState q={q} forbiddenText={t('Бюджет ведёт пара — у вашей роли к нему доступа нет.')} />
      <div className="px-5 mt-3">
        {/* Сводка — только когда бюджет пришёл. Без ответа здесь стояло
            «0 ₽ · 0% · из 0 ₽ запланировано», и это не «пусто», а
            «неизвестно»: такой экран пара читает как «денег не осталось». */}
        {ready(q) && (
        <div className="card p-5">
          <div className="flex justify-between items-end">
            <span className="text-[30px] font-extrabold tracking-tight tabular">{fmt(total)}</span>
            {hasTotal && <span className="text-[var(--rose-deep)] font-bold">{spentPct}%</span>}
          </div>
          {hasTotal ? (
            <>
              <p className="text-[11.5px] text-[var(--soft)] mt-1">{t('из')} {fmt(budgetTotal)} {t('запланировано · осталось')} {fmt(Math.max(0, budgetTotal - total))}</p>
              <div className="mt-3"><Bar pct={spentPct} /></div>
            </>
          ) : (
            <div className="mt-1">
              <p className="text-[11.5px] text-[var(--soft)]">{t('обязательств · итог не задан')}</p>
              <div className="flex gap-2 mt-3">
                <input value={totalDraft} onChange={e => setTotalDraft(e.target.value)} inputMode="numeric" placeholder={t('Общий бюджет, ₽')} className="flex-1 min-w-0 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] tabular" />
                <button disabled={busyId === 'total'} onClick={saveTotal} className="press px-4 rounded-xl grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50 shrink-0">{busyId === 'total' ? t('Сохраняем…') : t('Задать бюджет')}</button>
              </div>
              <p className="text-[10px] text-[var(--soft2)] mt-2 leading-relaxed">{t('Лимиты категорий и резерв появятся, когда задан общий бюджет.')}</p>
            </div>
          )}
          {hasTotal && <div className="mt-3 pt-3 border-t border-[var(--track)] space-y-2">
            <div className="flex justify-between items-center"><span className="text-[11.5px] text-[var(--soft)]">🛟 {t('Резерв на непредвиденное')}</span><b className="text-[12.5px] tabular">{fmt(reserve)}</b></div>
            {server && <p className="text-[11px] text-[var(--soft)]">{t('Сейчас')}: <span className="tabular">{percentText(server.reserveBps)} %</span></p>}
            <div className="flex gap-2 items-center"><input aria-label={t('Резерв, %')} value={reserveDraft} onChange={e => setReserveDraft(e.target.value)} inputMode="decimal" placeholder={server ? percentText(server.reserveBps) : ''} className="w-24 bg-[var(--bg)] rounded-lg px-3 py-2 text-xs" /><span className="text-xs">%</span><button disabled={busyId === 'reserve' || !reserveDraft.trim()} onClick={saveReserve} className="press px-3 py-2 rounded-lg bg-[var(--bg)] text-xs font-semibold disabled:opacity-50">{busyId === 'reserve' ? t('Сохраняем…') : t('Сохранить')}</button></div>
            {err && errAt === 'reserve' && <p role="alert" className="text-[11px] text-[var(--rose-ink)]">{err}</p>}
            <p className="text-[10px] text-[var(--soft2)]">{t('Можно выбрать от 0 до 50%. Резерв не увеличивает категории и не считается расходом.')}</p>
          </div>}
          {reserve > 0 && total > budgetTotal - reserve && (
            <p className="text-[10.5px] text-[var(--rose-ink)] mt-1.5">{t('Обязательства уже съели резерв — на неожиданности запаса нет')}</p>
          )}
          <div className="mt-4 space-y-4">
            {cats.map(b => (
              <div key={b.id}>
                <div className="flex justify-between text-[12.5px] items-center">
                  <span className="flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: b.color }} />{b.name}{b.live && <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('из команды')}</span>}</span>
                  {/* Лимит категории — доля общего бюджета: без итога его нет,
                      и «/ 0К» с пустой полосой выдавали бы ноль за лимит. */}
                  <b className="tabular">{thousands(b.amount)}{t('К')}{hasTotal && <span className="text-[var(--soft)] font-normal text-[10.5px]">/ {thousands(b.limit)}{t('К')}</span>}</b>
                </div>
                {hasTotal && (
                  <div className="h-1.5 rounded-full bg-[var(--track)] mt-1.5 overflow-hidden">
                    {/* Лимит 0 при расходах — полная полоса перерасхода, а не пустая (pct(x, 0) = 0; ревью 018, BF-11). */}
                    <div className="h-full rounded-full" style={{ width: `${b.limit > 0 ? Math.min(100, pct(b.amount, b.limit)) : b.amount > 0 ? 100 : 0}%`, background: b.amount > b.limit ? 'var(--rose-deep)' : b.color }} />
                  </div>
                )}
                {hasTotal && b.amount > b.limit && <p className="text-[10.5px] text-[var(--rose-ink)] mt-1">{t('Сверх лимита')}: <span className="tabular">{fmt(b.amount - b.limit)}</span></p>}
                {/* Лимит — своей строкой под категорией: третьим элементом в строке с названием
                    и суммой он сжимал её (ревью 018, BF-11). Имя категории — в доступных именах кнопок (BF-12). */}
                {hasTotal && <div className="flex flex-wrap gap-1 items-center mt-1.5">
                  <input aria-label={`${b.name} ${t('лимит, ₽')}`} value={limitDrafts[b.id] ?? ''} onChange={e => setLimitDrafts(v => ({...v,[b.id]:e.target.value}))} inputMode="numeric" placeholder={wholeRubles(b.limit)} className="w-28 bg-[var(--bg)] rounded-lg px-2 py-1.5 text-[11px] tabular" />
                  <button disabled={busyId === `limit-${b.id}` || !(limitDrafts[b.id] ?? '').trim()} onClick={() => saveLimit(b.id,b.limitVersion)} aria-label={`${t('Задать лимит')}: ${b.name}`} className="press px-2.5 py-1.5 rounded-lg bg-[var(--bg)] text-[11px] font-semibold disabled:opacity-50">{t('Лимит')}</button>
                  {b.limitCustom && <button disabled={busyId === `limit-${b.id}`} onClick={() => resetLimit(b.id,b.limitVersion)} aria-label={`${t('Вернуть автоматический лимит')}: ${b.name}`} className="press px-2.5 py-1.5 rounded-lg text-[11px] underline disabled:opacity-50">{t('Авто')}</button>}
                  {b.limitCustom && <span className="text-[10px] text-[var(--soft)]">{t('лимит задан вами')}</span>}
                </div>}
                {err && errAt === `limit-${b.id}` && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-1">{err}</p>}
                {/* Свои статьи живут внутри своей категории: сервер помечает их
                    `custom`, и удалять можно только их. Прежний экран решал это
                    сравнением номера строки с длиной мок-списка — при другом
                    числе категорий крестик попадал не туда. */}
                {b.items.map(it => (
                  <div key={it.id} className="flex justify-between items-center text-[11.5px] mt-1.5 pl-4">
                    <span className="text-[var(--soft)] truncate">{it.title}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <b className="tabular">{fmt(it.amount)}</b>
                      {it.custom && (
                        <button disabled={busyId === it.id} onClick={() => removeItem(it.id)} className="press text-[var(--rose-deep)] text-[12px] disabled:opacity-50" aria-label={t('Удалить статью')}>×</button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        )}
        {/* Подсказка строится из настоящих чисел, а не вписана в разметку.
            Здесь стояло «Площадка и кейтеринг на 86% лимита. Зафиксируйте меню
            до 1 марта» — текст с процентом и датой, не связанными ни с чем.
            Показываем только когда есть о чём говорить: категория, которая
            реально подошла к своему лимиту. */}
        {/* Порог и текст — с сервера (правило §3.14 п. 3, 85 % плана): раньше
            экран считал свои 80 % по загруженной странице, и главная с бюджетом
            могли назвать разные проценты. */}
        {(tipsQ.data?.items ?? []).filter(x => x.kind === 'budget').slice(0, 1).map(x => (
          <div key={x.categoryId ?? x.title} className="mt-3.5"><AiTip text={`${x.title}. ${x.body}`} /></div>
        ))}

        {/*
          * Блок «оплачено · предстоит · резерв» убран.
          *
          * Все три числа считались на клиенте по правилу «половина суммы
          * брони — аванс, вторая половина — доплата за 7 дней до даты».
          * Ни такого графика, ни резерва сервер не знает: он отдаёт цену
          * сделки и факт оплаты. Резерв «непредвиденное» 10% по плану ч. 283
          * заводится категорией бюджета — этого в ответе пока нет, и рисовать
          * его на клиенте значит показывать деньги, которых никто не отложил.
          */}

        {err && errAt !== 'reserve' && !errAt?.startsWith('limit-') && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-3.5">{err}</p>}

        {adding ? (
          <div className="card p-4 mt-3.5 fade-up">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('Статья расхода (например, «Фейерверк»)')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" placeholder={t('Сумма, ₽')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] mt-2.5 tabular" />
            {/* Категорию спрашиваем, а не угадываем: сервер требует её при
                создании статьи, и «Прочее» по умолчанию спрятало бы расход не
                там, где его будут искать. */}
            <select value={cat || cats[0]?.id || ''} onChange={e => setCat(e.target.value)} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none mt-2.5">
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setAdding(false)} className="press flex-1 h-[44px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button disabled={busyId === 'new' || !cats.length} onClick={add} className="press flex-1 h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{busyId === 'new' ? t('Сохраняем…') : t('Добавить')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="press w-full card-s mt-3.5 py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2"><Plus size={16} />{t('Добавить расход')}</button>
        )}
      </div>
    </div>
  )
}

/* Чек-лист */
/** Подпись периода задачи: ключ словаря — русская строка (R-07); незнакомый период — как пришёл. */
const PERIOD_LABEL: Record<string, string> = { '9': 'За 9 мес', '6': 'За 6 мес', '3': 'За 3 мес', '1': 'За 1 мес' }

export function Checklist() {
  const store = useStore()
  const [params] = useSearchParams()
  const linkedWedding = params.get('wedding')
  const weddingId = linkedWedding && /^[0-9a-f-]{36}$/i.test(linkedWedding) ? linkedWedding : store.weddingId
  const linkedTask = params.get('task')
  // A second notification can change only the query string on this same route.
  // Key the editor session by its target so filters and drafts cannot point at
  // the previous task/wedding. Reloading the URL uses the same initial target.
  return <ChecklistContent key={JSON.stringify([weddingId, linkedTask])}
    weddingId={weddingId} linkedWedding={linkedWedding} linkedTask={linkedTask} />
}

function ChecklistContent({ weddingId, linkedWedding, linkedTask }: {
  weddingId: string | null; linkedWedding: string | null; linkedTask: string | null
}) {
  const store = useStore()
  const linkedQ = useApi(() => weddingId && linkedWedding ? getWedding(weddingId) : Promise.resolve(null), [weddingId, linkedWedding])
  const weddingDate = linkedWedding ? linkedQ.data?.date ?? null : store.weddingDate
  const [period, setPeriod] = useState(linkedTask ? 'all' : '9')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const [newPlan, setNewPlan] = useState<TaskPlanningValue>({ assigneeId: '', due: '', dueMode: 'relative' })
  const [planningId, setPlanningId] = useState<string | null>(null)
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const writing = useRef(false)

  /* Чек-лист приходит с сервера: он собирается там при создании свадьбы вместе
     с мозаикой и таймингом, одной транзакцией. Локальные `tt_tasks_extra` и
     `tt_tasks_done` были заменой этому, пока сервера не было. */
  const q = useApi(() => weddingId ? getTasks(weddingId) : noWedding(), [weddingId])
  const meQ = useApi(() => getMe(), [])
  const membersQ = useApi(() => weddingId ? getMembers(weddingId) : Promise.resolve([]), [weddingId])
  const members = membersQ.data ?? []
  const membersReady = ready(membersQ) && !membersQ.refreshing
  const meReady = ready(meQ) && !!meQ.data?.id
  /* Пока запись идёт, строка не отзывается на повторные нажатия: два быстрых
     тапа по галочке — это две записи, и вторая отменяла бы первую. */
  const [busyId, setBusyId] = useState<string | null>(null)
  /* Ошибка помнит, чьё действие её вызвало: у раскрытой задачи она стоит под
     строкой, остальные — внизу списка (фича 008). */
  const [err, setErr] = useState<{ id: string; text: string } | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  /*
   * Деталь задачи (фича 008, План §20.1 экран 12 — «внутри»): тап по названию
   * раскрывает строку — срок, период, «Переименовать», «Удалить». Отдельного
   * маршрута нет: заметок у задачи в контракте нет, и экран из двух строк не
   * стоит перехода. Галочка при этом осталась галочкой — своей кнопкой слева.
   */
  const [openId, setOpenId] = useState<string | null>(linkedTask)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /* Поля контракта опциональны — приводим один раз здесь, чтобы дальше по
     экрану не тащить `?? ''` в каждом сравнении. */
  /* Срок считает сервер от даты свадьбы. Пока даты нет, срока нет ни у одной
     задачи — и это честнее выдуманного «через месяц». Признака срочности в
     контракте по-прежнему нет: цветной точки на строке не будет. */
  const allTasks = (q.data ?? []).map(x => ({
    id: x.id ?? '', title: x.title ?? '', period: x.period ?? '', done: !!x.done, custom: !!x.custom,
    due: x.due ?? null,
    dueMode: x.dueMode ?? 'relative',
    assignee: x.assignee ?? null,
    reminderDaysBefore: x.reminderDaysBefore ?? null, reminderTime: x.reminderTime ?? '09:00',
  }))
  const visibleTasks = mineOnly ? (meReady ? allTasks.filter(x => x.assignee?.userId === meQ.data!.id) : [])
    : unassignedOnly ? allTasks.filter(x => !x.assignee) : allTasks
  const list = visibleTasks.filter(task => period === 'all' || task.period === period)
  const done = allTasks.filter(t => t.done).map(t => t.id)

  /* Галочка — общая на пару: её ставит один, а видят оба. Поэтому она едет на
     сервер, а не в `tt_tasks_done` на этом телефоне, и список перечитывается
     ответом сервера, а не подкручивается на месте. */
  const write = async (fn: () => Promise<unknown>, id: string): Promise<boolean> => {
    /* Без свадьбы записывать некуда — и молчать об этом нельзя: кнопка, которая
       ничего не делает и ничего не говорит, читается как поломка. */
    if (!weddingId) { setErr({ id, text: t('Сначала создайте свадьбу — задачи живут в ней') }); return false }
    if (writing.current || busyId || q.refreshing || !ready(q)) return false
    writing.current = true
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload(); return true }
    catch (e) { setErr({ id, text: explainError(e) }); return false }
    finally { writing.current = false; setBusyId(null) }
  }
  const toggle = (id: string, isDone: boolean) => void write(() => setTaskDone(weddingId!, id, !isDone), id)
  /* Удалить можно только свою задачу: шаблонные сервер удалять не даёт (409
     `system_task`), и кнопки у них нет — кнопка с заведомым отказом равна
     кнопке без действия (R-176). Переименовать даёт любую. */
  const removeTask = (id: string) => void write(async () => {
    await deleteTask(weddingId!, id)
    setConfirmDel(null)
  }, id)
  const rename = (id: string) => void write(async () => {
    const title = draft.trim()
    if (!title) return
    await renameTask(weddingId!, id, title)
    setRenaming(null)
  }, id)
  const addTask = () => void write(async () => {
    if (!title.trim() || (newPlan.reminderDaysBefore != null && !newPlan.reminderTime)) return
    await addTaskApi(weddingId!, {
      title: title.trim(),
      period: period === 'all' ? '9' : period,
      dueMode: newPlan.dueMode,
      ...(newPlan.reminderDaysBefore != null ? { reminderDaysBefore: newPlan.reminderDaysBefore, reminderTime: newPlan.reminderTime ?? '09:00' } : {}),
      ...(newPlan.due ? { due: newPlan.due } : newPlan.dueMode === 'fixed' ? { due: null } : {}),
      ...(membersReady && newPlan.assigneeId ? { assigneeId: newPlan.assigneeId } : {}),
    })
    setTitle(''); setNewPlan({ assigneeId: '', due: '', dueMode: 'relative' }); setAdding(false)
  }, 'new')
  // Персональный план от даты: обратный отсчёт, текущий этап, следующий шаг
  // «Сейчас» фиксируется на монтировании: Date.now() в теле рендера — нечистый вызов,
  // его результат менялся бы от перерисовки к перерисовке.
  const [now] = useState(() => Date.now())
  /* Обратный отсчёт от выбранной даты, а не от вшитого 14.06.2027: дату
     выбирает пара, и чужое число здесь было бы неверным у всех, кроме одной
     свадьбы. Без даты отсчёта нет — и это честнее нуля. */
  const target = weddingDate ? Date.parse(weddingDate) : null
  const daysLeft = target ? Math.max(0, Math.ceil((target - now) / 86400000)) : null
  const curPeriod = daysLeft === null ? '9' : daysLeft > 270 ? '9' : daysLeft > 180 ? '6' : daysLeft > 90 ? '3' : '1'
  const nextTask = allTasks.find(tk => !done.includes(tk.id) && tk.period === curPeriod) ?? allTasks.find(tk => !done.includes(tk.id))

  return (
    <div className="pb-28">
      <TopBar back title={t('Чек-лист')} sub={t('Что уже сделано, что впереди')} right={
        <button disabled={!ready(q) || q.refreshing || !!busyId} onClick={() => setAdding(true)} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{t('+ Задача')}</button>
      } />
      <AsyncState q={q} />
      <div className="px-5 mt-3 space-y-3">
        <div className="card p-4 flex items-center gap-4">
          <div className="text-center shrink-0 w-[72px]">
            <b className="font-serif-d text-[28px] tabular leading-none">{daysLeft ?? '—'}</b>
            <p className="text-[9.5px] text-[var(--soft)] mt-1">{daysLeft === null ? t('дата не выбрана') : t('дней до дня X')}</p>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-[var(--soft)]">{t('Ваш этап сейчас:')} <b className="text-[var(--ink)]">{curPeriod === '9' ? t('За 9 мес') : curPeriod === '6' ? t('За 6 мес') : curPeriod === '3' ? t('За 3 мес') : t('За 1 мес')}</b></p>
            {nextTask && (
              <button onClick={() => { setMineOnly(false); setUnassignedOnly(false); setPeriod(nextTask.period) }} className="press mt-2 w-full text-left bg-[var(--rose-soft)] rounded-xl px-3 py-2">
                <p className="text-[9px] font-bold uppercase tracking-wide text-[var(--rose-ink)]">{t('Следующий шаг →')}</p>
                <p className="text-[12px] font-semibold mt-0.5 truncate">{nextTask.title}</p>
              </button>
            )}
            {/* «Всё сделано» — утверждение о списке, и без списка его нет:
                при отказе сервера оно поздравляло с готовностью, которой не
                видело. */}
            {!nextTask && ready(q) && <p className="text-[12px] font-semibold text-[var(--sage-deep)] mt-2">{allTasks.length ? t('Всё сделано — вы полностью готовы ✓') : t('Чек-лист пуст — добавьте первую задачу')}</p>}
          </div>
        </div>
        {ready(q) && (
          <div className="card-s px-4 py-3 flex items-center gap-3">
            {/* Пустой список — это 0 из 0: деление на ноль рисовало «NaN%». */}
            <b className="text-[12px] whitespace-nowrap">{done.length} {t('из')} {allTasks.length}</b>
            <div className="flex-1 h-1.5 rounded-full bg-[var(--track)] overflow-hidden">
              <div className="h-full grad rounded-full transition-all duration-500" style={{ width: `${pct(done.length, allTasks.length)}%` }} />
            </div>
            <span className="text-[10px] font-bold text-[var(--sage-deep)] tabular">{pct(done.length, allTasks.length)}%</span>
          </div>
        )}
      </div>
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        <button disabled={!meReady} aria-pressed={mineOnly} onClick={() => { setMineOnly(v => !v); setUnassignedOnly(false); setPeriod('all') }} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap disabled:opacity-50', mineOnly ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--soft)]')}>{t('Мои задачи')}</button>
        <button aria-pressed={unassignedOnly} onClick={() => { setUnassignedOnly(v => !v); setMineOnly(false); setPeriod('all') }} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', unassignedOnly ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--soft)]')}>{t('Без ответственного')}</button>
        <button onClick={() => { setPeriod('all'); setMineOnly(false); setUnassignedOnly(false) }} className="press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap bg-[var(--card)]">{t('Все задачи')}</button>
        {[['9', t('За 9 мес')], ['6', t('За 6 мес')], ['3', t('За 3 мес')], ['1', t('За 1 мес')]].map(([id, l]) => (
          <button key={id} onClick={() => setPeriod(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', period === id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 mt-4">
        {adding && (
          <div role="group" aria-label={t('Новая задача')} className="card p-4 mb-3.5 fade-up">
            <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()}
              placeholder={t('Новая задача…')} autoFocus className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            <TaskPlanningFields value={newPlan} onChange={setNewPlan} members={members} membersReady={membersReady}
              hasWeddingDate={!!weddingDate} disabled={!!busyId || q.refreshing} />
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setAdding(false)} className="press flex-1 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button disabled={!!busyId || q.refreshing || !title.trim() || (newPlan.reminderDaysBefore != null && !newPlan.reminderTime)} onClick={addTask} className="press flex-1 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{busyId === 'new' ? t('Сохраняем…') : t('Добавить')}</button>
            </div>
          </div>
        )}
        <div className="card px-4 py-1.5">
          {list.map((task, i) => {
            const isDone = done.includes(task.id)
            const open = openId === task.id
            return (
              <div key={task.id} className={cn(i !== list.length - 1 && 'border-b border-[var(--track)]')}>
                <div className="flex items-center gap-1">
                  {/* Галочка и название — две кнопки, а не одна: кнопка внутри
                      кнопки невалидна, а тап по названию теперь раскрывает
                      строку, не отмечает задачу. */}
                  <button disabled={!!busyId || q.refreshing} onClick={() => toggle(task.id, isDone)} aria-label={isDone ? t('Снять отметку') : t('Отметить выполненной')} className="py-3.5 pr-2 shrink-0 disabled:opacity-60">
                    <span className={cn('w-[26px] h-[26px] rounded-[9px] flex items-center justify-center text-[12px] shrink-0 transition-all',
                      isDone ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : 'bg-[var(--card)] border-[1.5px] border-[var(--line)] text-[var(--rose-deep)] font-bold text-[11px]')}>
                      {isDone ? '✓' : i + 1}
                    </span>
                  </button>
                  <button onClick={() => { setOpenId(open ? null : task.id); setRenaming(null); setConfirmDel(null); setPlanningId(null) }} aria-expanded={open} className="flex-1 min-w-0 flex items-center gap-3 py-3.5 text-left">
                    <span className={cn('flex-1 text-[13px]', isDone && 'text-[var(--soft)] line-through')}>{task.title}</span>
                    {/* Точка «важный срок» убрана: признака срочности в контракте
                        нет, и все точки были одного цвета при подписи о двух. */}
                    {task.due && <span className="text-[10.5px] text-[var(--soft)] tabular shrink-0">{shortWeddingDate(task.due)}</span>}
                  </button>
                </div>
                {open && (
                  <div className="pb-3.5 pl-9 fade-up">
                    {/* Срок считает сервер от даты свадьбы; без даты его нет ни у
                        одной задачи — и это говорится словами, не пустотой. */}
                    <p className="text-[11px] text-[var(--soft)]">
                      {t('Срок:')} {task.due ? formatWeddingDate(task.due) : t('Срок не задан')} · {t(PERIOD_LABEL[task.period] ?? task.period)}
                      {task.due && <> · {task.dueMode === 'fixed' ? t('фиксированный') : t('следует за свадьбой')}</>}
                    </p>
                    <p className="text-[11px] text-[var(--soft)] mt-1">{t('Ответственный:')} {task.assignee?.name || t('не назначен')}</p>
                    <button disabled={!!busyId || q.refreshing} onClick={() => setPlanningId(planningId === task.id ? null : task.id)}
                      className="press text-[11px] font-semibold px-3 py-2 mt-2 rounded-full bg-[var(--bg)] disabled:opacity-50">{t('Ответственный и срок')}</button>
                    {planningId === task.id && <TaskPlanningEditor key={task.id} task={task} members={members} membersReady={membersReady}
                      hasWeddingDate={!!weddingDate} disabled={!!busyId || q.refreshing}
                      onSave={patch => write(() => patchTask(weddingId!, task.id, patch), task.id)} onCancel={() => setPlanningId(null)} />}
                    {renaming === task.id ? (
                      <div className="flex items-center gap-2 mt-2">
                        <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && rename(task.id)} aria-label={t('Название задачи')}
                          className="flex-1 min-w-0 h-9 px-3 rounded-lg bg-[var(--bg)] text-[12.5px] outline-none" />
                        <button disabled={busyId === task.id || !draft.trim()} onClick={() => rename(task.id)} className="press text-[11px] font-bold text-[var(--sage-deep)] disabled:opacity-50">{busyId === task.id ? t('Сохраняем…') : t('Сохранить')}</button>
                        <button onClick={() => setRenaming(null)} className="press text-[11px] text-[var(--soft)]">{t('Отмена')}</button>
                      </div>
                    ) : (
                      <div className="flex gap-2 mt-2">
                        <button onClick={() => { setRenaming(task.id); setDraft(task.title); setConfirmDel(null) }} className="press text-[11px] font-semibold px-3 py-1.5 rounded-full bg-[var(--bg)]">{t('Переименовать')}</button>
                        {task.custom && (
                          confirmDel === task.id
                            ? <button disabled={!!busyId || q.refreshing} onClick={() => removeTask(task.id)} className="press text-[11px] font-bold px-3 py-1.5 rounded-full bg-[var(--rose-deep)] text-[var(--card)] disabled:opacity-50">{busyId === task.id ? t('Удаляем…') : t('Удалить?')}</button>
                            : <button onClick={() => setConfirmDel(task.id)} className="press text-[11px] font-semibold px-3 py-1.5 rounded-full bg-[var(--bg)] text-[var(--rose-ink)]">{t('Удалить')}</button>
                        )}
                      </div>
                    )}
                    {err?.id === task.id && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-2 leading-relaxed">{err.text}</p>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {ready(q) && !list.length && (!mineOnly || meReady) && <p className="text-[12px] text-[var(--soft)] mt-3" role="status">{t('Нет задач по выбранному фильтру')}</p>}
        {meQ.error && <p className="text-[11px] text-[var(--soft)] mt-3">{t('Профиль не загрузился — фильтр «Мои задачи» недоступен')}</p>}
        {/* Ошибка раскрытой задачи стоит под её строкой; остальные — здесь. */}
        {err && err.id !== openId && <p className="text-[12px] text-[var(--rose-ink)] text-center mt-3">{err.text}</p>}
      </div>
    </div>
  )
}

/* Тайминг дня */
export function Timeline() {
  const { weddingId, weddingDate } = useStore()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [till, setTill] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<string[] | null>(null)
  /* Галочка «Показывать гостям» у нового блока. По умолчанию включена — как
     умолчание контракта: программа праздника гостям видна, снимают её у
     «Сборов невесты» и «Монтажа арки» (План §8.8, фича 009). */
  const [forGuestsNew, setForGuestsNew] = useState(true)
  /* Черновик автоплана: показан, но ещё не применён. */
  const [draft, setDraft] = useState<TimelineDraft[] | null>(null)
  const [draftVersion, setDraftVersion] = useState<string | null>(null)

  /* Тайминг с сервера. Раньше он жил в `useState` и терялся при перезагрузке:
     добавленное событие исчезало вместе с вкладкой (единственный экран, где
     это было так). */
  const q = useApi(() => weddingId ? getTimelineSnapshot(weddingId) : noWedding(), [weddingId])
  const membersQ = useApi(() => weddingId ? getMembers(weddingId) : Promise.resolve([]), [weddingId])
  const guestsQ = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const slotsQ = useApi(() => weddingId ? getSlots(weddingId) : Promise.resolve([]), [weddingId])
  const [blockEditor, setBlockEditor] = useState<{ weddingId: string; id: string; list: TimelineDraft[]; version: string } | null>(null)
  const choices: TimelineChoice[] = [
    ...(membersQ.data ?? []).filter(m => m.user?.id && ['couple', 'helper', 'coordinator'].includes(m.role ?? '')).map(m => ({
      reference: { kind: 'member' as const, id: m.user!.id! }, name: `${t('Команда')}: ${m.user!.name || m.user!.id}`,
    })),
    ...(guestsQ.data ?? []).filter(g => g.id).map(g => ({ reference: { kind: 'guest' as const, id: g.id! }, name: `${t('Гости')}: ${g.name || g.id}` })),
    ...(slotsQ.data ?? []).filter(s => s.deal?.id && ['booked', 'paid_deposit', 'done'].includes(s.deal.state ?? '')).map(s => ({
      reference: { kind: 'deal' as const, id: s.deal!.id! }, name: `${s.label ?? t('Подрядчик')}: ${s.deal!.vendor?.name || s.deal!.externalName || s.deal!.id}`,
    })),
  ]
  const [conflictedVersion, setConflictedVersion] = useState<string | null>(null)
  /* Часовой пояс места свадьбы, а не зрителя: по нему живёт день X. Пара может
     смотреть тайминг из другого города, и «13:00» должно означать 13:00 на
     площадке. */
  const wq = useApi(() => weddingId ? getWedding(weddingId) : noWedding(), [weddingId])
  const tz = wq.data?.tz
  const raw = q.data?.data ?? []
  const updatedAt = q.data?.headers.get('X-Timeline-Updated-At')
  const updatedBy = q.data?.headers.get('X-Timeline-Updated-By')
  const author = updatedBy ? membersQ.data?.find(m => m.user?.id === updatedBy)?.user?.name || updatedBy : null
  const changedAt = updatedAt && !Number.isNaN(Date.parse(updatedAt))
    ? tz ? new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: tz,
    }).format(new Date(updatedAt)) : updatedAt : null
  const events = raw.map(e => ({
    id: e.id ?? '',
    /* Сервер отдаёт метку времени, экран показывает часы и минуты в поясе
       свадьбы. Пустое время — норма: блок есть, час ещё не назначен. */
    time: e.startsAt ? formatTime(e.startsAt, tz) : '—',
    name: e.name ?? '',
    loc: e.location ?? '',
    icon: e.icon ?? '📌',
    tile: 'bg-[var(--peach)]',
    who: e.who ?? '',
    /* Без поля в ответе — умолчание контракта «виден»: так же читает базу сервер. */
    forGuests: e.forGuests ?? true,
    planning: toTimelineDraft(e),
  }))

  /*
   * Последний список, который сервер принял, и ответ, который был на экране
   * в тот момент. Пока свежий ответ не заменил его — или пропал вовсе, если
   * перечитывание сорвалось, — следующий PUT строится отсюда, а не из
   * показанного: список на экране в это окно прежний, и собранный из него
   * PUT возвращал только что убранный блок или, при пустом экране, стирал
   * весь тайминг (ревью R3-02).
   */
  const [sent, setSent] = useState<{ weddingId: string; list: TimelineDraft[]; etag: string | null; shown: typeof q.data } | null>(null)

  /*
   * Тайминг сохраняется списком целиком: отдельного пути «добавить блок»
   * контракт не знает. Значит, отправлять надо всё, что пришло, — пропущенный
   * блок сервер понял бы как удалённый.
   */
  /* Возвращает, принял ли сервер список: форма нового блока очищается только
     по «да» — иначе отказ (сеть, 422) стирал набранное название и время
     (ревью 015). */
  const save = async (next: TimelineDraft[], fromVersion?: string | null): Promise<boolean> => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — тайминг живёт в ней')); return false }
    const version = fromVersion ?? (sent && sent.weddingId === weddingId && (sent.shown === q.data || q.data === null) ? sent.etag : q.data?.etag)
    if (!version) { setErr(t('Обновите программу перед сохранением')); return false }
    setBusy(true)
    setErr(null)
    try {
      const saved = await putTimeline(weddingId, next, version)
      setSent({ weddingId, list: saved.data.map(toTimelineDraft), etag: saved.etag, shown: q.data })
      setConflictedVersion(null)
      q.reload()
      return true
    } catch (e) {
      if (e instanceof ApiError && e.code === 'timeline_conflict') setConflictedVersion(version)
      const details = e instanceof ApiError && e.status === 422 ? Object.values(e.fields).map(t).join('. ') : ''
      setErr(details ? `${explainError(e)}: ${details}` : explainError(e)); return false
    } finally { setBusy(false) }
  }

  const accepted = sent && sent.weddingId === weddingId && (sent.shown === q.data || q.data === null) ? sent.list : null
  const asDraft = (): TimelineDraft[] => {
    if (accepted) return accepted
    return raw.map(toTimelineDraft)
  }
  /* Крестики и «Добавить» закрыты, пока список перечитывается: правка по
     прежнему списку откатила бы предыдущую. Закрыты и когда списка нет
     вовсе — первый GET упал и принятой копии нет: пустой экран здесь значит
     «не знаю», а не «пусто» (инвариант 13), и PUT из него стёр бы тайминг. */
  /* И пока не пришёл пояс площадки: время блока считается в нём, и до ответа
     «13:00» легло бы в чужой пояс (ревью 015, FB3). */
  const version = accepted ? sent?.etag : q.data?.etag
  const locked = busy || q.refreshing || !version || (q.data === null && !accepted) || !ready(wq) || conflictedVersion === version

  const addEvent = () => void (async () => {
    if (!name.trim()) return
    const startsAt = from && weddingDate ? isoAtWeddingTime(weddingDate, from, tz) : ''
    if (from && !startsAt) { setErr(t('Укажите дату и время начала блока')); return }
    const endsAt = till && weddingDate ? isoAtWeddingTime(weddingDate, till, tz) : null
    if (till && !startsAt) { setErr(t('Укажите дату и время начала блока')); return }
    const ok = await save([...asDraft(), { name: name.trim(), startsAt: startsAt || '', ...(endsAt ? { endsAt } : {}), forGuests: forGuestsNew }])
    if (!ok) return
    setName(''); setFrom(''); setTill(''); setForGuestsNew(true); setEditing(false)
  })()

  const removeEvent = (id: string) => void save(asDraft().filter(e => e.id !== id))
  /* Галочка — тот же PUT всего списка, что крестик: отдельного пути «показать
     гостям» контракт не знает. Список — из принятого сервером (`asDraft`), а
     не с экрана: иначе галочка сразу после крестика вернула бы убранный блок. */
  const toggleForGuests = (id: string) => void save(asDraft().map(e => (e.id === id ? { ...e, forGuests: !e.forGuests } : e)))

  /*
   * Автоплан сервер отдаёт предпросмотром и сам ничего не меняет — так же
   * ведёт себя и экран: показываем, что получилось и какие нашлись конфликты,
   * а заменяет тайминг пара отдельной кнопкой. Применять сразу нельзя: это
   * стирает уже расставленные блоки, о которых человек не просил.
   */
  const autoplan = () => void (async () => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — тайминг живёт в ней')); return }
    setBusy(true)
    setErr(null)
    try {
      const res = await autogenTimeline(weddingId)
      setConflicts(res.data?.conflicts ?? [])
      setDraftVersion(res.etag)
      setDraft((res.data?.events ?? []).map(toTimelineDraft))
    } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  const applyDraft = () => void (async () => {
    if (!draft) return
    if (!draftVersion) { setErr(t('Обновите программу перед сохранением')); return }
    if (await save(draft, draftVersion)) {
      setDraft(null); setDraftVersion(null); setConflicts(null)
    }
  })()

  return (
    <div className="pb-28">
      <TopBar back title={t('День свадьбы')} sub={weddingDate ? `${t('Расписание ')}${formatWeddingDate(weddingDate)}` : t('Расписание дня · полный сценарий')} right={
        <button onClick={() => setEditing(!editing)} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{editing ? t('Готово') : t('Править')}</button>
      } />
      <AsyncState q={q} />
      {ready(q) && q.data?.etag && <div aria-label={t('Версия программы')} className="px-5 mt-2 text-[11px] text-[var(--soft)] space-y-1 break-words">
        <p>{t('Версия программы')}: {q.data.etag.replace(/^"|"$/g, '')}</p>
        <p>{author ? <>{t('Автор изменения')}: {author}</> : t('Автор изменения неизвестен')}</p>
        <p>{changedAt ? <>{t('Изменено')}: <time dateTime={updatedAt!}>{changedAt}</time></> : t('Время изменения неизвестно')}</p>
      </div>}
      {/* Прогноз погоды убран: здесь стояло «Прогноз на 14 июня: +22°, к вечеру
          кратковременный дождь» — выдуманный текст с чужой датой. Погоды нет ни
          в контракте, ни в источниках данных; показывать её нарисованной нельзя,
          потому что по ней принимают решение о плане Б. Вернётся, когда появится
          настоящий источник — MIGRATION-PLAN.md §2.8. */}
      <div className="px-5 mt-2 space-y-2.5 stagger">
        {editing && (
          <div className="card p-4 fade-up">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('Событие (например, «Первый танец»)')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            {/* Время вводится полями «с» и «до», а не одной строкой «19:00 —
                19:10»: сервер хранит две метки времени, и разбирать их из
                свободного текста значит гадать. */}
            <div className="flex gap-2.5 mt-2.5">
              <input value={from} onChange={e => setFrom(e.target.value)} type="time" aria-label={t('Начало')} className="flex-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none tabular" />
              <input value={till} onChange={e => setTill(e.target.value)} type="time" aria-label={t('Конец')} className="flex-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none tabular" />
            </div>
            {/* Видят ли блок гости в день X: снятая галочка — блок только для
                команды («Сборы невесты», «Монтаж арки»), гостю его не отдаёт
                сервер (`GET /join/{t}/day`). */}
            <label className="flex items-center gap-2 mt-2.5 text-[12px] font-medium">
              <input type="checkbox" checked={forGuestsNew} onChange={e => setForGuestsNew(e.target.checked)} className="accent-[var(--rose)]" />
              {t('Показывать гостям')}
            </label>
            {weddingDate && !ready(wq) && <p className="text-[11px] text-[var(--soft)] mt-2">{wq.loading ? t('Загружаем часовой пояс площадки…') : t('Часовой пояс площадки не загрузился — время блока считать не в чем')}</p>}
            <button disabled={locked || !!blockEditor} onClick={addEvent} className="press w-full h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold mt-3 disabled:opacity-50">{busy ? t('Сохраняем…') : t('Добавить в тайминг')}</button>
          </div>
        )}
        {err && (!blockEditor || blockEditor.weddingId !== weddingId) && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
        {ready(q) && !q.data?.etag && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Обновите программу перед сохранением')}</p>}
        {conflictedVersion !== null && <button type="button" disabled={q.refreshing} onClick={() => q.reload()} className="press flex items-center gap-2 text-[12px] text-[var(--rose-deep)] disabled:opacity-50"><RefreshCw size={14} />{t('Обновить')}</button>}
        {/* Пустой тайминг — состояние, а не пустое место: без этой строки экран
            без событий и экран без ответа сервера выглядели одинаково. */}
        {!events.length && ready(q) && (
          <p className="text-[12px] text-[var(--soft)] text-center py-4">{t('Тайминг пуст — добавьте событие или соберите автоплан по команде')}</p>
        )}
        {events.map(e => (
          <div key={e.id} className="card-s p-4 flex gap-3 fade-up items-start">
            <Tile icon={e.icon} tile={e.tile} size={42} />
            <div className="min-w-0 flex-1">
              <b className="text-[13.5px]">{e.name}</b>
              <p className="text-[11px] text-[var(--soft)] mt-0.5">{e.loc}</p>
              <p className="text-[11px] text-[var(--rose-deep)] font-semibold mt-1 tabular">{e.time}</p>
              <p className="text-[10px] text-[var(--sage-deep)] mt-0.5">{e.who}</p>
              <div className="mt-1 space-y-1 text-[11px] text-[var(--soft)]">
                {e.planning.durationMinutes != null && <p>{t('Длительность, мин')}: {e.planning.durationMinutes}</p>}
                {e.planning.fixed && <p className="flex items-center gap-1"><LockKeyhole size={12} />{t('Фиксированное начало')}</p>}
                {!!e.planning.travelMinutes && <p>{t('Переезд, мин')}: {e.planning.travelMinutes}</p>}
                {!!e.planning.bufferMinutes && <p>{t('Запас, мин')}: {e.planning.bufferMinutes}</p>}
                {e.planning.responsible && <p className="break-words">{t('Ответственный')}: {choices.find(c => c.reference.kind === e.planning.responsible!.kind && c.reference.id === e.planning.responsible!.id)?.name || e.planning.responsible.id}</p>}
                {!!e.planning.participants?.length && <p className="break-words">{t('Участники блока')}: {e.planning.participants.map(r => choices.find(c => c.reference.kind === r.kind && c.reference.id === r.id)?.name || r.id).join(', ')}</p>}
                {!!e.planning.dependsOn?.length && <p className="break-words">{t('Зависит от блоков')}: {e.planning.dependsOn.map(id => raw.find(r => r.id === id)?.name || id).join(', ')}</p>}
              </div>
              {/* Пометка — по ответу сервера, а не по галочке на экране: гость
                  этого блока в своей программе не увидит. */}
              {!e.forGuests && <p className="text-[10px] text-[var(--soft)] mt-0.5">{t('скрыт от гостей')}</p>}
              {editing && (
                <label className="flex items-center gap-1.5 mt-1.5 text-[11px] text-[var(--soft)]">
                  <input type="checkbox" checked={e.forGuests} disabled={locked || !!blockEditor} onChange={() => toggleForGuests(e.id)} className="accent-[var(--rose)]" />
                  {t('Показывать гостям')}
                </label>
              )}
              {editing && <button type="button" title={t('Изменить блок')} aria-label={`${t('Изменить блок')}: ${e.name}`}
                disabled={locked || !!blockEditor} className="press mt-2 h-8 w-8 inline-flex items-center justify-center text-[var(--rose-deep)] disabled:opacity-50"
                onClick={() => { if (weddingId && version) setBlockEditor({ weddingId, id: e.id, list: asDraft(), version }) }}><Pencil size={16} /></button>}
              {editing && blockEditor?.weddingId === weddingId && blockEditor.id === e.id && tz && <TimelinePlanningEditor
                key={`${blockEditor.weddingId}:${blockEditor.id}:${blockEditor.version}`} event={blockEditor.list.find(r => r.id === e.id)!}
                events={blockEditor.list} choices={choices} timeZone={tz}
                referencesReady={ready(membersQ) && ready(guestsQ) && ready(slotsQ)}
                referencesError={membersQ.error || guestsQ.error || slotsQ.error}
                serverError={err}
                disabled={locked || blockEditor.version === conflictedVersion}
                onCancel={() => setBlockEditor(null)} onSave={next => save(blockEditor.list.map(r => r.id === next.id ? next : r), blockEditor.version)} />}
            </div>
            {editing && (
              <button disabled={locked || !!blockEditor} onClick={() => removeEvent(e.id)} className="press text-[var(--rose-deep)] text-[14px] shrink-0 disabled:opacity-50" aria-label={t('Убрать из тайминга')}>×</button>
            )}
          </div>
        ))}
        {/* Автоплан и конфликты — с сервера. Здесь стояло «Автоплан готов:
            конфликтов нет. План Б на дождь — шатёр уже включён в аренду
            усадьбы»: текст показывался всегда и ничего не проверял. */}
        <button disabled={busy} onClick={autoplan} className="press w-full card-s py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50">✨ {busy ? t('Считаем…') : t('Собрать автоплан по команде')}</button>
        {conflicts !== null && (
          <div className="card p-4">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Предложение автоплана')}</span>
            {conflicts.length
              ? <ul className="mt-2 space-y-1.5">{conflicts.map(c => <li key={c} className="text-[11.5px] text-[var(--rose-ink)]">• {c}</li>)}</ul>
              : <p className="text-[11.5px] text-[var(--sage-deep)] mt-2">{t('Конфликтов не нашлось')}</p>}
            {draft?.length ? (
              <>
                <div className="mt-3 space-y-1 border-t border-[var(--track)] pt-3">
                  {draft.map(e => (
                    <div key={`${e.name}-${e.startsAt}`} className="flex justify-between text-[11.5px]">
                      <span className="truncate">{e.name}</span>
                      <b className="tabular shrink-0 ml-2">{e.startsAt ? formatTime(e.startsAt, tz) : '—'}</b>
                    </div>
                  ))}
                </div>
                {/* Заменять тайминг целиком — решение пары: у неё уже могут
                    стоять свои блоки, и молча стирать их нельзя. */}
                <div className="flex gap-2.5 mt-3">
                  <button disabled={busy} onClick={() => { setDraft(null); setDraftVersion(null); setConflicts(null) }} className="press flex-1 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
                  <button disabled={busy || !draftVersion || draftVersion === conflictedVersion} onClick={applyDraft} className="press flex-1 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{t('Заменить тайминг')}</button>
                </div>
              </>
            ) : null}
          </div>
        )}
        {weddingId && ready(q) && !q.refreshing && q.data?.etag && <TimelineAcknowledgments key={weddingId} weddingId={weddingId} timelineVersion={q.data.etag} refreshTimeline={q.reload} />}
        <button onClick={() => window.print()} className="press w-full card-s py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} />{t('Скачать PDF для координатора')}</button>
      </div>
    </div>
  )
}

/*
 * Гости: список, RSVP и добавление — всё на сервере.
 *
 * Что здесь было неправдой:
 *  — до ответа сервера список подменялся моком из `lib/data.ts`, и человек
 *    видел чужих «Ольгу и Дениса» как своих гостей;
 *  — добавление и смена статуса писались в `tt_guests` на этом телефоне: у
 *    второго из пары список оставался прежним, и никто об этом не узнавал;
 *  — «веган / аллергия / трансфер» переключались кнопками пары и хранились в
 *    `tt_rsvp`. Эти поля заполняет сам гость в своей форме RSVP, и контракт
 *    правку их парой не принимает — теперь они только показываются;
 *  — строка «✓ Автоматически уйдёт кейтерингу и площадке 1 июня» обещала
 *    рассылку, которой нет;
 *  — подсказка «8 гостей не ответили» считала до восьми независимо от списка,
 *    а кнопка «отправить напоминание» только меняла надпись на экране.
 */
interface GuestRow {
  id: string
  name: string
  status: 'yes' | 'no' | 'pending'
  plus: boolean
  partyId: string
  partyPosition: number
  partySize: number
  isPrimary: boolean
  isPlaceholder: boolean
  tableId?: string | null
  /** Телефон вводит пара — по нему уходит SMS-напоминание молчащим. */
  phone?: string | null
  /* Номер видит только пара (152-ФЗ, контракт v0.29.0): помощнику и
     координатору приходит лишь факт «телефон записан» — его и показываем,
     без цифр и без поля ввода (фича 005). */
  hasPhone?: boolean
  /* Что гость написал в RSVP. До фичи 005 писалось и нигде не читалось
     (D3-25); приходит только паре — нет поля, нет и строки. */
  comment?: string | null
  diet?: string | null
  dietNote?: string | null
  transfer?: string | null
}

/** Ровно десять цифр после +7 — так контракт описывает телефон. */
const PHONE_DIGITS = 10

/** Потолок одного импорта — `maxItems` контракта: больше сервер отвечает 422 без имён. */
const IMPORT_MAX = 300

/** Подписи ограничений по еде: ключ словаря — русская строка (R-07). */
const DIET_LABEL: Record<string, string> = {
  vegetarian: 'вегетарианец',
  vegan: 'веган',
  halal: 'халяль',
  kosher: 'кошер',
  gluten_free: 'без глютена',
  other: 'особое меню',
}

const RSVP_NEXT: Record<GuestRow['status'], 'yes' | 'no' | 'pending'> = { yes: 'no', no: 'pending', pending: 'yes' }

export function Guests() {
  const nav = useNavigate()
  const { weddingId } = useStore()
  const q = useApi(() => weddingId ? getGuests(weddingId) : noWedding(), [weddingId])

  /* Приводим ответ сервера к тому, что рисует экран: у него `plusOne` вместо
     `plus` и `pending` вместо `wait`. Подмены моком нет — пустой список это
     пустой список. */
  const list: GuestRow[] = useMemo(
    () => (q.data ?? []).map((g, i): GuestRow => ({
      id: g.id ?? String(i),
      name: g.name ?? '',
      status: g.status === 'yes' ? 'yes' : g.status === 'no' ? 'no' : 'pending',
      plus: !!g.plusOne,
      partyId: g.partyId ?? g.id ?? String(i),
      partyPosition: g.partyPosition ?? 1,
      partySize: g.partySize ?? (g.plusOne ? 2 : 1),
      isPrimary: g.isPrimary ?? (g.partyPosition ?? 1) === 1,
      isPlaceholder: g.isPlaceholder ?? false,
      tableId: g.tableId,
      phone: g.phone,
      hasPhone: g.hasPhone,
      comment: g.comment,
      diet: g.diet,
      dietNote: g.dietNote,
      transfer: g.transfer,
    })),
    [q.data],
  )

  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [familyMember, setFamilyMember] = useState('')
  const [familyAddFor, setFamilyAddFor] = useState<string | null>(null)
  const [familyDraft, setFamilyDraft] = useState('')
  /* Телефон гостя — десять цифр после +7. Раньше ввести его было негде, и
     «Напомнить не ответившим» не находила ни одного адресата: сервер честно
     отвечал «без телефона» на каждого. */
  const [phone, setPhone] = useState('')
  const [phoneEdit, setPhoneEdit] = useState<string | null>(null)
  const [phoneDraft, setPhoneDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [reminded, setReminded] = useState<string | null>(null)
  /*
   * Списком (фича 008, экран 29). На свадьбе в сотню гостей заводить их по
   * одному — час работы, а список у пары уже есть: заметки, таблица, чат.
   * Разбор — на клиенте (`lib/guestsImport.ts`), предпросмотр без запроса;
   * уходит один `POST …/guests/import` только с чистыми строками. Итог —
   * из ответа сервера, не из предпросмотра: что дубликат, решает он
   * (инвариант §5.13). Отказ — его словами, здесь же, под кнопкой.
   */
  const [bulk, setBulk] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkErr, setBulkErr] = useState<string | null>(null)
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: { name: string; reason: 'duplicate' | 'invalid' }[] } | null>(null)
  /* Пометка «уже в списке» — тем же правилом, что у сервера: имя без регистра
     и пробелов, телефон как `+7…`. Повтор внутри вставленного текста — тоже
     дубликат, сервер завёл бы лишь первого. Список не пришёл — пометок нет,
     дедупликацию сделает сервер и назовёт её в `skipped`. */
  const preview = useMemo(() => {
    const names = new Set(list.map(g => guestNameKey(g.name)))
    const phones = new Set(list.map(g => g.phone).filter((p): p is string => !!p))
    return parseGuestList(bulkText).map(row => {
      const phone = row.phone ? normalizeRuPhone(row.phone) : null
      const dup = !row.error && (names.has(guestNameKey(row.name)) || (!!phone && phones.has(phone)))
      if (!row.error && !dup) { names.add(guestNameKey(row.name)); if (phone) phones.add(phone) }
      return { ...row, dup }
    })
  }, [bulkText, list])
  const clean = preview.filter(r => !r.error && !r.dup)
  const importList = async () => {
    /* Без свадьбы записывать некуда — те же слова, что у добавления одного. */
    if (!weddingId) { setBulkErr(t('Сначала создайте свадьбу — гости живут в ней')); return }
    /* Предел сервера — 300 строк за раз (`maxItems`): длиннее — 422 на весь
       список без единого добавленного; лучше сказать до запроса (ревью 015). */
    if (clean.length > 300) { setBulkErr(t('За один раз — не больше 300 гостей: вставьте список частями')); return }
    setBusyId('import')
    setBulkErr(null)
    setBulkResult(null)
    try {
      const rows: GuestImportRow[] = clean.map(r => ({ name: r.name, ...(r.phone ? { phone: r.phone } : {}), ...(r.plusOne ? { plusOne: true } : {}) }))
      const res = await importGuests(weddingId, rows)
      /* 201 без тела — не «добавлено 0»: итог без ответа не называем. */
      if (!res) throw new Error('пустой ответ')
      setBulkResult({ created: res.created.length, skipped: res.skipped })
      setBulkText('')
      q.reload()
    } catch (e) { setBulkErr(explainError(e)) } finally { setBusyId(null) }
  }
  /*
   * Своя роль — из списка свадеб, как на экране команды (D1-25). «Напомнить
   * не ответившим» тратит SMS-лимит свадьбы, и сервер отдаёт её только паре
   * (403 остальным, фича 005): помощнику и координатору кнопки нет — кнопка
   * с заведомым отказом равна кнопке без действия (R-176). Пока роль едет
   * или не пришла — на её месте состояние запроса, а не кнопка (RF-03).
   */
  const mine = useApi(() => listMyWeddings(), [])
  const iAmCouple = mine.data?.find(w => w.id === weddingId)?.role === 'couple'

  const write = async (id: string, fn: () => Promise<unknown>) => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — гости живут в ней')); return }
    // Enter в поле по второму разу не шлёт второй запрос, пока идёт первый (ревью 015).
    if (busyId) return
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }
  const add = () => {
    if (!name.trim()) return
    /* Недобранный номер — не «без телефона»: раньше семь цифр молча
       выбрасывались, и гость заводился без SMS-напоминания (ревью 015). */
    if (phone.length > 0 && phone.length !== PHONE_DIGITS) { setErr(t('Телефон — десять цифр после +7, или оставьте поле пустым')); return }
    void write('new', async () => {
      await addGuest(weddingId!, {
        name: name.trim(),
        ...(familyMember.trim() ? { members: [{ name: familyMember.trim() }] } : {}),
        ...(phone.length === PHONE_DIGITS ? { phone: `+7${phone}` } : {}),
      })
      setName(''); setFamilyMember(''); setPhone(''); setAdding(false)
    })
  }
  /* Пустое поле стирает номер (`null`): контракт различает «не трогать» и «убрать». */
  const savePhone = (g: GuestRow) => void write(g.id, async () => {
    await patchGuest(weddingId!, g.id, { phone: phoneDraft.length === PHONE_DIGITS ? `+7${phoneDraft}` : null })
    setPhoneEdit(null)
  })
  const addMember = (g: GuestRow) => {
    const memberName = familyDraft.trim()
    if (!memberName || !g.isPrimary || g.partySize >= 10) return
    void write(`family-${g.id}`, async () => {
      await addGuestMember(weddingId!, g.id, memberName)
      setFamilyDraft('')
      setFamilyAddFor(null)
    })
  }
  const cycle = (g: GuestRow) => void write(g.id, () => patchGuest(weddingId!, g.id, { status: RSVP_NEXT[g.status] }))
  const remove = (g: GuestRow) => void write(g.id, async () => {
    await deleteGuest(weddingId!, g.id)
    setConfirmDel(null)
  })

  const yes = list.filter(g => g.status === 'yes').length
  // 020: одна строка списка = одна реальная персона. Скрытого +1 больше нет.
  const persons = (status: string) => list.filter(g => g.status === status).length
  const shown = filter === 'all' ? list : list.filter(g => g.status === filter)
  const waiting = list.filter(g => g.status === 'pending').length

  return (
    <div className="pb-28">
      {/* Числа появляются вместе с ответом сервера. «0 в списке · 0
          подтвердили» при отказе читается как «нам никто не ответил». */}
      <TopBar back title={t('Гости')} sub={ready(q) ? `${list.length}${t(' в списке · ')}${yes}${t(' подтвердили')}` : undefined} right={
        <div className="flex shrink-0 gap-2">
          <button onClick={() => { setAdding(!adding); setBulk(false) }} className="press h-10 w-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Добавить гостя')}><Plus size={16} /></button>
          {/* Списком — рядом с добавлением одного: одна панель за раз. */}
          <button onClick={() => { setBulk(!bulk); setAdding(false) }} className={cn('press h-10 w-10 rounded-full flex items-center justify-center', bulk ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)]')} style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Добавить списком')} title={t('Добавить списком')}><ListPlus size={16} /></button>
          <button onClick={() => nav('/wedding/invites')} aria-label={t('Пригласить')} title={t('Пригласить')} className="press h-10 w-10 shrink-0 sm:w-auto sm:px-4 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold flex items-center justify-center gap-1.5"><Send size={16} /><span className="hidden sm:inline">{t('Пригласить')}</span></button>
        </div>
      } />
      <AsyncState q={q} />
      {bulk && (
        <div className="px-5 mt-3 fade-up">
          <div className="card p-4 space-y-2.5">
            <p className="text-[12.5px] font-semibold">{t('Добавить списком')}</p>
            <textarea autoFocus value={bulkText} onChange={e => setBulkText(e.target.value)} rows={5} aria-label={t('Список гостей')}
              placeholder={t('Каждый гость — с новой строки. В строке через запятую: имя, телефон, +1')}
              className="w-full rounded-2xl bg-[var(--bg)] px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] resize-y" />
            <p className="text-[10.5px] text-[var(--soft2)]">{t('Например: Анна Петрова, +7 917 000-11-22, +1')}</p>
            {/* Предпросмотр: строка с ошибкой показывается как написана, чтобы
                было видно, что именно не разобралось. */}
            {preview.length > 0 && (
              <ul className="space-y-1">
                {preview.map(r => (
                  <li key={r.index} className="flex items-center gap-2 text-[12px]">
                    <span className={cn('flex-1 min-w-0 truncate', (r.error || r.dup) && 'text-[var(--soft)]')}>
                      {r.error ? r.raw : [r.name, r.phone, r.plusOne ? t('с +1') : null].filter(Boolean).join(' · ')}
                    </span>
                    {r.error === 'name' && <span className="text-[10px] font-bold text-[var(--rose-ink)] shrink-0">{t('нет имени')}</span>}
                    {r.error === 'phone' && <span className="text-[10px] font-bold text-[var(--rose-ink)] shrink-0">{t('телефон не распознан')}</span>}
                    {r.dup && <span className="text-[10px] font-bold text-[var(--honey-ink)] shrink-0">{t('уже в списке')}</span>}
                  </li>
                ))}
              </ul>
            )}
            {clean.length > IMPORT_MAX && <p className="text-[11px] text-[var(--rose-ink)]">{t('За раз — не больше 300 гостей: разделите список')}</p>}
            {bulkErr && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed">{bulkErr}</p>}
            {bulkResult && (
              <div className="text-[11.5px] text-[var(--ink2)] leading-relaxed">
                <p className="font-semibold">{t('Добавлено')} {bulkResult.created} · {t('пропущено')} {bulkResult.skipped.length}</p>
                {bulkResult.skipped.map((s, i) => (
                  <p key={i} className="text-[var(--soft)]">{s.name} — {s.reason === 'duplicate' ? t('уже в списке') : t('телефон не распознан')}</p>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="flex-1" />
              <button onClick={() => setBulk(false)} className="press px-4 py-2 text-[12px] font-semibold text-[var(--soft)]">{t('Закрыть')}</button>
              <button disabled={busyId === 'import' || clean.length === 0 || clean.length > IMPORT_MAX} onClick={() => void importList()} className="press px-5 py-2 rounded-full grad text-[var(--on-grad)] text-[12px] font-bold disabled:opacity-50">
                {busyId === 'import' ? t('Добавляем…') : `${t('Добавить')} ${clean.length} ${plural(clean.length, t('гостя'), t('гостей'), t('гостей'))}`}
              </button>
            </div>
          </div>
        </div>
      )}
      {adding && (
        <div className="px-5 mt-3 fade-up">
          <div className="card p-4 space-y-2.5">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder={t('Имя гостя или семьи')} className="w-full h-11 px-4 rounded-full bg-[var(--bg)] text-[13px] outline-none" />
            <div className="flex items-center gap-2 h-11 px-4 rounded-full bg-[var(--bg)]">
              <span className="text-[13px] text-[var(--soft)] tabular">+7</span>
              <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, PHONE_DIGITS))} onKeyDown={e => e.key === 'Enter' && add()} inputMode="tel" placeholder={t('Телефон — для SMS-напоминания (необязательно)')} className="flex-1 bg-transparent text-[13px] outline-none tabular" />
            </div>
            <input value={familyMember} onChange={e => setFamilyMember(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
              placeholder={t('Второй человек семьи (необязательно)')} aria-label={t('Второй человек семьи')}
              className="w-full h-11 px-4 rounded-full bg-[var(--bg)] text-[13px] outline-none" />
            <p className="text-[10.5px] text-[var(--soft)]">{t('У каждого человека будет отдельный RSVP, меню, место и трансфер; ссылка у семьи одна.')}</p>
            <div className="flex items-center gap-2">
              <div className="flex-1" />
              <button onClick={() => setAdding(false)} className="press px-4 py-2 text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button disabled={busyId === 'new'} onClick={add} className="press px-5 py-2 rounded-full grad text-[var(--on-grad)] text-[12px] font-bold disabled:opacity-50">{busyId === 'new' ? t('Сохраняем…') : t('Добавить')}</button>
            </div>
          </div>
        </div>
      )}
      <div className="px-5 mt-3 grid grid-cols-3 gap-2.5">
        {/* Прочерк, пока список не пришёл: «0 придут · 0 ждём · 0 не смогут»
            при отказе сервера — три выдуманных нуля подряд. */}
        {[[num(q, persons('yes')), t('придут'), 'text-[var(--sage-deep)]'], [num(q, persons('pending')), t('ждём ответ'), 'text-[var(--honey-deep)]'], [num(q, persons('no')), t('не смогут'), 'text-[var(--rose-deep)]']].map(([v, l, c]) => (
          <div key={l} className="card-s p-3.5 text-center">
            <b className={cn('text-[20px] tabular', c)}>{v}</b>
            <span className="text-[9.5px] text-[var(--soft)] block mt-0.5">{l}</span>
          </div>
        ))}
      </div>
      <div className="px-5 flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        {[['all', t('Все')], ['yes', t('Придут')], ['pending', t('Ждём')], ['no', t('Не придут')]].map(([id, l]) => (
          <button key={id} onClick={() => setFilter(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', filter === id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 mt-4">
        {err && <p className="text-[12px] text-[var(--rose-ink)] mb-2.5">{err}</p>}
        <div className="card px-4 py-1.5">
          {!shown.length && ready(q) && <p className="py-4 text-[12px] text-[var(--soft)] text-center">{list.length ? t('В этом фильтре пусто') : t('Список пуст — добавьте первого гостя')}</p>}
          {shown.map((g, i) => (
            <div key={g.id} className={cn('flex items-center gap-3 py-3', i !== shown.length - 1 && 'border-b border-[var(--track)]')}>
              <div className={cn('w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-serif-d text-white shrink-0',
                g.status === 'yes' ? 'bg-[var(--sage)]' : g.status === 'no' ? 'bg-[var(--rose)]' : 'bg-[var(--gold-soft)]')}>
                {g.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] block truncate">{g.name}</b>
                <span className="text-[10px] text-[var(--soft)]">
                  {g.isPrimary
                    ? g.partySize > 1
                      ? `${t('Семейное приглашение')} · ${g.partySize} ${t('чел.')}`
                      : t('Один человек в приглашении')
                    : t('Человек семьи')}
                </span>
                {g.isPrimary && g.partySize < 10 && familyAddFor !== g.id && (
                  <button
                    onClick={() => { setFamilyAddFor(g.id); setFamilyDraft('') }}
                    className="press block text-[10px] mt-1 text-[var(--sage-deep)] font-semibold"
                  >
                    + {t('Добавить человека в семью')}
                  </button>
                )}
                {familyAddFor === g.id && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <input
                      autoFocus
                      value={familyDraft}
                      onChange={e => setFamilyDraft(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addMember(g)}
                      placeholder={t('Имя человека')}
                      className="min-w-0 flex-1 h-8 px-2.5 rounded-lg bg-[var(--bg)] text-[11px] outline-none"
                    />
                    <button
                      disabled={busyId === `family-${g.id}` || !familyDraft.trim()}
                      onClick={() => addMember(g)}
                      className="press text-[10px] font-bold text-[var(--sage-deep)] disabled:opacity-50"
                    >
                      {t('Добавить')}
                    </button>
                    <button onClick={() => { setFamilyAddFor(null); setFamilyDraft('') }} className="press text-[10px] text-[var(--soft)]">
                      {t('Отмена')}
                    </button>
                  </div>
                )}
                {/* Телефон — единственное, что пара вводит за гостя: по нему
                    уходит напоминание. Пустое поле стирает номер. */}
                {phoneEdit === g.id ? (
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[10px] text-[var(--soft)] tabular">+7</span>
                    <input autoFocus value={phoneDraft} onChange={e => setPhoneDraft(e.target.value.replace(/\D/g, '').slice(0, PHONE_DIGITS))} onKeyDown={e => e.key === 'Enter' && savePhone(g)} inputMode="tel" aria-label={t('Телефон гостя')} className="w-[118px] h-7 px-2 rounded-lg bg-[var(--bg)] text-[11px] outline-none tabular" />
                    <button disabled={busyId === g.id || (phoneDraft.length !== 0 && phoneDraft.length !== PHONE_DIGITS)} onClick={() => savePhone(g)} className="press text-[10px] font-bold text-[var(--sage-deep)] disabled:opacity-50">{t('Сохранить')}</button>
                    <button onClick={() => setPhoneEdit(null)} className="press text-[10px] text-[var(--soft)]">{t('Отмена')}</button>
                  </div>
                ) : g.phone == null && g.hasPhone ? (
                  <span className="block text-[10px] mt-0.5 text-[var(--soft)]">{t('телефон записан')}</span>
                ) : (
                  <button onClick={() => { setPhoneEdit(g.id); setPhoneDraft((g.phone ?? '').replace(/^\+7/, '')) }} className="press block text-[10px] mt-0.5 text-[var(--sage-deep)] tabular">
                    {g.phone ?? t('+ телефон для напоминания')}
                  </button>
                )}
                {/* Слова гостя из RSVP — как написал, без правки за него. */}
                {g.comment && <p className="text-[10.5px] text-[var(--ink2)] mt-1 leading-snug italic">«{g.comment}»</p>}
                {/* Еда и трансфер — ответы самого гостя в его форме RSVP:
                    пара их видит, но не правит за него. */}
                {(g.diet || g.dietNote || g.transfer === 'need') && (
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {(g.diet || g.dietNote) && (
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-[var(--lav)] text-[var(--lav-ink)]">
                        🍽 {g.dietNote ?? t(DIET_LABEL[g.diet!] ?? g.diet!)}
                      </span>
                    )}
                    {g.transfer === 'need' && (
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-[var(--blue)] text-[var(--blue-ink)]">🚌 {t('трансфер')}</span>
                    )}
                  </div>
                )}
              </div>
              {confirmDel === g.id ? (
                <button disabled={busyId === g.id} onClick={() => remove(g)} className="press text-[9px] font-bold px-2.5 py-1 rounded-full bg-[var(--rose-deep)] text-[var(--card)] disabled:opacity-50">{t('Удалить?')}</button>
              ) : (
                <button onClick={() => setConfirmDel(g.id)} className="press text-[9px] font-bold px-2 py-1 rounded-full text-[var(--soft)]" aria-label={t('Удалить гостя')}>×</button>
              )}
              <button disabled={busyId === g.id} onClick={() => cycle(g)} title={t('Нажмите, чтобы сменить статус')} className={cn('press text-[9px] font-bold px-2.5 py-1 rounded-full transition-all disabled:opacity-50',
                g.status === 'yes' ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : g.status === 'no' ? 'bg-[var(--rose-soft)] text-[var(--rose-ink)]' : 'bg-[var(--honey)] text-[var(--honey-ink)]')}>
                {g.status === 'yes' ? t('Придёт') : g.status === 'no' ? t('Не придёт') : t('Ждём')}
              </button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3.5">
          <button onClick={() => nav('/wedding/seating')} className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Armchair size={15} />{t('Рассадка')}</button>
          <button onClick={() => {
            /* Заголовок и «да/нет» — через словарь, как и статусы: иначе в
               английском интерфейсе файл выходил смешанным (R-07, ревью D3-21). */
            const csv = `${t('Имя;Статус;Семья')}\n` + list.map(g => `${g.name};${g.status === 'yes' ? t('Придёт') : g.status === 'no' ? t('Не придёт') : t('Ждём')};${g.partySize > 1 ? t('да') : t('нет')}`).join('\n')
            const a = document.createElement('a')
            a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }))
            /* Имя файла общее: пара в нём не названа, а прежнее «alina-timur»
               доставалось всем скачавшим. Номер стола убран из выгрузки —
               рассадка живёт отдельным списком столов. */
            a.download = 'gosti.csv'
            a.click()
          }} className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} />{t('Список CSV')}</button>
        </div>
        {/* Сводка для кейтеринга — только по пришедшему списку: «0 персон · 0
            особое меню» без сервера площадка прочла бы как заказ. */}
        {ready(q) && <div className="mt-3.5">
          {(() => {
            const yesGuests = list.filter(g => g.status === 'yes')
            const special = yesGuests.filter(g => g.diet || g.dietNote).length
            const transfer = yesGuests.filter(g => g.transfer === 'need').length
            const seats = yesGuests.length
            return (
              <div className="card p-4">
                <p className="text-[12px] font-semibold mb-1.5">🍽 {t('Для кейтеринга')}</p>
                <p className="text-[11px] text-[var(--soft)] leading-relaxed">
                  {seats} {t('персон')} · {special} {t('особое меню')} · {transfer} {t('нужен трансфер')}
                </p>
                {/* Прежняя строка обещала автоматическую отправку кейтерингу
                    «1 июня». Такой рассылки нет — числа сводки пара передаёт
                    сама. */}
                <p className="text-[10px] text-[var(--soft2)] mt-1.5">{t('Цифры обновляются по ответам гостей — покажите их площадке и кейтерингу сами.')}</p>
              </div>
            )
          })()}
        </div>}
        {waiting > 0 && (
          <div className="mt-3.5 space-y-2">
            {/* Число — из списка, а не «8» константой. */}
            <AiTip text={`${waiting} ${plural(waiting, t('гость ещё не ответил'), t('гостя ещё не ответили'), t('гостей ещё не ответили'))}`} onPress={() => nav('/wedding/invites')} />
            {/* Одно СМС каждому молчащему — вместо обхода списка руками.
                Кому не уйдёт, сервер называет отдельно: без телефона и с уже
                открытой ссылкой (новая ссылка увела бы за собой выбор гостя).
                Только паре — см. `mine` выше. */}
            <AsyncState q={mine} />
            {iAmCouple && <button disabled={busyId === 'remind'} onClick={() => void write('remind', async () => {
              /* Итог прошлой попытки убираем сразу: иначе рядом с отказом
                 висит «Отправлено: 1» и читается как успех. */
              setReminded(null)
              const res = await remindGuests(weddingId!)
              const parts = [`${t('Отправлено:')} ${res?.sent ?? 0}`]
              if (res?.skippedNoPhone) parts.push(`${t('без телефона:')} ${res.skippedNoPhone}`)
              if (res?.skippedLinkUsed) parts.push(`${t('ссылку уже открыли:')} ${res.skippedLinkUsed}`)
              setReminded(parts.join(' · '))
            })} className="press w-full card-s py-3.5 text-[12.5px] font-semibold disabled:opacity-50">
              {busyId === 'remind' ? t('Отправляем…') : t('Напомнить не ответившим')}
            </button>}
            {reminded && <p className="text-[11px] text-[var(--soft)] px-1">{reminded}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

/* Общий фотоальбом гостей: QR на столах + модерация парой */
export function Album() {
  const { weddingId } = useStore()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  /*
   * Кадры гостей приходят с сервера.
   *
   * Раньше альбом жил в `tt_album` браузера пары и наполнялся кнопкой
   * «Загрузить фото (демо)», которая добавляла эмодзи из списка. Гость,
   * снявший что-то на свадьбе, до пары не доходил вовсе.
   */
  const q = useApi(() => weddingId ? getAlbum(weddingId) : noWedding(), [weddingId])
  const photos = q.data ?? []
  const pending = photos.filter(p => !p.approved).length

  const moderate = (photoId: string, approved: boolean) => void (async () => {
    if (!weddingId) return
    setBusyId(photoId)
    setErr(null)
    try { await setPhotoApproved(weddingId, photoId, approved); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  })()

  const approveAll = () => void (async () => {
    if (!weddingId) return
    setBusyId('all')
    setErr(null)
    /* Один запрос на все кадры (`PATCH …/album`, план миграции §2.3): цикл по
       кадру был сотней запросов на альбом из сотни фото, и обрыв посередине
       оставлял альбом наполовину одобренным. Перечитываем в любом случае. */
    try {
      await setAlbumApproved(weddingId, true)
    } catch (e) { setErr(explainError(e)) } finally { setBusyId(null); q.reload() }
  })()

  return (
    <div className="pb-28">
      <TopBar back title={t('Фотоальбом гостей')} sub={ready(q) ? `${photos.length} ${plural(photos.length, t('кадр'), t('кадра'), t('кадров'))} · ${pending} ${t('на модерации')}` : undefined} />
      <AsyncState q={q} />
      <div className="px-5 mt-3 space-y-3">
        {/*
          * QR-квадрат из шестнадцати клеточек и кнопка «Загрузить фото (демо)»
          * убраны. Настоящей ссылки для гостя нет, а загрузка упирается в
          * объектное хранилище: сервер честно отвечает, что бакет и ключи не
          * подключены. Рисовать вместо этого работающий вид — обещать то,
          * чего сегодня нет.
          */}
        <div className="card p-4">
          <p className="text-[13px] font-semibold">{t('Загрузка фото пока не подключена')}</p>
          <p className="text-[11px] text-[var(--soft)] leading-relaxed mt-1">
            {t('Гости смогут загружать кадры без регистрации, когда будет подключено файловое хранилище. Кадры, которые уже пришли, видны ниже.')}
          </p>
        </div>
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
        {pending > 0 && (
          <div className="card p-3.5 flex items-center justify-between">
            <p className="text-[12px] font-medium">{t('Новых на модерации:')} {pending}</p>
            <button disabled={busyId === 'all'} onClick={approveAll} className="press text-[11px] font-bold px-3.5 py-2 rounded-full grad text-[var(--on-grad)] disabled:opacity-50">{busyId === 'all' ? t('Одобряем…') : t('Одобрить все')}</button>
          </div>
        )}
        {!photos.length && ready(q) && (
          <p className="text-[12px] text-[var(--soft)] text-center py-4">{t('Кадров пока нет')}</p>
        )}
      </div>
      <div className="px-5 mt-4 grid grid-cols-3 gap-2.5">
        {photos.map((p, i) => (
          <button key={p.id} disabled={busyId === p.id} onClick={() => moderate(p.id ?? '', !p.approved)}
            className={cn('press relative aspect-square rounded-[20px] overflow-hidden bg-[var(--track)] disabled:opacity-40', !p.approved && 'opacity-50')}
            style={{ animationDelay: `${i * 30}ms`, boxShadow: 'var(--shadow)' }}>
            {/* Кадр — настоящий файл гостя. Эмодзи-заглушки из палитры больше
                нет: она изображала фотографии, которых не было. */}
            {p.url && <img src={p.url} alt="" className="w-full h-full object-cover" loading="lazy" />}
            <span className={cn('absolute top-1.5 right-1.5 text-[8px] font-bold px-1.5 py-0.5 rounded-full', p.approved ? 'bg-[var(--sage)] text-[var(--on-grad)]' : 'bg-[var(--ink)] text-[var(--bg)]')}>
              {p.approved ? '✓' : '…'}
            </span>
          </button>
        ))}
      </div>
      {photos.length > 0 && (
        <p className="px-6 mt-3 text-center text-[10.5px] text-[var(--soft)]">{t('Тап по фото — одобрить/скрыть. Скрытые видите только вы.')}</p>
      )}
    </div>
  )
}

/* Документы */
/* Код шаблона сервера → название карточки: список показывал «photographer»
   вместо «Договор с фотографом» (ERR-0241). Ключи — те же строки словаря. */
const CONTRACT_TITLE: Record<string, string> = {
  photographer: key('Договор с фотографом'),
  venue: key('Аренда площадки'),
  host: key('Договор с ведущим'),
  universal: key('Универсальный договор услуг'),
}

export function Documents() {
  const nav = useNavigate()
  const { weddingId } = useStore()
  /* Список договоров — с сервера; закрыт помощнику матрицей доступа,
     поэтому 403 здесь штатный ответ. Сервер заводит их только черновиками —
     пути подписи нет, и заголовок «Подписанные» над ними утверждал статус,
     которого не бывает (ревью D2-14, R-174). Шаблоны договоров остаются
     локальными: это заготовки текста, а не данные свадьбы. */
  const q = useApi(() => weddingId ? getDocuments(weddingId) : noWedding(), [weddingId])
  return (
    <div className="pb-28">
      <TopBar back title={t('Документы')} sub={t('Договоры из шаблонов — за 2 минуты')} />
      <AsyncState q={q} forbiddenText={t('Документы ведёт пара — у вашей роли к ним доступа нет.')} />
      {ready(q) && (q.data ?? []).length > 0 && (
        <div className="px-5 mt-3">
          <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1">{t('Черновики договоров')}</span>
          <div className="space-y-2 mt-2">
            {(q.data ?? []).map((d, k) => (
              <div key={d.id ?? k} className="card-s p-3.5 flex items-center gap-3">
                <FileText size={15} className="text-[var(--sage-deep)] shrink-0" />
                <b className="text-[12.5px] flex-1 truncate">{t((d.templateCode && CONTRACT_TITLE[d.templateCode]) ?? d.templateCode ?? key('Договор'))}</b>
                <span className="text-[10px] text-[var(--soft)] shrink-0">{d.status === 'signed' ? t('подписан') : d.status === 'sent' ? t('отправлен') : t('черновик')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {contractTemplates.map(c => (
          <button key={c.id} onClick={() => nav('/wedding/documents/new')} className="press w-full card-s p-4 flex items-center gap-3 text-left fade-up">
            <Tile icon={c.icon} tile={c.tile} />
            <div className="flex-1 min-w-0">
              <b className="text-[13.5px] block">{t(c.name)}</b>
              <span className="text-[10.5px] text-[var(--soft)]">{t(c.desc)}</span>
            </div>
            <span className="text-[10px] font-bold px-3 py-1.5 rounded-full grad text-[var(--on-grad)] shrink-0">{t('Создать')}</span>
          </button>
        ))}
      </div>

      {/* Здесь стоял второй, выдуманный список «Подписанные»: «Договор с
          фотографом · подписан обеими сторонами · PDF» и «Аренда усадьбы
          «Липовый сад»». Нажатие скачивало .doc, в котором заказчиком значились
          «Алина Козлова и Тимур Волков» — чужие имена в документе, который
          человек мог отнести подрядчику. Настоящий список договоров (черновиков) стоит
          выше и приходит с сервера. */}

      <p className="px-6 mt-4 text-[10.5px] text-[var(--soft)] leading-relaxed text-center">
        {t('Шаблоны носят информационный характер и не заменяют консультацию юриста. Данные подставляются автоматически из сделки.')}
      </p>
    </div>
  )
}
