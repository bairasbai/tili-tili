import { createElement, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Wallet, ListChecks, Clock3, Users, FileText, Plus, Send, Download, Armchair, Heart, NotebookPen, Wine, Gift, Camera, Bus, UtensilsCrossed, ShieldCheck } from 'lucide-react'
import { contractTemplates } from '@/lib/contractTemplates'
import { fmt } from '@/lib/money'
import type { Slot } from '@/lib/types'
import { useApi, explainError } from '@/lib/api/useApi'
import { formatWeddingDate, isoAtWeddingTime, shortWeddingDate } from '@/lib/weddingDate'
import { AsyncState, num, ready } from '@/components/AsyncState'
import { getBudget, getDocuments, getGuests, getTasks, getTimeline, getWedding } from '@/lib/api/weddingData'
import { getAlbum, setPhotoApproved } from '@/lib/api/gifts'
import { addBudgetItem, addGuest, addTask as addTaskApi, autogenTimeline, deleteBudgetItem, deleteGuest, deleteTask, patchGuest, putTimeline, remindGuests, setTaskDone, type TimelineDraft } from '@/lib/api/weddingWrite'
import { rub } from '@/lib/money'
import { AiTip, Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { committedTotal } from '@/lib/budget'
import { useBusy } from '@/lib/useBusy'
import { catIcon } from '@/lib/icons'
import { cn, copyText, pct, plural } from '@/lib/utils'
import { chatRouteForVendor } from '@/lib/api/chats'
import { t } from '@/lib/i18n'

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
  const booked = slots.filter(s => s.state === 'booked').length
  const progress = slots.filter(s => s.state !== 'empty').length
  /* Общий бюджет — с сервера. Здесь стояло `couple.budgetTotal` из мока:
     полоса «забронировано на сумму» считалась от чужого миллиона двухсот и
     врала у каждой пары, кроме выдуманной. */
  const budget = useApi(() => weddingId ? getBudget(weddingId) : Promise.resolve(null), [weddingId])
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
        <button onClick={() => nav('/dayx')} className="press w-full rounded-[22px] p-4 flex items-center gap-3 text-left text-white" style={{ background: 'linear-gradient(120deg,#3A322B,#1E1A16)', boxShadow: 'var(--shadow)' }}>
          <span className="text-[22px]">🎬</span>
          <span className="flex-1">
            <b className="text-[13px] block">{t('Режим дня X')}</b>
            {/* Ни «демо», ни SOS здесь больше нет: экран дня X работает на
                серверном тайминге, а отдельной кнопки «позвать координатора»
                контракт не знает — вместо неё командный чат (R-163). */}
            <span className="text-[10px] text-white/60">{t('Тайминг, сдвиг всей программы, план Б и чат команды')}</span>
          </span>
        </button>
      </div>
      <div className="px-5 mt-5">
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5 stagger">
          {slots.map(s => {
            return (
            <button
              key={s.id}
              onClick={() => nav(`/wedding/slot/${s.id}`)}
              className={cn('press rounded-[18px] p-3 flex flex-col items-center justify-center gap-1.5 aspect-[0.85] md:aspect-auto md:py-5 fade-up',
                s.state === 'empty' ? 'border-[1.5px] border-dashed border-[#D8B4AE] bg-[var(--rose-soft)]/30' : 'card-s')}
            >
              <span className={cn('w-9 h-9 rounded-[12px] flex items-center justify-center', s.state === 'empty' ? '' : s.tile)}>
                {s.state === 'empty' ? <Plus size={20} className="text-[var(--rose-ink)]" /> : createElement(catIcon(s.categoryId), { size: 18, className: 'text-[var(--ink2)]' })}
              </span>
              <b className="text-[10.5px] text-center leading-tight">{s.label}</b>
              {s.state === 'booked' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[var(--sage-deep)]">{t('забронирован')}</span>}
              {s.state === 'hold' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[var(--honey-deep)]">{s.status && t(s.status)}</span>}
              {s.state === 'candidate' && <span className="text-[7.5px] font-bold uppercase tracking-wide text-[var(--rose-deep)]">{t('кандидаты')}</span>}
            </button>
            )
          })}
        </div>
        {/* Подсказка называет настоящие пустые слоты, а не «DJ и Декоратор»
            константой, и не обещает дату 14.06, которой у этой пары может не
            быть. Когда пустых слотов нет — подсказки тоже нет. */}
        {(() => {
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
          {slotsState === 'ready' && ready(budget) && <Bar pct={pct(committedTotal(slots), budgetTotal)} />}
          {budget.error && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-2">{budget.error}</p>}
        </div>
      </div>
    </div>
  )
}

/* Деталь слота */
export function SlotDetail() {
  const { slots, slotsState } = useStore()
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
          : slotsState === 'ready' ? t('Слот не найден') : t('Загружаем…')}
      </p>
    </div>
  )
  return <SlotView s={s} />
}

/* Тело экрана вынесено отдельно: состояние слота нужно до первого хука, а
   хуки нельзя объявлять после условного возврата. */
function SlotView({ s }: { s: Slot }) {
  const nav = useNavigate()
  const { cancelBooking, removeExternalVendor, bookExternal, inviteExternal } = useStore()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [ownOpen, setOwnOpen] = useState(false)
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

  /* Любое действие здесь уходит на сервер и меняет чужой календарь. Ошибку
     показываем словами, а не глотаем: «сделали вид, что получилось» на
     необратимом действии дороже честного отказа. */
  const guard = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try { await fn() } catch (e) { setErr(explainError(e)) }
  }

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
          <div className="flex gap-2">
            <input value={ownPrice} onChange={e => setOwnPrice(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Цена, ₽')} className="flex-1 h-11 px-4 rounded-[14px] bg-[var(--track)] text-[13px] outline-none" />
            <input value={ownPhone} onChange={e => setOwnPhone(e.target.value)} inputMode="tel" placeholder={t('Телефон')} className="flex-1 h-11 px-4 rounded-[14px] bg-[var(--track)] text-[13px] outline-none" />
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
              <button onClick={() => void guard(async () => setInviteLink(await inviteExternal(s.id)))} className="press mt-3 w-full py-3 rounded-[16px] grad text-[var(--on-grad)] text-[12.5px] font-bold">{t('Создать ссылку-приглашение')}</button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 mt-3">
          {/* У своего подрядчика идентификатора каталога нет: тогда ведём в
              список чатов, где его переписка отдельной строкой. */}
          <button onClick={() => void (async () => nav(await chatRouteForVendor(s.vendorId)))()} className="press card-s py-3.5 text-[13px] font-semibold">{t('Написать')}</button>
          <button disabled={!s.dealId} onClick={() => nav(`/deal/${s.dealId}`)} className="press card-s py-3.5 text-[13px] font-semibold disabled:opacity-50">{t('Сделка')}</button>
          <button onClick={() => nav(`/search/${s.categoryId}`)} className="press card-s py-3.5 text-[13px] font-semibold">{t('Заменить')}</button>
          {confirmCancel ? (
            <button onClick={() => void guard(async () => {
              /* У своего подрядчика удаление, а не отмена: только оно гасит
                 выданную ему ссылку-приглашение. */
              await (s.external ? removeExternalVendor(s.id) : cancelBooking(s.id))
              nav('/wedding')
            })} className="press card-s py-3.5 text-[13px] font-bold text-white" style={{ background: '#9B6A6A' }}>{t('Точно отменить?')}</button>
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
            <button key={String(l)} onClick={() => void (async () => nav(to ? String(to) : await chatRouteForVendor(s.vendorId)))()} className={cn('press w-full flex items-center gap-3 py-3 text-left', i !== 2 && 'border-b border-[var(--track)]')}>
              <Tile icon={String(ic)} tile={String(tile)} size={34} />
              <span className="flex-1 text-[12px] font-medium">{l}</span>
            </button>
          ))}
        </div>
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
export function Budget() {
  const { weddingId } = useStore()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [cat, setCat] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  /*
   * Бюджет считает сервер, а не браузер.
   *
   * Он знает то, чего фронт знать не может: суммы сделок, внесённые авансы и
   * оплаты. Локальный расчёт из цен слотов был единственно возможным без
   * сервера, но повторяет его лишь до первой оплаты — дальше «потрачено»
   * расходится с тем, что реально ушло подрядчикам.
   */
  const q = useApi(() => weddingId ? getBudget(weddingId) : Promise.resolve(null), [weddingId])
  const server = q.data
  const budgetTotal = server?.total?.amount ?? 0
  /* Без ответа сервера показываем пусто, а не мок: подстановка мок-бюджета
     означала бы, что человек без свадьбы видит чужие 677 000 ₽ и верит им. */
  const cats = (server?.categories ?? []).map(c => ({
    id: c.id ?? '',
    name: c.title ?? '',
    amount: c.fromSlots ?? 0,
    limit: c.planned?.amount ?? 0,
    color: c.color ?? 'var(--lav)',
    /* `live` в контракте — имена забронированной команды через разделитель,
       а не флаг: экран показывает их подписью «из команды». */
    live: c.live ?? undefined,
    items: (c.items ?? []).map(it => ({
      id: it.id ?? '',
      title: it.title ?? '',
      amount: it.amount?.amount ?? 0,
      custom: !!it.custom,
    })),
  }))
  /* Потрачено берём у сервера целиком: свои статьи он уже учёл. Раньше к
     серверной сумме прибавлялся локальный список `tt_budget_custom`, и одна и
     та же статья считалась дважды, как только доезжала на сервер. */
  const total = server?.spent?.amount ?? 0
  const spentPct = pct(total, budgetTotal)
  /* Резерв на непредвиденное считает сервер — 10% от общего бюджета (План
     ч. 283). Доля на клиенте разошлась бы с серверной на первой правке. */
  const reserve = server?.reserve?.amount ?? 0

  const write = async (id: string, fn: () => Promise<unknown>) => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — бюджет живёт в ней')); return }
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }
  const add = () => void write('new', async () => {
    const rubles = parseInt(amount.replace(/\D/g, ''), 10)
    const categoryId = cat || cats[0]?.id
    if (!name.trim() || !rubles || !categoryId) return
    // поле «Сумма, ₽» — рубли, на сервер уходят копейки
    await addBudgetItem(weddingId!, name.trim(), rub(rubles), categoryId)
    setName(''); setAmount(''); setAdding(false)
  })
  const removeItem = (id: string) => void write(id, () => deleteBudgetItem(weddingId!, id))

  return (
    <div className="pb-28">
      <TopBar back title={t('Бюджет')} sub={t('Распределение средств')} />
      <AsyncState q={q} forbiddenText={t('Бюджет ведёт пара — у вашей роли к нему доступа нет.')} />
      <div className="px-5 mt-3">
        {/* Сводка — только когда бюджет пришёл. Без ответа здесь стояло
            «0 ₽ · 0% · из 0 ₽ запланировано», и это не «пусто», а
            «неизвестно»: такой экран пара читает как «денег не осталось». */}
        {ready(q) && (
        <div className="card p-5">
          <div className="flex justify-between items-end">
            <span className="text-[30px] font-extrabold tracking-tight tabular">{fmt(total)}</span>
            <span className="text-[var(--rose-deep)] font-bold">{spentPct}%</span>
          </div>
          <p className="text-[11.5px] text-[var(--soft)] mt-1">{t('из')} {fmt(budgetTotal)} {t('запланировано · осталось')} {fmt(Math.max(0, budgetTotal - total))}</p>
          <div className="mt-3"><Bar pct={spentPct} /></div>
          {reserve > 0 && (
            /* Отдельной строкой, а не категорией: категории делят сто процентов
               между собой, и резерв внутри них означал бы, что часть сметы
               просто уменьшили. */
            <div className="flex justify-between items-center mt-3 pt-3 border-t border-[var(--track)]">
              <span className="text-[11.5px] text-[var(--soft)]">🛟 {t('Резерв на непредвиденное (10%)')}</span>
              <b className="text-[12.5px] tabular">{fmt(reserve)}</b>
            </div>
          )}
          {reserve > 0 && total > budgetTotal - reserve && (
            <p className="text-[10.5px] text-[var(--rose-ink)] mt-1.5">{t('Обязательства уже съели резерв — на неожиданности запаса нет')}</p>
          )}
          <div className="mt-4 space-y-4">
            {cats.map(b => (
              <div key={b.id}>
                <div className="flex justify-between text-[12.5px] items-center">
                  <span className="flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: b.color }} />{b.name}{b.live && <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('из команды')}</span>}</span>
                  <b className="tabular">{thousands(b.amount)}{t('К')}<span className="text-[var(--soft)] font-normal text-[10.5px]">/ {thousands(b.limit)}{t('К')}</span></b>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--track)] mt-1.5 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct(b.amount, b.limit)}%`, background: b.color }} />
                </div>
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
        {(() => {
          const tight = cats.find(b => b.limit > 0 && b.amount / b.limit >= 0.8)
          if (!tight) return null
          return <div className="mt-3.5"><AiTip text={`«${tight.name}»${t(' — ')}${pct(tight.amount, tight.limit)}${t('% лимита. Проверьте, всё ли учтено, прежде чем добавлять расходы сюда.')}`} /></div>
        })()}

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

        {err && <p className="text-[12px] text-[var(--rose-ink)] mt-3.5">{err}</p>}

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
export function Checklist() {
  const { weddingId, weddingDate } = useStore()
  const [period, setPeriod] = useState('9')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  /* Чек-лист приходит с сервера: он собирается там при создании свадьбы вместе
     с мозаикой и таймингом, одной транзакцией. Локальные `tt_tasks_extra` и
     `tt_tasks_done` были заменой этому, пока сервера не было. */
  const q = useApi(() => weddingId ? getTasks(weddingId) : Promise.resolve([]), [weddingId])
  /* Пока запись идёт, строка не отзывается на повторные нажатия: два быстрых
     тапа по галочке — это две записи, и вторая отменяла бы первую. */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  /* Поля контракта опциональны — приводим один раз здесь, чтобы дальше по
     экрану не тащить `?? ''` в каждом сравнении. */
  /* Срок считает сервер от даты свадьбы. Пока даты нет, срока нет ни у одной
     задачи — и это честнее выдуманного «через месяц». Признака срочности в
     контракте по-прежнему нет: цветной точки на строке не будет. */
  const allTasks = (q.data ?? []).map(x => ({
    id: x.id ?? '', title: x.title ?? '', period: x.period ?? '', done: !!x.done, custom: !!x.custom,
    due: x.due ?? null,
  }))
  const list = allTasks.filter(t => t.period === period)
  const done = allTasks.filter(t => t.done).map(t => t.id)

  /* Галочка — общая на пару: её ставит один, а видят оба. Поэтому она едет на
     сервер, а не в `tt_tasks_done` на этом телефоне, и список перечитывается
     ответом сервера, а не подкручивается на месте. */
  const write = async (fn: () => Promise<unknown>, id: string) => {
    /* Без свадьбы записывать некуда — и молчать об этом нельзя: кнопка, которая
       ничего не делает и ничего не говорит, читается как поломка. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — задачи живут в ней')); return }
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }
  const toggle = (id: string, isDone: boolean) => void write(() => setTaskDone(weddingId!, id, !isDone), id)
  /* Удалить можно только свою задачу: шаблонные сервер удалять не даёт, и
     крестика у них нет. */
  const removeTask = (id: string) => void write(async () => {
    await deleteTask(weddingId!, id)
    setConfirmDel(null)
  }, id)
  const addTask = () => void write(async () => {
    if (!title.trim()) return
    await addTaskApi(weddingId!, title.trim(), period)
    setTitle(''); setAdding(false)
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
        <button onClick={() => setAdding(true)} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{t('+ Задача')}</button>
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
              <button onClick={() => setPeriod(nextTask.period)} className="press mt-2 w-full text-left bg-[var(--rose-soft)] rounded-xl px-3 py-2">
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
        {[['9', t('За 9 мес')], ['6', t('За 6 мес')], ['3', t('За 3 мес')], ['1', t('За 1 мес')]].map(([id, l]) => (
          <button key={id} onClick={() => setPeriod(id)} className={cn('press px-4 py-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap', period === id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)] text-[var(--soft)]')} style={{ boxShadow: 'var(--shadow)' }}>{l}</button>
        ))}
      </div>
      <div className="px-5 mt-4">
        {adding && (
          <div className="card p-4 mb-3.5 fade-up">
            <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()}
              placeholder={t('Новая задача…')} autoFocus className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setAdding(false)} className="press flex-1 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button disabled={busyId === 'new'} onClick={addTask} className="press flex-1 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{busyId === 'new' ? t('Сохраняем…') : t('Добавить')}</button>
            </div>
          </div>
        )}
        <div className="card px-4 py-1.5">
          {list.map((task, i) => {
            const isDone = done.includes(task.id)
            return (
              <div key={task.id} className={cn('flex items-center gap-1', i !== list.length - 1 && 'border-b border-[var(--track)]')}>
                <button disabled={busyId === task.id} onClick={() => toggle(task.id, isDone)} className="flex-1 flex items-center gap-3 py-3.5 text-left disabled:opacity-60">
                  <span className={cn('w-[26px] h-[26px] rounded-[9px] flex items-center justify-center text-[12px] shrink-0 transition-all',
                    isDone ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : 'bg-[var(--card)] border-[1.5px] border-[#E8DED4] text-[var(--rose-deep)] font-bold text-[11px]')}>
                    {isDone ? '✓' : i + 1}
                  </span>
                  <span className={cn('flex-1 text-[13px]', isDone && 'text-[var(--soft)] line-through')}>{task.title}</span>
                  {/* Точка «важный срок» убрана: признака срочности в контракте
                      нет, и все точки были одного цвета при подписи о двух. */}
                  {task.due && <span className="text-[10.5px] text-[var(--soft)] tabular shrink-0">{shortWeddingDate(task.due)}</span>}
                </button>
                {/* Крестик — отдельной кнопкой рядом, а не внутри строки:
                    кнопка внутри кнопки невалидна и нажимается не везде. */}
                {task.custom && (
                  confirmDel === task.id
                    ? <button disabled={busyId === task.id} onClick={() => removeTask(task.id)} className="press text-[9px] font-bold px-2 py-1 rounded-full bg-[#A36666] text-white shrink-0 disabled:opacity-50">{t('Удалить?')}</button>
                    : <button onClick={() => setConfirmDel(task.id)} className="press text-[var(--soft)] text-[13px] px-1.5 shrink-0" aria-label={t('Удалить задачу')}>×</button>
                )}
              </div>
            )
          })}
        </div>
        {err && <p className="text-[12px] text-[var(--rose-ink)] text-center mt-3">{err}</p>}
      </div>
    </div>
  )
}

/*
 * Часы и минуты блока тайминга в часовом поясе свадьбы.
 *
 * Прежняя версия брала `toISOString().slice(11, 16)` — то есть UTC. Церемония
 * в 13:00 в Уфе показывалась как 08:00, ровно на разницу поясов. Пояс берётся
 * у свадьбы, а не у зрителя: пара может смотреть тайминг из другого города,
 * а координатор — из третьего, но час на площадке один.
 */
function formatTime(iso: string, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false }).format(new Date(iso))
  } catch {
    /* Неизвестный пояс не должен ронять экран: показываем по месту зрителя. */
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
  }
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
  /* Черновик автоплана: показан, но ещё не применён. */
  const [draft, setDraft] = useState<TimelineDraft[] | null>(null)

  /* Тайминг с сервера. Раньше он жил в `useState` и терялся при перезагрузке:
     добавленное событие исчезало вместе с вкладкой (единственный экран, где
     это было так). */
  const q = useApi(() => weddingId ? getTimeline(weddingId) : Promise.resolve([]), [weddingId])
  /* Часовой пояс места свадьбы, а не зрителя: по нему живёт день X. Пара может
     смотреть тайминг из другого города, и «13:00» должно означать 13:00 на
     площадке. */
  const wq = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const tz = wq.data?.tz
  const raw = q.data ?? []
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
  }))

  /*
   * Тайминг сохраняется списком целиком: отдельного пути «добавить блок»
   * контракт не знает. Значит, отправлять надо всё, что пришло, — пропущенный
   * блок сервер понял бы как удалённый.
   */
  const save = (next: TimelineDraft[]) => void (async () => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — тайминг живёт в ней')); return }
    setBusy(true)
    setErr(null)
    try { await putTimeline(weddingId, next); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  const asDraft = (): TimelineDraft[] => raw.map(e => ({
    id: e.id,
    name: e.name ?? '',
    startsAt: e.startsAt ?? '',
    ...(e.endsAt ? { endsAt: e.endsAt } : {}),
    ...(e.who ? { who: e.who } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.icon ? { icon: e.icon } : {}),
  }))

  const addEvent = () => {
    if (!name.trim() || !weddingDate) return
    const startsAt = isoAtWeddingTime(weddingDate, from, tz)
    if (!startsAt) { setErr(t('Укажите время в формате 19:00')); return }
    const endsAt = till ? isoAtWeddingTime(weddingDate, till, tz) : null
    save([...asDraft(), { name: name.trim(), startsAt, ...(endsAt ? { endsAt } : {}) }])
    setName(''); setFrom(''); setTill(''); setEditing(false)
  }

  const removeEvent = (id: string) => save(asDraft().filter(e => e.id !== id))

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
      setConflicts(res?.conflicts ?? [])
      setDraft((res?.events ?? []).map(e => ({
        id: e.id,
        name: e.name ?? '',
        startsAt: e.startsAt ?? '',
        ...(e.endsAt ? { endsAt: e.endsAt } : {}),
        ...(e.who ? { who: e.who } : {}),
        ...(e.location ? { location: e.location } : {}),
        ...(e.icon ? { icon: e.icon } : {}),
      })))
    } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  const applyDraft = () => {
    if (!draft) return
    save(draft)
    setDraft(null)
    setConflicts(null)
  }

  return (
    <div className="pb-28">
      <TopBar back title={t('День свадьбы')} sub={weddingDate ? `${t('Расписание ')}${formatWeddingDate(weddingDate)}` : t('Расписание дня · полный сценарий')} right={
        <button onClick={() => setEditing(!editing)} className="press h-10 px-4 rounded-full bg-[var(--card)] text-[12px] font-semibold text-[var(--rose-deep)]" style={{ boxShadow: 'var(--shadow)' }}>{editing ? t('Готово') : t('Править')}</button>
      } />
      <AsyncState q={q} />
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
            {!weddingDate && <p className="text-[11px] text-[var(--soft)] mt-2">{t('Сначала выберите дату свадьбы — без неё у события нет дня.')}</p>}
            <button disabled={busy || !weddingDate} onClick={addEvent} className="press w-full h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold mt-3 disabled:opacity-50">{busy ? t('Сохраняем…') : t('Добавить в тайминг')}</button>
          </div>
        )}
        {err && <p className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
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
            </div>
            {editing && (
              <button disabled={busy} onClick={() => removeEvent(e.id)} className="press text-[var(--rose-deep)] text-[14px] shrink-0 disabled:opacity-50" aria-label={t('Убрать из тайминга')}>×</button>
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
                  <button onClick={() => { setDraft(null); setConflicts(null) }} className="press flex-1 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
                  <button disabled={busy} onClick={applyDraft} className="press flex-1 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{t('Заменить тайминг')}</button>
                </div>
              </>
            ) : null}
          </div>
        )}
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
  tableId?: string | null
  /** Телефон вводит пара — по нему уходит SMS-напоминание молчащим. */
  phone?: string | null
  diet?: string | null
  dietNote?: string | null
  transfer?: string | null
}

/** Ровно десять цифр после +7 — так контракт описывает телефон. */
const PHONE_DIGITS = 10

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
  const q = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])

  /* Приводим ответ сервера к тому, что рисует экран: у него `plusOne` вместо
     `plus` и `pending` вместо `wait`. Подмены моком нет — пустой список это
     пустой список. */
  const list: GuestRow[] = useMemo(
    () => (q.data ?? []).map((g, i): GuestRow => ({
      id: g.id ?? String(i),
      name: g.name ?? '',
      status: g.status === 'yes' ? 'yes' : g.status === 'no' ? 'no' : 'pending',
      plus: !!g.plusOne,
      tableId: g.tableId,
      phone: g.phone,
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
  const [plus, setPlus] = useState(false)
  /* Телефон гостя — десять цифр после +7. Раньше ввести его было негде, и
     «Напомнить не ответившим» не находила ни одного адресата: сервер честно
     отвечал «без телефона» на каждого. */
  const [phone, setPhone] = useState('')
  const [phoneEdit, setPhoneEdit] = useState<string | null>(null)
  const [phoneDraft, setPhoneDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [reminded, setReminded] = useState<string | null>(null)

  const write = async (id: string, fn: () => Promise<unknown>) => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — гости живут в ней')); return }
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }
  const add = () => void write('new', async () => {
    if (!name.trim()) return
    await addGuest(weddingId!, { name: name.trim(), plusOne: plus, ...(phone.length === PHONE_DIGITS ? { phone: `+7${phone}` } : {}) })
    setName(''); setPlus(false); setPhone(''); setAdding(false)
  })
  /* Пустое поле стирает номер (`null`): контракт различает «не трогать» и «убрать». */
  const savePhone = (g: GuestRow) => void write(g.id, async () => {
    await patchGuest(weddingId!, g.id, { phone: phoneDraft.length === PHONE_DIGITS ? `+7${phoneDraft}` : null })
    setPhoneEdit(null)
  })
  const cycle = (g: GuestRow) => void write(g.id, () => patchGuest(weddingId!, g.id, { status: RSVP_NEXT[g.status] }))
  const remove = (g: GuestRow) => void write(g.id, async () => {
    await deleteGuest(weddingId!, g.id)
    setConfirmDel(null)
  })

  const yes = list.filter(g => g.status === 'yes').length
  // Считаем людей, а не записи: «Ольга и Денис» с +1 — это двое за столом
  // и две порции у кейтеринга. Иначе счётчики расходятся со сводкой ниже.
  const persons = (status: string) =>
    list.filter(g => g.status === status).reduce((a, g) => a + 1 + (g.plus ? 1 : 0), 0)
  const shown = filter === 'all' ? list : list.filter(g => g.status === filter)
  const waiting = list.filter(g => g.status === 'pending').length

  return (
    <div className="pb-28">
      {/* Числа появляются вместе с ответом сервера. «0 в списке · 0
          подтвердили» при отказе читается как «нам никто не ответил». */}
      <TopBar back title={t('Гости')} sub={ready(q) ? `${list.length}${t(' в списке · ')}${yes}${t(' подтвердили')}` : undefined} right={
        <div className="flex gap-2">
          <button onClick={() => setAdding(!adding)} className="press h-10 w-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Добавить гостя')}><Plus size={16} /></button>
          <button onClick={() => nav('/wedding/invites')} className="press h-10 px-4 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold flex items-center gap-1.5"><Send size={13} />{t('Пригласить')}</button>
        </div>
      } />
      <AsyncState q={q} />
      {adding && (
        <div className="px-5 mt-3 fade-up">
          <div className="card p-4 space-y-2.5">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder={t('Имя гостя или семьи')} className="w-full h-11 px-4 rounded-full bg-[var(--bg)] text-[13px] outline-none" />
            <div className="flex items-center gap-2 h-11 px-4 rounded-full bg-[var(--bg)]">
              <span className="text-[13px] text-[var(--soft)] tabular">+7</span>
              <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, PHONE_DIGITS))} onKeyDown={e => e.key === 'Enter' && add()} inputMode="tel" placeholder={t('Телефон — для SMS-напоминания (необязательно)')} className="flex-1 bg-transparent text-[13px] outline-none tabular" />
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPlus(!plus)} className={cn('press px-3.5 py-2 rounded-full text-[11.5px] font-semibold', plus ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)] text-[var(--soft)]')}>{t('с +1')}</button>
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
                g.status === 'yes' ? 'bg-[#A9BCA0]' : g.status === 'no' ? 'bg-[#C98A8A]' : 'bg-[var(--gold-soft)]')}>
                {g.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] block truncate">{g.name}</b>
                <span className="text-[10px] text-[var(--soft)]">{g.plus ? t('с +1') : t('один/одна')}</span>
                {/* Телефон — единственное, что пара вводит за гостя: по нему
                    уходит напоминание. Пустое поле стирает номер. */}
                {phoneEdit === g.id ? (
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[10px] text-[var(--soft)] tabular">+7</span>
                    <input autoFocus value={phoneDraft} onChange={e => setPhoneDraft(e.target.value.replace(/\D/g, '').slice(0, PHONE_DIGITS))} onKeyDown={e => e.key === 'Enter' && savePhone(g)} inputMode="tel" aria-label={t('Телефон гостя')} className="w-[118px] h-7 px-2 rounded-lg bg-[var(--bg)] text-[11px] outline-none tabular" />
                    <button disabled={busyId === g.id || (phoneDraft.length !== 0 && phoneDraft.length !== PHONE_DIGITS)} onClick={() => savePhone(g)} className="press text-[10px] font-bold text-[var(--sage-deep)] disabled:opacity-50">{t('Сохранить')}</button>
                    <button onClick={() => setPhoneEdit(null)} className="press text-[10px] text-[var(--soft)]">{t('Отмена')}</button>
                  </div>
                ) : (
                  <button onClick={() => { setPhoneEdit(g.id); setPhoneDraft((g.phone ?? '').replace(/^\+7/, '')) }} className="press block text-[10px] mt-0.5 text-[var(--sage-deep)] tabular">
                    {g.phone ?? t('+ телефон для напоминания')}
                  </button>
                )}
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
                <button disabled={busyId === g.id} onClick={() => remove(g)} className="press text-[9px] font-bold px-2.5 py-1 rounded-full bg-[#A36666] text-white disabled:opacity-50">{t('Удалить?')}</button>
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
            const csv = 'Имя;Статус;+1\n' + list.map(g => `${g.name};${g.status === 'yes' ? t('Придёт') : g.status === 'no' ? t('Не придёт') : t('Ждём')};${g.plus ? 'да' : 'нет'}`).join('\n')
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
            const seats = yesGuests.reduce((a, g) => a + 1 + (g.plus ? 1 : 0), 0)
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
                открытой ссылкой (новая ссылка увела бы за собой выбор гостя). */}
            <button disabled={busyId === 'remind'} onClick={() => void write('remind', async () => {
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
            </button>
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
  const q = useApi(() => weddingId ? getAlbum(weddingId) : Promise.resolve([]), [weddingId])
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
    /* Перечитываем в любом случае: если одобрение сорвалось на середине,
       часть кадров уже одобрена — экран, оставшийся на старых данных, покажет
       на модерации то, чего там больше нет. */
    try {
      for (const p of photos.filter(x => !x.approved)) await setPhotoApproved(weddingId, p.id ?? '', true)
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
export function Documents() {
  const nav = useNavigate()
  const { weddingId } = useStore()
  /* Список подписанных документов — с сервера; закрыт помощнику матрицей
     доступа, поэтому 403 здесь штатный ответ. Шаблоны договоров остаются
     локальными: это заготовки текста, а не данные свадьбы. */
  const q = useApi(() => weddingId ? getDocuments(weddingId) : Promise.resolve([]), [weddingId])
  return (
    <div className="pb-28">
      <TopBar back title={t('Документы')} sub={t('Договоры из шаблонов — за 2 минуты')} />
      <AsyncState q={q} forbiddenText={t('Документы ведёт пара — у вашей роли к ним доступа нет.')} />
      {ready(q) && (q.data ?? []).length > 0 && (
        <div className="px-5 mt-3">
          <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1">{t('Подписанные')}</span>
          <div className="space-y-2 mt-2">
            {(q.data ?? []).map((d, k) => (
              <div key={d.id ?? k} className="card-s p-3.5 flex items-center gap-3">
                <FileText size={15} className="text-[var(--sage-deep)] shrink-0" />
                <b className="text-[12.5px] flex-1 truncate">{d.templateCode ?? t('Договор')}</b>
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
              <b className="text-[13.5px] block">{c.name}</b>
              <span className="text-[10.5px] text-[var(--soft)]">{c.desc}</span>
            </div>
            <span className="text-[10px] font-bold px-3 py-1.5 rounded-full grad text-[var(--on-grad)] shrink-0">{t('Создать')}</span>
          </button>
        ))}
      </div>

      {/* Здесь стоял второй, выдуманный список «Подписанные»: «Договор с
          фотографом · подписан обеими сторонами · PDF» и «Аренда усадьбы
          «Липовый сад»». Нажатие скачивало .doc, в котором заказчиком значились
          «Алина Козлова и Тимур Волков» — чужие имена в документе, который
          человек мог отнести подрядчику. Настоящий список подписанных стоит
          выше и приходит с сервера. */}

      <p className="px-6 mt-4 text-[10.5px] text-[var(--soft)] leading-relaxed text-center">
        {t('Шаблоны носят информационный характер и не заменяют консультацию юриста. Данные подставляются автоматически из сделки.')}
      </p>
    </div>
  )
}
