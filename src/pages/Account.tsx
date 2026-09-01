import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Shield, Smartphone, ChevronRight, HelpCircle, LogOut, MapPin, MonitorSmartphone, Moon } from 'lucide-react'
import { TopBar, Tile } from '@/components/chrome'
import { CityPicker } from '@/components/CityPicker'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

/* Вход: телефон → OTP → роль */
export function Auth() {
  const nav = useNavigate()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState(['', '', '', ''])
  const [sec, setSec] = useState(42)
  useEffect(() => {
    if (step !== 1 || sec <= 0) return
    const t = setTimeout(() => setSec(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [step, sec])

  return (
    <div className="min-h-dvh flex flex-col">
      <div className="flex items-center px-5 pt-7">
        {step > 0 ? (
          <button onClick={() => setStep((step - 1) as 0 | 1)} className="press w-10 h-10 rounded-full bg-white flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label="Назад">
            <ChevronLeft size={18} />
          </button>
        ) : <div className="w-10" />}
      </div>

      {step === 0 && (
        <div className="flex-1 px-7 pt-10 fade-up">
          <div className="w-[72px] h-[72px] rounded-[24px] grad flex items-center justify-center text-white text-[28px] font-serif-d" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>Тт</div>
          <h1 className="font-serif-d text-[32px] mt-7">С возвращением</h1>
          <p className="text-[13.5px] text-[#93897F] mt-2 font-light">Введите номер телефона — пришлём код из SMS</p>
          <div className="card-s flex items-center gap-3 px-5 py-4 mt-8">
            <Smartphone size={18} className="text-[#B57171]" />
            <span className="text-[15px] font-semibold">+7</span>
            <input value={phone} onChange={e => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
              inputMode="tel" placeholder="917 123-45-67" className="bg-transparent outline-none text-[15px] w-full placeholder:text-[#CFC5BA]" />
          </div>
          <p className="text-[10.5px] text-[#BFB5AA] mt-4 leading-relaxed">Продолжая, вы принимаете оферту и политику конфиденциальности</p>
        </div>
      )}

      {step === 1 && (
        <div className="flex-1 px-7 pt-10 fade-up">
          <h1 className="font-serif-d text-[32px]">Код из SMS</h1>
          <p className="text-[13.5px] text-[#93897F] mt-2 font-light">Отправили на +7 {phone || '··· ···-··-··'}</p>
          <div className="flex gap-3 mt-8">
            {code.map((c, k) => (
              <input key={k} value={c} inputMode="numeric" maxLength={1}
                id={`otp-${k}`}
                onChange={e => {
                  const v = e.target.value.replace(/\D/g, '')
                  setCode(cc => cc.map((x, i) => (i === k ? v : x)))
                  if (v && k < 3) document.getElementById(`otp-${k + 1}`)?.focus()
                }}
                className="card-s w-full aspect-square text-center text-[22px] font-bold outline-none focus:ring-2 focus:ring-[#C98A8A]" />
            ))}
          </div>
          <button onClick={() => sec === 0 && setSec(42)} className={cn('text-[12px] font-semibold mt-6 press', sec > 0 ? 'text-[#BFB5AA]' : 'text-[#B57171]')}>
            {sec > 0 ? `Отправить код повторно · 0:${String(sec).padStart(2, '0')}` : 'Отправить код повторно'}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="flex-1 px-7 pt-10 fade-up">
          <h1 className="font-serif-d text-[32px]">Кто вы?</h1>
          <p className="text-[13.5px] text-[#93897F] mt-2 font-light">Роль можно добавить второй позже</p>
          <div className="space-y-3 mt-8 stagger">
            <button onClick={() => nav('/quiz')} className="press w-full card p-5 flex items-center gap-4 text-left fade-up">
              <div className="w-[52px] h-[52px] rounded-[18px] bg-[#F2DFDC] flex items-center justify-center text-[24px]">💍</div>
              <div className="flex-1"><b className="text-[15px]">Мы планируем свадьбу</b><p className="text-[11.5px] text-[#93897F] mt-0.5">Конструктор, бюджет, гости, день X</p></div>
              <ChevronRight size={18} className="text-[#BFB5AA]" />
            </button>
            <button onClick={() => nav('/vendor-app/profile')} className="press w-full card p-5 flex items-center gap-4 text-left fade-up">
              <div className="w-[52px] h-[52px] rounded-[18px] bg-[#E6EEE2] flex items-center justify-center text-[24px]">✨</div>
              <div className="flex-1"><b className="text-[15px]">Я подрядчик</b><p className="text-[11.5px] text-[#93897F] mt-0.5">Анкета-витрина, заявки, календарь, сделки</p></div>
              <ChevronRight size={18} className="text-[#BFB5AA]" />
            </button>
            <button onClick={() => nav('/invite')} className="press w-full card p-5 flex items-center gap-4 text-left fade-up">
              <div className="w-[52px] h-[52px] rounded-[18px] bg-[#F0DCB8] flex items-center justify-center text-[24px]">💌</div>
              <div className="flex-1"><b className="text-[15px]">Я гость</b><p className="text-[11.5px] text-[#93897F] mt-0.5">У меня есть ссылка-приглашение</p></div>
              <ChevronRight size={18} className="text-[#BFB5AA]" />
            </button>
          </div>
        </div>
      )}

      <div className="px-7 pb-[max(28px,env(safe-area-inset-bottom))]">
        {step < 2 && (
          <button onClick={() => setStep((step + 1) as 1 | 2)} className="press w-full h-[54px] rounded-full grad text-white font-semibold text-[14px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            {step === 0 ? 'Получить код' : 'Войти'}
          </button>
        )}
      </div>
    </div>
  )
}

/* Центр уведомлений */
export function Notifications() {
  const nav = useNavigate()
  const [readIds, setReadIds] = useState<number[]>([])
  const items = [
    { icon: '💰', tile: 'bg-[#F0DCB8]', title: 'Аванс подтверждён', text: 'Артём Краснов получил 30 000 ₽. Дата 14.06 закрыта для других пар.', time: '14:20', unread: true, today: true, to: '/deal' },
    { icon: '✦', tile: 'bg-[#F2DFDC]', title: 'Тиль', text: 'Свободных фотографов на вашу дату осталось 6 — бронируйте в этом месяце.', time: '11:05', unread: true, today: true, to: '/assistant' },
    { icon: '💌', tile: 'bg-[#D9CCE3]', title: 'RSVP', text: 'Ольга и Денис Соколовы подтвердили приезд с +1.', time: 'вчера', unread: false, today: false, to: '/wedding/guests' },
    { icon: '📄', tile: 'bg-[#C3D5E8]', title: 'Договор готов', text: 'Договор с фотографом сгенерирован — скачайте и подпишите.', time: 'вчера', unread: false, today: false, to: '/wedding/documents' },
    { icon: '⏳', tile: 'bg-[#E6EEE2]', title: 'Hold истекает', text: 'Студия «Пион»: мягкая бронь истекает через 12 часов.', time: 'пн', unread: false, today: false, to: '/wedding' },
  ]
  const groups: [string, typeof items][] = [['Сегодня', items.filter(n => n.today)], ['Ранее', items.filter(n => !n.today)]]
  return (
    <div className="pb-28">
      <TopBar back title="Уведомления" sub="Тихие часы 22:00–09:00" right={
        <button onClick={() => setReadIds(items.map((_, k) => k))} className="press text-[11px] font-bold text-[#B57171]">Прочитать все</button>
      } />
      {groups.map(([label, list]) => (
        <div key={label}>
          <div className="px-5 mt-3">
            <span className="text-[10px] tracking-[.18em] uppercase text-[#93897F] font-semibold px-1">{label}</span>
          </div>
          <div className="px-5 mt-2 space-y-2.5 stagger">
            {list.map((n) => {
              const k = items.indexOf(n)
              return (
              <button key={k} onClick={() => { setReadIds(r => [...r, k]); nav(n.to) }} className="press w-full card-s p-4 flex gap-3 fade-up relative text-left">
                {n.unread && !readIds.includes(k) && <span className="absolute top-4 right-4 w-2 h-2 rounded-full bg-[#C98A8A]" />}
                <Tile icon={n.icon} tile={n.tile} size={42} />
                <div className="min-w-0">
                  <b className="text-[13px]">{n.title}</b>
                  <p className="text-[11.5px] text-[#93897F] leading-relaxed mt-0.5 pr-4">{n.text}</p>
                  <span className="text-[10px] text-[#BFB5AA]">{n.time}</span>
                </div>
              </button>
            )})}
          </div>
        </div>
      ))}
    </div>
  )
}

/* Настройки */
export function Settings() {
  const nav = useNavigate()
  const [quiet, setQuiet] = useState(true)
  const [push, setPush] = useState({ tasks: true, chats: true, deals: true, tips: false })
  const [name, setName] = useState('Алина Валеева')
  const [editName, setEditName] = useState(false)
  const [androidGone, setAndroidGone] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [cityPick, setCityPick] = useState(false)
  const { city, cityRegion, setCity } = useStore()
  const Row = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
    <div className="flex items-center justify-between py-3.5 border-b border-[#F1E9E2] last:border-none">
      <span className="text-[13px] font-medium">{label}</span>
      <button onClick={() => onChange(!value)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', value ? 'grad' : 'bg-[#EADFD6]')} aria-label={label}>
        <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-white shadow transition-all', value ? 'left-[22px]' : 'left-[3px]')} />
      </button>
    </div>
  )
  return (
    <div className="pb-28">
      <TopBar back title="Настройки" />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card px-4 py-1.5">
          <div className="flex items-center gap-3 py-3.5 border-b border-[#F1E9E2]">
            <div className="w-10 h-10 rounded-full bg-[#C98A8A] text-white font-serif-d text-[16px] flex items-center justify-center">{name[0] ?? 'А'}</div>
            <div className="flex-1">
              {editName ? (
                <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && setEditName(false)} autoFocus
                  className="w-full bg-[#FBF6F1] rounded-lg px-3 py-2 text-[13px] outline-none" />
              ) : <b className="text-[13px]">{name}</b>}
              <p className="text-[10px] text-[#93897F]">+7 917 ···-45-67</p>
            </div>
            <button onClick={() => setEditName(!editName)} className="text-[10.5px] font-bold text-[#B57171] press">{editName ? 'Готово' : 'Изменить'}</button>
          </div>
          <Row label="Push: дедлайны задач" value={push.tasks} onChange={v => setPush(p => ({ ...p, tasks: v }))} />
          <Row label="Push: сообщения" value={push.chats} onChange={v => setPush(p => ({ ...p, chats: v }))} />
          <Row label="Push: сделки и оплаты" value={push.deals} onChange={v => setPush(p => ({ ...p, deals: v }))} />
          <Row label="Советы ИИ-координатора" value={push.tips} onChange={v => setPush(p => ({ ...p, tips: v }))} />
          <button onClick={() => setCityPick(true)} className="press w-full flex items-center justify-between py-3.5 border-b border-[#F1E9E2] last:border-none text-left">
            <span className="text-[13px] font-medium">Город свадьбы</span>
            <span className="flex items-center gap-1.5 text-[12px] text-[#93897F]"><MapPin size={13} className="text-[#C98A8A]" />{city} · {cityRegion}</span>
          </button>
        </div>
        <div className="card px-4 py-1.5">
          <div className="flex items-center gap-3 py-3.5 border-b border-[#F1E9E2]">
            <Moon size={16} className="text-[#5C554B]" />
            <span className="flex-1 text-[13px] font-medium">Тихие часы</span>
            <button onClick={() => setQuiet(!quiet)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', quiet ? 'grad' : 'bg-[#EADFD6]')} aria-label="Тихие часы">
              <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-white shadow transition-all', quiet ? 'left-[22px]' : 'left-[3px]')} />
            </button>
          </div>
          <p className="text-[10.5px] text-[#93897F] py-3">22:00–09:00 — только критичные уведомления. В день X тихие часы отключены автоматически.</p>
        </div>
        <div className="card px-4 py-1.5">
          <div className="flex items-center gap-3 py-3.5 border-b border-[#F1E9E2]">
            <MonitorSmartphone size={16} className="text-[#5C554B]" />
            <div className="flex-1"><b className="text-[13px]">iPhone · Safari</b><p className="text-[10px] text-[#7E9A74]">● текущая сессия</p></div>
          </div>
          {!androidGone && (
            <div className="flex items-center gap-3 py-3.5">
              <MonitorSmartphone size={16} className="text-[#5C554B]" />
              <div className="flex-1"><b className="text-[13px]">Android · Chrome</b><p className="text-[10px] text-[#93897F]">2 дня назад</p></div>
              <button onClick={() => setAndroidGone(true)} className="text-[10.5px] font-bold text-[#B57171] press">Завершить</button>
            </div>
          )}
        </div>
        <button onClick={() => nav('/auth')} className="press w-full card-s py-4 text-[13px] font-semibold text-[#B57171] flex items-center justify-center gap-2"><LogOut size={15} /> Выйти со всех устройств</button>
        {confirmDelete ? (
          <button onClick={() => { localStorage.clear(); nav('/') }} className="press w-full py-3 text-[12px] font-bold text-[#B57171]">Подтвердить удаление — данные сотрутся</button>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="press w-full py-3 text-[11.5px] font-semibold text-[#BFB5AA]">Удалить аккаунт и все данные</button>
        )}
        <p className="flex items-center justify-center gap-1.5 text-[10px] text-[#BFB5AA]"><Shield size={11} /> Данные защищены по 152-ФЗ · удаление аккаунта — по запросу</p>
      </div>
      {cityPick && <CityPicker onClose={() => setCityPick(false)} onPick={(c) => { setCity(c.n, c.r); setCityPick(false) }} />}
    </div>
  )
}

/* Поддержка: FAQ + тикет */
export function Support() {
  const [open, setOpen] = useState<number | null>(0)
  const [writing, setWriting] = useState(false)
  const [msg, setMsg] = useState('')
  const [tickets, setTickets] = useState([
    { id: '#1042', topic: 'оплата вне платформы', status: 'Отвечен · ждём вашу оценку', ok: true },
  ])
  const send = () => {
    if (!msg.trim()) return
    setTickets(t => [{ id: `#${1043 + t.length}`, topic: msg.trim(), status: 'Принят · ответим до 24 ч', ok: false }, ...t])
    setMsg(''); setWriting(false)
  }
  const faq = [
    ['Как работает бронирование даты?', 'Мягкая бронь (hold) держит дату 72 часа. После подтверждения подрядчиком и отметки об авансе дата закрывается для других пар.'],
    ['Платформа берёт комиссию?', 'Нет. Сейчас «Тили-тили» полностью бесплатна и для пар, и для подрядчиков.'],
    ['Деньги проходят через приложение?', 'Нет, оплата — напрямую подрядчику по договору. Мы агрегатор и не являемся стороной сделки.'],
    ['Что если подрядчик отменит бронь?', 'Слот станет «пожарным», ИИ сразу предложит трёх свободных на вашу дату замен, а задача появится в чек-листе.'],
    ['Как гость отвечает на приглашение?', 'По именной ссылке или QR — без установки приложения. RSVP занимает около минуты.'],
  ]
  return (
    <div className="pb-28">
      <TopBar back title="Поддержка" sub="Отвечаем до 24 ч · в день X — до 2 ч" />
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {faq.map(([q, a], k) => (
          <button key={k} onClick={() => setOpen(open === k ? null : k)} className="press w-full card-s p-4 text-left fade-up">
            <div className="flex items-center justify-between gap-3">
              <b className="text-[13px]">{q}</b>
              <HelpCircle size={15} className={cn('shrink-0 transition-colors', open === k ? 'text-[#C98A8A]' : 'text-[#BFB5AA]')} />
            </div>
            {open === k && <p className="text-[12px] text-[#93897F] leading-relaxed mt-2.5 fade-in">{a}</p>}
          </button>
        ))}
        {tickets.map(t => (
          <div key={t.id} className="card-s p-4 flex items-center gap-3 fade-up">
            <Tile icon="💬" tile={t.ok ? 'bg-[#E6EEE2]' : 'bg-[#F0DCB8]'} size={42} />
            <div className="flex-1">
              <b className="text-[12.5px] block truncate">Тикет {t.id} · {t.topic}</b>
              <p className={cn('text-[10px] mt-0.5', t.ok ? 'text-[#7E9A74]' : 'text-[#B98A2F]')}>● {t.status}</p>
            </div>
          </div>
        ))}
        {writing ? (
          <div className="card p-4 fade-up">
            <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={3} autoFocus placeholder="Опишите вопрос…" className="w-full bg-[#FBF6F1] rounded-xl px-4 py-3 text-[13px] outline-none resize-none placeholder:text-[#CFC5BA]" />
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setWriting(false)} className="press flex-1 h-[44px] rounded-full bg-[#FBF6F1] text-[12px] font-semibold text-[#93897F]">Отмена</button>
              <button onClick={send} className="press flex-1 h-[44px] rounded-full grad text-white text-[12px] font-semibold">Отправить тикет</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setWriting(true)} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-2" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            Написать в поддержку
          </button>
        )}
        <p className="text-center text-[10px] text-[#BFB5AA]">hello@tili-tili.ru · Telegram @tilitili_help</p>
      </div>
    </div>
  )
}
