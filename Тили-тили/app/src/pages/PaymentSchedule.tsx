import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { CalendarDays, Download, Plus, RefreshCw } from 'lucide-react'
import { TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { useStore } from '@/lib/store'
import { t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { noWedding, useApi, explainError } from '@/lib/api/useApi'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { parsePaymentRubles, paymentRubles } from '@/lib/paymentAmount'
import { addPaymentReceipt, createPaymentInstallment, deletePaymentReceipt, exportPaymentHistory, getPaymentReceipt, getPaymentSchedule, linkPaymentPlan, listPaymentReceipts, payInstallment,
  updatePaymentInstallment, type PaymentInstallment, type PaymentRecord, type PaymentScheduleData, type ScheduleFilter } from '@/lib/api/paymentSchedule'

const field = 'mt-1 w-full min-w-0 rounded-xl bg-[var(--bg)] px-3 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--rose)]'
const button = 'press min-h-11 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50'
const statusText = { pending: 'Ожидается', partial: 'Частично отмечено', paid: 'Отмечено полностью', cancelled: 'Отменён' }
type Editor = { mode: 'new' } | { mode: 'edit' | 'pay' | 'cancel'; item: PaymentInstallment } | { mode: 'link'; payment: PaymentRecord }
type Draft = { title: string; amount: string; due: string; dealId: string; installmentId: string; reason: string }
const empty: Draft = { title: '', amount: '', due: '', dealId: '', installmentId: '', reason: '' }

export default function PaymentSchedule() {
  const { weddingId } = useStore()
  // Changing weddings must not carry an old financial form or idempotency key over.
  return <ScheduleSession key={weddingId ?? 'none'} weddingId={weddingId} />
}

function ScheduleSession({ weddingId }: { weddingId: string | null }) {
  const [filter, setFilter] = useState<ScheduleFilter>({})
  const fingerprint = JSON.stringify(filter)
  const q = useApi(() => weddingId ? getPaymentSchedule(weddingId, filter) : noWedding(), [weddingId, fingerprint])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [draft, setDraft] = useState<Draft>(empty)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const writing = useRef(false)
  const retries = useRef(new Map<string, string>())
  const data = ready(q) ? q.data : null
  const disabled = busy || q.refreshing || !data || data.readOnly
  function open(next: Editor) {
    setError(null); setNotice(null); setEditor(next)
    if (next.mode === 'new') setDraft({ ...empty, dealId: data?.deals.find(d => d.canPlan)?.id ?? '', due: data?.range.from ?? '' })
    else if (next.mode === 'link') setDraft({ ...empty, installmentId: next.payment.installmentId ?? '' })
    else setDraft({ ...empty, title: next.item.title, due: next.item.due, dealId: next.item.dealId,
      amount: paymentRubles(next.mode === 'pay' ? next.item.remaining.amount : next.item.amount.amount) })
  }
  const change = (key: keyof Draft, value: string) => setDraft(current => ({ ...current, [key]: value }))
  async function write(tag: string, body: unknown, action: (key: string) => Promise<unknown>) {
    if (writing.current || disabled || !weddingId) return
    writing.current = true; setBusy(true); setError(null); setNotice(null)
    const attempt = weddingId + ':' + tag + ':' + JSON.stringify(body)
    let key = retries.current.get(attempt)
    if (!key) { key = newIdempotencyKey(); retries.current.set(attempt, key) }
    try {
      await action(key)
      retries.current.delete(attempt)
      if (editor && (editor.mode === 'new' || editor.mode === 'edit') && data && (draft.due < data.range.from || draft.due > data.range.to)) {
        setFilter({ ...filter, from: draft.due, to: draft.due })
      }
      setEditor(null); setNotice(t('Изменение сохранено')); q.reload()
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'stale_payment_plan'
        ? t('График изменился. Черновик сохранён: закройте форму, обновите данные и проверьте этап заново.')
        : explainError(e))
    } finally { writing.current = false; setBusy(false) }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!editor || !weddingId || disabled) return
    if (editor.mode === 'new' || editor.mode === 'edit' || editor.mode === 'pay') {
      const amount = parsePaymentRubles(draft.amount)
      if (amount === null) { setError(t('Введите сумму больше нуля, не более двух знаков после запятой')); return }
      const money = { amount, currency: 'RUB' as const }
      if (editor.mode === 'pay') {
        const body = { version: editor.item.version, amount: money }
        void write('pay:' + editor.item.id, body, key => payInstallment(weddingId, editor.item.id, body, key))
      } else {
        if (!draft.title.trim() || !draft.due || !draft.dealId) { setError(t('Заполните название, сумму, дату и сделку')); return }
        if (editor.mode === 'new') {
          const body = { title: draft.title.trim(), due: draft.due, dealId: draft.dealId, amount: money }
          void write('new', body, key => createPaymentInstallment(weddingId, body, key))
        } else {
          const body = { version: editor.item.version, title: draft.title.trim(), due: draft.due, amount: money }
          void write('edit:' + editor.item.id, body, key => updatePaymentInstallment(weddingId, editor.item.id, body, key))
        }
      }
    } else if (editor.mode === 'cancel') {
      const body = { version: editor.item.version, cancelled: true as const, reason: draft.reason.trim() }
      void write('cancel:' + editor.item.id, body, key => updatePaymentInstallment(weddingId, editor.item.id, body, key))
    } else if (editor.mode === 'link') {
      const body = { version: editor.payment.version, installmentId: draft.installmentId || null }
      void write('link:' + editor.payment.id, body, key => linkPaymentPlan(weddingId, editor.payment.id, body, key))
    }
  }
  async function download() {
    if (writing.current || !weddingId || !data) return
    writing.current = true; setBusy(true); setError(null)
    try {
      const file = await exportPaymentHistory(weddingId)
      const link = document.createElement('a'), objectUrl = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }))
      link.href = objectUrl; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (e) { setError(explainError(e)) } finally { writing.current = false; setBusy(false) }
  }
  return <div className="pb-28">
    <TopBar back fallback="/wedding/budget" title={t('График платежей')} sub={t('Сроки отдельно, деньги — без дублей')} />
    <div className="px-5 space-y-4 mt-3">
      <AsyncState q={q} forbiddenText={t('Финансовый раздел доступен только паре')} />
      {data && <>
        <FinancialSummary data={data} />
        <p className="text-xs leading-relaxed text-[var(--soft)]">{t('Отметка оплаты — запись о вашем переводе, не банковская операция. Плановые этапы не увеличивают бюджет.')}</p>
        {data.readOnly && <p role="status" className="card p-4 text-sm">{t('Свадьба отменена — история доступна только для чтения')}</p>}
        <div className="flex flex-wrap gap-2">
          <button className={button + ' grad text-[var(--on-grad)] flex items-center gap-2'} disabled={disabled || !data.deals.some(d => d.canPlan)} onClick={() => open({ mode: 'new' })}><Plus size={17} />{t('Добавить этап')}</button>
          <button className={button + ' bg-[var(--card)] flex items-center gap-2'} disabled={busy || q.refreshing} onClick={q.reload}><RefreshCw size={16} />{t('Обновить данные')}</button>
          <button className={button + ' bg-[var(--card)] flex items-center gap-2'} disabled={busy || q.refreshing} onClick={() => void download()}><Download size={16} />{t('История CSV')}</button>
        </div>
        {!data.deals.some(d => d.canPlan) && !data.readOnly && <p className="card p-4 text-sm">{t('Для графика нужна забронированная сделка с согласованной ценой.')} <Link to="/wedding" className="underline">{t('Команда подрядчиков')}</Link></p>}
        {data.summary.unallocated.amount !== 0 && <p role="status" className="card p-4 text-sm leading-relaxed">{t('Есть оплаты без активного этапа:')} <strong>{fmt(data.summary.unallocated.amount)}</strong>. {t('Привяжите их в истории, вместо того чтобы отмечать оплату повторно.')}</p>}
        {data.deals.filter(d => d.needsReview).map(d => <p role="status" key={d.id} className="card p-4 text-sm">{d.name}: {t('Цена сделки изменилась — проверьте суммы этапов. Автоматически они не уменьшены.')}</p>)}
        {editor && <form onSubmit={submit} className="card p-4 space-y-3" aria-label={t('Редактор платежа')}>
          <h2 className="font-bold text-base">{t(editor.mode === 'new' ? 'Новый этап' : editor.mode === 'pay' ? 'Отметить оплату' : editor.mode === 'link' ? 'Привязать оплату' : editor.mode === 'cancel' ? 'Отменить этап' : 'Изменить этап')}</h2>
          {(editor.mode === 'new' || editor.mode === 'edit') && <>
            <label className="block text-xs">{t('Сделка')}<select className={field} aria-label={t('Сделка')} value={draft.dealId} disabled={busy || editor.mode === 'edit'} onChange={e => change('dealId', e.target.value)} required>
              <option value="">{t('Выберите сделку')}</option>{data.deals.filter(d => d.canPlan).map(d => <option value={d.id} key={d.id}>{d.name} · {d.price ? fmt(d.price.amount) : t('Цена не задана')}</option>)}
            </select></label>
            <label className="block text-xs">{t('Название этапа')}<input className={field} value={draft.title} maxLength={200} disabled={busy} onChange={e => change('title', e.target.value)} required /></label>
            <label className="block text-xs">{t('Дата платежа')}<input type="date" className={field} value={draft.due} disabled={busy} onChange={e => change('due', e.target.value)} required /></label>
            <p className="text-xs text-[var(--soft)]">{t('Согласованная дата платежа не меняется при переносе свадьбы.')}</p>
          </>}
          {(editor.mode === 'new' || editor.mode === 'edit' || editor.mode === 'pay') && <label className="block text-xs">{t('Сумма, ₽')}<input className={field} inputMode="decimal" value={draft.amount} maxLength={24} disabled={busy} onChange={e => change('amount', e.target.value)} required /></label>}
          {editor.mode === 'pay' && <p className="text-xs leading-relaxed">{t('Отметьте только новый перевод. Прежние оплаты привязываются через историю. Можно внести часть суммы.')}</p>}
          {editor.mode === 'cancel' && <><p className="text-sm">{t('Отмена этапа убирает срок из графика, но не возвращает деньги и не удаляет оплаты.')}</p><label className="block text-xs">{t('Причина отмены')}<textarea className={field} value={draft.reason} maxLength={500} disabled={busy} onChange={e => change('reason', e.target.value)} /></label></>}
          {editor.mode === 'link' && <><p className="text-xs">{t('Одна отметка привязывается целиком к одному этапу своей сделки. Новая оплата не создаётся.')}</p><label className="block text-xs">{t('Этап платежа')}<select className={field} value={draft.installmentId} disabled={busy} onChange={e => change('installmentId', e.target.value)}>
            <option value="">{t('Без привязки')}</option>{data.allInstallments.filter(i => i.dealId === editor.payment.dealId && (i.status !== 'cancelled' || i.id === editor.payment.installmentId)).map(i => <option key={i.id} value={i.id} disabled={i.status === 'cancelled'}>{i.title}{i.status === 'cancelled' ? ` · ${t('Отменён')}` : ''}</option>)}
          </select></label></>}
          <div className="flex gap-2"><button type="submit" disabled={disabled} className={button + ' grad text-[var(--on-grad)]'}>{t(busy ? 'Сохраняем…' : 'Сохранить')}</button><button type="button" disabled={busy} className={button} onClick={() => { setEditor(null); setError(null) }}>{t('Закрыть')}</button></div>
        </form>}
      </>}
      {error && <p role="alert" className="card p-4 text-sm text-[var(--rose-deep)]">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {data && <>
        <Filters key={fingerprint + data.range.from + data.range.to} data={data} busy={busy || q.refreshing} apply={setFilter} />
        <div className="flex items-center justify-between gap-2"><h2 className="text-base font-bold flex items-center gap-2"><CalendarDays size={18} />{t('Платежи по датам')}</h2><span className="text-sm font-semibold tabular">{fmt(data.dueInWindow.amount)}</span></div>
        <p className="text-xs text-[var(--soft)]">{t('Остаток выбранных этапов, включая включённые просрочки. Непривязанные оплаты здесь ещё не вычтены.')}</p>
        {!data.items.length && <p className="card p-5 text-sm">{t('Нет этапов по выбранному фильтру')}</p>}
        {data.items.map(item => <section className="card p-4 space-y-2" key={item.id} aria-label={item.title}>
          <div className="flex justify-between items-start gap-3"><div className="min-w-0"><h3 className="font-bold break-words">{item.title}</h3><p className="text-xs text-[var(--soft)] break-words">{data.deals.find(d => d.id === item.dealId)?.name}</p></div><time className="text-xs whitespace-nowrap" dateTime={item.due}>{item.due}</time></div>
          <p className="text-xs font-semibold text-[var(--rose-deep)]">{t(statusText[item.status])}{item.overdue ? ` · ${t('Просрочено')}` : ''}</p>
          <dl className="grid grid-cols-3 gap-2 text-xs"><div><dt>{t('План этапа')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.amount.amount)}</dd></div><div><dt>{t('Отмечено')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.paid.amount)}</dd></div><div><dt>{t('Остаток')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.remaining.amount)}</dd></div></dl>
          {item.cancelReason && <p className="text-xs break-words">{item.cancelReason}</p>}
          {item.status !== 'cancelled' && <div className="flex flex-wrap gap-1 pt-1">
            <button className={button + ' bg-[var(--sage-soft)]'} disabled={disabled || item.remaining.amount <= 0} onClick={() => open({ mode: 'pay', item })}>{t('Отметить оплату')}</button>
            <button className={button} disabled={disabled} onClick={() => open({ mode: 'edit', item })}>{t('Изменить')}</button>
            <button className={button} disabled={disabled} onClick={() => open({ mode: 'cancel', item })}>{t('Отменить этап')}</button>
          </div>}
        </section>)}
        <details className="card p-4"><summary className="cursor-pointer font-bold py-1">{t('История оплат')} · {data.payments.length}</summary>
          <p className="text-xs text-[var(--soft)] my-3">{t('Все отметки по сделкам, в том числе отменённым. Возвраты вычитаются, отменённые отметки не входят в итог.')}</p>
          {!data.payments.length && <p className="text-sm">{t('Отметок оплат пока нет')}</p>}
          {data.payments.map(p => <div key={p.id} className="border-t border-[var(--line)] py-3 space-y-1">
            <p className="text-sm font-semibold">{data.deals.find(d => d.id === p.dealId)?.name} · {p.kind === 'refund' ? '−' : ''}{fmt(p.amount.amount)}</p>
            <p className="text-xs text-[var(--soft)]">{p.createdAt.slice(0,10)} · {t(p.status === 'cancelled' ? 'Отметка отменена' : p.kind === 'refund' ? 'Возврат' : 'Отмечено')}</p>
            <p className="text-xs">{data.allInstallments.find(i => i.id === p.installmentId)?.title ?? t('Без привязки')}</p>
            {p.status !== 'cancelled' && <button className={button} disabled={disabled} onClick={() => open({ mode: 'link', payment: p })}>{t('Привязать оплату')}</button>}
            <ReceiptPanel weddingId={weddingId!} paymentId={p.id} disabled={disabled} />
          </div>)}
        </details>
        <Link className="block text-sm underline py-2" to="/wedding/budget">{t('К бюджету свадьбы')}</Link>
      </>}
    </div>
  </div>
}

function FinancialSummary({ data }: { data: PaymentScheduleData }) {
  return <section className="card p-4" aria-label={t('Итоги по активным сделкам')}>
    <h2 className="font-bold text-sm mb-3">{t('Итоги по активным сделкам')}</h2>
    <dl className="grid grid-cols-1 min-[360px]:grid-cols-3 gap-3 text-xs">
      {[['Обязательства', data.summary.committed], ['Отмечено оплат', data.summary.recorded], ['Осталось по сделкам', data.summary.remaining]].map(([label, value]) => typeof value !== 'string' && <div key={String(label)}><dt className="text-[var(--soft)]">{t(String(label))}</dt><dd className="text-base font-bold mt-1 tabular break-words">{fmt(value.amount)}</dd></div>)}
    </dl>
    {data.summary.unknownPrices > 0 && <p className="text-xs mt-3">{t('Не все цены заданы — итог неполный:')} {data.summary.unknownPrices}</p>}
    {data.summary.inactiveDealRecorded.amount !== 0 && <p className="text-xs mt-3">{t('Нетто оплат по неактивным сделкам:')} {fmt(data.summary.inactiveDealRecorded.amount)}</p>}
  </section>
}
function Filters({ data, busy, apply }: { data: PaymentScheduleData; busy: boolean; apply: (v: ScheduleFilter) => void }) {
  const [from, setFrom] = useState(data.range.from), [to, setTo] = useState(data.range.to)
  const [overdue, setOverdue] = useState(data.range.includeOverdue), [cancelled, setCancelled] = useState(data.range.includeCancelled)
  return <form className="card p-4 space-y-3" aria-label={t('Период платежей')} onSubmit={event => { event.preventDefault(); apply({ from, to, includeOverdue: overdue, includeCancelled: cancelled }) }}>
    <div className="grid grid-cols-2 gap-3"><label className="text-xs min-w-0">{t('С даты')}<input required className={field} type="date" value={from} onChange={e => setFrom(e.target.value)} disabled={busy} /></label><label className="text-xs min-w-0">{t('По дату')}<input required className={field} type="date" value={to} onChange={e => setTo(e.target.value)} disabled={busy} /></label></div>
    <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={overdue} onChange={e => setOverdue(e.target.checked)} disabled={busy} />{t('Добавить просроченные')}</label>
    <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={cancelled} onChange={e => setCancelled(e.target.checked)} disabled={busy} />{t('Показать отменённые')}</label>
    <div className="flex flex-wrap justify-between items-center gap-2"><span className="text-xs text-[var(--soft)]">{data.range.timeZone}</span><button className={button} disabled={busy} type="submit">{t('Применить период')}</button></div>
  </form>
}

function ReceiptPanel({ weddingId, paymentId, disabled }: { weddingId: string; paymentId: string; disabled: boolean }) {
  const q = useApi(() => listPaymentReceipts(weddingId, paymentId), [weddingId, paymentId])
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  /* Список — только из ответа сервера. Пока его нет, счётчика нет: «· 0» при
     загрузке или ошибке читался бы как «подтверждений нет» (R-178). */
  const items = ready(q) && q.data ? q.data.items : null
  const upload = async (file: File | undefined) => {
    if (!file || busy || disabled) return
    setError(null)
    if (file.size > 524288) { setError(t('Файл должен быть не больше 512 КБ')); return }
    const allowed = ['application/pdf','image/jpeg','image/png','image/webp'] as const
    if (!allowed.includes(file.type as typeof allowed[number])) { setError(t('Разрешены PDF, JPEG, PNG и WebP')); return }
    setBusy(true)
    try {
      const raw = new Uint8Array(await file.arrayBuffer())
      let binary = ''; for (let i=0;i<raw.length;i+=0x8000) binary += String.fromCharCode(...raw.subarray(i,i+0x8000))
      // Deterministic per payment+content: if the response is lost and the same file is selected again,
      // the server replays the first result instead of storing a duplicate receipt.
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
      const fingerprint = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
      await addPaymentReceipt(weddingId,paymentId,{filename:file.name,mimeType:file.type as typeof allowed[number],contentBase64:btoa(binary)},`receipt-${paymentId}-${fingerprint}`)
      q.reload()
    } catch(e) { setError(explainError(e)) } finally { setBusy(false) }
  }
  const download = async (id: string) => {
    if (busy) return; setBusy(true); setError(null)
    try {
      const file=await getPaymentReceipt(weddingId,paymentId,id), binary=atob(file.contentBase64)
      const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i)
      const href=URL.createObjectURL(new Blob([bytes],{type:file.mimeType}))
      const a=document.createElement('a');a.href=href;a.download=file.filename;a.click();URL.revokeObjectURL(href)
    } catch(e){setError(explainError(e))} finally{setBusy(false)}
  }
  const remove = async(id:string) => { if(busy)return;setBusy(true);setError(null);try{await deletePaymentReceipt(weddingId,paymentId,id);q.reload()}catch(e){setError(explainError(e))}finally{setBusy(false)} }
  return <details className="mt-2"><summary className="text-xs cursor-pointer">{t('Подтверждения оплаты')}{' '}{items ? `· ${items.length}` : ''}</summary>
    <div className="mt-2 space-y-2"><label className={button+' inline-flex items-center cursor-pointer bg-[var(--bg)]'}>{busy ? t('Загрузка…') : t('Прикрепить файл')}<input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={disabled||busy||!items||items.length>=5} onChange={e=>void upload(e.target.files?.[0])}/></label>
      <p className="text-[10px] text-[var(--soft)]">{t('Только для пары · до 512 КБ · максимум 5 файлов')}</p>
      <AsyncState q={q} />
      {items?.map(r=><div key={r.id} className="flex gap-2 items-center text-xs"><span className="min-w-0 flex-1 truncate">{r.filename}</span><button className="underline" disabled={busy} onClick={()=>void download(r.id)}>{t('Скачать')}</button><button className="underline text-[var(--rose-deep)]" disabled={busy} onClick={()=>void remove(r.id)}>{t('Удалить')}</button></div>)}
      {error&&<p role="alert" className="text-xs text-[var(--rose-deep)]">{error}</p>}
    </div></details>
}
