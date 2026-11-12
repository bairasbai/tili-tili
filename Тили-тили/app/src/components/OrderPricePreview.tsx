import { useEffect, useRef, useState, type FormEvent } from 'react'
import { beginOrderAction, previewOrderPriceChange } from '@/lib/api/orders'
import { ApiError } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { normalizeOfferPriceQuantity, PRICE_COMPONENT_LABELS, PRICE_UNIT_LABELS,
  type PriceBreakdown, type PriceComponent } from '@/lib/offerPriceComponents'

type Kind = PriceComponent['kind']
type Draft = Partial<Record<Kind, string>>
type Preview = Awaited<ReturnType<typeof previewOrderPriceChange>>
type Result = { preview: Preview; changed: Kind[] }
const amountText = (money: PriceComponent['amount']) => money === null ? t('Не уточнено') : fmt(money.amount)

export function OrderPricePreview({ dealId, breakdown }: { dealId: string; breakdown?: PriceBreakdown }) {
  const [draft, setDraft] = useState<Draft>({})
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState(false)
  const pending = useRef<ReturnType<typeof beginOrderAction> | null>(null)
  useEffect(() => () => {
    pending.current?.close()
    pending.current = null
  }, [])

  const lines = breakdown?.components.flatMap(line => line.formula ? [{ kind: line.kind, formula: line.formula }] : []) ?? []
  async function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || closed) return
    setError(null)
    setResult(null)
    const changes: { kind: Kind; quantity: string }[] = []
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

    const action = beginOrderAction(() => {
      if (pending.current !== action) throw new Error('Order price preview closed')
    })
    pending.current = action
    setBusy(true)
    try {
      const preview = await previewOrderPriceChange(dealId, { changes }, { assertCurrent: action.assertCurrent })
      action.assertCurrent()
      setResult({ preview, changed: changes.map(line => line.kind) })
    } catch (cause) {
      if (pending.current !== action) return
      try { action.assertCurrent() } catch {
        setClosed(true)
        setError(t('Доступ к заказу изменился. Откройте раздел заново.'))
        return
      }
      if (cause instanceof ApiError && [401, 403, 404, 409, 410].includes(cause.status)) setClosed(true)
      setError(explainError(cause))
    } finally {
      if (pending.current === action) {
        action.close()
        pending.current = null
        setBusy(false)
      }
    }
  }

  return <details className="mt-3 rounded-xl border border-[var(--line)] p-3 text-xs">
    <summary className="cursor-pointer font-semibold">{t('Предпросмотр изменения цены')}</summary>
    {error && <p role="alert" className="mt-2 text-[var(--rose-ink)]">{error}</p>}
    {!closed && (lines.length === 0
      ? <p className="mt-2">{t('В принятом предложении нет расчётных доплат')}</p>
      : <form onSubmit={event => void calculate(event)} className="mt-2 space-y-3">
        <p>{t('Расчёт использует ставки принятого предложения. Цена договора и платежи сохраняются.')}</p>
        <fieldset disabled={busy} className="space-y-2">
          {lines.map(({ kind, formula }) => {
            const name = t(PRICE_COMPONENT_LABELS[kind])
            const quantity = formula.quantity?.replace('.', getI18nLang() === 'ru' ? ',' : '.') ?? t('Не уточнено')
            return <label key={kind} className="grid gap-1 sm:grid-cols-2">
              <span>
                <span className="block font-semibold">{name}</span>
                <span className="block text-[var(--soft)]">
                  {t('Текущее количество')} {quantity} ({t(PRICE_UNIT_LABELS[formula.unit])})
                </span>
                <span className="block text-[var(--soft)]">
                  {t('Ставка за единицу')} {amountText(formula.rate)}
                </span>
              </span>
              <input inputMode="decimal" value={draft[kind] ?? ''}
                className="min-h-11 w-full rounded-xl bg-[var(--bg)] px-3"
                placeholder={t('Новое количество')}
                aria-label={t('Новое количество для «{item}»').replace('{item}', name)}
                onChange={event => {
                  const value = event.target.value
                  setDraft(previous => ({ ...previous, [kind]: value }))
                  setResult(null)
                  setError(null)
                }} />
            </label>
          })}
          <button type="submit" disabled={!lines.some(({ kind }) => draft[kind]?.trim())}
            className="min-h-11 rounded-xl border border-[var(--line)] px-3 font-semibold disabled:opacity-60">
            {busy ? t('Рассчитываем…') : t('Рассчитать разницу')}
          </button>
        </fieldset>
        {result && <OrderPricePreviewResult result={result} />}
      </form>)}
  </details>
}

function OrderPricePreviewResult({ result: { preview, changed } }: { result: Result }) {
  const { current, proposed, difference } = preview
  const delta = difference?.amount
  const differenceText = delta === undefined ? t('Не уточнено')
    : (delta > 0 ? '+' : delta < 0 ? '−' : '') + fmt(Math.abs(delta))
  return <div aria-live="polite" className="space-y-2">
    <dl className="grid grid-cols-2 gap-1">
      <dt>{t('Текущая известная оценка')}</dt><dd className="tabular">{fmt(current.knownTotal.amount)}</dd>
      <dt>{t('Известная оценка с изменениями')}</dt><dd className="tabular">{fmt(proposed.knownTotal.amount)}</dd>
      <dt className="font-semibold">{t('Разница по изменённым позициям')}</dt><dd className="tabular font-semibold">{differenceText}</dd>
    </dl>
    {changed.map(kind => {
      const before = current.components.find(line => line.kind === kind)?.amount ?? null
      const after = proposed.components.find(line => line.kind === kind)?.amount ?? null
      return <p key={kind}>{t(PRICE_COMPONENT_LABELS[kind])} · {amountText(before)} → {amountText(after)}</p>
    })}
    {(current.unknownKinds.length > 0 || proposed.unknownKinds.length > 0)
      && <p className="text-[var(--rose-ink)]">{t('Неуточнённые доплаты могут увеличить итоговую сумму.')}</p>}
    {difference === null && <p>{t('Для сравнения изменённых позиций нужно уточнить исходное количество или ставку.')}</p>}
  </div>
}
