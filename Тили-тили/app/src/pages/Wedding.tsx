import { createElement, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Wallet, ListChecks, Clock3, Users, FileText, Plus, Send, Download, Armchair, Heart, NotebookPen, Wine, Gift, Camera, Bus, UtensilsCrossed, ShieldCheck } from 'lucide-react'
import { budgetItems, couple, guests, contractTemplates, fmt, initialAlbum, type Guest } from '@/lib/data'
import { useApi } from '@/lib/api/useApi'
import { formatWeddingDate } from '@/lib/weddingDate'
import { AsyncState, ready } from '@/components/AsyncState'
import { getBudget, getDocuments, getGuests, getTasks, getTimeline } from '@/lib/api/weddingData'
import { rub } from '@/lib/money'
import { AiTip, Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { budgetRows, committedSlots, committedTotal, spentTotal, type BudgetRow } from '@/lib/budget'
import { useBusy } from '@/lib/useBusy'
import { catIcon } from '@/lib/icons'
import { cn, copyText } from '@/lib/utils'
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
  const { slots } = useStore()
  const booked = slots.filter(s => s.state === 'booked').length
  const progress = slots.filter(s => s.state !== 'empty').length

  return (
    <div className="pb-28">
      <TopBar title={t('Наш день')} sub={`${booked}${t(' забронировано · ')}${progress - booked}${t(' в работе · ')}${slots.length - progress}${t(' пустых')}`} />
      <WeddingNav />
      <div className="px-5 mt-3.5">
        <button onClick={() => nav('/dayx')} className="press w-full rounded-[22px] p-4 flex items-center gap-3 text-left text-white" style={{ background: 'linear-gradient(120deg,#3A322B,#1E1A16)', boxShadow: 'var(--shadow)' }}>
          <span className="text-[22px]">🎬</span>
          <span className="flex-1">
            <b className="text-[13px] block">{t('Режим дня X')}</b>
            <span className="text-[10px] text-white/60">{t('Live-тайминг, задержки, план Б и SOS')}</span>
          </span>
          <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--card)]/15">{t('демо')}</span>
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
        <div className="mt-4"><AiTip text={t('Пустой слот «DJ» и «Декоратор» — подобрать свободных на 14.06 под ваш бюджет?')} onPress={() => nav('/search/dj')} /></div>
      </div>

      <div className="px-5">
        <SectionHead title={t('Сводка')} />
        <div className="card p-5 mt-2">
          <div className="flex justify-between text-[12px] mb-1.5"><span className="text-[var(--soft)]">{t('Команда собрана')}</span><b>{booked} из {slots.length}</b></div>
          <Bar pct={(booked / slots.length) * 100} />
          <div className="flex justify-between text-[12px] mb-1.5 mt-4"><span className="text-[var(--soft)]">{t('Забронировано на сумму')}</span><b className="tabular">{fmt(committedTotal(slots))}</b></div>
          <Bar pct={Math.round((committedTotal(slots) / couple.budgetTotal) * 100)} />
        </div>
      </div>
    </div>
  )
}

/* Деталь слота */
export function SlotDetail() {
  const nav = useNavigate()
  const { slots, cancelBooking, bookExternal, inviteExternal } = useStore()
  const id = location.pathname.split('/').pop()
  const s = slots.find(x => x.id === id) ?? slots[0]
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [ownOpen, setOwnOpen] = useState(false)
  const [ownName, setOwnName] = useState('')
  const [ownPrice, setOwnPrice] = useState('')
  const [ownPhone, setOwnPhone] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  const [ownBusy, runOwn] = useBusy()
  const addOwn = () => runOwn(() => {
    if (!ownName.trim() || !Number(ownPrice)) return
    // поле «Цена, ₽» — рубли, в состоянии храним копейки
    bookExternal(s.id, ownName.trim(), rub(Number(ownPrice)), ownPhone.trim() || undefined)
    setOwnOpen(false); setOwnName(''); setOwnPrice(''); setOwnPhone('')
  })
  const inviteLink = `tili-tili.ru/join/ТИЛИ-СВОЙ-${s.id.toUpperCase()}`

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
            {s.invited ? (
              <div className="flex items-center gap-2 mt-3">
                <code className="flex-1 text-[10.5px] bg-[var(--track)] rounded-[12px] px-3 py-2.5 truncate">{inviteLink}</code>
                <button onClick={() => { copyText(inviteLink); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500) }} className="press text-[11px] font-bold px-3.5 py-2.5 rounded-[12px] grad text-[var(--on-grad)]">{linkCopied ? '✓' : t('Копия')}</button>
              </div>
            ) : (
              <button onClick={() => inviteExternal(s.id)} className="press mt-3 w-full py-3 rounded-[16px] grad text-[var(--on-grad)] text-[12.5px] font-bold">{t('Создать ссылку-приглашение')}</button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 mt-3">
          <button onClick={() => nav('/us/chats/ch1')} className="press card-s py-3.5 text-[13px] font-semibold">{t('Написать')}</button>
          <button onClick={() => nav('/deal')} className="press card-s py-3.5 text-[13px] font-semibold">{t('Сделка')}</button>
          <button onClick={() => nav(`/search/${s.categoryId}`)} className="press card-s py-3.5 text-[13px] font-semibold">{t('Заменить')}</button>
          {confirmCancel ? (
            <button onClick={() => { cancelBooking(s.id); nav('/wedding') }} className="press card-s py-3.5 text-[13px] font-bold text-white" style={{ background: '#9B6A6A' }}>{t('Точно отменить?')}</button>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="press card-s py-3.5 text-[13px] font-semibold text-[var(--rose-deep)]">{s.external ? t('Удалить подрядчика') : t('Отменить бронь')}</button>
          )}
        </div>

        {s.price && (
          <div className="card p-4 mt-3.5">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('График платежей')}</span>
            {[
              [t('Аванс · при бронировании'), Math.round(s.price * 0.5), true],
              [t('Доплата · за 7 дней до даты'), s.price - Math.round(s.price * 0.5), false],
            ].map(([l, v, paid]) => (
              <div key={String(l)} className="flex items-center justify-between mt-3">
                <span className="text-[12px] text-[var(--ink2)]">{l}</span>
                <span className="flex items-center gap-2">
                  <b className="text-[12.5px] tabular">{fmt(Number(v))}</b>
                  <span className={cn('text-[8.5px] font-bold px-2 py-1 rounded-full', paid ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : 'bg-[var(--honey)] text-[var(--honey-ink)]')}>{paid ? t('✓ Оплачен') : t('Ожидает')}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="card px-4 py-1.5 mt-3.5">
          {[
            ['📄', 'bg-[var(--blue)]', t('Договор подписан обеими сторонами'), '/wedding/documents'],
            ['🗓', 'bg-[var(--honey)]', t('Дата 14.06 закрыта у подрядчика'), '/wedding/timeline'],
            ['💬', 'bg-[var(--sage-soft)]', t('Чат по сделке — 3 новых сообщения'), '/us/chats/ch1'],
          ].map(([ic, tile, l, to], i) => (
            <button key={String(l)} onClick={() => nav(String(to))} className={cn('press w-full flex items-center gap-3 py-3 text-left', i !== 2 && 'border-b border-[var(--track)]')}>
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
  const { slots, weddingId } = useStore()
  const booked = committedSlots(slots)
  const [custom, setCustom] = usePersist<BudgetRow[]>('tt_budget_custom', [])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const add = () => {
    const a = parseInt(amount.replace(/\D/g, ''), 10)
    if (!name.trim() || !a) return
    setCustom(it => [...it, { name: name.trim(), amount: rub(a), limit: rub(Math.ceil(a * 1.2)), color: 'var(--lav)' }])
    setName(''); setAmount(''); setAdding(false)
  }

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
  const budgetTotal = server?.total?.amount ?? couple.budgetTotal
  const items: BudgetRow[] = server
    ? [
        ...(server.categories ?? []).map(c => ({
          name: c.title ?? '',
          amount: c.fromSlots ?? 0,
          limit: c.planned?.amount || 1,
          color: c.color ?? 'var(--lav)',
          /* `live` в контракте — имена забронированной команды через
             разделитель, а не флаг: экран показывает их подписью «из команды». */
          live: c.live ?? undefined,
        })),
        ...custom,
      ]
    : budgetRows(slots, custom)
  const total = server ? (server.spent?.amount ?? 0) + custom.reduce((a, c) => a + c.amount, 0) : spentTotal(slots, custom)
  const pct = budgetTotal ? Math.round((total / budgetTotal) * 100) : 0
  // Умный бюджет: fact (оплаченные авансы) vs предстоящие платежи + резерв 10%
  const paidFact = Math.round(booked.reduce((a, s) => a + (s.price ?? 0), 0) * 0.5)
  const upcoming = booked.map(s => ({ vendor: s.vendor ?? s.label, amount: Math.round((s.price ?? 0) * 0.5) }))
  const upcomingTotal = upcoming.reduce((a, u) => a + u.amount, 0)
  const reserve = Math.round(budgetTotal * 0.1)
  const freeAfterReserve = budgetTotal - total - reserve
  return (
    <div className="pb-28">
      <TopBar back title={t('Бюджет')} sub={t('Распределение средств')} />
      <AsyncState q={q} forbiddenText={t('Бюджет ведёт пара — у вашей роли к нему доступа нет.')} />
      <div className="px-5 mt-3">
        <div className="card p-5">
          <div className="flex justify-between items-end">
            <span className="text-[30px] font-extrabold tracking-tight tabular">{fmt(total)}</span>
            <span className="text-[var(--rose-deep)] font-bold">{pct}%</span>
          </div>
          <p className="text-[11.5px] text-[var(--soft)] mt-1">{t('из')} {fmt(budgetTotal)} {t('запланировано · осталось')} {fmt(Math.max(0, budgetTotal - total))}</p>
          <div className="mt-3"><Bar pct={pct} /></div>
          <div className="mt-4 space-y-4">
            {items.map((b, bi) => {
              const p = Math.round((b.amount / b.limit) * 100)
              return (
                <div key={b.name}>
                  <div className="flex justify-between text-[12.5px] items-center">
                    <span className="flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: b.color }} />{b.name}{b.live && <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('из команды')}</span>}</span>
                    <b className="tabular">{thousands(b.amount)}{t('К')}<span className="text-[var(--soft)] font-normal text-[10.5px]">/ {thousands(b.limit)}{t('К')}</span>{bi >= budgetItems.length && <button onClick={() => setCustom(c => c.filter((_, ci) => ci !== bi - budgetItems.length))} className="press text-[var(--rose-deep)] text-[12px] ml-1.5" aria-label={t('Удалить статью')}>×</button>}</b>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--track)] mt-1.5 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${p}%`, background: b.color }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {/* Подсказка строится из настоящих чисел, а не вписана в разметку.
            Здесь стояло «Площадка и кейтеринг на 86% лимита. Зафиксируйте меню
            до 1 марта» — текст с процентом и датой, не связанными ни с чем.
            Показываем только когда есть о чём говорить: категория, которая
            реально подошла к своему лимиту. */}
        {(() => {
          const tight = items.find(b => b.limit > 0 && b.amount / b.limit >= 0.8)
          if (!tight) return null
          const pctOf = Math.round((tight.amount / tight.limit) * 100)
          return <div className="mt-3.5"><AiTip text={`«${tight.name}»${t(' — ')}${pctOf}${t('% лимита. Проверьте, всё ли учтено, прежде чем добавлять расходы сюда.')}`} /></div>
        })()}

        {/* Fact: оплачено · предстоит · резерв */}
        <div className="card p-4 mt-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Деньги: факт и план')}</span>
            <span className={cn('text-[9.5px] font-bold px-2 py-1 rounded-full', freeAfterReserve >= 0 ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : 'bg-[var(--rose-soft)] text-[var(--rose-ink)]')}>
              {freeAfterReserve >= 0 ? `${t('свободно')} ${fmt(Math.max(0, freeAfterReserve))}` : t('бюджет превышен')}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3 text-center">
            <div className="bg-[var(--bg)] rounded-xl py-2.5"><b className="text-[13px] tabular text-[var(--sage-deep)]">{fmt(paidFact)}</b><p className="text-[9px] text-[var(--soft)] mt-0.5">{t('оплачено (авансы)')}</p></div>
            <div className="bg-[var(--bg)] rounded-xl py-2.5"><b className="text-[13px] tabular text-[var(--honey-deep)]">{fmt(upcomingTotal)}</b><p className="text-[9px] text-[var(--soft)] mt-0.5">{t('предстоит доплат')}</p></div>
            <div className="bg-[var(--bg)] rounded-xl py-2.5"><b className="text-[13px] tabular">{fmt(reserve)}</b><p className="text-[9px] text-[var(--soft)] mt-0.5">{t('резерв 10%')}</p></div>
          </div>
          {upcoming.length > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--track)] space-y-2">
              {upcoming.slice(0, 3).map(u => (
                <div key={u.vendor} className="flex items-center justify-between">
                  <span className="text-[12px] font-medium truncate">{u.vendor} · {t('доплата')}</span>
                  <span className="text-right shrink-0"><b className="text-[12.5px] tabular">{fmt(u.amount)}</b><span className="text-[9.5px] text-[var(--honey-deep)] font-semibold block">{t('за 7 дней до даты')}</span></span>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-[var(--soft2)] mt-3 leading-relaxed">{t('Резерв 10% не трогаем: он закрывает форс-мажоры (горячая замена, +2 гостя, доп. час фотографа).')}</p>
        </div>

        {adding ? (
          <div className="card p-4 mt-3.5 fade-up">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('Статья расхода (например, «Фейерверк»)')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" placeholder={t('Сумма, ₽')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] mt-2.5 tabular" />
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setAdding(false)} className="press flex-1 h-[44px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button onClick={add} className="press flex-1 h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Добавить')}</button>
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
  /* Поля контракта опциональны — приводим один раз здесь, чтобы дальше по
     экрану не тащить `?? ''` в каждом сравнении. */
  const allTasks = (q.data ?? []).map(x => ({
    id: x.id ?? '', title: x.title ?? '', period: x.period ?? '', done: !!x.done, custom: !!x.custom,
    /* Срок и признак срочности сервер не отдаёт: в контракте у задачи только
       id, title, period, done и custom. Раньше они брались из мока — теперь
       их просто нет, и выдумывать их здесь нельзя. */
    due: '', urgent: false,
  }))
  const list = allTasks.filter(t => t.period === period)
  /* Отметка «сделано» — это запись, а не чтение: она едет на сервер на этапе 6.
     Пока держим её локально поверх серверного списка, иначе галочка перестала
     бы ставиться вовсе. */
  const [doneLocal, setDoneLocal] = usePersist<string[]>('tt_tasks_done', [])
  const done = [...doneLocal, ...allTasks.filter(t => t.done).map(t => t.id)]
  const toggle = (id: string) => setDoneLocal(d => d.includes(id) ? d.filter(x => x !== id) : [...d, id])
  const addTask = () => {
    if (!title.trim()) return
    setTitle(''); setAdding(false)
  }
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
            {!nextTask && <p className="text-[12px] font-semibold text-[var(--sage-deep)] mt-2">{t('Всё сделано — вы полностью готовы ✓')}</p>}
          </div>
        </div>
        <div className="card-s px-4 py-3 flex items-center gap-3">
          <b className="text-[12px] whitespace-nowrap">{done.length} из {allTasks.length}</b>
          <div className="flex-1 h-1.5 rounded-full bg-[var(--track)] overflow-hidden">
            <div className="h-full grad rounded-full transition-all duration-500" style={{ width: `${(done.length / allTasks.length) * 100}%` }} />
          </div>
          <span className="text-[10px] font-bold text-[var(--sage-deep)] tabular">{Math.round((done.length / allTasks.length) * 100)}%</span>
        </div>
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
              <button onClick={addTask} className="press flex-1 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Добавить')}</button>
            </div>
          </div>
        )}
        <div className="card px-4 py-1.5">
          {list.map((t, i) => {
            const isDone = done.includes(t.id)
            return (
              <button key={t.id} onClick={() => toggle(t.id)} className={cn('w-full flex items-center gap-3 py-3.5 text-left', i !== list.length - 1 && 'border-b border-[var(--track)]')}>
                <span className={cn('w-[26px] h-[26px] rounded-[9px] flex items-center justify-center text-[12px] shrink-0 transition-all',
                  isDone ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : 'bg-[var(--card)] border-[1.5px] border-[#E8DED4] text-[var(--rose-deep)] font-bold text-[11px]')}>
                  {isDone ? '✓' : i + 1 + allTasks.filter(x => x.period === period && done.includes(x.id)).length}
                </span>
                <span className={cn('flex-1 text-[13px]', isDone && 'text-[var(--soft)] line-through')}>{t.title}</span>
                <i className={cn('w-2 h-2 rounded-full', t.urgent ? 'bg-[#C98A8A]' : 'bg-[#A9BCA0]')} />
                <span className="text-[10.5px] text-[var(--soft)]">{t.due}</span>
              </button>
            )
          })}
        </div>
        <p className="text-[10.5px] text-[var(--soft)] text-center mt-3">{t('● розовый — важный срок · ● зелёный — плановый')}</p>
      </div>
    </div>
  )
}

/* Тайминг дня */
export function Timeline() {
  const { weddingId, weddingDate } = useStore()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [time, setTime] = useState('')

  /* Тайминг с сервера. Раньше он жил в `useState` и терялся при перезагрузке:
     добавленное событие исчезало вместе с вкладкой (единственный экран, где
     это было так). */
  const q = useApi(() => weddingId ? getTimeline(weddingId) : Promise.resolve([]), [weddingId])
  const events = (q.data ?? []).map(e => ({
    id: e.id ?? '',
    /* Сервер отдаёт метку времени, экран показывает часы и минуты. Пустое
       время — норма: блок есть, час ещё не назначен. */
    time: e.startsAt ? new Date(e.startsAt).toISOString().slice(11, 16) : '—',
    name: e.name ?? '',
    loc: e.location ?? '',
    /* Иконки блока в контракте нет — ставим общую, а не выдумываем по названию. */
    icon: '📌',
    tile: 'bg-[var(--peach)]',
    who: e.who ?? '',
  }))
  const addEvent = () => {
    if (!name.trim() || !time.trim()) return
    setName(''); setTime(''); setEditing(false)
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
            <input value={time} onChange={e => setTime(e.target.value)} placeholder={t('Время (например, 19:00 — 19:10)')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)] mt-2.5" />
            <button onClick={addEvent} className="press w-full h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold mt-3">{t('Добавить в тайминг')}</button>
          </div>
        )}
        {events.map(e => (
          <div key={e.id} className="card-s p-4 flex gap-3 fade-up">
            <Tile icon={e.icon} tile={e.tile} size={42} />
            <div className="min-w-0">
              <b className="text-[13.5px]">{e.name}</b>
              <p className="text-[11px] text-[var(--soft)] mt-0.5">{e.loc}</p>
              <p className="text-[11px] text-[var(--rose-deep)] font-semibold mt-1 tabular">{e.time}</p>
              <p className="text-[10px] text-[var(--sage-deep)] mt-0.5">{e.who}</p>
            </div>
          </div>
        ))}
        <div className="mt-2"><AiTip text={t('Автоплан готов: конфликтов нет. План Б на дождь для церемонии — шатёр уже включён в аренду усадьбы.')} /></div>
        <button onClick={() => window.print()} className="press w-full card-s py-4 text-[13.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} />{t('Скачать PDF для координатора')}</button>
      </div>
    </div>
  )
}

/* Гости */
export function Guests() {
  const nav = useNavigate()
  const { weddingId } = useStore()
  /* Гости с сервера. Локальный список остаётся хранилищем правок до этапа 6:
     добавление и смена статуса пока не уезжают, но список уже не выдуманный. */
  const q = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  /*
   * Список — с сервера, правки — пока поверх него.
   *
   * Смена статуса и добавление гостя уезжают на сервер на этапе 6. До тех пор
   * держим их в `tt_guests` и накладываем на серверный список: иначе на этапе
   * чтения человек лишился бы уже работавшей возможности — статусы перестали
   * бы переживать перезагрузку.
   */
  const [local, setLocal] = usePersist<Guest[]>('tt_guests', [])
  /* Серверный список выводится при рендере, а не складывается в состояние
     через эффект: setState внутри эффекта даёт каскад перерисовок и запрещён
     линтом проекта. Форма гостя на сервере другая — статус называется
     `status` и принимает `pending` вместо `wait`, «стороны» жениха и невесты
     нет вовсе, стол строковый. Приводим к тому, что рисует экран. */
  const server: Guest[] = useMemo(
    () => (q.data ?? guests).map((g, i): Guest => ({
      id: (g as { id?: string }).id ?? String(i),
      name: (g as { name?: string }).name ?? '',
      status: (g as { status?: string }).status === 'yes' ? 'yes' : (g as { status?: string }).status === 'no' ? 'no' : 'pending',
      plus: !!(g as { plusOne?: boolean; plus?: boolean }).plusOne || !!(g as { plus?: boolean }).plus,
    })),
    [q.data],
  )
  const byId = new Map(server.map(g => [g.id, g]))
  for (const g of local) byId.set(g.id, g)
  const list = [...byId.values()]
  const setList = (fn: (prev: Guest[]) => Guest[]) => setLocal(fn(list))
  const [extras, setExtras] = usePersist<Record<string, { diet?: string; transfer?: boolean }>>('tt_rsvp', {})
  const [reminded, setReminded] = useState(false)
  const [filter, setFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [plus, setPlus] = useState(false)
  const add = () => {
    if (!name.trim()) return
    setList(l => [...l, { id: `g${Date.now()}`, name: name.trim(), status: 'pending' as const, plus }])
    setName(''); setPlus(false); setAdding(false)
  }
  const yes = list.filter(g => g.status === 'yes').length
  // Считаем людей, а не записи: «Ольга и Денис» с +1 — это двое за столом
  // и две порции у кейтеринга. Иначе счётчики расходятся со сводкой ниже.
  const persons = (status: string) =>
    list.filter(g => g.status === status).reduce((a, g) => a + 1 + (g.plus ? 1 : 0), 0)
  const shown = filter === 'all' ? list : list.filter(g => g.status === filter)
  return (
    <div className="pb-28">
      <TopBar back title={t('Гости')} sub={`${list.length}${t(' в списке · ')}${yes}${t(' подтвердили')}`} right={
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
            <div className="flex items-center gap-2">
              <button onClick={() => setPlus(!plus)} className={cn('press px-3.5 py-2 rounded-full text-[11.5px] font-semibold', plus ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)] text-[var(--soft)]')}>{t('с +1')}</button>
              <div className="flex-1" />
              <button onClick={() => setAdding(false)} className="press px-4 py-2 text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button onClick={add} className="press px-5 py-2 rounded-full grad text-[var(--on-grad)] text-[12px] font-bold">{t('Добавить')}</button>
            </div>
          </div>
        </div>
      )}
      <div className="px-5 mt-3 grid grid-cols-3 gap-2.5">
        {[[String(persons('yes')), t('придут'), 'text-[var(--sage-deep)]'], [String(persons('pending')), t('ждём ответ'), 'text-[var(--honey-deep)]'], [String(persons('no')), t('не смогут'), 'text-[var(--rose-deep)]']].map(([v, l, c]) => (
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
        <div className="card px-4 py-1.5">
          {shown.map((g, i) => (
            <div key={g.id} className={cn('flex items-center gap-3 py-3', i !== shown.length - 1 && 'border-b border-[var(--track)]')}>
              <div className={cn('w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-serif-d text-white shrink-0',
                g.status === 'yes' ? 'bg-[#A9BCA0]' : g.status === 'no' ? 'bg-[#C98A8A]' : 'bg-[var(--gold-soft)]')}>
                {g.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] block truncate">{g.name}</b>
                <span className="text-[10px] text-[var(--soft)]">{g.plus ? 'с +1' : t('один/одна')}{g.table ? `${t(' · стол №')}${g.table}` : ''}</span>
                {g.status === 'yes' && (
                  <div className="flex gap-1.5 mt-1.5">
                    <button onClick={() => setExtras(x => { const d = x[g.id]?.diet; const next = !d ? t('веган') : d === t('веган') ? t('аллергия') : undefined; const n = { ...x }; if (next) n[g.id] = { ...n[g.id], diet: next }; else delete n[g.id]; return n })}
                      className={cn('press text-[9px] font-bold px-2 py-0.5 rounded-full', extras[g.id]?.diet ? 'bg-[var(--lav)] text-[var(--lav-ink)]' : 'bg-[var(--track)] text-[var(--track-ink)]')}>
                      🍽 {extras[g.id]?.diet ?? t('всё ест')}
                    </button>
                    <button onClick={() => setExtras(x => ({ ...x, [g.id]: { ...x[g.id], transfer: !x[g.id]?.transfer } }))}
                      className={cn('press text-[9px] font-bold px-2 py-0.5 rounded-full', extras[g.id]?.transfer ? 'bg-[var(--blue)] text-[var(--blue-ink)]' : 'bg-[var(--track)] text-[var(--track-ink)]')}>
                      🚌 {t('трансфер')}
                    </button>
                  </div>
                )}
              </div>
              <button onClick={() => setList(l => l.map(x => x.id === g.id ? { ...x, status: x.status === 'yes' ? 'no' : x.status === 'no' ? 'pending' : 'yes' } : x))} title={t('Нажмите, чтобы сменить статус')} className={cn('press text-[9px] font-bold px-2.5 py-1 rounded-full transition-all',
                g.status === 'yes' ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : g.status === 'no' ? 'bg-[var(--rose-soft)] text-[var(--rose-ink)]' : 'bg-[var(--honey)] text-[var(--honey-ink)]')}>
                {g.status === 'yes' ? t('Придёт') : g.status === 'no' ? t('Не придёт') : t('Ждём')}
              </button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3.5">
          <button onClick={() => nav('/wedding/seating')} className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Armchair size={15} />{t('Рассадка')}</button>
          <button onClick={() => {
            const csv = 'Имя;Статус;+1;Стол\n' + list.map(g => `${g.name};${g.status === 'yes' ? t('Придёт') : g.status === 'no' ? t('Не придёт') : t('Ждём')};${g.plus ? 'да' : 'нет'};${g.table ?? ''}`).join('\n')
            const a = document.createElement('a')
            a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv' }))
            a.download = 'gosti-alina-timur.csv'
            a.click()
          }} className="press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Download size={15} />{t('Список CSV')}</button>
        </div>
        <div className="mt-3.5">
          {(() => {
            const yesGuests = list.filter(g => g.status === 'yes')
            const vegan = yesGuests.filter(g => extras[g.id]?.diet === t('веган')).length
            const allergy = yesGuests.filter(g => extras[g.id]?.diet === t('аллергия')).length
            const transfer = yesGuests.filter(g => extras[g.id]?.transfer).length
            const seats = yesGuests.reduce((a, g) => a + 1 + (g.plus ? 1 : 0), 0)
            return (
              <div className="card p-4">
                <p className="text-[12px] font-semibold mb-1.5">🍽 {t('Для кейтеринга')}</p>
                <p className="text-[11px] text-[var(--soft)] leading-relaxed">
                  {seats} {t('персон')} · {vegan} {t('веган')} · {allergy} {t('аллергия')} · {transfer} {t('нужен трансфер')}
                </p>
                <p className="text-[10px] text-[var(--sage-deep)] font-medium mt-1.5">✓ {t('Автоматически уйдёт кейтерингу и площадке 1 июня — обновляется по RSVP')}</p>
              </div>
            )
          })()}
        </div>
        <div className="mt-3.5">
          {reminded
            ? <div className="card p-3.5 text-[12px] font-medium text-[var(--sage-deep)]">✓ {t('Напоминания отправлены 8 гостям · повторим за 3 дня до дедлайна')}</div>
            : <AiTip text={t('8 гостей не ответили — дедлайн RSVP 1 мая. Отправить напоминание одной кнопкой?')} onPress={() => setReminded(true)} />}
        </div>
      </div>
    </div>
  )
}

/* Общий фотоальбом гостей: QR на столах + модерация парой */
export function Album() {
  const [photos, setPhotos] = usePersist('tt_album', initialAlbum)
  const [moderated, setModerated] = useState(0)
  const pool = ['💃', '🥂', '🎆', '🤳', '🍰', '💐', '🎤', '🕺', '📸', '❤️']
  const pending = photos.filter(p => !p.approved).length
  const addPhoto = () => setPhotos(ps => [...ps, { id: 'p' + Date.now(), emoji: pool[ps.length % pool.length], tile: ['bg-[var(--rose-soft)]', 'bg-[var(--sage-soft)]', 'bg-[var(--honey)]', 'bg-[var(--lav)]'][ps.length % 4], approved: false, at: t('сейчас') }])
  return (
    <div className="pb-28">
      <TopBar back title={t('Фотоальбом гостей')} sub={`${photos.length} ${t('кадров ·')} ${pending} ${t('на модерации')}`} />
      <div className="px-5 mt-3 space-y-3">
        <div className="card p-4 flex items-center gap-4">
          <div className="w-[76px] h-[76px] rounded-[16px] bg-[var(--ink)] grid grid-cols-4 gap-[3px] p-2.5 shrink-0">
            {Array.from({ length: 16 }).map((_, i) => <span key={i} className="rounded-[2px]" style={{ background: (i * 7 + 3) % 3 ? '#EFE9DF' : 'transparent' }} />)}
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-semibold">{t('QR-код для столов')}</p>
            <p className="text-[11px] text-[var(--soft)] leading-relaxed mt-0.5">{t('Гости сканируют и загружают фото и видео без регистрации — всё попадает сюда.')}</p>
            <button onClick={addPhoto} className="press mt-2 text-[11px] font-bold px-3.5 py-2 rounded-full card-s">{t('＋ Загрузить фото (демо)')}</button>
          </div>
        </div>
        {pending > 0 && (
          <div className="card p-3.5 flex items-center justify-between">
            <p className="text-[12px] font-medium">{t('Новых на модерации:')} {pending}</p>
            <button onClick={() => { setPhotos(ps => ps.map(p => ({ ...p, approved: true }))); setModerated(m => m + 1) }} className="press text-[11px] font-bold px-3.5 py-2 rounded-full grad text-[var(--on-grad)]">{t('Одобрить все')}</button>
          </div>
        )}
        {moderated > 0 && pending === 0 && <p className="text-[11px] text-[var(--sage-deep)] font-medium px-1">✓ {t('Все кадры одобрены и видны гостям')}</p>}
      </div>
      <div className="px-5 mt-4 grid grid-cols-3 gap-2.5">
        {photos.map((p, i) => (
          <button key={p.id} onClick={() => setPhotos(ps => ps.map(x => x.id === p.id ? { ...x, approved: !x.approved } : x))}
            className={cn('press relative aspect-square rounded-[20px] flex items-center justify-center text-[38px]', p.tile, !p.approved && 'opacity-50')} style={{ animationDelay: `${i * 30}ms`, boxShadow: 'var(--shadow)' }}>
            {p.emoji}
            <span className={cn('absolute top-1.5 right-1.5 text-[8px] font-bold px-1.5 py-0.5 rounded-full', p.approved ? 'bg-[var(--sage)] text-[var(--on-grad)]' : 'bg-[var(--ink)] text-[var(--bg)]')}>
              {p.approved ? '✓' : '…'}
            </span>
            <span className="absolute bottom-1.5 left-2 text-[8.5px] text-[var(--soft)]">{p.at}</span>
          </button>
        ))}
      </div>
      <p className="px-6 mt-3 text-center text-[10.5px] text-[var(--soft)]">{t('Тап по фото — одобрить/скрыть. Скрытые видите только вы.')}</p>
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

      <div className="px-5 mt-5">
        <h2 className="font-serif-d text-[19px] px-1 mb-2">{t('Подписанные')}</h2>
        <div className="space-y-2.5">
          {[
            [t('Договор с фотографом'), t('подписан обеими сторонами · PDF'), '✓'],
            [t('Аренда усадьбы «Липовый сад»'), t('подписан · скан загружен'), '✓'],
          ].map(([n, d]) => (
            <button key={n} onClick={() => {
              const html = `<html><head><meta charset="utf-8"></head><body style="font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.7"><h1>${n}</h1><p>${t('г. Уфа · подписан обеими сторонами')}</p><p>${t('Заказчик: Алина Козлова и Тимур Волков. Предмет, стоимость, ответственность сторон — по шаблону «Тили-тили».')}</p><p><i>${t('Сформировано tili-tili.ru')}</i></p></body></html>`
              const a = document.createElement('a')
              a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }))
              a.download = `${n.replace(/[«»\s]+/g, '-').toLowerCase()}.doc`
              a.click(); URL.revokeObjectURL(a.href)
            }} className="press w-full card-s p-4 flex items-center gap-3 text-left">
              <div className="w-10 h-10 rounded-[14px] bg-[var(--sage-soft)] flex items-center justify-center">📄</div>
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] block truncate">{n}</b>
                <span className="text-[10px] text-[var(--sage-deep)]">{d}</span>
              </div>
              <Download size={14} className="text-[var(--soft2)] shrink-0" />
            </button>
          ))}
        </div>
      </div>

      <p className="px-6 mt-4 text-[10.5px] text-[var(--soft)] leading-relaxed text-center">
        {t('Шаблоны носят информационный характер и не заменяют консультацию юриста. Данные подставляются автоматически из сделки.')}
      </p>
    </div>
  )
}
