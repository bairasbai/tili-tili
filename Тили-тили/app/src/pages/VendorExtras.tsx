import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { X, Clock, Send, Star, TrendingUp, Eye, MessageCircle, CalendarCheck, ChevronRight } from 'lucide-react'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { AsyncState, CabinetDenied, ready } from '@/components/AsyncState'
import { ComplaintSheet } from '@/components/ComplaintSheet'
import { OrderDraft } from '@/components/OrderDraft'
import { OrderTerms } from '@/components/OrderTerms'
import { OrderResourceCommitments } from '@/components/OrderResourceCommitments'
import { OrderResourcePlan } from '@/components/OrderResourcePlan'
import { explainError, useApi } from '@/lib/api/useApi'
import { getVendorAnalytics, getVendorDeals, getVendorLeads, getVendorOfferRequests, getVendorProfile, getVendorReviews, leadAction, replyToReview, sendVendorOffer, type VendorOfferInput, type VendorOfferRequest } from '@/lib/api/vendor'
import { getDealEvents } from '@/lib/api/slots'
import { cn, pct, plural } from '@/lib/utils'
import { fmt, parsePaymentRubles, paymentRubles } from '@/lib/money'
import { getI18nLang, t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'
import { newIdempotencyKey } from '@/lib/api/client'
import { OfferSummary } from '@/components/OfferSummary'
import { VendorPaymentHistory } from '@/components/VendorPaymentHistory'
import type { components } from '@/lib/api/schema'

/** Локаль дат — по языку интерфейса, а не «ru-RU» навсегда (R-07). */
const dateLocale = () => (getI18nLang() === 'en' ? 'en-GB' : 'ru-RU')

/*
 * Заявка подрядчика.
 *
 * Экран был словарём из трёх выдуманных пар: `ch1`, `ch2`, `ch3` — какой бы
 * идентификатор ни стоял в адресе, показывалась «Алина и Тимур». Быстрые
 * ответы никуда не уходили, «Hold 72 ч» и «Отклонить» переключали состояние
 * внутри экрана, а пара об этом не узнавала.
 *
 * Теперь заявка настоящая, а каждое действие уходит в `POST /vendor/leads/{id}`.
 * Что именно делает сервер, важно называть точно: ответ уходит сообщением в
 * чат пары и поднимает ей уведомление, а hold и отказ живут у самой заявки —
 * дату они не бронируют и паре не пишут. Экран говорит это словами, потому
 * что подрядчик планирует свой месяц по этим пометкам.
 */
/*
 * Карточка сделки подрядчика (План §8.2: «статус, мини-таймлайн, договор,
 * отметки оплат»). До сверки планов 2026-09-18 строка списка не открывалась:
 * подрядчик видел сумму и статус, а что происходило со сделкой и сколько
 * пришло платежами — нет. Переходы состояний делает пара (`PATCH /deals` —
 * только ей); подрядчику здесь — журнал, оплаты, договор, чат и спор.
 */
const DEAL_STATE_LABEL: Record<string, string> = {
  candidate: 'Не связывались', contacted: 'Написали', negotiating: 'Переговоры', booked: 'Забронировано',
  paid_deposit: 'Аванс получен', done: 'Завершена', cancelled: 'Отменена',
}
const EVENT_STATE: Record<string, string> = {
  candidate: 'Вернулась к статусу «Не связывались»', contacted: 'Пара написала', negotiating: 'Переговоры', booked: 'Забронировано',
  paid_deposit: 'Аванс внесён', done: 'Выполнено', cancelled: 'Сделка отменена',
}
const EVENT_BY: Record<string, string> = { couple: 'пара', vendor: 'вы', system: 'автоматически' }
const CONTRACT_STATUS: Record<string, string> = { draft: 'черновик', sent: 'отправлен', signed: 'подписан' }

type VendorPackage = components['schemas']['VendorPackage']

function requestCloseReason(reason: VendorOfferRequest['closeReason']): string {
  if (reason === 'removed') return t('Пара отозвала запрос')
  if (reason === 'booked_other') return t('Пара выбрала другого исполнителя')
  if (reason === 'booked') return t('Ваше предложение выбрано')
  if (reason === 'wedding_cancelled') return t('Свадьба отменена')
  if (reason === 'date_changed') return t('Дата свадьбы изменилась')
  if (reason === 'vendor_erased') return t('Анкета подрядчика удалена')
  return t('Запрос закрыт')
}

/** Ответ на один запрос. Ключ живёт до успешного ответа и переживает обрыв сети. */
function VendorOfferEditor({ request, packages, onSaved }: {
  request: VendorOfferRequest
  packages: VendorPackage[]
  onSaved: () => void
}) {
  const firstPackage = packages[0]
  const [open, setOpen] = useState(!request.offer)
  const [mode, setMode] = useState<'package' | 'custom' | 'decline'>(firstPackage ? 'package' : 'custom')
  const [packageId, setPackageId] = useState(firstPackage?.id ?? '')
  const [title, setTitle] = useState('')
  const [includes, setIncludes] = useState('')
  const [price, setPrice] = useState(firstPackage?.price ? paymentRubles(firstPackage.price.amount) : '')
  const [message, setMessage] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null)

  const choosePackage = (id: string) => {
    setPackageId(id)
    const selected = packages.find(item => item.id === id)
    setPrice(selected?.price ? paymentRubles(selected.price.amount) : '')
  }

  const submit = async () => {
    if (busyRef.current) return
    let body: VendorOfferInput
    if (mode === 'decline') {
      if (!message.trim()) { setError(t('Напишите причину отказа')); return }
      body = { kind: 'decline', message: message.trim() }
    } else {
      const amount = parsePaymentRubles(price)
      if (amount === null) { setError(t('Введите цену больше нуля')); return }
      if (mode === 'package') {
        if (!packageId) { setError(t('Выберите пакет')); return }
        body = {
          kind: 'offer', packageId, price: { amount, currency: 'RUB' },
          ...(message.trim() ? { message: message.trim() } : {}),
          ...(validUntil ? { validUntil } : {}),
        }
      } else {
        const parts = includes.split('\n').map(item => item.trim()).filter(Boolean)
        if (!title.trim() || parts.length === 0) { setError(t('Заполните название и состав предложения')); return }
        body = {
          kind: 'offer', title: title.trim(), includes: parts, price: { amount, currency: 'RUB' },
          ...(message.trim() ? { message: message.trim() } : {}),
          ...(validUntil ? { validUntil } : {}),
        }
      }
    }

    const fingerprint = JSON.stringify(body)
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: newIdempotencyKey() }
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await sendVendorOffer(request.id, body, attempt.current.key)
      attempt.current = null
      setOpen(false)
      onSaved()
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} className="press mt-3 text-[11px] font-bold text-[var(--rose-deep)]">
      {request.offer ? t('Изменить ответ') : t('Ответить')}
    </button>
  )

  return (
    <div className="card-s rounded-[18px] p-3 mt-3 space-y-2.5">
      <div className="grid grid-cols-3 gap-1.5">
        {(['package', 'custom', 'decline'] as const).map(item => (
          <button
            type="button"
            key={item}
            disabled={item === 'package' && packages.length === 0}
            onClick={() => setMode(item)}
            className={cn('press h-9 rounded-full text-[10.5px] font-semibold disabled:opacity-40', mode === item ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)] text-[var(--soft)]')}
          >{item === 'package' ? t('Пакет') : item === 'custom' ? t('Своё предложение') : t('Отказ')}</button>
        ))}
      </div>

      {mode === 'package' && (
        <select value={packageId} onChange={event => choosePackage(event.target.value)} aria-label={t('Пакет')} className="w-full h-11 rounded-[14px] bg-[var(--bg)] px-3 text-[12px] outline-none">
          {packages.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      )}
      {mode === 'custom' && (
        <>
          <input value={title} onChange={event => setTitle(event.target.value)} placeholder={t('Название предложения')} className="w-full h-11 rounded-[14px] bg-[var(--bg)] px-3 text-[12px] outline-none" />
          <textarea value={includes} onChange={event => setIncludes(event.target.value)} placeholder={t('Что входит — по пункту в строке')} className="w-full min-h-20 rounded-[14px] bg-[var(--bg)] px-3 py-2.5 text-[12px] outline-none resize-y" />
        </>
      )}
      {mode !== 'decline' && (
        <div className="grid grid-cols-2 gap-2">
          <input value={price} onChange={event => setPrice(event.target.value)} inputMode="decimal" aria-label={t('Цена предложения, ₽')} placeholder={t('Цена, ₽')} className="w-full h-11 rounded-[14px] bg-[var(--bg)] px-3 text-[12px] outline-none" />
          <input type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} aria-label={t('Действует до')} className="w-full h-11 rounded-[14px] bg-[var(--bg)] px-3 text-[11px] outline-none" />
        </div>
      )}
      <textarea
        value={message}
        onChange={event => setMessage(event.target.value)}
        placeholder={mode === 'decline' ? t('Причина отказа') : t('Сообщение паре (необязательно)')}
        className="w-full min-h-20 rounded-[14px] bg-[var(--bg)] px-3 py-2.5 text-[12px] outline-none resize-y"
      />
      {mode !== 'decline' && !validUntil && <p className="text-[10px] text-[var(--soft)]">{t('Если срок не выбрать, предложение действует семь дней')}</p>}
      {error && <p role="alert" className="text-[11px] text-[var(--rose-ink)]">{error}</p>}
      <div className="flex gap-2">
        {request.offer && <button type="button" disabled={busy} onClick={() => setOpen(false)} className="press flex-1 h-10 rounded-full bg-[var(--track)] text-[11px] font-semibold disabled:opacity-50">{t('Отмена')}</button>}
        <button type="button" disabled={busy} onClick={() => void submit()} className="press flex-1 h-10 rounded-full grad text-[var(--on-grad)] text-[11px] font-semibold disabled:opacity-50">{busy ? t('Отправляем…') : mode === 'decline' ? t('Отправить отказ') : t('Отправить предложение')}</button>
      </div>
    </div>
  )
}

/** Новый экран 019: запросы пары и версии ответа подрядчика. */
export function VendorOfferRequests() {
  const q = useApi(() => getVendorOfferRequests(), [])
  const profile = useApi(() => getVendorProfile(), [])
  const requests = [...(q.data ?? [])].sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.createdAt.localeCompare(a.createdAt))
  const packages = profile.data?.packages ?? []

  return (
    <div className="pb-28">
      <TopBar back fallback="/vendor-app" title={t('Запросы предложений')} sub={ready(q) ? `${requests.filter(item => item.status === 'open').length} ${t('открыто')}` : undefined} />
      <div className="px-5 mt-3">
        <AsyncState q={q} denied={<CabinetDenied />} />
        <AsyncState q={profile} denied={<CabinetDenied />} />
        {ready(q) && requests.length === 0 && <p className="py-8 text-center text-[12px] text-[var(--soft)]">{t('Запросов пока нет — они появятся, когда пара выберет вас кандидатом')}</p>}
        <div className="space-y-3">
          {requests.map(request => (
            <article key={request.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <b className="text-[13.5px]">{request.weddingDate ? formatWeddingDate(request.weddingDate) : t('Дата ещё не выбрана')}</b>
                  <p className="text-[10.5px] text-[var(--soft)] mt-0.5">{[request.city, request.guests == null ? null : `${request.guests} ${t('гостей')}`].filter(Boolean).join(' · ') || t('Условия пока не указаны')}</p>
                </div>
                <span className={cn('text-[9px] font-bold px-2.5 py-1.5 rounded-full shrink-0', request.status === 'open' ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]' : 'bg-[var(--track)] text-[var(--track-ink)]')}>{request.status === 'open' ? t('Открыт') : t('Закрыт')}</span>
              </div>
              {request.wishes && <div className="mt-3"><span className="text-[9px] uppercase tracking-wide text-[var(--soft)] font-semibold">{t('Пожелания')}</span><p className="text-[12px] text-[var(--ink2)] whitespace-pre-wrap mt-1">{request.wishes}</p></div>}
              {request.budgetHint && <p className="text-[11px] mt-2"><span className="text-[var(--soft)]">{t('Ориентир бюджета')}:</span> <b className="tabular">{fmt(request.budgetHint.amount)}</b></p>}
              {request.offer && <div className="mt-3 border-t border-[var(--track)] pt-3 text-[11px]"><OfferSummary request={request} /></div>}
              {request.status === 'closed' ? <p className="mt-3 text-[11px] font-semibold text-[var(--soft)]">{requestCloseReason(request.closeReason)}</p>
                : ready(profile) && <VendorOfferEditor key={`${request.id}:${request.offer?.id ?? 'none'}`} request={request} packages={packages} onSaved={q.reload} />}
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}

export function VendorDealCard() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const q = useApi(() => getVendorDeals(), [])
  const events = useApi(() => getDealEvents(id), [id])
  const [dispute, setDispute] = useState(false)
  const d = (q.data?.items ?? []).find(x => x.id === id)
  const price = d?.price?.amount ?? null
  const paid = d?.paid?.amount ?? null
  const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'

  return (
    <div className="pb-28">
      <TopBar back fallback="/vendor-app/deals" title={d?.coupleName ?? t('Сделка')} sub={d?.weddingDate ? formatWeddingDate(d.weddingDate) : undefined} />
      <div className="px-5 mt-3 space-y-3">
        <AsyncState q={q} denied={<CabinetDenied />} />
        {ready(q) && !d && <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Сделка не найдена')}</p>}
        {d && (
          <>
            <div className="card p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Состояние')}</span>
                <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)]">{t(DEAL_STATE_LABEL[d.state ?? ''] ?? d.state ?? '')}</span>
              </div>
              {d.packageName && <p className="text-[12px] mt-2">{t('Пакет:')} <b>{d.packageName}</b></p>}
              {d.packageIncludes && d.packageIncludes.length > 0 && <ul className="mt-2 list-disc pl-4 text-[11px] text-[var(--ink2)]">{d.packageIncludes.map((part, index) => <li key={index}>{part}</li>)}</ul>}
              {d.holdUntil && <p className="text-[11px] text-[var(--honey-deep)] mt-1">{t('держим до')} {new Date(d.holdUntil).toLocaleString(locale, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>}
              {/* Только раскрытые подрядчику известные суммы; без ответа — прочерк. */}
              <div className="grid grid-cols-3 gap-2 mt-4">
                <div><span className="text-[9.5px] text-[var(--soft)] block">{t('Сумма')}</span><b className="tabular text-[13px]">{price === null ? '—' : fmt(price)}</b></div>
                <div><span className="text-[9.5px] text-[var(--soft)] block">{t(d.unknownAmountPayments ? 'Известные оплаты' : 'Оплачено')}</span><b className="tabular text-[13px]">{paid === null ? '—' : fmt(paid)}</b></div>
                <div><span className="text-[9.5px] text-[var(--soft)] block">{t('Остаток')}</span><b className="tabular text-[13px]">{price === null || paid === null ? '—' : fmt(Math.max(0, price - paid))}</b></div>
              </div>
              {!d.unknownAmountPayments && price !== null && paid !== null && price > 0 && <div className="mt-2.5"><Bar pct={pct(Math.min(paid, price), price)} /></div>}
              {!!d.unknownAmountPayments && <p role="status" className="text-[11px] text-[var(--honey-deep)] mt-2"><span>{t('Есть оплаты с неизвестной суммой')}</span> · {d.unknownAmountPayments}<br /><span>{t('Числовой остаток их не учитывает.')}</span></p>}
              <p className="text-[10.5px] text-[var(--soft)] mt-2 leading-relaxed">{t('Показаны только платежи, которыми пара поделилась с вами.')}</p>
            </div>

            <VendorPaymentHistory key={id} dealId={id} />

            {/* Договор: заголовок последней редакции. Полей сторон здесь нет —
                их видит пара на экране документов. */}
            <div className="card p-5">
              <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Договор')}</span>
              {d.contract ? (
                <p className="text-[12.5px] mt-2">
                  {t('Редакция')} {d.contract.version} · {t(CONTRACT_STATUS[d.contract.status ?? ''] ?? d.contract.status ?? '')}
                  {d.contract.createdAt && <span className="text-[10.5px] text-[var(--soft2)] block mt-0.5">{new Date(d.contract.createdAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
                </p>
              ) : (
                <p className="text-[12px] text-[var(--soft)] mt-2 leading-relaxed">{t('Договора пока нет — его оформляет пара из шаблона в своей карточке сделки.')}</p>
              )}
            </div>

            <OrderDraft dealId={id} />
            <OrderResourcePlan dealId={id} />
            <OrderTerms dealId={id} />
            <OrderResourceCommitments dealId={id} onChanged={q.reload} />
            {d.busRoutes && d.busRoutes.length > 0 && (
              <div className="card p-5">
                <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Маршруты для гостей')}</span>
                <div className="mt-2 space-y-1.5">
                  {d.busRoutes.map(r => (
                    <p key={r.id} className="text-[12px] tabular">{r.name}{r.time ? ` · ${r.time}` : ''} · {r.taken ?? 0} {t('из')} {r.seats ?? 0}</p>
                  ))}
                </div>
              </div>
            )}

            <div className="card p-5">
              <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Что происходило')}</span>
              <AsyncState q={events} />
              {ready(events) && !(events.data ?? []).length && <p className="text-[12px] text-[var(--soft)] mt-3">{t('Пока ничего не происходило')}</p>}
              <div className="mt-3 space-y-3">
                {(events.data ?? []).map(e => (
                  <div key={e.id} className="flex gap-3">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--rose-deep)] mt-1.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12.5px] font-medium">{e.kind === 'price' ? (e.note ?? t('Цена изменена')) : e.fromState === null && e.toState === 'candidate' ? t('Создан черновик заказа') : t(EVENT_STATE[e.toState ?? ''] ?? e.toState ?? '')}</p>
                      <p className="text-[10.5px] text-[var(--soft2)] mt-0.5">
                        {e.at ? new Date(e.at).toLocaleString(locale, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : ''}
                        {e.by && ` · ${t(EVENT_BY[e.by] ?? e.by)}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2.5">
              <button disabled={!d.chatId} onClick={() => d.chatId && nav(`/vendor-app/chats/${d.chatId}`)} className="press flex-1 h-[48px] rounded-full grad text-[var(--on-grad)] text-[13px] font-semibold disabled:opacity-50">
                {d.chatId ? t('Написать паре') : t('Пара ещё не писала')}
              </button>
              <button onClick={() => setDispute(true)} className="press px-5 h-[48px] rounded-full bg-[var(--card)] text-[12.5px] font-semibold" style={{ boxShadow: 'var(--shadow)' }}>{t('Открыть спор')}</button>
            </div>
            {dispute && <ComplaintSheet target="deal" targetId={d.id ?? ''} title={`${t('Сделка')}: ${d.coupleName ?? ''}`} onClose={() => setDispute(false)} />}
          </>
        )}
      </div>
    </div>
  )
}

export function VendorLead() {
  const nav = useNavigate()
  const { id } = useParams()
  const q = useApi(() => getVendorLeads(), [])
  const lead = (q.data ?? []).find(l => l.id === id)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const act = (action: 'reply' | 'hold' | 'decline' | 'reopen', text?: string) => void (async () => {
    if (!id) return
    setBusy(true)
    setErr(null)
    try { await leadAction(id, action, text); setReply(''); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  if (!lead) return (
    <div className="pb-28">
      <TopBar back title={t('Заявка')} />
      <AsyncState q={q} denied={<CabinetDenied />} />
      {ready(q) && <p className="px-5 mt-6 text-[13px] text-[var(--soft)]">{t('Заявка не найдена')}</p>}
    </div>
  )

  const status = lead.status ?? 'new'
  const templates = [
    t('Здравствуйте! Дата свободна, с радостью обсудим детали 💛'),
    t('Спасибо за интерес! Предлагаю созвониться — когда удобно?'),
    t('К сожалению, на эту дату я занят. Могу порекомендовать коллег.'),
  ]

  return (
    <div className="min-h-dvh flex flex-col pb-28">
      <TopBar back title={lead.coupleName ?? t('Заявка')} sub={lead.weddingDate ? formatWeddingDate(lead.weddingDate) : t('дата не назначена')} />
      <div className="flex-1 px-5 mt-3 space-y-3">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full grad flex items-center justify-center text-[var(--on-grad)] font-serif-d text-[17px]">{(lead.coupleName ?? '?')[0]}</div>
            <div className="flex-1 min-w-0">
              <b className="text-[14px]">{lead.coupleName}</b>
              <p className="text-[10.5px] text-[var(--soft)]">{lead.city ?? t('город не указан')}</p>
            </div>
            {status === 'hold' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--honey)] text-[var(--honey-ink)]">{t('⏳ Держим дату')}</span>}
            {status === 'declined' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)]">{t('Отклонена')}</span>}
            {status === 'won' && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('Сделка')}</span>}
          </div>
          {lead.message && <div className="card-s p-3.5 mt-3 text-[12.5px] text-[var(--ink2)] leading-relaxed">{lead.message}</div>}
          {/* Срок — ваш собственный: сервер держит его у заявки и ничего не
              бронирует. Бронь появляется только со сделкой. */}
          {lead.holdUntil && (
            <p className="text-[10.5px] text-[var(--honey-deep)] mt-2.5">{t('Держите до')} {new Date(lead.holdUntil).toLocaleString(dateLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>
          )}
          {/* Переписка по заявке (`Lead.chatId`, контракт v0.30.1, фича 007):
              ответ ложится в чат пары, и продолжить разговор можно там же.
              Чат называет сервер — это переход в существующий, не создание;
              у заявки без чата (выигранной без переписки) кнопки нет. */}
          {lead.chatId && (
            <button onClick={() => nav(`/vendor-app/chats/${lead.chatId}`)} className="press w-full h-10 mt-3 rounded-full bg-[var(--bg)] text-[11.5px] font-bold text-[var(--rose-deep)] flex items-center justify-center gap-1.5">
              <MessageCircle size={13} />{t('Открыть чат')}
            </button>
          )}
        </div>

        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}

        {(status === 'new' || status === 'replied') && (
          <>
            <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1">{t('Быстрые ответы')}</span>
            <div className="space-y-2">
              {templates.map(x => (
                <button key={x} disabled={busy} onClick={() => act('reply', x)} className="press w-full card-s px-4 py-3 text-left text-[12px] text-[var(--ink2)] disabled:opacity-50">{x}</button>
              ))}
            </div>
            {/* Ответ уходит отсюда — полем ниже — и ложится в чат пары; сама
                переписка открывается кнопкой «Открыть чат» в карточке выше,
                по `chatId` от сервера (фича 007). Прежняя «В чат» вела в
                выдуманный `ch1` и была снята вместе с моками. */}
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button disabled={busy} onClick={() => act('hold')} className="press h-11 rounded-full bg-[var(--honey)] text-[var(--honey-ink)] text-[11.5px] font-bold flex items-center justify-center gap-1 disabled:opacity-50"><Clock size={13} />{t('Hold 72 ч')}</button>
              <button disabled={busy} onClick={() => act('decline')} className="press h-11 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[11.5px] font-bold flex items-center justify-center gap-1 disabled:opacity-50"><X size={13} />{t('Отклонить')}</button>
            </div>
          </>
        )}
        {/* Выигранная заявка — уже сделка, и действий над ней здесь нет.
            Без этой строки экран выглядит пустым и сломанным: ни кнопок, ни
            объяснения, куда делась заявка. */}
        {status === 'won' && (
          <div className="card-s p-4 text-center">
            <b className="text-[13px]">{t('Заявка стала сделкой')}</b>
            <p className="text-[11px] text-[var(--soft)] mt-1">{t('Пара забронировала вас — дальше всё в разделе «Сделки»: сумма, аванс и состояние.')}</p>
            <button onClick={() => nav('/vendor-app/deals')} className="press mt-3 text-[11px] font-bold text-[var(--sage-deep)]">{t('Открыть сделки →')}</button>
          </div>
        )}
        {(status === 'hold' || status === 'declined') && (
          <div className="card-s p-4 text-center">
            <b className="text-[13px]">{status === 'hold' ? t('Держим дату 72 часа') : t('Заявка отклонена')}</b>
            {/* Прежние подписи обещали чужое действие: «пара видит бронь» и
                «пара получила отказ». Сервер не делает ни того, ни другого —
                hold и отказ живут у заявки, пара узнаёт о решении из чата. */}
            <p className="text-[11px] text-[var(--soft)] mt-1">{status === 'hold' ? t('Это ваша пометка со сроком. Бронь даты появится, когда пара подтвердит сделку — напишите ей, чтобы не потерять время.') : t('Пара уведомления не получит: если нужно объяснить отказ, напишите в чат.')}</p>
            <button disabled={busy} onClick={() => act('reopen')} className="press mt-3 text-[11px] font-bold text-[var(--rose-deep)] disabled:opacity-50">{t('Вернуть в работу')}</button>
          </div>
        )}
      </div>
      {(status === 'new' || status === 'replied') && (
        <div className="px-5 pt-3 flex gap-2">
          <input value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && reply.trim() && act('reply', reply.trim())} placeholder={t('Написать паре…')} className="flex-1 h-12 px-5 rounded-full bg-[var(--card)] text-[13px] outline-none" style={{ boxShadow: 'var(--shadow)' }} />
          <button disabled={busy || !reply.trim()} onClick={() => act('reply', reply.trim())} className="press w-12 h-12 rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0 disabled:opacity-50"><Send size={16} /></button>
        </div>
      )}
    </div>
  )
}

/*
 * Отзывы о подрядчике.
 *
 * Три отзыва стояли в состоянии экрана, рейтинг «4.9» — в разметке, а ответ
 * подрядчика оставался в браузере и до пары не доходил. Теперь отзывы читаются
 * с сервера, а ответ уходит в `POST /vendor/reviews/{id}/reply` и виден всем в
 * карточке анкеты.
 *
 * Число слева — та же серверная оценка, что видит пара в каталоге
 * (`GET /vendor/profile` → `rating`): взвешенная, с затуханием, с порогом в
 * три отзыва. Своё среднее по видимым отзывам давало второе число рядом с
 * первым, и подрядчик с одним гостевым 5★ видел «5» здесь и «Новый на
 * платформе» в каталоге (ревью D5-17). Пока оценки нет — прочерк (R-178).
 */
export function VendorReviews() {
  const q = useApi(() => getVendorReviews(), [])
  const profile = useApi(() => getVendorProfile(), [])
  const reviews = q.data ?? []
  const [answering, setAnswering] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /* Жалоба на отзыв (§18.2): чужие фото, оскорбление, отзыв не про эту работу. */
  const [complaint, setComplaint] = useState<{ id: string; author: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const answered = reviews.filter(r => r.reply).length
  const rating = ready(profile) ? (profile.data?.rating ?? null) : null

  const save = (reviewId: string) => void (async () => {
    if (!text.trim()) return
    if (busy) return // второй запрос, пока идёт первый (Enter, двойной тап) — ревью 015
    setBusy(true)
    setErr(null)
    try { await replyToReview(reviewId, text.trim()); setAnswering(null); setText(''); q.reload() }
    catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <div className="pb-28">
      <TopBar back title={t('Отзывы')} sub={reviews.length ? `${reviews.length} ${plural(reviews.length, t('отзыв'), t('отзыва'), t('отзывов'))} · ${t('отвечено')} ${answered}` : ''} />
      <AsyncState q={q} denied={<CabinetDenied />} />
      <div className="px-5 mt-3">
        {!reviews.length && ready(q) && (
          <p className="text-[12px] text-[var(--soft)] py-3">{t('Отзывов пока нет. Их оставляют пары после завершённой сделки и гости — после свадьбы.')}</p>
        )}
        {reviews.length > 0 && (
          <div className="card p-4 flex items-center gap-4">
            <div className="text-center">
              <b className="font-serif-d text-[30px] tabular">{rating ?? '—'}</b>
              <p className="text-[9.5px] text-[var(--soft)]">{t('оценка в каталоге')}</p>
              {profile.error && <p role="alert" className="text-[9.5px] text-[var(--rose-ink)] mt-0.5">{t('не загрузилась')}</p>}
            </div>
            <div className="flex-1">
              <Bar pct={pct(answered, reviews.length)} />
              <p className="text-[10.5px] text-[var(--soft)] mt-2">{t('Отвечено на')} {answered} {t('из')} {reviews.length}. {t('Ответ виден парам в карточке анкеты.')}</p>
              {/* Оценка взвешенная, со скидкой на давность и на вес гостя, и
                  появляется только с третьего отзыва — один отзыв от знакомого
                  не должен делать пятёрку. */}
              {ready(profile) && rating === null && (
                <p className="text-[10px] text-[var(--soft2)] mt-1">{t('В каталоге оценка появится с третьего отзыва')}</p>
              )}
            </div>
          </div>
        )}
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-2">{err}</p>}
        <div className="space-y-2.5 mt-3.5 stagger">
          {reviews.map(r => (
            <div key={r.id} className="card p-4 fade-up">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-[var(--rose-soft)] flex items-center justify-center text-[13px] font-serif-d text-[var(--rose-ink)]">{(r.authorName ?? '?')[0]}</div>
                <div className="flex-1 min-w-0">
                  <b className="text-[12.5px]">{r.authorName}</b>
                  <p className="text-[9.5px] text-[var(--soft)]">{r.createdAt ? new Date(r.createdAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</p>
                </div>
                {/* Гость и пара весят в рейтинге по-разному — значок об этом
                    честно предупреждает (§15). */}
                {r.source === 'guest' && <span className="text-[8.5px] font-bold px-2 py-1 rounded-full bg-[var(--blue)] text-[var(--blue-ink)]">{t('Гость')}</span>}
                <span className="text-[10px] text-[var(--honey-deep)]">{'★'.repeat(r.rating ?? 0)}{'☆'.repeat(5 - (r.rating ?? 0))}</span>
              </div>
              {r.text && <p className="text-[12px] text-[var(--ink2)] leading-relaxed mt-2.5">{r.text}</p>}
              {r.reply ? (
                <div className="mt-2.5 pl-3 border-l-2 border-[#A9BCA0]">
                  <p className="text-[10px] font-bold text-[var(--sage-deep)] mb-0.5">{t('Ваш ответ')}</p>
                  <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed">{r.reply.text}</p>
                </div>
              ) : answering === r.id ? (
                <div className="mt-2.5 flex gap-2">
                  <input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && save(r.id ?? '')} placeholder={t('Ответить…')} className="flex-1 h-10 px-4 rounded-full bg-[var(--bg)] text-[12px] outline-none" />
                  <button disabled={busy} onClick={() => save(r.id ?? '')} className="press w-10 h-10 rounded-full grad text-[var(--on-grad)] flex items-center justify-center disabled:opacity-50"><Send size={13} /></button>
                </div>
              ) : (
                <button onClick={() => { setAnswering(r.id ?? null); setText('') }} className="press mt-2.5 text-[11px] font-bold text-[var(--sage-deep)]">{t('Ответить →')}</button>
              )}
              <button onClick={() => setComplaint({ id: r.id ?? '', author: r.authorName ?? '' })} className="press block mt-2 text-[10.5px] font-semibold text-[var(--soft)] underline underline-offset-2">{t('Пожаловаться на отзыв')}</button>
            </div>
          ))}
        </div>
        {complaint && <ComplaintSheet target="review" targetId={complaint.id} title={`${t('Отзыв')}: ${complaint.author}`} onClose={() => setComplaint(null)} />}
      </div>
    </div>
  )
}

/*
 * Аналитика анкеты.
 *
 * Воронка «1 240 → 96 → 34 → 8», доход 385 000 ₽ и «+38%» стояли в разметке:
 * одни и те же числа у каждого подрядчика. Теперь их считает сервер, а период
 * выбирается — месяц, сезон, год.
 */
export function VendorAnalytics() {
  const nav = useNavigate()
  const [period, setPeriod] = useState<'month' | 'season' | 'year'>('season')
  const q = useApi(() => getVendorAnalytics(period), [period])
  const a = q.data
  const f = a?.funnel
  const views = f?.views ?? 0

  const funnel = [
    { l: t('Просмотры анкеты'), v: views, Icon: Eye, tile: 'bg-[var(--blue)]' },
    { l: t('Написали'), v: f?.contacts ?? 0, Icon: Star, tile: 'bg-[var(--honey)]' },
    { l: t('Заявки'), v: f?.leads ?? 0, Icon: MessageCircle, tile: 'bg-[var(--rose-soft)]' },
    { l: t('Сделки'), v: f?.deals ?? 0, Icon: CalendarCheck, tile: 'bg-[var(--sage-soft)]' },
  ]

  return (
    <div className="pb-28">
      <TopBar back title={t('Аналитика')} sub={t(PERIOD_LABEL[period])} />
      <AsyncState q={q} denied={<CabinetDenied />} />
      <div className="px-5 mt-3">
        <div className="flex gap-2">
          {(['month', 'season', 'year'] as const).map(x => (
            <button key={x} onClick={() => setPeriod(x)} className={cn('press flex-1 h-9 rounded-full text-[11.5px] font-semibold', period === x ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)] text-[var(--soft)]')}>{t(PERIOD_LABEL[x])}</button>
          ))}
        </div>
        {/* Доход и воронка — только когда цифры пришли. «Доход 0 ₽» при
            отказе сервера читается как факт о своём месяце. */}
        {ready(q) && (
        <div className="card p-5 grad text-[var(--on-grad)] mt-3">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] tracking-[.18em] uppercase opacity-80 font-semibold">{t(a?.revenueIncomplete ? 'Доход по известным суммам' : 'Доход')}</span>
            {/* Прирост приходит пустым, когда прошлого периода не было:
                «+100%» от нуля — это выдумка, и сервер её не делает. */}
            {!a?.revenueIncomplete && a?.revenueDeltaPct != null && (
              <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--card)]/25 flex items-center gap-1">
                <TrendingUp size={10} /> {a.revenueDeltaPct > 0 ? '+' : ''}{Math.round(a.revenueDeltaPct)}%
              </span>
            )}
          </div>
          <b className="font-serif-d text-[30px] block mt-1 tabular">{fmt(a?.revenue?.amount ?? 0)}</b>
          {/* Что это за число: сервер складывает платежи по дате платежа —
              аванс и остаток, возвраты с минусом, отменённые не в счёт.
              Раньше «доходом» была цена брони без единого рубля (ревью
              D5-08, R-178). */}
          <p className="text-[10px] opacity-80 mt-1">{t('поступившие платежи за период')}</p>
          {a?.revenueIncomplete && <p role="status" className="text-[11px] mt-2">{t('Есть оплаты с неизвестной суммой')}</p>}
          <p className="text-[10px] opacity-80 mt-1">{t('Показаны только платежи, которыми пара поделилась с вами.')}</p>
        </div>

        )}

        {ready(q) && (<>
        <div className="flex justify-between items-baseline px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">{t('Воронка анкеты')}</h2>
          {views > 0 && <span className="text-[10px] text-[var(--soft)]">{t('в заявку')} {pct(f?.leads ?? 0, views)}%</span>}
        </div>
        <div className="card p-4 space-y-3">
          {funnel.map(({ l, v, Icon, tile }) => (
            <div key={l} className="flex items-center gap-3">
              <div className={cn('w-9 h-9 rounded-[12px] flex items-center justify-center shrink-0', tile)}><Icon size={15} className="text-[var(--ink2)]" /></div>
              <div className="flex-1">
                <div className="flex justify-between text-[11px] mb-1"><span className="text-[var(--soft)]">{l}</span><b className="tabular">{v}</b></div>
                <Bar pct={pct(v, views)} />
              </div>
            </div>
          ))}
        </div>
        {views === 0 && (
          <p className="text-[11.5px] text-[var(--soft)] mt-3 px-1">{t('Пока нет данных: анкету ещё не смотрели. Числа появятся, когда она будет опубликована и попадёт в выдачу.')}</p>
        )}
        </>)}

        <button onClick={() => nav('/vendor-app/profile')} className="press w-full card-s p-4 mt-3.5 flex items-center gap-3 text-left">
          <Tile icon="🚀" tile="bg-[var(--rose-soft)]" size={42} />
          <div className="flex-1">
            <b className="text-[13px]">{t('Открыть анкету')}</b>
            <p className="text-[10.5px] text-[var(--soft)]">{t('заполненные пакеты и рассказ о себе поднимают конверсию')}</p>
          </div>
          <ChevronRight size={16} className="text-[var(--soft)]" />
        </button>
      </div>
    </div>
  )
}

const PERIOD_LABEL: Record<string, string> = { month: 'Месяц', season: 'Сезон', year: 'Год' }
