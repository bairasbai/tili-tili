import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { CalendarDays, Download, Plus, RefreshCw } from 'lucide-react'
import { TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { useStore } from '@/lib/store'
import { t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'
import { fmt } from '@/lib/money'
import { noWedding, useApi, explainError } from '@/lib/api/useApi'
import { ApiError, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { PaymentAmendmentHistory, PaymentCorrectionEditor, type PaymentCorrectionAttempt, type PaymentCorrectionDraft } from '@/components/PaymentAmendments'
import { parsePaymentRubles, paymentRubles } from '@/lib/paymentAmount'
import { paymentStatusLabel } from '@/lib/paymentEvidence'
import { addPaymentReceipt, createPaymentInstallment, deletePaymentReceipt, exportPaymentHistory, getPaymentReceipt, getPaymentSchedule, linkPaymentPlan, listPaymentReceipts, payInstallment,
  updatePaymentInstallment, type PaymentInstallment, type PaymentRecord, type PaymentScheduleData, type ScheduleFilter } from '@/lib/api/paymentSchedule'

const field = 'mt-1 w-full min-w-0 rounded-xl bg-[var(--bg)] px-3 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--rose)]'
const button = 'press min-h-11 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50'
/* covered — этап закрыт отметками сделки без привязки (ревью 018, M-01): деньги отмечены, но не к этому этапу. */
const statusText = { pending: 'Ожидается', partial: 'Частично отмечено', paid: 'Отмечено полностью', covered: 'Покрыто оплатами сделки', cancelled: 'Отменён' }
const methodText = { cash: 'Наличные', bank_transfer: 'Банковский перевод', card: 'Карта', other: 'Другое' } as const
const visibilityText = { private: 'Только мы', finance_members: 'Участники с доступом к финансам', vendor: 'Подрядчик этой сделки' } as const
type Editor = { mode: 'new' } | { mode: 'edit' | 'pay' | 'cancel'; item: PaymentInstallment } | { mode: 'link'; payment: PaymentRecord }
type Draft = {
  title: string; amount: string; due: string; dealId: string; installmentId: string; reason: string
  amountKnown: boolean; paymentMethod: 'cash'|'bank_transfer'|'card'|'other'
  visibility: 'private'|'finance_members'|'vendor'; paidOn: string
}
const empty: Draft = {
  title:'',amount:'',due:'',dealId:'',installmentId:'',reason:'',
  amountKnown:true,paymentMethod:'other',visibility:'private',paidOn:'',
}
type TextDraftKey = 'title'|'amount'|'due'|'dealId'|'installmentId'|'reason'|'paidOn'
const DAY = 86_400_000
/* Скачивание — ссылкой в документе, адрес отзывается позже: без вставки в DOM Firefox
   ссылку не нажимает, а отзыв сразу после click() обрывает скачивание (ревью 018, BF-07). */
function saveFile(blob: Blob, filename: string) {
  const link = document.createElement('a'), objectUrl = URL.createObjectURL(blob)
  link.href = objectUrl; link.download = filename; document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

export default function PaymentSchedule() {
  const { weddingId } = useStore()
  const [expired, setExpired] = useState(false)
  useEffect(() => { const clear = () => setExpired(true), a = onSessionChanged(clear), b = onSessionExpired(clear); return () => { a(); b() } }, [])
  if (expired) return <p role="alert" className="p-5 text-sm">{t('Сессия изменилась — откройте финансовый раздел снова')}</p>
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
  const [denied, setDenied] = useState(false)
  const [correctionAttempts,setCorrectionAttempts]=useState<Record<string,PaymentCorrectionAttempt>>({})
  const [correctionDrafts,setCorrectionDrafts]=useState<Record<string,PaymentCorrectionDraft>>({})
  const rememberCorrection=(id:string,attempt:PaymentCorrectionAttempt|null)=>setCorrectionAttempts(old=>{
    const next={...old};if(attempt)next[id]=attempt;else delete next[id];return next
  })
  const rememberDraft=(id:string,draft:PaymentCorrectionDraft|null)=>setCorrectionDrafts(old=>{
    const next={...old};if(draft)next[id]=draft;else delete next[id];return next
  })
  const writing = useRef(false)
  const retries = useRef(new Map<string, string>())
  /* Действия, получившие 409 «график изменился»: данные перечитаны, черновик остался в
     форме, и следующая отправка идёт с версией из свежих данных — не по кругу со старой
     (ревью 018, F-05). Пара видит обновлённую карточку до повторного «Сохранить». */
  const staleSeen = useRef(new Set<string>())
  const formRef = useRef<HTMLFormElement>(null)
  const data = !denied && ready(q) ? q.data : null
  const revoke = () => { setDenied(true); setEditor(null); setDraft(empty); setCorrectionAttempts({}); setCorrectionDrafts({}); retries.current.clear(); q.reload() }
  useEffect(()=>{
    if(q.failure&&[401,403,404].includes(q.failure.status)){
      setDenied(true);setEditor(null);setDraft(empty);setCorrectionAttempts({});setCorrectionDrafts({});retries.current.clear()
    }
  },[q.failure])
  const disabled = busy || q.refreshing || !data || data.readOnly
  /* Форма рисуется над списком: без прокрутки «Отметить оплату» у нижней карточки
     выглядело нерабочим (ревью 018, F-10). */
  useEffect(() => {
    if (!editor) return
    const form = formRef.current
    form?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    form?.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true })
  }, [editor])
  function open(next: Editor) {
    setError(null); setNotice(null); setEditor(next)
    if (next.mode === 'new') setDraft({ ...empty, dealId: data?.deals.find(d => d.canPlan)?.id ?? '', due: data?.range.from ?? '' })
    else if (next.mode === 'link') setDraft({ ...empty, installmentId: next.payment.installmentId ?? '' })
    else setDraft({ ...empty, title: next.item.title, due: next.item.due, dealId: next.item.dealId,
      amount: paymentRubles(next.mode === 'pay' ? next.item.remaining.amount : next.item.amount.amount),
      paidOn: next.mode === 'pay' ? (data?.range.today ?? '') : '' })
  }
  const change = (key: TextDraftKey, value: string) => setDraft(current => ({ ...current, [key]: value }))
  /* «Сохранить» без изменений писал в журнал, поднимал версию и сообщал «сохранено»
     (ревью 018, F-11). */
  const unchanged = !!editor && (
    (editor.mode === 'edit' && draft.title.trim() === editor.item.title && draft.due === editor.item.due
      && parsePaymentRubles(draft.amount) === editor.item.amount.amount)
    || (editor.mode === 'link' && (draft.installmentId || null) === editor.payment.installmentId))
  async function write(tag: string, body: unknown, action: (key: string) => Promise<unknown>) {
    if (writing.current || disabled || !weddingId) return
    writing.current = true; setBusy(true); setError(null); setNotice(null)
    const attempt = weddingId + ':' + tag + ':' + JSON.stringify(body)
    let key = retries.current.get(attempt)
    if (!key) { key = newIdempotencyKey(); retries.current.set(attempt, key) }
    try {
      await action(key)
      retries.current.delete(attempt)
      staleSeen.current.delete(tag)
      /* Фильтр сужается, только если этап иначе пропадёт из вида: просроченный этап
         виден и вне окна, пока включены просрочки (ревью 018, F-12). */
      const visibleAnyway = !!data && data.range.includeOverdue && draft.due < data.range.today
      if (editor && (editor.mode === 'new' || editor.mode === 'edit') && data && !visibleAnyway && (draft.due < data.range.from || draft.due > data.range.to)) {
        setFilter({ ...filter, from: draft.due, to: draft.due })
      }
      setEditor(null); setNotice(t('Изменение сохранено')); q.reload()
    } catch (e) {
      if(e instanceof ApiError&&[401,403,404].includes(e.status)){revoke();return}
      if (e instanceof ApiError && e.code === 'stale_payment_plan') {
        staleSeen.current.add(tag)
        q.reload()
        setError(t('График изменился — данные обновлены. Черновик остался в форме: проверьте этап и сохраните ещё раз.'))
      } else setError(explainError(e))
    } finally { writing.current = false; setBusy(false) }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!editor || !weddingId || disabled) return
    const stageVersion = (item: PaymentInstallment, tag: string) =>
      staleSeen.current.has(tag) ? (data?.items.find(i => i.id === item.id)?.version ?? item.version) : item.version
    if (editor.mode === 'new' || editor.mode === 'edit' || editor.mode === 'pay') {
      if (editor.mode === 'pay') {
        let amount: number | null = null
        if (draft.amountKnown) {
          amount = parsePaymentRubles(draft.amount)
          if (amount === null) { setError(t('Введите сумму больше нуля, не более двух знаков после запятой')); return }
        }
        const paidOn = draft.paidOn || data!.range.today
        const body = {
          version: stageVersion(editor.item, 'pay:' + editor.item.id),
          amountKnown: draft.amountKnown,
          paymentMethod: draft.paymentMethod,
          visibility: draft.visibility,
          paidOn,
          ...(draft.amountKnown ? { amount: { amount: amount!, currency: 'RUB' as const } } : {}),
        }
        void write('pay:' + editor.item.id, body, key => payInstallment(weddingId, editor.item.id, body, key))
      } else {
        const amount = parsePaymentRubles(draft.amount)
        if (amount === null) { setError(t('Введите сумму больше нуля, не более двух знаков после запятой')); return }
        const money = { amount, currency: 'RUB' as const }
        if (!draft.title.trim() || !draft.due || !draft.dealId) { setError(t('Заполните название, сумму, дату и сделку')); return }
        if (editor.mode === 'new') {
          const body = { title: draft.title.trim(), due: draft.due, dealId: draft.dealId, amount: money }
          void write('new', body, key => createPaymentInstallment(weddingId, body, key))
        } else {
          const body = { version: stageVersion(editor.item, 'edit:' + editor.item.id), title: draft.title.trim(), due: draft.due, amount: money }
          void write('edit:' + editor.item.id, body, key => updatePaymentInstallment(weddingId, editor.item.id, body, key))
        }
      }
    } else if (editor.mode === 'cancel') {
      // Пустую причину не шлём: в базе ей место — null, а не пустая строка (ревью 018, F-13).
      const reason = draft.reason.trim()
      const body = { version: stageVersion(editor.item, 'cancel:' + editor.item.id), cancelled: true as const, ...(reason ? { reason } : {}) }
      void write('cancel:' + editor.item.id, body, key => updatePaymentInstallment(weddingId, editor.item.id, body, key))
    } else if (editor.mode === 'link') {
      const tag = 'link:' + editor.payment.id
      const version = staleSeen.current.has(tag) ? (data?.payments.find(p => p.id === editor.payment.id)?.version ?? editor.payment.version) : editor.payment.version
      const body = { version, installmentId: draft.installmentId || null }
      void write('link:' + editor.payment.id, body, key => linkPaymentPlan(weddingId, editor.payment.id, body, key))
    }
  }
  async function download() {
    if (writing.current || !weddingId || !data) return
    writing.current = true; setBusy(true); setError(null)
    try {
      const file = await exportPaymentHistory(weddingId)
      saveFile(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }), file.filename)
    } catch (e) { setError(explainError(e)) } finally { writing.current = false; setBusy(false) }
  }
  return <div className="pb-28">
    <TopBar back fallback="/wedding/budget" title={t('График платежей')} sub={t('Сроки платежей по сделкам')} />
    <div className="px-5 space-y-4 mt-3">
      <AsyncState q={q} forbiddenText={t('Финансовый раздел доступен только паре')} />
      {denied && <p role="alert" className="text-sm">{t('Доступ к финансовой истории изменился — откройте раздел снова')}</p>}
      {/* Отказ по периоду прятал и сам фильтр — выбраться можно было только уходом с
          экрана (ревью 018, F-02). */}
      {!data && !q.loading && Object.keys(filter).length > 0 && <button className={button + ' bg-[var(--card)]'} onClick={() => setFilter({})}>{t('Сбросить период')}</button>}
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
        {editor && <form ref={formRef} onSubmit={submit} className="card p-4 space-y-3" aria-label={t('Редактор платежа')}>
          <h2 className="font-bold text-base">{t(editor.mode === 'new' ? 'Новый этап' : editor.mode === 'pay' ? 'Отметить оплату' : editor.mode === 'link' ? 'Привязать оплату' : editor.mode === 'cancel' ? 'Отменить этап' : 'Изменить этап')}</h2>
          {(editor.mode === 'new' || editor.mode === 'edit') && <>
            <label className="block text-xs">{t('Сделка')}<select className={field} aria-label={t('Сделка')} value={draft.dealId} disabled={busy || editor.mode === 'edit'} onChange={e => change('dealId', e.target.value)} required>
              <option value="">{t('Выберите сделку')}</option>{data.deals.filter(d => d.canPlan).map(d => <option value={d.id} key={d.id}>{d.name} · {d.price ? fmt(d.price.amount) : t('Цена не задана')}</option>)}
            </select></label>
            <label className="block text-xs">{t('Название этапа')}<input className={field} value={draft.title} maxLength={200} disabled={busy} onChange={e => change('title', e.target.value)} required /></label>
            <label className="block text-xs">{t('Дата платежа')}<input type="date" className={field} value={draft.due} disabled={busy} onChange={e => change('due', e.target.value)} required /></label>
            <p className="text-xs text-[var(--soft)]">{t('Согласованная дата платежа не меняется при переносе свадьбы.')}</p>
          </>}
          {(editor.mode === 'new' || editor.mode === 'edit' || (editor.mode === 'pay' && draft.amountKnown)) && <label className="block text-xs">{t('Сумма, ₽')}<input className={field} inputMode="decimal" value={draft.amount} maxLength={24} disabled={busy} onChange={e => change('amount', e.target.value)} required /></label>}
          {editor.mode === 'pay' && <>
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold">{t('Сохранять сумму?')}</legend>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="amount-known" checked={draft.amountKnown} disabled={busy} onChange={() => setDraft(v => ({...v,amountKnown:true}))} />{t('Сумма известна')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="amount-known" checked={!draft.amountKnown} disabled={busy} onChange={() => setDraft(v => ({...v,amountKnown:false,amount:''}))} />{t('Сумма не сохранена')}</label>
            </fieldset>
            {!draft.amountKnown && <p role="status" className="rounded-xl bg-[var(--honey)] p-3 text-xs leading-relaxed">{t('Сумма не сохранена. Фактические расходы и остаток бюджета могут быть неполными.')}</p>}
            <label className="block text-xs">{t('Способ оплаты')}<select className={field} value={draft.paymentMethod} disabled={busy} onChange={e => setDraft(v => ({...v,paymentMethod:e.target.value as Draft['paymentMethod']}))}>
              <option value="cash">{t('Наличные')}</option><option value="bank_transfer">{t('Банковский перевод')}</option><option value="card">{t('Карта')}</option><option value="other">{t('Другое')}</option>
            </select></label>
            <label className="block text-xs">{t('Дата фактической оплаты')}<input type="date" className={field} value={draft.paidOn} disabled={busy} onChange={e => change('paidOn',e.target.value)} required /></label>
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold">{t('Кто видит детали оплаты?')}</legend>
              {([['private','Только мы'],['finance_members','Участники с доступом к финансам'],['vendor','Подрядчик этой сделки']] as const).map(([value,label]) =>
                <label key={value} className="flex items-center gap-2 text-sm"><input type="radio" name="payment-visibility" checked={draft.visibility===value} disabled={busy} onChange={() => setDraft(v => ({...v,visibility:value}))} />{t(label)}</label>)}
            </fieldset>
            <p className="text-xs leading-relaxed text-[var(--soft)]">{t('Оплата отмечается вручную. Tili-tili сохраняет вашу запись и не переводит деньги подрядчику.')}</p>
            <p className="text-xs leading-relaxed">{t('Отметьте только новый платёж. Прежние оплаты привязываются через историю. Можно внести часть суммы.')}</p>
          </>}
          {editor.mode === 'cancel' && <><p className="text-sm">{t('Отмена этапа убирает срок из графика, но не возвращает деньги и не удаляет оплаты.')}</p><label className="block text-xs">{t('Причина отмены')}<textarea className={field} value={draft.reason} maxLength={500} disabled={busy} onChange={e => change('reason', e.target.value)} /></label></>}
          {editor.mode === 'link' && <><p className="text-xs">{t('Одна отметка привязывается целиком к одному этапу своей сделки. Новая оплата не создаётся.')}</p><label className="block text-xs">{t('Этап платежа')}<select className={field} value={draft.installmentId} disabled={busy} onChange={e => change('installmentId', e.target.value)}>
            <option value="">{t('Без привязки')}</option>{data.allInstallments.filter(i => i.dealId === editor.payment.dealId && (i.status !== 'cancelled' || i.id === editor.payment.installmentId)).map(i => <option key={i.id} value={i.id} disabled={i.status === 'cancelled'}>{i.title}{i.status === 'cancelled' ? ` · ${t('Отменён')}` : ` · ${t('остаток')} ${fmt(i.remaining.amount)}`}</option>)}
          </select></label></>}
          <div className="flex gap-2"><button type="submit" disabled={disabled || unchanged} className={button + ' grad text-[var(--on-grad)]'}>{busy ? t('Сохраняем…') : t('Сохранить')}</button><button type="button" disabled={busy} className={button} onClick={() => { setEditor(null); setError(null) }}>{t('Закрыть')}</button></div>
        </form>}
      </>}
      {error && <p role="alert" className="card p-4 text-sm text-[var(--rose-deep)]">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {data && <>
        <Filters key={fingerprint + data.range.from + data.range.to} data={data} busy={busy || q.refreshing} apply={setFilter} />
        <div className="flex items-center justify-between gap-2"><h2 className="text-base font-bold flex items-center gap-2"><CalendarDays size={18} />{t('Платежи по датам')}</h2><span className="text-sm font-semibold tabular">{fmt(data.dueInWindow.amount)}</span></div>
        <p className="text-xs text-[var(--soft)]">{t('Остаток этапов со сроком в выбранном периоде — с учётом всех отметок сделки, в том числе без привязки.')}</p>
        {data.overdueRemaining.amount > 0 && <p role="status" className="text-xs font-semibold text-[var(--rose-deep)]">{t('Просрочено всего')}: <span className="tabular">{fmt(data.overdueRemaining.amount)}</span></p>}
        {!data.items.length && <p className="card p-5 text-sm">{t('Нет этапов по выбранному фильтру')}</p>}
        {data.items.map(item => <section className="card p-4 space-y-2" key={item.id} aria-label={item.title}>
          <div className="flex justify-between items-start gap-3"><div className="min-w-0"><h3 className="font-bold break-words">{item.title}</h3><p className="text-xs text-[var(--soft)] break-words">{data.deals.find(d => d.id === item.dealId)?.name}</p></div><time className="text-xs whitespace-nowrap" dateTime={item.due}>{formatWeddingDate(item.due)}</time></div>
          <p className="text-xs font-semibold text-[var(--rose-deep)]">{t(statusText[item.status])}{item.overdue ? ` · ${t('Просрочено')}` : ''}</p>
          <dl className="grid grid-cols-3 gap-2 text-xs"><div><dt>{t('План этапа')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.amount.amount)}</dd></div><div><dt>{t('Отмечено')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.paid.amount)}</dd></div><div><dt>{t('Остаток')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.remaining.amount)}</dd></div></dl>
          {item.allocated.amount > 0 && <p className="text-xs text-[var(--soft)]">{t('Покрыто отметками без привязки')}: <span className="tabular">{fmt(item.allocated.amount)}</span></p>}
          {item.unknownAmountPayments > 0 && <p role="status" className="text-xs text-[var(--soft)]">{t('Есть оплаты с неизвестной суммой')}: {item.unknownAmountPayments}. {t('Числовой остаток их не учитывает.')}</p>}
          {/* Системная причина («Сделка отменена» из триггера) — ключ словаря; своя — текст пары: t() вернёт его как есть. */}
          {item.cancelReason && <p className="text-xs break-words">{t(item.cancelReason)}</p>}
          {item.status !== 'cancelled' && <div className="flex flex-wrap gap-1 pt-1">
            <button className={button + ' bg-[var(--sage-soft)]'} aria-label={`${t('Отметить оплату')}: ${item.title}`} disabled={disabled || item.remaining.amount <= 0} onClick={() => open({ mode: 'pay', item })}>{t('Отметить оплату')}</button>
            <button className={button} aria-label={`${t('Изменить')}: ${item.title}`} disabled={disabled} onClick={() => open({ mode: 'edit', item })}>{t('Изменить')}</button>
            <button className={button} aria-label={`${t('Отменить этап')}: ${item.title}`} disabled={disabled} onClick={() => open({ mode: 'cancel', item })}>{t('Отменить этап')}</button>
          </div>}
          <PaymentAmendmentHistory weddingId={weddingId!} id={item.id} type="installment" revision={item.version} denied={revoke} />
        </section>)}
        <details className="card p-4"><summary className="cursor-pointer font-bold py-1">{t('История оплат')} · {data.payments.length}</summary>
          <p className="text-xs text-[var(--soft)] my-3">{t('Все отметки по сделкам, в том числе отменённым. Возвраты вычитаются, отменённые отметки не входят в итог.')}</p>
          {!data.payments.length && <p className="text-sm">{t('Отметок оплат пока нет')}</p>}
          {data.payments.map(p => <div key={p.id} className="border-t border-[var(--line)] py-3 space-y-1">
            <p className="text-sm font-semibold">{data.deals.find(d => d.id === p.dealId)?.name} · {p.amountKnown && p.amount ? <>{p.kind === 'refund' ? '−' : ''}{fmt(p.amount.amount)}</> : t('Сумма не сохранена')}</p>
            <p className="text-xs text-[var(--soft)]">{formatWeddingDate(p.paidOn)} · {t(methodText[p.paymentMethod])} · {t(visibilityText[p.visibility])}</p>
            <p className="text-xs text-[var(--soft)]">{t(paymentStatusLabel(p))}</p>
            <p className="text-xs">{data.allInstallments.find(i => i.id === p.installmentId)?.title ?? t('Без привязки')}</p>
            {p.status !== 'cancelled' && <button className={button} disabled={disabled} onClick={() => open({ mode: 'link', payment: p })}>{t('Привязать оплату')}</button>}
            <PaymentCorrectionEditor weddingId={weddingId!} payment={p} disabled={disabled} reload={q.reload} denied={revoke}
              attempt={correctionAttempts[p.id]??null} onAttempt={attempt=>rememberCorrection(p.id,attempt)}
              savedDraft={correctionDrafts[p.id]??null} onDraft={draft=>rememberDraft(p.id,draft)} />
            <PaymentAmendmentHistory weddingId={weddingId!} id={p.id} type="payment" revision={p.version} denied={revoke} />
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
      {[['Цены активных сделок', data.summary.committed], ['Отмечено оплат', data.summary.recorded], ['Осталось по сделкам', data.summary.remaining]].map(([label, value]) => typeof value !== 'string' && <div key={String(label)}><dt className="text-[var(--soft)]">{t(String(label))}</dt><dd className="text-base font-bold mt-1 tabular break-words">{fmt(value.amount)}</dd></div>)}
    </dl>
    {data.summary.unknownPrices > 0 && <p className="text-xs mt-3">{t('Не все цены заданы — итог неполный:')} {data.summary.unknownPrices}</p>}
    {data.summary.amountIncomplete && <p role="status" className="text-xs mt-3">{t('Фактические расходы: от')} {fmt(data.summary.recorded.amount)}. {t('Есть платежи с неизвестной суммой. Фактические расходы и остаток бюджета могут быть неполными.')}</p>}
    {data.summary.inactiveDealRecorded.amount !== 0 && <p className="text-xs mt-3">{t('Нетто оплат по неактивным сделкам:')} {fmt(data.summary.inactiveDealRecorded.amount)}</p>}
  </section>
}
function Filters({ data, busy, apply }: { data: PaymentScheduleData; busy: boolean; apply: (v: ScheduleFilter) => void }) {
  const [from, setFrom] = useState(data.range.from), [to, setTo] = useState(data.range.to)
  const [overdue, setOverdue] = useState(data.range.includeOverdue), [cancelled, setCancelled] = useState(data.range.includeCancelled)
  const [invalid, setInvalid] = useState<string | null>(null)
  /* Период проверяется до запроса: 422 от сервера прятал весь экран вместе с этим
     фильтром (ревью 018, F-02). До 366 календарных дней — как на сервере. */
  const submitFilter = (event: FormEvent) => {
    event.preventDefault()
    if (from > to) { setInvalid(t('Начало периода позже конца')); return }
    if (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z') > 365 * DAY) { setInvalid(t('Выберите период не длиннее 366 дней')); return }
    setInvalid(null)
    apply({ from, to, includeOverdue: overdue, includeCancelled: cancelled })
  }
  return <form className="card p-4 space-y-3" aria-label={t('Период платежей')} onSubmit={submitFilter}>
    <div className="grid grid-cols-2 gap-3"><label className="text-xs min-w-0">{t('С даты')}<input required className={field} type="date" value={from} onChange={e => setFrom(e.target.value)} disabled={busy} /></label><label className="text-xs min-w-0">{t('По дату')}<input required className={field} type="date" value={to} onChange={e => setTo(e.target.value)} disabled={busy} /></label></div>
    <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={overdue} onChange={e => setOverdue(e.target.checked)} disabled={busy} />{t('Добавить просроченные')}</label>
    <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={cancelled} onChange={e => setCancelled(e.target.checked)} disabled={busy} />{t('Показать отменённые')}</label>
    <div className="flex flex-wrap justify-between items-center gap-2"><span className="text-xs text-[var(--soft)]">{t('Даты — по времени места свадьбы')}: {data.range.timeZone}</span><button className={button} disabled={busy} type="submit">{t('Применить период')}</button></div>
    {invalid && <p role="alert" className="text-xs text-[var(--rose-deep)]">{invalid}</p>}
  </form>
}

/* Список чеков грузится, когда панель раскрыта: панель на каждую отметку сразу слала
   N запросов одним пакетом, и ограничитель отвечал части из них 429 (ревью 018, BF-03). */
function ReceiptPanel({ weddingId, paymentId, disabled }: { weddingId: string; paymentId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  return <details className="mt-2" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="text-xs cursor-pointer py-2">{t('Приложенные документы')}</summary>
    {open && <>
      <p className="text-xs text-[var(--soft)] mb-2">{t('Файл приложен пользователем. Приложение не сверяет его с банковской операцией.')}</p>
      <ReceiptList weddingId={weddingId} paymentId={paymentId} disabled={disabled} />
    </>}
  </details>
}

const RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
type ReceiptType = typeof RECEIPT_TYPES[number]
const RECEIPT_MAX_BYTES = 524288, RECEIPTS_PER_PAYMENT = 5, RECEIPT_NAME_MAX = 180
/* Тело до ~700 КБ: под общими 15 секундами загрузка на медленной сети обрывалась бы
   «сервер недоступен» (ревью 018, BF-13). */
const RECEIPT_UPLOAD_TIMEOUT_MS = 60_000
/* Причина отказа по полю — текст сервера (ключ словаря); без неё — общий текст (ревью 018, BF-04). */
const receiptError = (e: unknown) => {
  const reason = e instanceof ApiError && e.status === 422 ? e.field('mimeType') ?? e.field('contentBase64') ?? e.field('filename') : null
  return reason ? t(reason) : explainError(e)
}

function ReceiptList({ weddingId, paymentId, disabled }: { weddingId: string; paymentId: string; disabled: boolean }) {
  const q = useApi(() => listPaymentReceipts(weddingId, paymentId), [weddingId, paymentId])
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  /* Ключ — на попытку загрузки, а не на содержимое: ключ из хэша файла жил сутки, и тот
     же файл после удаления «загружался» повтором старого ответа, а под другим именем
     получал 409 (ревью 018, BF-01). Тот же файл после сбоя сети идёт с тем же ключом —
     сервер вернёт первый ответ, а не запишет второй файл. */
  const attempt = useRef<{ file: string; key: string } | null>(null)
  /* Список — только из ответа сервера: пока его нет, счётчика нет (R-178). */
  const data = ready(q) ? q.data : null
  const items = data ? data.items : null
  const full = !!items && items.length >= RECEIPTS_PER_PAYMENT
  const canUpload = !!data?.uploadEnabled && !disabled && !full && !busy
  const upload = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = '' // тот же файл, выбранный снова, — снова событие (ревью 018, BF-06)
    if (!file || !canUpload) return
    setError(null)
    if (file.size === 0) { setError(t('Файл пустой — выберите другой')); return }
    if (file.size > RECEIPT_MAX_BYTES) { setError(t('Файл должен быть не больше 512 КБ')); return }
    if (!RECEIPT_TYPES.includes(file.type as ReceiptType)) { setError(t('Разрешены PDF, JPEG, PNG и WebP')); return }
    if (Array.from(file.name).length > RECEIPT_NAME_MAX) { setError(t('Имя файла длиннее 180 символов — переименуйте файл')); return }
    const signature = [file.name, file.size, file.lastModified, file.type].join('\n')
    if (attempt.current?.file !== signature) attempt.current = { file: signature, key: newIdempotencyKey() }
    const key = attempt.current.key
    setBusy('upload')
    try {
      const raw = new Uint8Array(await file.arrayBuffer())
      let binary = ''; for (let i = 0; i < raw.length; i += 0x8000) binary += String.fromCharCode(...raw.subarray(i, i + 0x8000))
      await addPaymentReceipt(weddingId, paymentId, { filename: file.name, mimeType: file.type as ReceiptType, contentBase64: btoa(binary) },
        key, RECEIPT_UPLOAD_TIMEOUT_MS)
      attempt.current = null
      q.reload()
    } catch (e) { setError(receiptError(e)) } finally { setBusy(null) }
  }
  const download = async (id: string) => {
    if (busy) return
    setBusy('download:' + id); setError(null)
    try {
      const file = await getPaymentReceipt(weddingId, paymentId, id), binary = atob(file.contentBase64)
      const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      saveFile(new Blob([bytes], { type: file.mimeType }), file.filename)
    } catch (e) { setError(explainError(e)) } finally { setBusy(null) }
  }
  /* Удаление безвозвратно — со второго нажатия, как у задач; в свадьбе «только чтение»
     кнопки нет в работе (ревью 018, BF-05). Файла уже нет (удалил партнёр, повтор после
     обрыва) — не ошибка: список перечитывается. */
  const remove = async (id: string) => {
    if (busy || disabled) return
    setBusy('delete:' + id); setError(null)
    try { await deletePaymentReceipt(weddingId, paymentId, id) }
    catch (e) { if (!(e instanceof ApiError && e.status === 404)) setError(explainError(e)) }
    finally { setBusy(null); setConfirmDelete(null); q.reload() }
  }
  return <div className="mt-1 space-y-2">
    <AsyncState q={q} />
    {data && (data.uploadEnabled
      ? <>
        <label className={button + ' inline-flex items-center bg-[var(--bg)] focus-within:ring-2 focus-within:ring-[var(--rose)] ' + (canUpload ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed')}
          aria-disabled={!canUpload}>
          {busy === 'upload' ? t('Загружаем…') : t('Прикрепить файл')}
          <input className="sr-only" type="file" accept={RECEIPT_TYPES.join(',')} disabled={!canUpload} onChange={e => void upload(e.currentTarget)} />
        </label>
        <p className="text-[10px] text-[var(--soft)]">{t('Загружать и удалять файлы может пара · до 512 КБ · максимум 5 файлов')}{' '}{items && <>· {t('прикреплено')}: <span className="tabular">{items.length}</span></>}</p>
      </>
      : <p className="text-xs text-[var(--soft)]">{t('Загрузка документов пока не включена на сервере — прикреплённые раньше файлы можно скачать и удалить.')}</p>)}
    {items?.map(r => <div key={r.id} className="flex flex-wrap gap-x-3 gap-y-1 items-center text-xs">
      <span className="min-w-0 flex-1 truncate">{r.filename}</span>
      <button className="underline min-h-8" aria-label={`${t('Скачать')}: ${r.filename}`} disabled={!!busy} onClick={() => void download(r.id)}>{busy === 'download:' + r.id ? t('Скачиваем…') : t('Скачать')}</button>
      {confirmDelete === r.id
        ? <button className="underline font-bold text-[var(--rose-deep)] min-h-8" aria-label={`${t('Удалить?')} ${r.filename}`} disabled={!!busy || disabled} onClick={() => void remove(r.id)}>{busy === 'delete:' + r.id ? t('Удаляем…') : t('Удалить?')}</button>
        : <button className="underline text-[var(--rose-deep)] min-h-8" aria-label={`${t('Удалить')}: ${r.filename}`} disabled={!!busy || disabled} onClick={() => setConfirmDelete(r.id)}>{t('Удалить')}</button>}
    </div>)}
    {error && <p role="alert" className="text-xs text-[var(--rose-deep)]">{error}</p>}
  </div>
}
