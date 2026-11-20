import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { beginOrderAction, getOrder, previewOrderPriceChange, publishOrderPriceAmendment } from '@/lib/api/orders'
import { ApiError, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { useOrderLiveAccess } from '@/lib/useOrderLiveAccess'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { normalizeOfferPriceQuantity, PRICE_COMPONENT_LABELS, PRICE_UNIT_LABELS,
  type PriceBreakdown, type PriceComponent } from '@/lib/offerPriceComponents'

type Kind = PriceComponent['kind']
type Draft = Partial<Record<Kind, string>>
type Preview = Awaited<ReturnType<typeof previewOrderPriceChange>>
type Change = { kind: Kind; quantity: string }
type Result = { preview: Preview; changes: Change[] }
type Proposal = { body: Parameters<typeof publishOrderPriceAmendment>[1]; key: string }
const amountText = (money: PriceComponent['amount']) => money === null ? t('Не уточнено') : fmt(money.amount, getI18nLang())
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rose-ink)]'
const action = `min-h-11 rounded-xl border border-[var(--line)] px-3 font-semibold disabled:opacity-60 aria-disabled:opacity-60 ${focus}`
const accessLost = (error: unknown) => error instanceof ApiError
  && ([401, 403, 404, 410].includes(error.status) || error.code === 'price_preview_unavailable')
const accessChanged = () => t('Доступ к заказу изменился. Откройте раздел заново.')

export function OrderPricePreview({ dealId, breakdown, onPublished }: {
  dealId: string; breakdown?: PriceBreakdown; onPublished?: (termsId: string) => void
}) {
  const [draft, setDraft] = useState<Draft>({})
  const [result, setResult] = useState<Result | null>(null)
  const [retry, setRetry] = useState<Proposal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [closed, setClosed] = useState(false)
  const [published, setPublished] = useState<string | null>(null)
  const summary = useRef<HTMLElement>(null)
  const calculateButton = useRef<HTMLButtonElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const publishedLink = useRef<HTMLAnchorElement>(null)
  const focusAfterSend = useRef(false)
  const pending = useRef<ReturnType<typeof beginOrderAction> | null>(null)
  const reported = useRef<string | null>(null)
  const reportPublished = useEffectEvent((id: string) => onPublished?.(id))
  function revoke(message: string) {
    setDraft({}); setResult(null); setRetry(null); setPublished(null); setClosed(true)
    setError(message)
  }
  useEffect(() => {
    const close = () => { pending.current?.close(); pending.current = null }
    const invalidate = () => {
      close()
      setDraft({}); setResult(null); setRetry(null); setPublished(null); setBusy(false); setClosed(true)
      setError(accessChanged())
    }
    const changed = onSessionChanged(invalidate), expired = onSessionExpired(invalidate)
    return () => { close(); changed(); expired() }
  }, [])

  const access = useOrderLiveAccess(open && !closed, busy, async assertLatest => {
    const action = beginOrderAction(assertLatest)
    try {
      const order = await getOrder(dealId, { assertCurrent: action.assertCurrent })
      action.assertCurrent()
      if (order.dealId !== dealId) {
        revoke(accessChanged())
        return
      }
      setResult(null)
      setError(null)
    } finally {
      action.close()
    }
  }, cause => {
    if (accessLost(cause)) revoke(explainError(cause))
    else setError(explainError(cause))
  })
  const visible = !closed && access.online && !access.checking && !access.failed
  useLayoutEffect(() => {
    if (busy || !focusAfterSend.current) return
    focusAfterSend.current = false
    if (document.activeElement === document.body) {
      (publishedLink.current ?? retryButton.current ?? calculateButton.current ?? summary.current)?.focus()
    }
  }, [busy, retry, published, error, visible])
  useEffect(() => {
    if (!visible || !published || reported.current === published) return
    reported.current = published
    reportPublished(published)
  }, [published, visible])
  const lines = breakdown?.components.flatMap(line => line.formula ? [{ kind: line.kind, formula: line.formula }] : []) ?? []
  async function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || closed || retry || !access.canAct()) return
    setError(null)
    setResult(null)
    setPublished(null)
    const changes: Change[] = []
    for (const { kind } of lines) {
      const value = draft[kind]?.trim()
      if (!value) continue
      const quantity = normalizeOfferPriceQuantity(value)
      if (quantity === null) {
        setError(t('Проверьте новое количество для «{item}»').replace('{item}', t(PRICE_COMPONENT_LABELS[kind])))
        return
      }
      changes.push({ kind, quantity })
    }
    if (!changes.length) return
    await run(async check => {
      const preview = await previewOrderPriceChange(dealId, { changes }, { assertCurrent: check })
      check()
      if (access.canAct()) setResult({ preview, changes })
    })
  }

  async function propose(trigger: HTMLButtonElement) {
    const quote = result?.preview.amendment
    if (!quote || !result || !onPublished || retry || pending.current || closed || !access.canAct()) return
    await send({
      body: {
        expectedAgreementId: quote.agreementId, expectedOrderVersion: quote.orderVersion,
        expectedTermsRevision: quote.termsRevision, expectedAmount: quote.proposedPrice.amount, changes: result.changes,
      },
      key: newIdempotencyKey(),
    }, trigger)
  }

  async function send(proposal: Proposal, trigger?: HTMLButtonElement) {
    await run(async check => {
      focusAfterSend.current = document.activeElement === trigger
      setResult(null)
      const response = await publishOrderPriceAmendment(dealId, proposal.body, proposal.key, { assertCurrent: check })
      check()
      if (!response.selected || response.selected.id !== response.proposedTermsId) throw new Error('Missing price proposal')
      setRetry(null)
      setPublished(response.selected.id)
    }, proposal)
  }

  async function run(work: (assertCurrent: () => void) => Promise<void>, proposal?: Proposal) {
    if (pending.current || closed || !access.canAct()) return
    setError(null)
    const action = beginOrderAction(() => {
      if (pending.current !== action) throw new Error('Order price preview closed')
    })
    pending.current = action
    setBusy(true)
    try {
      await work(action.assertCurrent)
    } catch (cause) {
      if (pending.current !== action) return
      try { action.assertCurrent() } catch {
        revoke(accessChanged())
        return
      }
      if (accessLost(cause)) {
        revoke(explainError(cause))
        return
      }
      if (proposal) {
        const uncertain = !(cause instanceof ApiError) || cause.isDown || cause.code === 'idempotency_in_progress'
        setRetry(uncertain ? proposal : null)
        if (uncertain) return
      }
      setError(explainError(cause))
    } finally {
      if (pending.current === action) {
        action.close()
        pending.current = null
        setBusy(false)
      }
    }
  }

  return <details onToggle={event => setOpen(event.currentTarget.open)} className="mt-3 rounded-xl border border-[var(--line)] p-3 text-xs">
    <summary ref={summary} className={`cursor-pointer font-semibold ${focus}`}>{t('Предпросмотр изменения цены')}</summary>
    {!closed && !access.online && <p role="status" className="mt-2">{t('Нет связи с сервером')}</p>}
    {!closed && access.online && access.checking && <p role="status" className="mt-2">{t('Проверяем доступ к заказу…')}</p>}
    {error && (closed || (access.online && !access.checking)) && <p role="alert" className="mt-2 text-[var(--rose-ink)]">{error}</p>}
    {!closed && access.online && !access.checking && access.failed &&
      <button type="button" className="min-h-11 px-3 font-semibold" onClick={access.recheck}>{t('Повторить')}</button>}
    {visible && published && <p role="status" className="mt-2">
      <a ref={publishedLink} href="#order-terms" className={`font-semibold underline ${focus}`}>{t('Финансовая поправка опубликована. Откройте условия для согласования.')}</a>
    </p>}
    {visible && (lines.length === 0
      ? <p className="mt-2">{t('В принятом предложении нет расчётных доплат')}</p>
      : <form onSubmit={event => void calculate(event)} className="mt-2 space-y-3">
        <p>{t('Расчёт использует ставки принятого предложения. Цена договора и платежи сохраняются.')}</p>
        <fieldset disabled={busy || !!retry} className="space-y-2">
          {lines.map(({ kind, formula }) => {
            const name = t(PRICE_COMPONENT_LABELS[kind])
            const quantity = formula.quantity?.replace('.', getI18nLang() === 'ru' ? ',' : '.') ?? t('Не уточнено')
            return <label key={kind} className="grid gap-1 sm:grid-cols-2">
              <span>
                <span className="block font-semibold">{name}</span>
                <span className="block text-[var(--soft)]">
                  {t('Количество в исходном предложении')} {quantity} ({t(PRICE_UNIT_LABELS[formula.unit])})
                </span>
                <span className="block text-[var(--soft)]">
                  {t('Ставка за единицу')} {amountText(formula.rate)}
                </span>
              </span>
              <input inputMode="decimal" value={draft[kind] ?? ''}
                className={`min-h-11 w-full rounded-xl bg-[var(--bg)] px-3 ${focus}`}
                placeholder={t('Новое количество')}
                aria-label={t('Новое количество для «{item}»').replace('{item}', name)}
                onChange={event => {
                  if (!access.canAct() || pending.current || retry) return
                  const value = event.target.value
                  setDraft(previous => ({ ...previous, [kind]: value }))
                  setResult(null)
                  setError(null)
                }} />
            </label>
          })}
        </fieldset>
        <button ref={calculateButton} type="submit" disabled={!lines.some(({ kind }) => draft[kind]?.trim())}
          aria-disabled={busy || !!retry} className={action}>{t('Рассчитать разницу')}</button>
        <p role="status" className="sr-only">{busy && t('Обновляем…')}</p>
        {result && <OrderPricePreviewResult result={result} />}
        {result?.preview.amendment && onPublished && <button type="button" aria-disabled={busy} onClick={event => void propose(event.currentTarget)}
          className={action}>
          {t('Предложить новую цену')}
        </button>}
        {retry && <>
          <p role="status">{t('Ответ не получен. Проверьте результат тем же запросом.')}</p>
          <button ref={retryButton} type="button" aria-disabled={busy} onClick={event => void send(retry, event.currentTarget)}
            className={action}>
            {t('Проверить результат запроса')}
          </button>
        </>}
      </form>)}
  </details>
}

function OrderPricePreviewResult({ result: { preview, changes } }: { result: Result }) {
  const { current, proposed, difference, amendment } = preview
  const delta = difference?.amount
  const differenceText = delta === undefined ? t('Не уточнено')
    : (delta > 0 ? '+' : delta < 0 ? '−' : '') + fmt(Math.abs(delta), getI18nLang())
  return <div aria-live="polite" className="space-y-2">
    <dl className="grid grid-cols-2 gap-1">
      <dt>{t('Текущая известная оценка')}</dt><dd className="tabular">{amountText(current.knownTotal)}</dd>
      <dt>{t('Известная оценка с изменениями')}</dt><dd className="tabular">{amountText(proposed.knownTotal)}</dd>
      <dt className="font-semibold">{t('Разница по изменённым позициям')}</dt><dd className="tabular font-semibold">{differenceText}</dd>
      {amendment && <>
        <dt>{t('Действующая цена договора')}</dt><dd className="tabular">{amountText(amendment.currentPrice)}</dd>
        <dt>{t('Предлагаемая цена договора')}</dt><dd className="tabular font-semibold">{amountText(amendment.proposedPrice)}</dd>
      </>}
    </dl>
    {changes.map(({ kind }) => {
      const before = current.components.find(line => line.kind === kind)?.amount ?? null
      const after = proposed.components.find(line => line.kind === kind)?.amount ?? null
      return <p key={kind}>{t(PRICE_COMPONENT_LABELS[kind])} · {amountText(before)} → {amountText(after)}</p>
    })}
    {(current.unknownKinds.length > 0 || proposed.unknownKinds.length > 0)
      && <p className="text-[var(--rose-ink)]">{t('Неуточнённые доплаты могут увеличить итоговую сумму.')}</p>}
    {difference === null && <p>{t('Для сравнения изменённых позиций нужно уточнить исходное количество или ставку.')}</p>}
    {amendment && <p>{t('Новая цена вступит в силу после согласия пары и исполнителя.')}</p>}
  </div>
}
