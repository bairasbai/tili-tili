import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Download, Check, FileText, Plus, Minus, Send, Armchair } from 'lucide-react'
import { contractTemplates, couple, guests, fmt } from '@/lib/data'
import { inviteThemes } from '@/lib/inviteThemes'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { AiTip, Tile, TopBar } from '@/components/chrome'
import { cn } from '@/lib/utils'

/* Карточка сделки */
export function Deal() {
  const nav = useNavigate()
  const { paySlot, cancelBooking } = useStore()
  const [paid, setPaid] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const steps = [
    { label: 'Кандидат', done: true },
    { label: 'Переговоры', done: true },
    { label: 'Договор', done: true },
    { label: 'Аванс 50%', done: true },
    { label: 'День X', done: paid },
    { label: 'Доплата', done: paid },
  ]
  return (
    <div className="pb-28">
      <TopBar back title="Сделка" sub="Ведущий · Артём Краснов" />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <Tile icon="🎤" tile="bg-[var(--lav)]" size={52} />
            <div className="flex-1">
              <b className="font-serif-d text-[17px]">Артём Краснов</b>
              <p className="text-[11px] text-[var(--soft)]">Банкет + церемония · 14.06.2027</p>
            </div>
            <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--honey)] text-[#B98A2F]">⏳ Аванс 50%</span>
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
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">Оплаты</span>
          <div className="flex justify-between items-center mt-3">
            <span className="text-[12.5px]">Аванс · 10 фев</span>
            <b className="tabular text-[13px] text-[#7E9A74]">✓ {fmt(30000)}</b>
          </div>
          <div className="flex justify-between items-center mt-2.5">
            <span className="text-[12.5px]">Доплата · 14 июн</span>
            <b className={cn('tabular text-[13px]', paid ? 'text-[#7E9A74]' : 'text-[var(--soft)]')}>{paid ? `✓ ${fmt(30000)}` : fmt(30000)}</b>
          </div>
          <div className="h-[1.5px] bg-[var(--track)] my-3" />
          <div className="flex justify-between items-center">
            <b className="text-[13px]">Итого по договору</b>
            <b className="font-serif-d text-[17px] text-[#B57171] tabular">{fmt(60000)}</b>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <button onClick={() => nav('/us/chats/ch3')} className="press card-s py-3.5 text-[13px] font-semibold">Написать</button>
          <button onClick={() => nav('/wedding/documents/new')} className="press card-s py-3.5 text-[13px] font-semibold flex items-center justify-center gap-1.5"><FileText size={14} /> Договор</button>
          {paid ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[#7E9A74] text-center">✓ Оплачено полностью</div>
          ) : (
            <button onClick={() => { setPaid(true); paySlot('s4') }} className="press card-s py-3.5 text-[13px] font-semibold text-[#7E9A74]">✓ Отметить доплату</button>
          )}
          {cancelled ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">Сделка отменена</div>
          ) : confirmCancel ? (
            <button onClick={() => { setCancelled(true); setConfirmCancel(false); cancelBooking('s4') }} className="press py-3.5 rounded-[18px] bg-[#B57171] text-white text-[13px] font-semibold">Точно отменить?</button>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="press card-s py-3.5 text-[13px] font-semibold text-[#B57171]">Отменить сделку</button>
          )}
        </div>
        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">История</span>
          {[
            ['10 фев', 'Аванс подтверждён подрядчиком', true],
            ['8 фев', 'Договор подписан обеими сторонами', true],
            ['3 фев', 'Hold 72 ч → подрядчик подтвердил дату', true],
            ['1 фев', 'Вы добавили Артёма в команду', true],
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

        <p className="text-[10px] text-[var(--soft2)] text-center leading-relaxed">Отмена менее чем за 30 дней до даты блокирует отзывы обеим сторонам до решения модерации.</p>
      </div>
    </div>
  )
}

/* Генерация и скачивание договора: DOCX (Word-совместимый HTML) / PDF (окно печати) */
function contractHTML(name: string) {
  return `<h1>${name}</h1><p>г. Уфа · ${new Date().toLocaleDateString('ru-RU')}</p>
  <p><b>Заказчик:</b> Алина Козлова и Тимур Волков<br><b>Исполнитель:</b> ______________________</p>
  <p>1. Предмет договора: услуги на свадебное торжество 14.06.2027.</p>
  <p>2. Стоимость и порядок оплаты: аванс 30% при подписании, остаток — за 14 дней до даты.</p>
  <p>3. Ответственность сторон и форс-мажор — по ГК РФ.</p>
  <p>4. Сформировано в приложении «Тили-тили» (tili-tili.ru).</p>`
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
  w.document.write(`<html><head><meta charset="utf-8"><title>${name}</title></head><body style="font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.6">${contractHTML(name)}<script>window.onload=()=>window.print()<\/script></body></html>`)
  w.document.close()
}

/* Мастер договора: шаблон → данные → готово */
export function ContractWizard() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [tpl, setTpl] = useState(0)
  const [done, setDone] = useState(false)
  const t = contractTemplates[tpl]

  if (done) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center fade-up">
      <div className="w-[92px] h-[92px] rounded-full grad flex items-center justify-center text-white pop" style={{ boxShadow: '0 20px 44px -14px rgba(201,138,138,.6)' }}><Check size={38} strokeWidth={2.5} /></div>
      <h1 className="font-serif-d text-[28px] mt-7">Договор готов</h1>
      <p className="text-[13px] text-[var(--soft)] mt-3 font-light leading-relaxed">«{t.name}» сгенерирован с вашими данными. Скачайте, подпишите с подрядчиком и загрузите скан в сделку.</p>
      <div className="flex gap-2.5 mt-8 w-full">
        <button onClick={() => downloadPdf(t.name)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> PDF</button>
        <button onClick={() => downloadDocx(t.name)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> DOCX</button>
      </div>
      <button onClick={() => nav('/wedding/documents')} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-2.5" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>Готово</button>
    </div>
  )

  return (
    <div className="min-h-dvh flex flex-col pb-10">
      <TopBar back title="Новый договор" sub={`Шаг ${step + 1} из 2`} />
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
            {[['Заказчик', couple.full], ['Исполнитель', 'Артём Краснов'], ['Дата оказания услуги', couple.date], ['Сумма', fmt(60000)], ['Аванс', fmt(30000) + ' · возврат 50% при отмене за 30 дней']].map(([l, v]) => (
              <div key={l}>
                <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{l}</span>
                <p className="text-[13.5px] font-medium mt-0.5">{v}</p>
              </div>
            ))}
            <div>
              <span className="text-[10px] tracking-[.14em] uppercase text-[#B57171] font-semibold">Паспортные данные *</span>
              <input placeholder="Заполните перед подписанием" className="w-full mt-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            </div>
          </div>
          <p className="text-[10px] text-[var(--soft2)] mt-3 text-center">Шаблон — информационный, не заменяет консультацию юриста</p>
        </div>
      )}
      <div className="px-5 mt-auto pt-6">
        <button onClick={() => (step === 0 ? setStep(1) : setDone(true))} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {step === 0 ? 'Далее' : 'Сгенерировать договор ✨'}
        </button>
      </div>
    </div>
  )
}

/* Рассадка */
export function Seating() {
  const [tables, setTables] = usePersist('tt_tables', [
    { n: 1, guests: ['Марина Ивановна', 'Игорь Петрович', 'Бабушка Зоя', 'Дядя Рафик'] },
    { n: 2, guests: ['Тётя Люда', 'Айгуль и Марсель', 'Кузина Дина'] },
    { n: 3, guests: ['Ольга и Денис', 'Коллеги Тимура (4)'] },
    { n: 4, guests: [] as string[] },
  ])
  const [unseated, setUnseated] = usePersist<string[]>('tt_unseated', ['Руслан Гареев', 'Айгуль и Марсель', 'Семья Хакимовых'])
  const [selected, setSelected] = useState<string | null>(null)
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
      <TopBar back title="Рассадка" sub={selected ? `Сажаем: ${selected} — выберите стол` : 'Выберите гостя, затем стол'} />
      <div className="px-5 mt-3">
        <div className="card-s px-4 py-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold shrink-0">Без стола:</span>
          {unseated.map(g => (
            <button key={g} onClick={() => setSelected(s => s === g ? null : g)} className={cn('press text-[10.5px] font-medium px-3 py-1.5 rounded-full whitespace-nowrap shrink-0 transition-all', selected === g ? 'grad text-white' : 'bg-[var(--bg)]')}>{g}</button>
          ))}
          {!unseated.length && <span className="text-[10.5px] text-[#7E9A74] font-semibold">все рассажены ✓</span>}
        </div>
      </div>
      <div className="px-5 mt-3 grid grid-cols-2 gap-3 stagger">
        {tables.map((t, i) => (
          <div key={t.n} onClick={() => seat(i)} className={cn('card p-4 text-left fade-up transition-all', selected && t.guests.length < 8 && 'ring-2 ring-[#A9BCA0] cursor-pointer')}>
            <div className="flex items-center justify-between">
              <b className="font-serif-d text-[16px]">Стол №{t.n}</b>
              <span className="text-[9px] text-[var(--soft)] flex items-center gap-1"><Armchair size={10} /> {t.guests.length}/8</span>
            </div>
            <div className="mt-2.5 space-y-1.5 min-h-[60px]">
              {t.guests.length ? t.guests.map(g => (
                <button key={g} onClick={e => { e.stopPropagation(); unseat(i, g) }} className="press w-full text-left text-[11px] bg-[var(--bg)] rounded-lg px-2.5 py-1.5 truncate">{g}</button>
              )) : <div className="text-[10.5px] text-[var(--soft2)] py-3 text-center border-[1.5px] border-dashed border-[#EAD9CF] rounded-xl">Пусто</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="px-5 mt-4 space-y-3">
        <button onClick={() => setTables(ts => [...ts, { n: ts.length + 1, guests: [] as string[] }])} className="press w-full card-s py-4 text-[13px] font-semibold flex items-center justify-center gap-2"><Plus size={15} /> Добавить стол</button>
        <AiTip text="Тётя Люда и дядя Рафик отмечены «не сажать вместе» — они за соседними столами, всё в порядке." />
        <button onClick={() => window.print()} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] flex items-center justify-center gap-2"><Download size={15} /> PDF для печати А3</button>
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
      <TopBar back title="Приглашения" sub="10 сценариев · ссылка · RSVP" />
      <div className="px-5 mt-3">
        {/* Превью сценария */}
        <div className="card p-6 text-center relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-2" style={{ background: inviteThemes[theme].accentGrad }} />
          <div className="w-[52px] h-[52px] rounded-full mx-auto flex items-center justify-center text-white font-serif-d text-[16px]" style={{ background: inviteThemes[theme].accentGrad }}>А♥Т</div>
          <p className="font-serif-d italic text-[14px] text-[var(--soft)] mt-4">Дорогая Марина Ивановна!</p>
          <h2 className="font-serif-d text-[26px] mt-2">{couple.bride} & {couple.groom}</h2>
          <p className="text-[10px] tracking-[.24em] uppercase font-semibold mt-1.5" style={{ color: '#B57171' }}>{couple.date} · {couple.city}</p>
          <p className="text-[11.5px] text-[var(--ink2)] font-light leading-relaxed mt-3">{inviteText}</p>
          <button onClick={() => nav('/invite')} className="press mt-4 px-5 h-[40px] rounded-full grad text-white text-[11.5px] font-semibold">Смотреть как гость →</button>
        </div>

        {/* 10 сценариев */}
        <div className="flex items-baseline justify-between px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">Сценарий приглашения</h2>
          <span className="text-[10px] text-[var(--soft)]">10 авторских</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {inviteThemes.map((t, k) => (
            <button key={t.id} onClick={() => setInviteTpl(k)} className={cn('press rounded-[20px] p-2 text-left bg-[var(--card)]', theme === k && 'ring-2 ring-[#C98A8A]')} style={{ boxShadow: 'var(--shadow)' }}>
              <div className="h-[64px] rounded-[14px] flex items-center justify-center text-[22px]" style={{ background: t.overlay }}>{t.emoji}</div>
              <b className="text-[11.5px] block mt-2 px-1">«{t.name}»</b>
              <span className="text-[9px] text-[var(--soft)] block px-1 pb-1 leading-tight">{t.desc}</span>
            </button>
          ))}
        </div>

        {/* Текст */}
        <div className="card p-4 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">Текст приглашения</span>
          <textarea value={inviteText} onChange={e => setInviteText(e.target.value)} rows={3}
            className="w-full mt-2 bg-[var(--bg)] rounded-xl px-4 py-3 text-[12.5px] outline-none leading-relaxed resize-none" />
          <p className="text-[9.5px] text-[var(--soft2)] mt-1.5">Имя гостя подставляется автоматически в начало</p>
        </div>

        {/* Вопросы гостям */}
        <div className="card px-4 py-1.5 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold block pt-3 pb-1">Вопросы в RSVP</span>
          {qRow('plus', 'Придёте с +1?')}
          {qRow('meal', 'Предпочтения по еде')}
          {qRow('transfer', 'Нужен ли трансфер')}
        </div>

        {/* Рассылка */}
        <div className="card p-5 mt-4">
          <div className="flex items-center justify-between">
            <b className="text-[13px]">Гостей в рассылке</b>
            <div className="flex items-center gap-3">
              <button onClick={() => setCount(Math.max(1, count - 1))} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center"><Minus size={14} /></button>
              <b className="tabular text-[16px] w-8 text-center">{count}</b>
              <button onClick={() => setCount(Math.min(guests.length * 10, count + 1))} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center"><Plus size={14} /></button>
            </div>
          </div>
          <p className="text-[10.5px] text-[var(--soft)] mt-3">Каждому — именная ссылка и QR. Ответы RSVP приходят в раздел «Гости» в реальном времени.</p>
        </div>

        {/* Ссылка и QR */}
        <div className="card p-5 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">Ссылка и QR</span>
          <div className="flex items-center gap-3 mt-3">
            <div className="w-[72px] h-[72px] rounded-2xl bg-[var(--ink)] p-2 grid grid-cols-5 gap-[3px]">
              {Array.from({ length: 25 }).map((_, k) => (
                <span key={k} className="rounded-[2px]" style={{ background: [0,1,2,4,5,10,12,14,20,21,23,24,7,17].includes(k) ? 'var(--bg)' : 'transparent' }} />
              ))}
            </div>
            <div className="flex-1 min-w-0">
              <b className="text-[12px] block truncate">tili-tili.ru/i/alina-timur</b>
              <p className="text-[10px] text-[var(--soft)] mt-1">Мессенджер сам подтянет обложку и имена — гость увидит приглашение ещё до клика.</p>
            </div>
          </div>
        </div>

        {sentInvites ? (
          <div className="card p-5 mt-4 text-center pop">
            <b className="text-[15px]">✓ Отправлено {count} гостям</b>
            <p className="text-[11px] text-[var(--soft)] mt-1.5">Ответы RSVP появятся в разделе «Гости» в реальном времени</p>
            <button onClick={() => nav('/wedding/guests')} className="press mt-4 px-6 h-[44px] rounded-full grad text-white text-[12px] font-semibold">К списку гостей →</button>
          </div>
        ) : (
          <button onClick={() => setSentInvites(true)} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-4 flex items-center justify-center gap-2" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            <Send size={15} /> Разослать приглашения
          </button>
        )}
      </div>
    </div>
  )
}
