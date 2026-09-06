import { createElement, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Download, Check, Copy, FileText, Plus, Armchair } from 'lucide-react'
import { contractTemplates } from '@/lib/contractTemplates'
import { dressPalettes } from '@/lib/dressPalettes'
import { fmt } from '@/lib/money'
import type { DealState, Slot } from '@/lib/types'
import { inviteThemes } from '@/lib/inviteThemes'
import { useStore } from '@/lib/store'
import { useBusy } from '@/lib/useBusy'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { AsyncState } from '@/components/AsyncState'
import { explainError, useApi } from '@/lib/api/useApi'
import { saveInviteDesign } from '@/lib/api/wedding'
import { guestInviteLink } from '@/lib/api/weddingWrite'
import { getDealEvents } from '@/lib/api/slots'
import { chatRouteForVendor } from '@/lib/api/chats'
import { ready } from '@/components/AsyncState'
import { getGuests, getWedding } from '@/lib/api/weddingData'
import { addTable, getTables, patchGuest } from '@/lib/api/weddingWrite'
import { catIcon } from '@/lib/icons'
import { cn, copyText, pct } from '@/lib/utils'
import { getI18nLang, t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'

/*
 * Карточка сделки.
 *
 * Экран был полностью выдуман: имя подрядчика, даты платежей, история из
 * четырёх событий и слот `s4` в обработчиках — всё это стояло в разметке
 * константами и не зависело ни от какой сделки. Теперь он показывает одну
 * настоящую сделку, найденную по идентификатору из адреса.
 *
 * Шесть состояний — решение владельца 2026-09-02, План §8.1. Двигать их можно
 * только вперёд по цепочке: сервер отвечает 409 на любой другой переход,
 * поэтому кнопка предлагает ровно один следующий шаг.
 */
const DEAL_STEPS: ReadonlyArray<{ state: DealState; label: string }> = [
  { state: 'candidate', label: 'Кандидат' },
  { state: 'contacted', label: 'Написали' },
  { state: 'negotiating', label: 'Переговоры' },
  { state: 'booked', label: 'Забронировано' },
  { state: 'paid_deposit', label: 'Аванс внесён' },
  { state: 'done', label: 'Выполнено' },
]

export function Deal() {
  const { slots } = useStore()
  const { id } = useParams()
  const s = slots.find(x => x.dealId === id)
  if (!s) return (
    <div className="pb-28">
      <TopBar back title={t('Сделка')} />
      <p className="px-5 mt-6 text-[13px] text-[var(--soft)]">{slots.length ? t('Сделка не найдена') : t('Загружаем…')}</p>
    </div>
  )
  return <DealView s={s} />
}

function DealView({ s }: { s: Slot }) {
  const nav = useNavigate()
  const { paySlot, cancelBooking, advanceDealTo } = useStore()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, run] = useBusy()

  const at = DEAL_STEPS.findIndex(x => x.state === s.dealState)
  const next = at >= 0 ? DEAL_STEPS[at + 1] : undefined
  const cancelled = s.dealState === 'cancelled'

  /* Каждое действие здесь необратимо на той стороне: двигает сделку, освобождает
     дату в календаре подрядчика или фиксирует деньги. Ошибку показываем словами. */
  const guard = (fn: () => Promise<unknown>) => run(async () => {
    setErr(null)
    try { await fn() } catch (e) { setErr(explainError(e)) }
  })

  return (
    <div className="pb-28">
      <TopBar back title={t('Сделка')} sub={`${t(s.label)} · ${s.vendor ?? t('Исполнитель не выбран')}`} />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <div className={cn('w-[52px] h-[52px] rounded-[18px] flex items-center justify-center shrink-0', s.tile)}>
              {createElement(catIcon(s.categoryId), { size: 24, className: 'text-[var(--ink2)]' })}
            </div>
            <div className="flex-1 min-w-0">
              <b className="font-serif-d text-[17px] block truncate">{s.vendor ?? t('Исполнитель не выбран')}</b>
              <p className="text-[11px] text-[var(--soft)]">{t(s.label)}</p>
            </div>
            {s.status && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--honey)] text-[var(--honey-ink)] shrink-0">{t(s.status)}</span>}
          </div>
          <div className="flex items-center mt-5">
            {DEAL_STEPS.map((step, k) => {
              /* Пройденным считаем шаг не позже текущего: «выполнено» ставилось
                 галочкой всем шестерым сразу, включая те, до которых не дошли. */
              const done = at >= 0 && k <= at
              return (
                <div key={step.state} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center">
                    <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold', done ? 'grad text-[var(--on-grad)]' : 'bg-[var(--track)] text-[var(--track-ink)]')}>{done ? '✓' : k + 1}</span>
                    <span className={cn('text-[7.5px] mt-1 whitespace-nowrap', done ? 'text-[var(--sage-deep)] font-bold' : 'text-[var(--soft2)]')}>{t(step.label)}</span>
                  </div>
                  {k < DEAL_STEPS.length - 1 && <div className={cn('flex-1 h-[2px] mx-1 rounded', done ? 'bg-[#A9BCA0]' : 'bg-[var(--track)]')} />}
                </div>
              )
            })}
          </div>
        </div>

        {/* Сумма — та, что записана в сделке, и та, что по ней уже внесена.
            Графика платежей контракт не отдаёт, и выдумывать его здесь нельзя:
            раньше на экране стояли «аванс 10 фев» и «доплата 14 июн» с суммами,
            не связанными ни с какой сделкой. */}
        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Оплаты')}</span>
          {/* Сумму платежей считает сервер: до этого её в ответе не было, и
              строка могла показать только факт оплаты, но не остаток долга. */}
          <div className="flex justify-between items-center mt-3">
            <span className="text-[12.5px]">{t('Оплачено')}</span>
            <b className={cn('tabular text-[13px]', (s.paid ?? 0) > 0 ? 'text-[var(--sage-deep)]' : 'text-[var(--soft)]')}>
              {fmt(s.paid ?? 0)}{s.price != null && ` ${t('из')} ${fmt(s.price)}`}
            </b>
          </div>
          {s.price != null && s.price > 0 && (
            <div className="mt-2.5">
              <Bar pct={pct(s.paid ?? 0, s.price)} />
              <p className="text-[10.5px] text-[var(--soft)] mt-1.5">
                {s.price - (s.paid ?? 0) > 0
                  ? `${t('осталось')} ${fmt(s.price - (s.paid ?? 0))}`
                  : t('оплачено полностью')}
              </p>
            </div>
          )}
          <div className="h-[1.5px] bg-[var(--track)] my-3" />
          <div className="flex justify-between items-center">
            <b className="text-[13px]">{t('Итого по договору')}</b>
            <b className="font-serif-d text-[17px] text-[var(--rose-deep)] tabular">{s.price != null ? fmt(s.price) : '—'}</b>
          </div>
        </div>

        {/* `revision` — состояние и оплаченное: после действия на этом же
            экране журнал обязан перечитаться, иначе он показывает историю до
            последнего шага и выглядит так, будто шага не было. */}
        {s.dealId && <DealJournal dealId={s.dealId} revision={`${s.dealState ?? ''}:${s.paid ?? 0}`} />}

        <div className="grid grid-cols-2 gap-2.5">
          <button onClick={() => void (async () => nav(await chatRouteForVendor(s.vendorId)))()} className="press card-s py-3.5 text-[13px] font-semibold">{t('Написать')}</button>
          <button onClick={() => nav(`/wedding/documents/new?deal=${s.dealId ?? ''}`)} className="press card-s py-3.5 text-[13px] font-semibold flex items-center justify-center gap-1.5"><FileText size={14} />{t('Договор')}</button>
          {/* «Внести аванс» — отдельный путь контракта, остальные шаги двигает
              PATCH сделки. Разные адреса, поэтому и кнопки разные. */}
          {cancelled ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">{t('Сделка отменена')}</div>
          ) : s.dealState === 'booked' ? (
            <button disabled={busy} onClick={() => guard(() => paySlot(s.id))} className="press card-s py-3.5 text-[13px] font-semibold text-[var(--sage-deep)] disabled:opacity-50">{busy ? t('Проводим…') : t('✓ Отметить оплату')}</button>
          ) : next ? (
            <button disabled={busy || !s.dealId} onClick={() => guard(() => advanceDealTo(s.dealId!, next.state))} className="press card-s py-3.5 text-[13px] font-semibold disabled:opacity-50">{busy ? t('Проводим…') : t(next.label)}</button>
          ) : (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--sage-deep)] text-center">{t('✓ Выполнено')}</div>
          )}
          {cancelled ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">{t('Дата свободна')}</div>
          ) : confirmCancel ? (
            <button disabled={busy} onClick={() => guard(async () => { await cancelBooking(s.id); setConfirmCancel(false); nav('/wedding') })} className="press py-3.5 rounded-[18px] bg-[#A36666] text-white text-[13px] font-semibold disabled:opacity-50">{t('Точно отменить?')}</button>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="press card-s py-3.5 text-[13px] font-semibold text-[var(--rose-deep)]">{t('Отменить сделку')}</button>
          )}
        </div>
        {err && <p className="text-[12px] text-[var(--rose-ink)]">{err}</p>}

        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Защита сделки')}</span>
          <div className="mt-3 space-y-2.5 text-[12px] text-[var(--soft)] leading-relaxed">
            <p>💸 <b className="text-[var(--ink)]">{t('Оплата:')}</b> {t('деньги идут напрямую подрядчику — приложение фиксирует факт оплаты, но не держит их у себя. Эскроу появится позже.')}</p>
            <p>📅 <b className="text-[var(--ink)]">{t('Отмена:')}</b> {t('условия возврата — в договоре со сторонами. Отмена освобождает вашу дату в календаре подрядчика сразу.')}</p>
            <p>⚖️ <b className="text-[var(--ink)]">{t('Спор:')}</b> {t('напишите в поддержку — переписка и договор останутся в приложении и будут приложены к обращению.')}</p>
          </div>
          <button onClick={() => nav('/support')} className="press mt-3 w-full h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Написать в поддержку')}</button>
        </div>
        <p className="text-[10px] text-[var(--soft2)] text-center leading-relaxed">{t('Отмена менее чем за 30 дней до даты блокирует отзывы обеим сторонам до решения модерации.')}</p>
      </div>
    </div>
  )
}

/*
 * Журнал сделки: что и когда с ней происходило.
 *
 * Раньше на этом экране стояла выдуманная история из четырёх событий —
 * одинаковая у всех пар. Настоящие события писались в базу с самого начала,
 * но прочитать их было негде: при споре «мы договаривались о другой сумме»
 * доказательство лежало и молчало.
 *
 * Автор события приходит ролью, а не именем: ни пара, ни подрядчик не
 * получают отсюда чужой идентификатор.
 */
const EVENT_STATE: Record<string, string> = {
  candidate: 'Кандидат',
  contacted: 'Написали',
  negotiating: 'Переговоры — бронь держится 72 часа',
  booked: 'Забронировано',
  paid_deposit: 'Аванс внесён',
  done: 'Выполнено',
  cancelled: 'Сделка отменена',
}

const EVENT_BY: Record<string, string> = {
  couple: 'вы',
  vendor: 'подрядчик',
  system: 'автоматически',
}

function DealJournal({ dealId, revision }: { dealId: string; revision: string }) {
  const q = useApi(() => getDealEvents(dealId), [dealId, revision])
  const events = q.data ?? []

  return (
    <div className="card p-5">
      <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Что происходило')}</span>
      <AsyncState q={q} />
      {!events.length && ready(q) && (
        <p className="text-[12px] text-[var(--soft)] mt-3">{t('Пока ничего не происходило')}</p>
      )}
      <div className="mt-3 space-y-3">
        {events.map(e => (
          <div key={e.id} className="flex gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--rose-deep)] mt-1.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] font-medium">
                {/* Правка цены несёт свой текст — старую и новую сумму; у перехода
                    состояния текста нет, и его даёт словарь. */}
                {e.kind === 'price' ? (e.note ?? t('Цена изменена')) : t(EVENT_STATE[e.toState ?? ''] ?? e.toState ?? '')}
              </p>
              <p className="text-[10.5px] text-[var(--soft2)] mt-0.5">
                {e.at ? new Date(e.at).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : ''}
                {e.by && ` · ${t(EVENT_BY[e.by] ?? e.by)}`}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/*
 * Генерация и скачивание договора: DOCX (Word-совместимый HTML) / PDF (окно печати).
 *
 * Данные подставляются из свадьбы и сделки. Раньше в тексте стояли константы:
 * «г. Уфа», «Алина Козлова и Тимур Волков» и «торжество 14.06.2027» — документ
 * с чужим городом, чужими именами и чужой датой скачивался у каждой пары.
 *
 * Настоящее место для этого — `POST /deals/{dealId}/contract`: там подстановка
 * идёт на сервере и документ попадает в список документов свадьбы. Пока путь
 * не подключён (этап 8), собираем текст на клиенте — но из настоящих данных.
 */
export interface ContractFacts {
  city: string
  customer: string
  vendor: string
  date: string
  amount: string
}

function contractHTML(name: string, f: ContractFacts) {
  // строки переводим заранее: внутри шаблонной строки работает только ${…}
  const [cust, exec, subject, price, p3, p4] = [
    t('Заказчик:'), t('Исполнитель:'),
    t('1. Предмет договора: услуги на свадебное торжество '),
    t('2. Стоимость услуг: '),
    t('3. Ответственность сторон и форс-мажор — по ГК РФ.'),
    t('4. Сформировано в приложении «Тили-тили» (tili-tili.ru).'),
  ]
  return `<h1>${name}</h1><p>${f.city}${new Date().toLocaleDateString('ru-RU')}</p>
  <p><b>${cust}</b> ${f.customer}<br><b>${exec}</b> ${f.vendor}</p>
  <p>${subject}${f.date}.</p><p>${price}${f.amount}.</p><p>${p3}</p><p>${p4}</p>`
}
function downloadDocx(name: string, f: ContractFacts) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body style="font-family:Georgia,serif">${contractHTML(name, f)}</body></html>`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }))
  a.download = 'dogovor-tili-tili.doc'
  a.click(); URL.revokeObjectURL(a.href)
}
function downloadPdf(name: string, f: ContractFacts) {
  const w = window.open('', '_blank')
  if (!w) return
  w.document.write(`<html><head><meta charset="utf-8"><title>${name}</title></head><body style="font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.6">${contractHTML(name, f)}<script>window.onload=()=>window.print()${'<'}/script></body></html>`)
  w.document.close()
}

/* Мастер договора: шаблон → данные → готово */
export function ContractWizard() {
  const nav = useNavigate()
  const { weddingDate, weddingId, slots } = useStore()
  /* Договор всегда про конкретную сделку: имя исполнителя и сумма берутся из
     неё. Без неё поля честно говорят «уточняется», а не подставляют чужие. */
  const [params] = useSearchParams()
  const slot = slots.find(x => x.dealId === params.get('deal'))
  const wq = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const facts: ContractFacts = {
    /* «г.» отдельным ключом переводить нечего — в английском такого сокращения
       нет, а пустой перевод неотличим от забытого. Пишем полной строкой. */
    city: wq.data?.city?.name ? `${t('Город: ')}${wq.data.city.name} · ` : '',
    customer: wq.data?.title ?? t('уточняется'),
    vendor: slot?.vendor ?? '______________________',
    date: weddingDate ? formatWeddingDate(weddingDate) : t('уточняется'),
    amount: slot?.price != null ? fmt(slot.price) : t('уточняется'),
  }
  const [step, setStep] = useState(0)
  const [tpl, setTpl] = useState(0)
  const [done, setDone] = useState(false)
  const ctpl = contractTemplates[tpl]

  if (done) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center fade-up">
      <div className="w-[92px] h-[92px] rounded-full grad flex items-center justify-center text-[var(--on-grad)] pop" style={{ boxShadow: '0 20px 44px -14px rgba(201,138,138,.6)' }}><Check size={38} strokeWidth={2.5} /></div>
      <h1 className="font-serif-d text-[28px] mt-7">{t('Договор готов')}</h1>
      <p className="text-[13px] text-[var(--soft)] mt-3 font-light leading-relaxed">«{ctpl.name}{t('» сгенерирован с вашими данными. Скачайте, подпишите с подрядчиком и загрузите скан в сделку.')}</p>
      <div className="flex gap-2.5 mt-8 w-full">
        <button onClick={() => downloadPdf(ctpl.name, facts)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> PDF</button>
        <button onClick={() => downloadDocx(ctpl.name, facts)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> DOCX</button>
      </div>
      <button onClick={() => nav('/wedding/documents')} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] mt-2.5" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Готово')}</button>
    </div>
  )

  return (
    <div className="min-h-dvh flex flex-col pb-10">
      <TopBar back title={t('Новый договор')} sub={`${t('Шаг ')}${step + 1}${t(' из 2')}`} />
      {step === 0 ? (
        <div className="px-5 mt-3 space-y-2.5 stagger">
          {contractTemplates.map((c, k) => (
            <button key={c.id} onClick={() => setTpl(k)} className={cn('press w-full card-s p-4 flex items-center gap-3 text-left fade-up', tpl === k && 'ring-2 ring-[#C98A8A]')}>
              <Tile icon={c.icon} tile={c.tile} size={42} />
              <div className="flex-1"><b className="text-[13px]">{c.name}</b><p className="text-[10.5px] text-[var(--soft)]">{c.desc}</p></div>
              <span className={cn('w-5 h-5 rounded-full border-2', tpl === k ? 'bg-[#C98A8A] border-[#C98A8A]' : 'border-[#EAD9CF]')} />
            </button>
          ))}
        </div>
      ) : (
        <div className="px-5 mt-3 fade-up">
          <div className="card p-5 space-y-3.5">
            {/* Аванс из списка убран: его размер брался константой 30 000 ₽ и
                не был связан ни с какой сделкой. */}
            {[[t('Заказчик'), facts.customer], [t('Исполнитель'), facts.vendor], [t('Дата оказания услуги'), facts.date], [t('Сумма'), facts.amount]].map(([l, v]) => (
              <div key={l}>
                <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{l}</span>
                <p className="text-[13.5px] font-medium mt-0.5">{v}</p>
              </div>
            ))}
            <div>
              <span className="text-[10px] tracking-[.14em] uppercase text-[var(--rose-deep)] font-semibold">{t('Паспортные данные *')}</span>
              <input placeholder={t('Заполните перед подписанием')} className="w-full mt-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            </div>
          </div>
          <p className="text-[10px] text-[var(--soft2)] mt-3 text-center">{t('Шаблон — информационный, не заменяет консультацию юриста')}</p>
        </div>
      )}
      <div className="px-5 mt-auto pt-6">
        <button onClick={() => (step === 0 ? setStep(1) : setDone(true))} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {step === 0 ? t('Далее') : t('Сгенерировать договор ✨')}
        </button>
      </div>
    </div>
  )
}

/* Рассадка */
/*
 * Рассадка: столы и гости с сервера.
 *
 * Место гостя — поле `tableId` у самого гостя, а не отдельная карта в браузере:
 * рассаживают вдвоём, и `tt_seating` на одном телефоне второй из пары не видел.
 * «Без стола» по-прежнему вычисляется, а не хранится — иначе гость оказывался
 * бы одновременно за столом и в списке нерассаженных.
 *
 * Значок горячего убран: он выдавался хешем от имени гостя и подписывался «из
 * опроса меню». Настоящий ответ гостя лежит в `diet`, и показываем теперь его.
 */
const DIET_ICON: Record<string, string> = {
  vegetarian: '🥦',
  vegan: '🥦',
  halal: '🍽',
  kosher: '🍽',
  gluten_free: '🌾',
  other: '🍽',
}

export function Seating() {
  const { weddingId } = useStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const guestsQ = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const tablesQ = useApi(() => weddingId ? getTables(weddingId) : Promise.resolve([]), [weddingId])

  // Рассаживать начинают до того, как ответят все, поэтому за столы попадают и
  // ждущие ответа. Исключаются только отказавшиеся.
  const attending = (guestsQ.data ?? [])
    .filter(g => g.status !== 'no')
    .map(g => ({ id: g.id ?? '', name: g.name ?? '', tableId: g.tableId ?? null, diet: g.diet ?? null }))

  const tables = (tablesQ.data ?? []).map(tb => ({
    id: tb.id ?? '',
    name: tb.name ?? '',
    capacity: tb.capacity ?? 8,
    guests: attending.filter(g => g.tableId === tb.id),
  }))
  const unseated = attending.filter(g => !g.tableId)

  const write = async (fn: () => Promise<unknown>) => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — рассадка живёт в ней')); return }
    setBusy(true)
    setErr(null)
    try { await fn(); guestsQ.reload(); tablesQ.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  }
  const seat = (tableId: string) => {
    const tb = tables.find(x => x.id === tableId)
    if (!selected || !tb || tb.guests.length >= tb.capacity) return
    void write(async () => { await patchGuest(weddingId!, selected, { tableId }); setSelected(null) })
  }
  /* Снятие со стола шлёт именно `null`: пропущенное поле сервер читает как
     «не трогать», и гость остался бы сидеть там, откуда его убрали. */
  const unseat = (guestId: string) => void write(() => patchGuest(weddingId!, guestId, { tableId: null }))

  const addNewTable = () => void write(() => addTable(weddingId!, `${t('Стол №')}${tables.length + 1}`, 8))

  /* Тиль раскидывает нерассаженных по свободным местам. Записей столько,
     сколько гостей: отдельного пути «рассадить всех» контракт не знает. */
  const autoSeat = () => void write(async () => {
    const free = tables.map(tb => ({ id: tb.id, left: tb.capacity - tb.guests.length }))
    let ti = 0
    for (const g of unseated) {
      while (ti < free.length && free[ti]!.left <= 0) ti++
      if (ti >= free.length) break
      await patchGuest(weddingId!, g.id, { tableId: free[ti]!.id })
      free[ti]!.left--
    }
    setSelected(null)
  })

  const selectedName = attending.find(g => g.id === selected)?.name

  return (
    <div className="pb-28">
      <TopBar back title={t('Рассадка')} sub={selectedName ? `${t('Сажаем: ')}${selectedName}${t(' — выберите стол')}` : t('Выберите гостя, затем стол')} />
      <AsyncState q={guestsQ} />
      <div className="px-5 mt-3">
        <div className="card-s px-4 py-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold shrink-0">{t('Без стола:')}</span>
          {unseated.map(g => (
            <button key={g.id} onClick={() => setSelected(s => s === g.id ? null : g.id)} className={cn('press text-[10.5px] font-medium px-3 py-1.5 rounded-full whitespace-nowrap shrink-0 transition-all', selected === g.id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)]')}>{g.name}</button>
          ))}
          {!unseated.length && <span className="text-[10.5px] text-[var(--sage-deep)] font-semibold">{attending.length ? t('все рассажены ✓') : t('гостей пока нет')}</span>}
        </div>
      </div>
      {err && <p className="px-5 mt-3 text-[12px] text-[var(--rose-ink)]">{err}</p>}
      <div className="px-5 mt-3 grid grid-cols-2 gap-3 stagger">
        {tables.map(tb => (
          <div key={tb.id} onClick={() => seat(tb.id)} className={cn('card p-4 text-left fade-up transition-all', selected && tb.guests.length < tb.capacity && 'ring-2 ring-[#A9BCA0] cursor-pointer')}>
            <div className="flex items-center justify-between">
              <b className="font-serif-d text-[16px]">{tb.name}</b>
              <span className="text-[9px] text-[var(--soft)] flex items-center gap-1"><Armchair size={10} /> {tb.guests.length}/{tb.capacity}</span>
            </div>
            <div className="mt-2.5 space-y-1.5 min-h-[60px]">
              {tb.guests.length ? tb.guests.map(g => (
                <button key={g.id} disabled={busy} onClick={e => { e.stopPropagation(); unseat(g.id) }} className="press w-full text-left text-[11px] bg-[var(--bg)] rounded-lg px-2.5 py-1.5 truncate flex items-center gap-1.5 disabled:opacity-50">
                  {g.diet && <span className="text-[10px] shrink-0">{DIET_ICON[g.diet] ?? '🍽'}</span>}
                  <span className="truncate">{g.name}</span>
                </button>
              )) : <div className="text-[10.5px] text-[var(--soft2)] py-3 text-center border-[1.5px] border-dashed border-[#EAD9CF] rounded-xl">{t('Пусто')}</div>}
            </div>
          </div>
        ))}
        {!tables.length && <p className="col-span-2 text-[12px] text-[var(--soft)] text-center py-4">{t('Столов пока нет — добавьте первый')}</p>}
      </div>
      <div className="px-5 mt-4 space-y-3">
        <button onClick={autoSeat} disabled={busy || !unseated.length || !tables.length} className={cn('press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] flex items-center justify-center gap-2', (busy || !unseated.length || !tables.length) && 'opacity-40')} style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>✨ {t('Рассадить автоматически')}</button>
        {/* Легенда описывает то, что гость сам указал в RSVP. Прежняя обещала
            «из опроса меню» три значка, которые выдавались хешем имени. */}
        <div className="card-s px-4 py-3 flex items-center gap-3 text-[10.5px] text-[var(--soft)]">
          <span className="font-semibold tracking-[.12em] uppercase shrink-0">{t('Легенда:')}</span>
          <span>🥦 {t('вег')}</span><span>🌾 {t('без глютена')}</span><span>🍽 {t('особое меню')}</span>
          <span className="ml-auto">{t('из ответа гостя')}</span>
        </div>
        <button disabled={busy} onClick={addNewTable} className="press w-full card-s py-4 text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50"><Plus size={15} />{t('Добавить стол')}</button>
        {/* Убраны подсказка про «тётю Люду и дядю Рафика», которых нет среди
            гостей, и плашка «подрядчик получает обновление и подтверждает»:
            рассадка никому не рассылается. */}
        <button onClick={() => window.print()} className="press w-full h-[52px] rounded-full bg-[var(--ink)] text-[var(--bg)] font-semibold text-[13.5px] flex items-center justify-center gap-2"><Download size={15} />{t('PDF для печати А3')}</button>
      </div>
    </div>
  )
}

/* Редактор приглашений: сценарий → текст → вопросы гостям → рассылка */
export function InviteEditor() {
  const nav = useNavigate()
  const { inviteTpl, setInviteTpl, inviteText, setInviteText, weddingDate, weddingId } = useStore()
  const theme = inviteTpl
  const [questions, setQuestions] = useState({ plus: true, meal: true, transfer: true })
  /* Дресс-код хранится у свадьбы: его видит гость. Пока он лежал в
     `tt_dress` браузера пары, гость получал палитру по умолчанию и принимал
     её за выбор пары. */
  const wq = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const [dress, setDress] = useState<string | null>(null)
  const [dressNote, setDressNote] = useState<string | null>(null)
  const dressId = dress ?? wq.data?.dressCode ?? 'd1'
  const dressText = dressNote ?? wq.data?.dressNote ?? ''
  const [saved, setSaved] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [links, setLinks] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)

  /* Гости — с сервера: ссылка именная, и выдаётся она конкретной записи. */
  const gq = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const guestList = gq.data ?? []

  const run = async (id: string, fn: () => Promise<unknown>) => {
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — приглашения живут в ней')); return }
    setBusyId(id)
    setErr(null)
    try { await fn() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }

  /* Текст и тему сохраняем на сервере: гость открывает приглашение со своего
     устройства, и в localStorage пары заглянуть не может. */
  const saveDesign = () => void run('design', async () => {
    await saveInviteDesign(weddingId!, inviteText, theme, dressId, dressText)
    wq.reload()
    setSaved(true)
  })

  /* Ссылка одноразовая и именная. Повторный выпуск гасит прежнюю — так
     работает контракт, и это правильно: ссылка, ушедшая не тому, отзывается. */
  const issueLink = (guestId: string) => void run(guestId, async () => {
    const res = await guestInviteLink(weddingId!, guestId)
    if (res?.url) setLinks(m => ({ ...m, [guestId]: res.url! }))
  })

  const copy = (url: string) => {
    copyText(url)
    setCopied(url); setTimeout(() => setCopied(null), 1600)
  }
  const qRow = (key: keyof typeof questions, label: string) => (
    <div className="flex items-center justify-between py-3 border-b border-[var(--track)] last:border-none">
      <span className="text-[12.5px] font-medium">{label}</span>
      <button onClick={() => setQuestions(q => ({ ...q, [key]: !q[key] }))} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', questions[key] ? 'grad' : 'bg-[var(--track)]')} aria-label={label}>
        <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-[var(--card)] shadow transition-all', questions[key] ? 'left-[22px]' : 'left-[3px]')} />
      </button>
    </div>
  )
  return (
    <div className="pb-28">
      <TopBar back title={t('Приглашения')} sub={t('10 сценариев · ссылка · RSVP')} />
      <div className="px-5 mt-3">
        {/* Превью сценария */}
        <div className="card p-6 text-center relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-2" style={{ background: inviteThemes[theme].accentGrad }} />
          {/*
            * Превью показывает то, что увидит гость, а не мок. Здесь стояли
            * «А♥Т», «Дорогая Марина Ивановна!», имена и город из `lib/data.ts`
            * — пара смотрела на чужую свадьбу. Имя гостя осталось подписью-
            * образцом и названо образцом: у каждого гостя оно своё.
            */}
          <div className="w-[52px] h-[52px] rounded-full mx-auto flex items-center justify-center text-white font-serif-d text-[16px]" style={{ background: inviteThemes[theme].accentGrad }}>♥</div>
          <p className="font-serif-d italic text-[14px] text-[var(--soft)] mt-4">{t('Имя гостя')}</p>
          <h2 className="font-serif-d text-[26px] mt-2">{wq.data?.title ?? t('Название свадьбы')}</h2>
          <p className="text-[10px] tracking-[.24em] uppercase font-semibold mt-1.5" style={{ color: '#B57171' }}>
            {[weddingDate ? formatWeddingDate(weddingDate) : t('дата уточняется'), wq.data?.city?.name].filter(Boolean).join(' · ')}
          </p>
          <p className="text-[11.5px] text-[var(--ink2)] font-light leading-relaxed mt-3">{inviteText}</p>
          {/* Кнопка «Смотреть как гость» убрана: гостевая страница открывается
              по личному токену, и у пары его нет — переход упирался в
              «Нужна ссылка из приглашения». */}
        </div>

        {/* 10 сценариев */}
        <div className="flex items-baseline justify-between px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">{t('Сценарий приглашения')}</h2>
          <span className="text-[10px] text-[var(--soft)]">{t('10 авторских')}</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {inviteThemes.map((th, k) => (
            <button key={th.id} onClick={() => setInviteTpl(k)} className={cn('press rounded-[20px] p-2 text-left bg-[var(--card)]', theme === k && 'ring-2 ring-[#C98A8A]')} style={{ boxShadow: 'var(--shadow)' }}>
              <div className="h-[64px] rounded-[14px] flex items-center justify-center text-[22px]" style={{ background: th.overlay }}>{th.emoji}</div>
              <b className="text-[11.5px] block mt-2 px-1">«{th.name}»</b>
              <span className="text-[9px] text-[var(--soft)] block px-1 pb-1 leading-tight">{th.desc}</span>
            </button>
          ))}
        </div>

        {/* Дресс-код и палитра */}
        <div className="card p-4 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Дресс-код и палитра')}</span>
          <div className="space-y-2.5 mt-3">
            {dressPalettes.map(p => (
              <button key={p.id} onClick={() => setDress(p.id)} className={cn('press w-full flex items-center gap-3 rounded-[14px] p-2 text-left', dressId === p.id && 'ring-2 ring-[#C98A8A] bg-[var(--track)]')}>
                <span className="flex -space-x-1.5">
                  {p.colors.map(c => <span key={c} className="w-6 h-6 rounded-full border-2 border-[var(--card)]" style={{ background: c }} />)}
                </span>
                <span className="text-[12px] font-medium flex-1">{p.name}</span>
                {dressId === p.id && <span className="text-[var(--sage-deep)] text-[13px]">✓</span>}
              </button>
            ))}
          </div>
          <input value={dressText} onChange={e => setDressNote(e.target.value)} placeholder={t('Комментарий: например, дамы — без белого')}
            className="w-full bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none mt-3" />
        </div>

        {/* Текст */}
        <div className="card p-4 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Текст приглашения')}</span>
          <textarea value={inviteText} onChange={e => setInviteText(e.target.value)} rows={3}
            className="w-full mt-2 bg-[var(--bg)] rounded-xl px-4 py-3 text-[12.5px] outline-none leading-relaxed resize-none" />
          <p className="text-[9.5px] text-[var(--soft2)] mt-1.5">{t('Имя гостя подставляется автоматически в начало')}</p>
        </div>

        {/* Вопросы гостям */}
        <div className="card px-4 py-1.5 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold block pt-3 pb-1">{t('Вопросы в RSVP')}</span>
          {qRow('plus', t('Придёте с +1?'))}
          {qRow('meal', t('Предпочтения по еде'))}
          {qRow('transfer', t('Нужен ли трансфер'))}
        </div>

        {/* Сохранение оформления: текст и тему видит гость, значит они на сервере */}
        <button disabled={busyId === 'design'} onClick={saveDesign} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] mt-4 flex items-center justify-center gap-2 disabled:opacity-50" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          <Check size={15} /> {busyId === 'design' ? t('Сохраняем…') : saved ? t('Оформление сохранено ✓') : t('Сохранить оформление')}
        </button>

        {/*
          * Именные ссылки вместо «разослать».
          *
          * Здесь стояли счётчик «гостей в рассылке» с кнопками ±, нарисованный
          * QR-квадрат, общая ссылка `tili-tili.ru/i/alina-timur` и кнопка
          * «Разослать приглашения», которая меняла только надпись на экране.
          * Ничего не отправлялось, и ссылки такой не существовало.
          *
          * Рассылку контракт не умеет: SMS и почта не подключены. Зато он
          * выдаёт каждому гостю личную одноразовую ссылку — её пара
          * пересылает сама, любым мессенджером.
          */}
        <div className="card p-5 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Именные ссылки')}</span>
          <p className="text-[10.5px] text-[var(--soft)] mt-2 leading-relaxed">
            {t('Каждая ссылка открывается один раз и подставляет имя гостя. Отправьте её сами — так приглашение не разойдётся по чужим чатам.')}
          </p>
          {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-2">{err}</p>}
          <div className="mt-3 space-y-2">
            {!guestList.length && ready(gq) && (
              <p className="text-[12px] text-[var(--soft)] py-2">{t('Список гостей пуст — добавьте гостей, чтобы выдать ссылки')}</p>
            )}
            {guestList.map(g => {
              const url = links[g.id ?? '']
              return (
                <div key={g.id} className="flex items-center gap-2">
                  <span className="flex-1 text-[12.5px] truncate">{g.name}</span>
                  {url ? (
                    <button onClick={() => copy(url)} className="press text-[11px] font-bold px-3 py-1.5 rounded-full bg-[var(--bg)] flex items-center gap-1.5">
                      {copied === url ? <><Check size={12} className="text-[var(--sage-deep)]" />{t('Скопировано')}</> : <><Copy size={12} />{t('Копировать')}</>}
                    </button>
                  ) : (
                    <button disabled={busyId === g.id} onClick={() => issueLink(g.id ?? '')} className="press text-[11px] font-bold px-3 py-1.5 rounded-full grad text-[var(--on-grad)] disabled:opacity-50">
                      {busyId === g.id ? t('Выдаём…') : t('Выдать ссылку')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <button onClick={() => nav('/wedding/guests')} className="press mt-4 w-full card-s py-3 text-[12px] font-semibold">{t('К списку гостей →')}</button>
        </div>
      </div>
    </div>
  )
}
