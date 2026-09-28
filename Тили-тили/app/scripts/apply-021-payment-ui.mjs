import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here=path.dirname(url.fileURLToPath(import.meta.url))
const root=path.resolve(here,'..','..')
const read=(rel)=>fs.readFileSync(path.join(root,rel),'utf8')
const write=(rel,value)=>fs.writeFileSync(path.join(root,rel),value,'utf8')
function replaceOne(s,from,to,label){
  const n=s.split(from).length-1
  if(n!==1)throw new Error(`${label}: expected 1 match, got ${n}`)
  return s.replace(from,to)
}

{
  const rel='app/src/pages/PaymentSchedule.tsx'
  let s=read(rel)
  s=replaceOne(s,
    "import { getI18nLang, t } from '@/lib/i18n'",
    "import { t } from '@/lib/i18n'",
    'remove timezone formatter import')
  s=replaceOne(s,
    `const statusText = { pending: 'Ожидается', partial: 'Частично отмечено', paid: 'Отмечено полностью', covered: 'Покрыто оплатами сделки', cancelled: 'Отменён' }
`,
    `const statusText = { pending: 'Ожидается', partial: 'Частично отмечено', paid: 'Отмечено полностью', covered: 'Покрыто оплатами сделки', cancelled: 'Отменён' }
const methodText = { cash: 'Наличные', bank_transfer: 'Банковский перевод', card: 'Карта', other: 'Другое' } as const
const visibilityText = { private: 'Только мы', finance_members: 'Участники с доступом к финансам', vendor: 'Подрядчик этой сделки' } as const
`,
    'payment labels')
  s=replaceOne(s,
    `type Draft = { title: string; amount: string; due: string; dealId: string; installmentId: string; reason: string }
const empty: Draft = { title: '', amount: '', due: '', dealId: '', installmentId: '', reason: '' }
/* Дата отметки — в поясе свадьбы, а не срезом UTC: отметка в 02:00 по Москве
   датировалась вчерашним днём (ревью 018, F-09; тот же класс, что ERR-0122). */
const paymentDate = (iso: string, timeZone: string) => new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU',
  { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(new Date(iso))
`,
    `type Draft = {
  title: string; amount: string; due: string; dealId: string; installmentId: string; reason: string
  amountKnown: boolean; paymentMethod: 'cash'|'bank_transfer'|'card'|'other'
  visibility: 'private'|'finance_members'|'vendor'; paidOn: string
}
const empty: Draft = {
  title:'',amount:'',due:'',dealId:'',installmentId:'',reason:'',
  amountKnown:true,paymentMethod:'other',visibility:'private',paidOn:'',
}
type TextDraftKey = 'title'|'amount'|'due'|'dealId'|'installmentId'|'reason'|'paidOn'
`,
    'draft fields')
  s=replaceOne(s,
    `    else setDraft({ ...empty, title: next.item.title, due: next.item.due, dealId: next.item.dealId,
      amount: paymentRubles(next.mode === 'pay' ? next.item.remaining.amount : next.item.amount.amount) })
  }

  const change = (key: keyof Draft, value: string) => setDraft(current => ({ ...current, [key]: value }))
`,
    `    else setDraft({ ...empty, title: next.item.title, due: next.item.due, dealId: next.item.dealId,
      amount: paymentRubles(next.mode === 'pay' ? next.item.remaining.amount : next.item.amount.amount),
      paidOn: next.mode === 'pay' ? (data?.range.today ?? '') : '' })
  }

  const change = (key: TextDraftKey, value: string) => setDraft(current => ({ ...current, [key]: value }))
`,
    'open pay draft')
  const oldSubmit=`    if (editor.mode === 'new' || editor.mode === 'edit' || editor.mode === 'pay') {
      const amount = parsePaymentRubles(draft.amount)
      if (amount === null) { setError(t('Введите сумму больше нуля, не более двух знаков после запятой')); return }
      const money = { amount, currency: 'RUB' as const }
      if (editor.mode === 'pay') {
        const body = { version: stageVersion(editor.item, 'pay:' + editor.item.id), amount: money }
        void write('pay:' + editor.item.id, body, key => payInstallment(weddingId, editor.item.id, body, key))
      } else {
        if (!draft.title.trim() || !draft.due || !draft.dealId) { setError(t('Заполните название, сумму, дату и сделку')); return }
        if (editor.mode === 'new') {
          const body = { title: draft.title.trim(), due: draft.due, dealId: draft.dealId, amount: money }
          void write('new', body, key => createPaymentInstallment(weddingId, body, key))
        } else {
          const body = { version: stageVersion(editor.item, 'edit:' + editor.item.id), title: draft.title.trim(), due: draft.due, amount: money }
          void write('edit:' + editor.item.id, body, key => updatePaymentInstallment(weddingId, editor.item.id, body, key))
        }
      }
`
  const newSubmit=`    if (editor.mode === 'new' || editor.mode === 'edit' || editor.mode === 'pay') {
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
`
  s=replaceOne(s,oldSubmit,newSubmit,'submit pay branch')
  const oldForm=`          {(editor.mode === 'new' || editor.mode === 'edit' || editor.mode === 'pay') && <label className="block text-xs">{t('Сумма, ₽')}<input className={field} inputMode="decimal" value={draft.amount} maxLength={24} disabled={busy} onChange={e => change('amount', e.target.value)} required /></label>}
          {editor.mode === 'pay' && <p className="text-xs leading-relaxed">{t('Отметьте только новый перевод. Прежние оплаты привязываются через историю. Можно внести часть суммы.')}</p>}
`
  const newForm=`          {(editor.mode === 'new' || editor.mode === 'edit' || (editor.mode === 'pay' && draft.amountKnown)) && <label className="block text-xs">{t('Сумма, ₽')}<input className={field} inputMode="decimal" value={draft.amount} maxLength={24} disabled={busy} onChange={e => change('amount', e.target.value)} required /></label>}
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
            <p className="text-xs leading-relaxed text-[var(--soft)]">{t('Оплачено вне приложения. Tili-tili фиксирует факт оплаты и не переводит деньги подрядчику.')}</p>
            <p className="text-xs leading-relaxed">{t('Отметьте только новый платёж. Прежние оплаты привязываются через историю. Можно внести часть суммы.')}</p>
          </>}
`
  s=replaceOne(s,oldForm,newForm,'payment form')
  s=replaceOne(s,
    `          <dl className="grid grid-cols-3 gap-2 text-xs"><div><dt>{t('План этапа')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.amount.amount)}</dd></div><div><dt>{t('Отмечено')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.paid.amount)}</dd></div><div><dt>{t('Остаток')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.remaining.amount)}</dd></div></dl>
          {item.allocated.amount > 0 && <p className="text-xs text-[var(--soft)]">{t('Покрыто отметками без привязки')}: <span className="tabular">{fmt(item.allocated.amount)}</span></p>}
`,
    `          <dl className="grid grid-cols-3 gap-2 text-xs"><div><dt>{t('План этапа')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.amount.amount)}</dd></div><div><dt>{t('Отмечено')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.paid.amount)}</dd></div><div><dt>{t('Остаток')}</dt><dd className="font-semibold mt-1 tabular break-words">{fmt(item.remaining.amount)}</dd></div></dl>
          {item.allocated.amount > 0 && <p className="text-xs text-[var(--soft)]">{t('Покрыто отметками без привязки')}: <span className="tabular">{fmt(item.allocated.amount)}</span></p>}
          {item.unknownAmountPayments > 0 && <p role="status" className="text-xs text-[var(--soft)]">{t('Есть оплаты с неизвестной суммой')}: {item.unknownAmountPayments}. {t('Числовой остаток их не учитывает.')}</p>}
`,
    'stage unknown warning')
  s=replaceOne(s,
    `          {data.payments.map(p => <div key={p.id} className="border-t border-[var(--line)] py-3 space-y-1">
            <p className="text-sm font-semibold">{data.deals.find(d => d.id === p.dealId)?.name} · {p.kind === 'refund' ? '−' : ''}{fmt(p.amount.amount)}</p>
            <p className="text-xs text-[var(--soft)]">{paymentDate(p.createdAt, data.range.timeZone)} · {t(p.status === 'cancelled' ? 'Отметка отменена' : p.kind === 'refund' ? 'Возврат' : 'Отмечено')}</p>
            <p className="text-xs">{data.allInstallments.find(i => i.id === p.installmentId)?.title ?? t('Без привязки')}</p>
`,
    `          {data.payments.map(p => <div key={p.id} className="border-t border-[var(--line)] py-3 space-y-1">
            <p className="text-sm font-semibold">{data.deals.find(d => d.id === p.dealId)?.name} · {p.amountKnown && p.amount ? <>{p.kind === 'refund' ? '−' : ''}{fmt(p.amount.amount)}</> : t('Сумма не сохранена')}</p>
            <p className="text-xs text-[var(--soft)]">{formatWeddingDate(p.paidOn)} · {t(methodText[p.paymentMethod])} · {t(visibilityText[p.visibility])}</p>
            <p className="text-xs text-[var(--soft)]">{t(p.status === 'cancelled' ? 'Отметка отменена' : p.kind === 'refund' ? 'Возврат' : 'Оплачено вне приложения')}</p>
            <p className="text-xs">{data.allInstallments.find(i => i.id === p.installmentId)?.title ?? t('Без привязки')}</p>
`,
    'payment history')
  s=replaceOne(s,
    `    {data.summary.unknownPrices > 0 && <p className="text-xs mt-3">{t('Не все цены заданы — итог неполный:')} {data.summary.unknownPrices}</p>}
    {data.summary.inactiveDealRecorded.amount !== 0 && <p className="text-xs mt-3">{t('Нетто оплат по неактивным сделкам:')} {fmt(data.summary.inactiveDealRecorded.amount)}</p>}
`,
    `    {data.summary.unknownPrices > 0 && <p className="text-xs mt-3">{t('Не все цены заданы — итог неполный:')} {data.summary.unknownPrices}</p>}
    {data.summary.amountIncomplete && <p role="status" className="text-xs mt-3">{t('Фактические расходы: от')} {fmt(data.summary.recorded.amount)}. {t('Есть платежи с неизвестной суммой. Фактические расходы и остаток бюджета могут быть неполными.')}</p>}
    {data.summary.inactiveDealRecorded.amount !== 0 && <p className="text-xs mt-3">{t('Нетто оплат по неактивным сделкам:')} {fmt(data.summary.inactiveDealRecorded.amount)}</p>}
`,
    'summary incomplete')
  write(rel,s)
  console.log('patched '+rel)
}

{
  const rel='app/src/pages/Wedding.tsx'
  let s=read(rel)
  s=replaceOne(s,
    `{server?.paymentSummary && <p className="text-xs text-[var(--soft)] mt-2">{t('Отмечено оплат')}: {fmt(server.paymentSummary.recorded.amount)} · {t('Осталось по сделкам')}: {fmt(server.paymentSummary.remaining.amount)}{/* Сделка без цены в остаток не входит: без оговорки «0 ₽» читался как «всё оплачено» (ревью 018, F-04; R-178). */}{server.paymentSummary.unknownPrices > 0 && <> ({t('без сделок, где цена не задана')}: {server.paymentSummary.unknownPrices})</>}. {t('Плановые этапы не увеличивают смету.')}</p>}`,
    `{server?.paymentSummary && <p className="text-xs text-[var(--soft)] mt-2">{server.paymentSummary.amountIncomplete ? t('Известно оплачено, от') : t('Отмечено оплат')}: {fmt(server.paymentSummary.recorded.amount)} · {t('Осталось по сделкам')}: {fmt(server.paymentSummary.remaining.amount)}{/* Сделка без цены в остаток не входит: без оговорки «0 ₽» читался как «всё оплачено» (ревью 018, F-04; R-178). */}{server.paymentSummary.unknownPrices > 0 && <> ({t('без сделок, где цена не задана')}: {server.paymentSummary.unknownPrices})</>}. {server.paymentSummary.amountIncomplete && <>{t('Есть платежи с неизвестной суммой. Фактические расходы и остаток бюджета могут быть неполными.')} </>}{t('Плановые этапы не увеличивают смету.')}</p>}`,
    'budget incomplete summary')
  write(rel,s)
  console.log('patched '+rel)
}

{
  const rel='app/src/lib/i18n.en.ts'
  let s=read(rel)
  const marker=`  'Место под подтверждения оплат у свадьбы закончилось — удалите ненужные файлы': 'The wedding has used up its space for payment evidence; delete files you no longer need',
})`
  const addition=`  'Место под подтверждения оплат у свадьбы закончилось — удалите ненужные файлы': 'The wedding has used up its space for payment evidence; delete files you no longer need',
  'Сохранять сумму?': 'Save the amount?',
  'Сумма известна': 'Amount known',
  'Сумма не сохранена': 'Amount not stored',
  'Сумма не сохранена. Фактические расходы и остаток бюджета могут быть неполными.': 'The amount is not stored. Actual spending and the remaining budget may be incomplete.',
  'Способ оплаты': 'Payment method',
  'Наличные': 'Cash',
  'Банковский перевод': 'Bank transfer',
  'Карта': 'Card',
  'Другое': 'Other',
  'Дата фактической оплаты': 'Actual payment date',
  'Кто видит детали оплаты?': 'Who can see payment details?',
  'Только мы': 'Only us',
  'Участники с доступом к финансам': 'Members with finance access',
  'Подрядчик этой сделки': 'Vendor for this deal',
  'Оплачено вне приложения. Tili-tili фиксирует факт оплаты и не переводит деньги подрядчику.': 'Paid outside the app. Tili-tili records the payment fact and does not transfer money to the vendor.',
  'Отметьте только новый платёж. Прежние оплаты привязываются через историю. Можно внести часть суммы.': 'Record only a new payment. Link previous payments from history. Partial payments are allowed.',
  'Оплачено вне приложения': 'Paid outside the app',
  'Есть оплаты с неизвестной суммой': 'There are payments with an unknown amount',
  'Числовой остаток их не учитывает.': 'The numeric balance does not include them.',
  'Фактические расходы: от': 'Actual spending: at least',
  'Есть платежи с неизвестной суммой. Фактические расходы и остаток бюджета могут быть неполными.': 'There are payments with an unknown amount. Actual spending and the remaining budget may be incomplete.',
  'Известно оплачено, от': 'Known paid, at least',
})`
  s=replaceOne(s,marker,addition,'English payment translations')
  write(rel,s)
  console.log('patched '+rel)
}
