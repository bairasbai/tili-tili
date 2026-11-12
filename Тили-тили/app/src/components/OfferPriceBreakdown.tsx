import { fmt } from '@/lib/money'
import { getI18nLang, t } from '@/lib/i18n'
import { PRICE_COMPONENT_KINDS, PRICE_COMPONENT_LABELS, PRICE_COMPONENT_STATUSES, PRICE_UNIT_LABELS,
  type PriceBreakdown, type PriceComponent, type PriceComponentDraft, type PriceUnit } from '@/lib/offerPriceComponents'

const statuses = Object.keys(PRICE_COMPONENT_STATUSES) as PriceComponent['status'][]
const units = Object.keys(PRICE_UNIT_LABELS) as PriceUnit[]
const field = 'min-h-10 w-full rounded-xl bg-[var(--bg)] px-3 py-2 text-xs'

export function OfferPriceEditor({ value, onChange }: {
  value: PriceComponentDraft
  onChange: (value: PriceComponentDraft) => void
}) {
  return <details className="rounded-xl border border-[var(--line)] p-3">
    <summary className="cursor-pointer text-xs font-semibold">{t('Составляющие цены')}</summary>
    <p className="my-2 text-[11px] text-[var(--soft)]">{t('Для отдельной доплаты укажите сумму или расчёт по единицам, если данные известны.')}</p>
    <div className="space-y-3">
      {PRICE_COMPONENT_KINDS.map(kind => {
        const line = value[kind] ?? { status: 'unknown', amount: '' }
        const name = t(PRICE_COMPONENT_LABELS[kind])
        const formula = line.formula
        return <div key={kind} className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <label className="block text-xs font-medium">
            <span>{name}</span>
            <select className={field} value={line.status} onChange={event => {
              const status = event.target.value as PriceComponent['status']
              onChange({ ...value, [kind]: { status, amount: '' } })
            }}>
              {statuses.map(status => <option key={status} value={status}>{t(PRICE_COMPONENT_STATUSES[status])}</option>)}
            </select>
          </label>
          {line.status === 'separate' && <>
            <label className="block text-xs">
              <span>{t('Способ расчёта')}</span>
              <select className={field} value={formula ? 'formula' : 'fixed'}
                aria-label={t('Способ расчёта для «{item}»').replace('{item}', name)}
                onChange={event => onChange({ ...value, [kind]: {
                  status: line.status, amount: '',
                  ...(event.target.value === 'formula' && { formula: { unit: '', quantity: '', rate: '' } }),
                } })}>
                <option value="fixed">{t('Фиксированная сумма')}</option>
                <option value="formula">{t('Количество × ставка')}</option>
              </select>
            </label>
            {formula ? <div className="grid grid-cols-1 gap-1.5 sm:col-span-2 sm:grid-cols-3">
              <label className="block text-xs">
                <span>{t('Единица измерения')}</span>
                <select className={field} value={formula.unit}
                  aria-label={t('Единица измерения для «{item}»').replace('{item}', name)}
                  onChange={event => onChange({ ...value, [kind]: {
                    ...line, formula: { ...formula, unit: event.target.value as PriceUnit | '' },
                  } })}>
                  <option value="">{t('Выберите единицу')}</option>
                  {units.map(unit => <option key={unit} value={unit}>{t(PRICE_UNIT_LABELS[unit])}</option>)}
                </select>
              </label>
              <label className="block text-xs">
                <span>{t('Количество')}</span>
                <input className={field} inputMode="decimal" value={formula.quantity}
                  aria-label={t('Количество для «{item}»').replace('{item}', name)}
                  onChange={event => onChange({ ...value, [kind]: {
                    ...line, formula: { ...formula, quantity: event.target.value },
                  } })} />
              </label>
              <label className="block text-xs">
                <span>{t('Ставка за единицу, ₽')}</span>
                <input className={field} inputMode="decimal" value={formula.rate}
                  aria-label={t('Ставка для «{item}», ₽').replace('{item}', name)}
                  onChange={event => onChange({ ...value, [kind]: {
                    ...line, formula: { ...formula, rate: event.target.value },
                  } })} />
              </label>
            </div> : <label className="block text-xs sm:col-start-2">
              <span>{t('Сумма доплаты, ₽')}</span>
              <input className={field} inputMode="decimal" value={line.amount}
                aria-label={t('Сумма доплаты за «{item}», ₽').replace('{item}', name)}
                onChange={event => onChange({ ...value, [kind]: { ...line, amount: event.target.value } })} />
            </label>}
          </>}
        </div>
      })}
    </div>
  </details>
}

export function OfferPriceBreakdownView({ breakdown, historicalWarning = false }: {
  breakdown?: PriceBreakdown
  historicalWarning?: boolean
}) {
  if (!breakdown) return historicalWarning
    ? <p className="text-xs font-medium text-[var(--rose-ink)]">{t('Доплаты по составляющим пока не уточнены')}</p> : null
  const byKind = new Map(breakdown.components.map(line => [line.kind, line]))
  return <div className="space-y-1.5 text-xs">
    <p className="flex flex-wrap justify-between gap-1 font-semibold">
      <span>{t('Известная оценка предложения')}</span><span className="tabular">{fmt(breakdown.knownTotal.amount)}</span>
    </p>
    {breakdown.unknownKinds.length > 0 && <p className="font-medium text-[var(--rose-ink)]">
      {t('Неуточнённые доплаты могут увеличить итоговую сумму.')}
    </p>}
    <details>
      <summary className="cursor-pointer font-semibold">{t('Составляющие цены')}</summary>
      <dl className="mt-1 space-y-1">
        {PRICE_COMPONENT_KINDS.map(kind => {
          const line = byKind.get(kind)
          const label = t(PRICE_COMPONENT_STATUSES[line?.status ?? 'unknown'])
          const amount = line?.status === 'separate'
            ? line.amount ? fmt(line.amount.amount) : t('Сумма не уточнена') : null
          return <div key={kind} className="flex flex-wrap justify-between gap-x-2 border-b border-[var(--line)] py-1">
            <dt>{t(PRICE_COMPONENT_LABELS[kind])}</dt>
            <dd>
              {label}{amount === null ? '' : ` · ${amount}`}
              {line?.formula && <span className="mt-0.5 block text-[var(--soft)]">
                {t('Единица измерения')} {t(PRICE_UNIT_LABELS[line.formula.unit])}
                {' · ' + t('Количество')} {line.formula.quantity?.replace('.', getI18nLang() === 'ru' ? ',' : '.') ?? t('Не уточнено')}
                {' · ' + t('Ставка за единицу')} {line.formula.rate ? fmt(line.formula.rate.amount) : t('Не уточнено')}
              </span>}
            </dd>
          </div>
        })}
      </dl>
    </details>
  </div>
}
