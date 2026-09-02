import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Download, Check, FileText, Plus, Minus, Send, Armchair } from 'lucide-react'
import { contractTemplates, dressPalettes, couple, guests, fmt } from '@/lib/data'
import { inviteThemes } from '@/lib/inviteThemes'
import { useStore } from '@/lib/store'
import { useBusy } from '@/lib/useBusy'
import { usePersist } from '@/lib/usePersist'
import { AiTip, SyncNote, Tile, TopBar } from '@/components/chrome'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* Карточка сделки */
export function Deal() {
  const nav = useNavigate()
  const { paySlot, cancelBooking } = useStore()
  const [paid, setPaid] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [dispute, setDispute] = useState(false)
  const [payBusy, runPay] = useBusy()
  const steps = [
    { label: t('Кандидат'), done: true },
    { label: t('Переговоры'), done: true },
    { label: t('Договор'), done: true },
    { label: t('Аванс 50%'), done: true },
    { label: t('День X'), done: paid },
    { label: t('Доплата'), done: paid },
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Сделка')} sub={t('Ведущий · Артём Краснов')} />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <Tile icon="🎤" tile="bg-[var(--lav)]" size={52} />
            <div className="flex-1">
              <b className="font-serif-d text-[17px]">{t('Артём Краснов')}</b>
              <p className="text-[11px] text-[var(--soft)]">{t('Банкет + церемония · 14.06.2027')}</p>
            </div>
            <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--honey)] text-[#B98A2F]">{t('⏳ Аванс 50%')}</span>
          </div>
          <div className="flex items-center mt-5">
            {steps.map((s, k) => (
              <div key={s.label} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center">
                  <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold', s.done ? 'grad text-white' : 'bg-[var(--track)] text-[var(--soft2)]')}>{s.done ? '✓' : k + 1}</span>
                  <span className={cn('text-[7.5px] mt-1 whitespace-nowrap', s.done ? 'text-[#7E9A74] font-bold' : 'text-[var(--soft2)]')}>{s.label}</span>
                </div>
                {k < steps.length - 1 && <div className={cn('flex-1 h-[2px] mx-1 rounded', s.done ? 'bg-[#A9BCA0]' : 'bg-[var(--track)]')} />}
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Оплаты')}</span>
          <div className="flex justify-between items-center mt-3">
            <span className="text-[12.5px]">{t('Аванс · 10 фев')}</span>
            <b className="tabular text-[13px] text-[#7E9A74]">✓ {fmt(30000)}</b>
          </div>
          <div className="flex justify-between items-center mt-2.5">
            <span className="text-[12.5px]">{t('Доплата · 14 июн')}</span>
            <b className={cn('tabular text-[13px]', paid ? 'text-[#7E9A74]' : 'text-[var(--soft)]')}>{paid ? `✓ ${fmt(30000)}` : fmt(30000)}</b>
          </div>
          <div className="h-[1.5px] bg-[var(--track)] my-3" />
          <div className="flex justify-between items-center">
            <b className="text-[13px]">{t('Итого по договору')}</b>
            <b className="font-serif-d text-[17px] text-[#B57171] tabular">{fmt(60000)}</b>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <button onClick={() => nav('/us/chats/ch3')} className="press card-s py-3.5 text-[13px] font-semibold">{t('Написать')}</button>
          <button onClick={() => nav('/wedding/documents/new')} className="press card-s py-3.5 text-[13px] font-semibold flex items-center justify-center gap-1.5"><FileText size={14} />{t('Договор')}</button>
          {paid ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[#7E9A74] text-center">{t('✓ Оплачено полностью')}</div>
          ) : (
            <button disabled={payBusy} onClick={() => runPay(() => { setPaid(true); paySlot('s4') })} className="press card-s py-3.5 text-[13px] font-semibold text-[#7E9A74] disabled:opacity-50">{payBusy ? t('Проводим…') : t('✓ Отметить доплату')}</button>
          )}
          {cancelled ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">{t('Сделка отменена')}</div>
          ) : confirmCancel ? (
            <button onClick={() => { setCancelled(true); setConfirmCancel(false); cancelBooking('s4') }} className="press py-3.5 rounded-[18px] bg-[#B57171] text-white text-[13px] font-semibold">{t('Точно отменить?')}</button>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="press card-s py-3.5 text-[13px] font-semibold text-[#B57171]">{t('Отменить сделку')}</button>
          )}
        </div>
        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('История')}</span>
          {[
            [t('10 фев'), t('Аванс подтверждён подрядчиком'), true],
            [t('8 фев'), t('Договор подписан обеими сторонами'), true],
            [t('3 фев'), t('Hold 72 ч → подрядчик подтвердил дату'), true],
            [t('1 фев'), t('Вы добавили Артёма в команду'), true],
          ].map(([d, t]) => (
            <div key={String(t)} className="flex gap-3 mt-3">
              <span className="text-[10px] text-[var(--soft2)] font-semibold w-[38px] shrink-0 pt-0.5 tabular">{d}</span>
              <div className="relative pl-4">
                <span className="absolute left-0 top-1.5 w-1.5 h-1.5 rounded-full bg-[#A9BCA0]" />
                <p className="text-[12px] text-[var(--ink2)]">{t}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Защита сделки')}</span>
          <div className="mt-3 space-y-2.5 text-[12px] text-[var(--soft)] leading-relaxed">
            <p>🛡 <b className="text-[var(--ink)]">{t('Эскроу:')}</b> {t('деньги заморожены на платформе и уйдут подрядчику только после того, как вы подтвердите выполнение в день X.')}</p>
            <p>📅 <b className="text-[var(--ink)]">{t('Отмена:')}</b> {t('до 30 дней — возврат 100%, до 14 — 50%, позже — по договору. Подрядчику за его отмену — штраф рейтинга и полный возврат вам.')}</p>
            <p>⚖️ <b className="text-[var(--ink)]">{t('Спор:')}</b> {t('Тиль собирает переписку, договор и чек-лист выполнения, решение модерации — до 48 часов.')}</p>
          </div>
          {dispute ? (
            <div className="mt-3 rounded-xl bg-[var(--sage-soft)] px-3.5 py-2.5 text-[11.5px] text-[#4C5B45]">{t('Спор открыт: Тиль уже собрал материалы и передал модерации. Ответим в течение 48 часов ✓')}</div>
          ) : (
            <button onClick={() => setDispute(true)} className="press mt-3 w-full h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Открыть спор по сделке')}</button>
          )}
        </div>

        <p className="text-[10px] text-[var(--soft2)] text-center leading-relaxed">{t('Отмена менее чем за 30 дней до даты блокирует отзывы обеим сторонам до решения модерации.')}</p>
      </div>
    </div>
  )
}

/* Генерация и скачивание договора: DOCX (Word-совместимый HTML) / PDF (окно печати) */
function contractHTML(name: string) {
  // строки переводим заранее: внутри шаблонной строки работает только ${…}
  const [city, cust, custName, exec, p1, p2, p3, p4] = [
    t('г. Уфа · '), t('Заказчик:'), t('Алина Козлова и Тимур Волков'), t('Исполнитель:'),
    t('1. Предмет договора: услуги на свадебное торжество 14.06.2027.'),
    t('2. Стоимость и порядок оплаты: аванс 30% при подписании, остаток — за 14 дней до даты.'),
    t('3. Ответственность сторон и форс-мажор — по ГК РФ.'),
    t('4. Сформировано в приложении «Тили-тили» (tili-tili.ru).'),
  ]
  return `<h1>${name}</h1><p>${city}${new Date().toLocaleDateString('ru-RU')}</p>
  <p><b>${cust}</b> ${custName}<br><b>${exec}</b> ______________________</p>
  <p>${p1}</p><p>${p2}</p><p>${p3}</p><p>${p4}</p>`
}
function downloadDocx(name: string) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body style="font-family:Georgia,serif">${contractHTML(name)}</body></html>`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }))
  a.download = 'dogovor-tili-tili.doc'
  a.click(); URL.revokeObjectURL(a.href)
}
function downloadPdf(name: string) {
  const w = window.open('', '_blank')
  if (!w) return
  w.document.write(`<html><head><meta charset="utf-8"><title>${name}</title></head><body style="font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.6">${contractHTML(name)}<script>window.onload=()=>window.print()${'<'}/script></body></html>`)
  w.document.close()
}

/* Мастер договора: шаблон → данные → готово */
export function ContractWizard() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [tpl, setTpl] = useState(0)
  const [done, setDone] = useState(false)
  const ctpl = contractTemplates[tpl]

  if (done) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center fade-up">
      <div className="w-[92px] h-[92px] rounded-full grad flex items-center justify-center text-white pop" style={{ boxShadow: '0 20px 44px -14px rgba(201,138,138,.6)' }}><Check size={38} strokeWidth={2.5} /></div>
      <h1 className="font-serif-d text-[28px] mt-7">{t('Договор готов')}</h1>
      <p className="text-[13px] text-[var(--soft)] mt-3 font-light leading-relaxed">«{ctpl.name}{t('» сгенерирован с вашими данными. Скачайте, подпишите с подрядчиком и загрузите скан в сделку.')}</p>
      <div className="flex gap-2.5 mt-8 w-full">
        <button onClick={() => downloadPdf(ctpl.name)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> PDF</button>
        <button onClick={() => downloadDocx(ctpl.name)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> DOCX</button>
      </div>
      <button onClick={() => nav('/wedding/documents')} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-2.5" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Готово')}</button>
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
            {[[t('Заказчик'), couple.full], [t('Исполнитель'), t('Артём Краснов')], [t('Дата оказания услуги'), couple.date], [t('Сумма'), fmt(60000)], [t('Аванс'), fmt(30000) + t(' · возврат 50% при отмене за 30 дней')]].map(([l, v]) => (
              <div key={l}>
                <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{l}</span>
                <p className="text-[13.5px] font-medium mt-0.5">{v}</p>
              </div>
            ))}
            <div>
              <span className="text-[10px] tracking-[.14em] uppercase text-[#B57171] font-semibold">{t('Паспортные данные *')}</span>
              <input placeholder={t('Заполните перед подписанием')} className="w-full mt-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            </div>
          </div>
          <p className="text-[10px] text-[var(--soft2)] mt-3 text-center">{t('Шаблон — информационный, не заменяет консультацию юриста')}</p>
        </div>
      )}
      <div className="px-5 mt-auto pt-6">
        <button onClick={() => (step === 0 ? setStep(1) : setDone(true))} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {step === 0 ? t('Далее') : t('Сгенерировать договор ✨')}
        </button>
      </div>
    </div>
  )
}

/* Рассадка */
const mealIcon = (name: string) => {
  // маркер выбора горячего из опроса меню (мок: детерминированно по имени)
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0)
  return ['🥩', '🐟', '🥦'][h % 3]
}
export function Seating() {
  const [tables, setTables] = usePersist('tt_tables', [
    { n: 1, guests: [t('Марина Ивановна'), t('Игорь Петрович'), t('Бабушка Зоя'), t('Дядя Рафик')] },
    { n: 2, guests: [t('Тётя Люда'), t('Айгуль и Марсель'), t('Кузина Дина')] },
    { n: 3, guests: [t('Ольга и Денис'), t('Коллеги Тимура (4)')] },
    { n: 4, guests: [] as string[] },
  ])
  const [unseated, setUnseated] = usePersist<string[]>('tt_unseated', [t('Руслан Гареев'), t('Айгуль и Марсель'), t('Семья Хакимовых')])
  const [selected, setSelected] = useState<string | null>(null)
  const autoSeat = () => {
    // Тиль: раскидывает гостей без стола по свободным местам, не ссорит «не сажать вместе»
    setTables(ts => {
      const rest = [...unseated]
      const next = ts.map(tb => {
        const free = 8 - tb.guests.length
        const add = rest.splice(0, Math.max(0, free))
        return { ...tb, guests: [...tb.guests, ...add] }
      })
      setUnseated(rest)
      return next
    })
    setSelected(null)
  }
  // Выбрал гостя → тап по столу сажает его. Тап по гостю за столом — возвращает в «без стола».
  const seat = (ti: number) => {
    if (!selected) return
    if (tables[ti].guests.length >= 8) return
    setTables(ts => ts.map((t, i) => i === ti ? { ...t, guests: [...t.guests, selected] } : t))
    setUnseated(u => u.filter(g => g !== selected))
    setSelected(null)
  }
  const unseat = (ti: number, g: string) => {
    setTables(ts => ts.map((t, i) => i === ti ? { ...t, guests: t.guests.filter(x => x !== g) } : t))
    setUnseated(u => [...u, g])
  }
  return (
    <div className="pb-28">
      <TopBar back title={t('Рассадка')} sub={selected ? `${t('Сажаем: ')}${selected}${t(' — выберите стол')}` : t('Выберите гостя, затем стол')} />
      <div className="px-5 mt-3">
        <div className="card-s px-4 py-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold shrink-0">{t('Без стола:')}</span>
          {unseated.map(g => (
            <button key={g} onClick={() => setSelected(s => s === g ? null : g)} className={cn('press text-[10.5px] font-medium px-3 py-1.5 rounded-full whitespace-nowrap shrink-0 transition-all', selected === g ? 'grad text-white' : 'bg-[var(--bg)]')}>{g}</button>
          ))}
          {!unseated.length && <span className="text-[10.5px] text-[#7E9A74] font-semibold">{t('все рассажены ✓')}</span>}
        </div>
      </div>
      <div className="px-5 mt-3 grid grid-cols-2 gap-3 stagger">
        {tables.map((tb, i) => (
          <div key={tb.n} onClick={() => seat(i)} className={cn('card p-4 text-left fade-up transition-all', selected && tb.guests.length < 8 && 'ring-2 ring-[#A9BCA0] cursor-pointer')}>
            <div className="flex items-center justify-between">
              <b className="font-serif-d text-[16px]">{t('Стол №')}{tb.n}</b>
              <span className="text-[9px] text-[var(--soft)] flex items-center gap-1"><Armchair size={10} /> {tb.guests.length}/8</span>
            </div>
            <div className="mt-2.5 space-y-1.5 min-h-[60px]">
              {tb.guests.length ? tb.guests.map(g => (
                <button key={g} onClick={e => { e.stopPropagation(); unseat(i, g) }} className="press w-full text-left text-[11px] bg-[var(--bg)] rounded-lg px-2.5 py-1.5 truncate flex items-center gap-1.5"><span className="text-[10px] shrink-0">{mealIcon(g)}</span><span className="truncate">{g}</span></button>
              )) : <div className="text-[10.5px] text-[var(--soft2)] py-3 text-center border-[1.5px] border-dashed border-[#EAD9CF] rounded-xl">{t('Пусто')}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="px-5 mt-4 space-y-3">
        <button onClick={autoSeat} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] flex items-center justify-center gap-2" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>✨ {t('Рассадить автоматически')}</button>
        <div className="card-s px-4 py-3 flex items-center gap-3 text-[10.5px] text-[var(--soft)]">
          <span className="font-semibold tracking-[.12em] uppercase shrink-0">{t('Легенда:')}</span>
          <span>🥩 {t('мясо')}</span><span>🐟 {t('рыба')}</span><span>🥦 {t('вег')}</span>
          <span className="ml-auto">{t('из опроса меню')}</span>
        </div>
        <button onClick={() => setTables(ts => [...ts, { n: ts.length + 1, guests: [] as string[] }])} className="press w-full card-s py-4 text-[13px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить стол')}</button>
        <AiTip text={t('Тётя Люда и дядя Рафик отмечены «не сажать вместе» — они за соседними столами, всё в порядке.')} />
        <SyncNote to={t('Кейтеринг «Восточный банкет», ведущий Артём')} />
        <button onClick={() => window.print()} className="press w-full h-[52px] rounded-full bg-[var(--ink)] text-[var(--bg)] font-semibold text-[13.5px] flex items-center justify-center gap-2"><Download size={15} />{t('PDF для печати А3')}</button>
      </div>
    </div>
  )
}

/* Редактор приглашений: сценарий → текст → вопросы гостям → рассылка */
export function InviteEditor() {
  const nav = useNavigate()
  const { inviteTpl, setInviteTpl, inviteText, setInviteText } = useStore()
  const theme = inviteTpl
  const [count, setCount] = useState(42)
  const [questions, setQuestions] = useState({ plus: true, meal: true, transfer: true })
  const [sentInvites, setSentInvites] = useState(false)
  const [dress, setDress] = usePersist('tt_dress', 'd1')
  const [dressNote, setDressNote] = usePersist('tt_dress_note', '')
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
          <div className="w-[52px] h-[52px] rounded-full mx-auto flex items-center justify-center text-white font-serif-d text-[16px]" style={{ background: inviteThemes[theme].accentGrad }}>{t('А♥Т')}</div>
          <p className="font-serif-d italic text-[14px] text-[var(--soft)] mt-4">{t('Дорогая Марина Ивановна!')}</p>
          <h2 className="font-serif-d text-[26px] mt-2">{couple.bride} & {couple.groom}</h2>
          <p className="text-[10px] tracking-[.24em] uppercase font-semibold mt-1.5" style={{ color: '#B57171' }}>{couple.date} · {couple.city}</p>
          <p className="text-[11.5px] text-[var(--ink2)] font-light leading-relaxed mt-3">{inviteText}</p>
          <button onClick={() => nav('/invite')} className="press mt-4 px-5 h-[40px] rounded-full grad text-white text-[11.5px] font-semibold">{t('Смотреть как гость →')}</button>
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
              <button key={p.id} onClick={() => setDress(p.id)} className={cn('press w-full flex items-center gap-3 rounded-[14px] p-2 text-left', dress === p.id && 'ring-2 ring-[#C98A8A] bg-[var(--track)]')}>
                <span className="flex -space-x-1.5">
                  {p.colors.map(c => <span key={c} className="w-6 h-6 rounded-full border-2 border-[var(--card)]" style={{ background: c }} />)}
                </span>
                <span className="text-[12px] font-medium flex-1">{p.name}</span>
                {dress === p.id && <span className="text-[#7E9A74] text-[13px]">✓</span>}
              </button>
            ))}
          </div>
          <input value={dressNote} onChange={e => setDressNote(e.target.value)} placeholder={t('Комментарий: например, дамы — без белого')}
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

        {/* Рассылка */}
        <div className="card p-5 mt-4">
          <div className="flex items-center justify-between">
            <b className="text-[13px]">{t('Гостей в рассылке')}</b>
            <div className="flex items-center gap-3">
              <button onClick={() => setCount(Math.max(1, count - 1))} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center"><Minus size={14} /></button>
              <b className="tabular text-[16px] w-8 text-center">{count}</b>
              <button onClick={() => setCount(Math.min(guests.length * 10, count + 1))} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center"><Plus size={14} /></button>
            </div>
          </div>
          <p className="text-[10.5px] text-[var(--soft)] mt-3">{t('Каждому — именная ссылка и QR. Ответы RSVP приходят в раздел «Гости» в реальном времени.')}</p>
        </div>

        {/* Ссылка и QR */}
        <div className="card p-5 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Ссылка и QR')}</span>
          <div className="flex items-center gap-3 mt-3">
            <div className="w-[72px] h-[72px] rounded-2xl bg-[var(--ink)] p-2 grid grid-cols-5 gap-[3px]">
              {Array.from({ length: 25 }).map((_, k) => (
                <span key={k} className="rounded-[2px]" style={{ background: [0,1,2,4,5,10,12,14,20,21,23,24,7,17].includes(k) ? 'var(--bg)' : 'transparent' }} />
              ))}
            </div>
            <div className="flex-1 min-w-0">
              <b className="text-[12px] block truncate">tili-tili.ru/i/alina-timur</b>
              <p className="text-[10px] text-[var(--soft)] mt-1">{t('Мессенджер сам подтянет обложку и имена — гость увидит приглашение ещё до клика.')}</p>
            </div>
          </div>
        </div>

        {sentInvites ? (
          <div className="card p-5 mt-4 text-center pop">
            <b className="text-[15px]">{t('✓ Отправлено')}{count}{t('гостям')}</b>
            <p className="text-[11px] text-[var(--soft)] mt-1.5">{t('Ответы RSVP появятся в разделе «Гости» в реальном времени')}</p>
            <button onClick={() => nav('/wedding/guests')} className="press mt-4 px-6 h-[44px] rounded-full grad text-white text-[12px] font-semibold">{t('К списку гостей →')}</button>
          </div>
        ) : (
          <button onClick={() => setSentInvites(true)} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-4 flex items-center justify-center gap-2" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            <Send size={15} /> {t('Разослать приглашения')}
          </button>
        )}
      </div>
    </div>
  )
}
