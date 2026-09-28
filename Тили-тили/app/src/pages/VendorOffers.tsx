import { useRef, useState } from 'react'
import { TopBar } from '@/components/chrome'
import { AsyncState, CabinetDenied, ready } from '@/components/AsyncState'
import { OfferSummary } from '@/components/OfferSummary'
import { explainError, useApi } from '@/lib/api/useApi'
import { getVendorOfferRequests, getVendorProfile, sendVendorOffer, type VendorOfferInput, type VendorOfferRequest } from '@/lib/api/vendor'
import { newIdempotencyKey } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'
import { parsePaymentRubles, paymentRubles } from '@/lib/paymentAmount'
import { formatWeddingDate } from '@/lib/weddingDate'
import { cn } from '@/lib/utils'
import { fmt } from '@/lib/money'
import { t } from '@/lib/i18n'

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

