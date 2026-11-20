import { useId, useLayoutEffect, useRef, useState } from 'react'
import { acceptOffer, type OfferPublic, type OfferRequest } from '@/lib/api/offers'
import { ApiError, newIdempotencyKey, type ProgramEventPrecondition } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { useOfferDay } from '@/lib/useOfferDay'
import { t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { sameProgramEvent, type ProgramEventMaterial } from '@/lib/slotEventContext'

const CONFLICT_COPY: Record<string, string> = {
  offer_expired: 'Срок предложения истёк — запросите новое',
  offer_stale_date: 'Предложение на прежнюю дату — запросите заново',
  offer_superseded: 'Подрядчик изменил предложение — проверьте новые условия',
  request_closed: 'Запрос уже закрыт',
  offer_declined: 'Подрядчик отказался от запроса',
  slot_taken: 'Место уже занято — обновите предложения',
  date_taken: 'Эта дата у подрядчика уже занята',
  vendor_unavailable: 'Анкета подрядчика недоступна',
}
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rose-ink)]'

/** Mount with a wedding/offer key, so a new version is a new explicit intent. */
type AcceptanceProps = {
  weddingId: string
  request?: OfferRequest | OfferPublic
  currentWeddingDate: string | null
  weddingTz?: string | null
  eventContextKey?: string
  programEventContext?: ProgramEventPrecondition
  /** Actual current seven-field slot context; never decoded from an opaque key. */
  currentProgramEvent?: ProgramEventMaterial | null
  canAccept: boolean
  onChanged: () => void
  onRefreshFocus?: () => void
}
export function OfferAcceptance(props: AcceptanceProps) {
  const snapshot = props.request && 'id' in props.request ? props.request.programEvent : undefined
  const today = useOfferDay(snapshot ? snapshot.timeZone : props.weddingTz)
  const scope = JSON.stringify([props.weddingId, props.request, props.currentWeddingDate, props.weddingTz, props.canAccept, today, props.eventContextKey, props.programEventContext, props.currentProgramEvent])
  const key = useLegacySessionKey(scope)
  return <OfferAcceptanceForm key={key} {...props} scope={scope} today={today} />
}
function OfferAcceptanceForm({ weddingId, request, currentWeddingDate, canAccept, onChanged, onRefreshFocus, scope, today, programEventContext, currentProgramEvent }: AcceptanceProps & { scope: string; today: string }) {
  const attempt = useRef<string | null>(null)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [failure, setFailure] = useState<{ message: string; refresh: boolean } | null>(null)
  const failureId = useId()
  const submitButton = useRef<HTMLButtonElement>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const receipt = useRef<HTMLParagraphElement>(null)
  const restoreFocus = useRef(false)
  const full = request && 'id' in request ? request : null
  const offer = full?.offer
  const snapshot = full?.programEvent
  const legacyMainContext = !programEventContext && currentProgramEvent?.isMain !== false
  const currentContext = snapshot ? (sameProgramEvent(snapshot, currentProgramEvent)
    && (snapshot.isMain || (!!snapshot.timeZone && !!programEventContext && programEventContext.id === snapshot.id
      && programEventContext.date === snapshot.date && programEventContext.timeZone === snapshot.timeZone))) : legacyMainContext
  const eligible = canAccept && full?.status === 'open' && full.weddingDate === currentWeddingDate
    && currentContext && offer?.kind === 'offer' && offer.validUntil >= today
  const capture = useLegacyActionScope(JSON.stringify([scope, eligible, today]), weddingId)

  useLayoutEffect(() => {
    if (!restoreFocus.current) return
    restoreFocus.current = false
    if (document.activeElement === document.body) (refreshButton.current ?? receipt.current)?.focus()
  }, [accepted, failure])

  const accept = async () => {
    if (!eligible || !offer || busy.current || accepted || failure?.refresh) return
    const action = capture()
    if (!action.isCurrent()) return
    busy.current = true
    setPending(true)
    setFailure(null)
    attempt.current ??= newIdempotencyKey()
    try {
      await acceptOffer(weddingId, offer.id, attempt.current, { assertCurrent: action.assertCurrent, programEventContext })
      if (!action.isCurrent()) return
      restoreFocus.current = document.activeElement === submitButton.current
      setAccepted(true)
      onChanged()
    } catch (error) {
      if (!action.isCurrent()) return
      const conflict = error instanceof ApiError && CONFLICT_COPY[error.code]
      if (conflict) restoreFocus.current = document.activeElement === submitButton.current
      // Transport uncertainty and an in-progress request retain the original key.
      // A definitive application refusal allows a fresh intent after reloading.
      if (error instanceof ApiError && !error.isDown && error.code !== 'idempotency_in_progress') attempt.current = null
      setFailure({ message: conflict ? t(conflict) : explainError(error), refresh: Boolean(conflict) })
    } finally {
      if (action.isCurrent()) { busy.current = false; setPending(false) }
    }
  }

  if (accepted) return <p ref={receipt} role="status" tabIndex={-1} className={`text-[11px] text-[var(--sage-ink)] mt-2 ${focus}`}>{t('Бронь создана по условиям предложения')}</p>
  if (!eligible && !failure) return null
  return <div className="mt-2 space-y-2">
    {eligible && offer?.kind === 'offer' && offer.priceBreakdown && <p className="text-xs text-[var(--soft)]">
      {t('В бронь войдёт цена предложения {amount}. Доплаты показаны в оценке отдельно.').replace('{amount}', fmt(offer.price.amount))}
    </p>}
    <p role="status" className="sr-only">{pending && t('Принимаем…')}</p>
    {eligible && !failure?.refresh && <button ref={submitButton} type="button"
      aria-disabled={pending}
      onClick={() => void accept()}
      aria-label={`${t('Принять предложение')}: ${offer?.title ?? ''}`}
      className={`press px-4 py-2 rounded-xl grad text-[var(--on-grad)] text-[12px] font-semibold aria-disabled:opacity-50 ${focus}`}
    >{pending ? t('Принимаем…') : t('Принять')}</button>}
    {failure && <p id={failureId} role="alert" className="text-[11px] text-[var(--rose-ink)]">{failure.message}</p>}
    {failure?.refresh && <button ref={refreshButton} type="button" aria-describedby={failureId}
      onClick={event => {
        if (document.activeElement === event.currentTarget) onRefreshFocus?.()
        onChanged()
      }} className={`press px-3 py-2 rounded-xl bg-[var(--track)] text-[11px] font-semibold ${focus}`}>{t('Обновить предложения')}</button>}
  </div>
}
