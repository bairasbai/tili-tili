import { useState } from 'react'
import { Download } from 'lucide-react'
import { AsyncState, ready } from '@/components/AsyncState'
import { getVendorPayments, getVendorPaymentReceipt } from '@/lib/api/vendor'
import { explainError, useApi } from '@/lib/api/useApi'
import { key, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { formatWeddingDate } from '@/lib/weddingDate'

const METHODS = { cash: key('Наличные'), bank_transfer: key('Банковский перевод'), card: key('Карта'), other: key('Другое') }
const KINDS = { deposit: key('Аванс'), balance: key('Остаток'), refund: key('Возврат') }
const STATUSES = { recorded: key('Оплата отмечена'), confirmed: key('Оплата подтверждена'), cancelled: key('Оплата отменена') }

/** Сервер проверяет сделку, видимость платежа и принадлежность подтверждения вместе. */
export function VendorPaymentHistory({ dealId }: { dealId: string }) {
  const q = useApi(() => getVendorPayments(dealId), [dealId])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const download = async (paymentId: string, receiptId: string) => {
    if (busy) return
    setBusy(receiptId); setError(null)
    try {
      const file = await getVendorPaymentReceipt(dealId, paymentId, receiptId)
      const bytes = Uint8Array.from(atob(file.contentBase64), c => c.charCodeAt(0))
      const link = document.createElement('a'), objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }))
      link.href = objectUrl; link.download = file.filename
      // Firefox требует ссылку в DOM; немедленный revoke может оборвать скачивание.
      document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (e) { setError(explainError(e)) } finally { setBusy(null) }
  }

  return <section className="card p-5" aria-label={t('История платежей')}>
    <h2 className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('История платежей')}</h2>
    <AsyncState q={q} />
    {ready(q) && q.data?.length === 0 && <p className="text-[12px] text-[var(--soft)] mt-3">{t('Пара пока не поделилась платежами')}</p>}
    {ready(q) && <div className="mt-3 space-y-3">{q.data?.map(p => <article key={p.id} className="rounded-xl bg-[var(--bg)] p-3">
      <div className="flex justify-between gap-3 text-[12px]">
        <span>{t(KINDS[p.kind])}</span>
        <b className={p.status === 'cancelled' ? 'tabular line-through' : 'tabular'}>
          {p.amountKnown && p.amount ? fmt(p.kind === 'refund' ? -p.amount.amount : p.amount.amount) : t('Сумма не сохранена')}
        </b>
      </div>
      <p className="text-[11px] text-[var(--soft)] mt-1">{formatWeddingDate(p.paidOn)} · {t(METHODS[p.paymentMethod])}</p>
      <p className="text-[11px] text-[var(--soft)] mt-1">{t(STATUSES[p.status])}</p>
      {p.receipts.length > 0 && <div className="mt-2">
        <p className="text-[10.5px] text-[var(--soft)]">{t('Подтверждения оплаты')}</p>
        {p.receipts.map(r => <button key={r.id} type="button" disabled={busy !== null}
          aria-label={`${t('Скачать')} ${r.filename}`} onClick={() => void download(p.id, r.id)}
          className="press w-full min-h-11 flex items-center gap-2 text-left text-[11.5px] text-[var(--rose-deep)] disabled:opacity-50">
          <Download size={14} className="shrink-0" /><span className="break-all">{busy === r.id ? t('Секунду…') : r.filename}</span>
        </button>)}
      </div>}
    </article>)}</div>}
    {error && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] mt-2">{error}</p>}
  </section>
}
