import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Shield, Smartphone, ChevronRight, HelpCircle, LogOut, MapPin, MonitorSmartphone, Moon } from 'lucide-react'
import { TopBar, Tile } from '@/components/chrome'
import { CityPicker } from '@/components/CityPicker'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { cn } from '@/lib/utils'
import { t, reloadToRoot } from '@/lib/i18n'

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
        <button onClick={() => (step > 0 ? setStep((step - 1) as 0 | 1) : nav('/'))} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
          <ChevronLeft size={18} />
        </button>
      </div>

      {step === 0 && (
        <div className="flex-1 px-7 pt-10 fade-up">
          <div className="w-[72px] h-[72px] rounded-[24px] grad flex items-center justify-center text-white text-[28px] font-serif-d" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Тт')}</div>
          <h1 className="font-serif-d text-[32px] mt-7">{t('С возвращением')}</h1>
          <p className="text-[13.5px] text-[var(--soft)] mt-2 font-light">{t('Введите номер телефона — пришлём код из SMS')}</p>
          <div className="card-s flex items-center gap-3 px-5 py-4 mt-8">
            <Smartphone size={18} className="text-[var(--rose-deep)]" />
            <span className="text-[15px] font-semibold">+7</span>
            <input type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
              inputMode="tel" placeholder="917 123-45-67" className="bg-transparent outline-none text-[15px] w-full placeholder:text-[var(--soft2)]" />
          </div>
          <p className="text-[10.5px] text-[var(--soft2)] mt-4 leading-relaxed">{t('Продолжая, вы принимаете оферту и политику конфиденциальности')}</p>
        </div>
      )}

      {step === 1 && (
        <div className="flex-1 px-7 pt-10 fade-up">
          <h1 className="font-serif-d text-[32px]">{t('Код из SMS')}</h1>
          <p className="text-[13.5px] text-[var(--soft)] mt-2 font-light">{t('Отправили на +7')}{phone || '··· ···-··-··'}</p>
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
          <button onClick={() => sec === 0 && setSec(42)} className={cn('text-[12px] font-semibold mt-6 press', sec > 0 ? 'text-[var(--soft2)]' : 'text-[var(--rose-deep)]')}>
            {sec > 0 ? `${t('Отправить код повторно · 0:')}${String(sec).padStart(2, '0')}` : t('Отправить код повторно')}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="flex-1 px-7 pt-10 fade-up">
          <h1 className="font-serif-d text-[32px]">{t('Кто вы?')}</h1>
          <p className="text-[13.5px] text-[var(--soft)] mt-2 font-light">{t('Роль можно добавить второй позже')}</p>
          <div className="space-y-3 mt-8 stagger">
            <button onClick={() => nav('/quiz')} className="press w-full card p-5 flex items-center gap-4 text-left fade-up">
              <div className="w-[52px] h-[52px] rounded-[18px] bg-[var(--rose-soft)] flex items-center justify-center text-[24px]">💍</div>
              <div className="flex-1"><b className="text-[15px]">{t('Мы планируем свадьбу')}</b><p className="text-[11.5px] text-[var(--soft)] mt-0.5">{t('Конструктор, бюджет, гости, день X')}</p></div>
              <ChevronRight size={18} className="text-[var(--soft2)]" />
            </button>
            <button onClick={() => nav('/vendor-app/profile')} className="press w-full card p-5 flex items-center gap-4 text-left fade-up">
              <div className="w-[52px] h-[52px] rounded-[18px] bg-[var(--sage-soft)] flex items-center justify-center text-[24px]">✨</div>
              <div className="flex-1"><b className="text-[15px]">{t('Я подрядчик')}</b><p className="text-[11.5px] text-[var(--soft)] mt-0.5">{t('Анкета-витрина, заявки, календарь, сделки')}</p></div>
              <ChevronRight size={18} className="text-[var(--soft2)]" />
            </button>
            <button onClick={() => nav('/invite')} className="press w-full card p-5 flex items-center gap-4 text-left fade-up">
              <div className="w-[52px] h-[52px] rounded-[18px] bg-[var(--honey)] flex items-center justify-center text-[24px]">💌</div>
              <div className="flex-1"><b className="text-[15px]">{t('Я гость')}</b><p className="text-[11.5px] text-[var(--soft)] mt-0.5">{t('У меня есть ссылка-приглашение')}</p></div>
              <ChevronRight size={18} className="text-[var(--soft2)]" />
            </button>
          </div>
        </div>
      )}

      <div className="px-7 pb-[max(28px,env(safe-area-inset-bottom))]">
        {step < 2 && (
          <button onClick={() => setStep((step + 1) as 1 | 2)} className="press w-full h-[54px] rounded-full grad text-white font-semibold text-[14px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            {step === 0 ? t('Получить код') : t('Войти')}
          </button>
        )}
      </div>
    </div>
  )
}

/* Центр уведомлений */
export function Notifications() {
  const nav = useNavigate()
  const [readIds, setReadIds] = usePersist<number[]>('tt_notif_read', [])
  const items = [
    { icon: '💰', tile: 'bg-[var(--honey)]', title: t('Аванс подтверждён'), text: t('Артём Краснов получил 30 000 ₽. Дата 14.06 закрыта для других пар.'), time: '14:20', unread: true, today: true, to: '/deal' },
    { icon: '✦', tile: 'bg-[var(--rose-soft)]', title: t('Тиль'), text: t('Свободных фотографов на вашу дату осталось 6 — бронируйте в этом месяце.'), time: '11:05', unread: true, today: true, to: '/assistant' },
    { icon: '💌', tile: 'bg-[var(--lav)]', title: 'RSVP', text: t('Ольга и Денис Соколовы подтвердили приезд с +1.'), time: t('вчера'), unread: false, today: false, to: '/wedding/guests' },
    { icon: '📄', tile: 'bg-[var(--blue)]', title: t('Договор готов'), text: t('Договор с фотографом сгенерирован — скачайте и подпишите.'), time: t('вчера'), unread: false, today: false, to: '/wedding/documents' },
    { icon: '⏳', tile: 'bg-[var(--sage-soft)]', title: t('Hold истекает'), text: t('Студия «Пион»: мягкая бронь истекает через 12 часов.'), time: t('пн'), unread: false, today: false, to: '/wedding' },
  ]
  const groups: [string, typeof items][] = [[t('Сегодня'), items.filter(n => n.today)], [t('Ранее'), items.filter(n => !n.today)]]
  return (
    <div className="pb-28">
      <TopBar back title={t('Уведомления')} sub={t('Тихие часы 22:00–09:00')} right={
        <button onClick={() => setReadIds(items.map((_, k) => k))} className="press text-[11px] font-bold text-[var(--rose-deep)]">{t('Прочитать все')}</button>
      } />
      {groups.map(([label, list]) => (
        <div key={label}>
          <div className="px-5 mt-3">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold px-1">{label}</span>
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
                  <p className="text-[11.5px] text-[var(--soft)] leading-relaxed mt-0.5 pr-4">{n.text}</p>
                  <span className="text-[10px] text-[var(--soft2)]">{n.time}</span>
                </div>
              </button>
            )})}
          </div>
        </div>
      ))}
    </div>
  )
}

/* Тумблер настроек. Объявлен на уровне модуля: компонент, созданный внутри
   рендера, — новый тип на каждой перерисовке, из-за чего React размонтирует и
   монтирует поддерево заново (теряется фокус в полях, срываются анимации). */
function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-3.5 border-b border-[var(--track)] last:border-none">
      <span className="text-[13px] font-medium">{label}</span>
      <button onClick={() => onChange(!value)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', value ? 'grad' : 'bg-[var(--track)]')} aria-label={label}>
        <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-[var(--card)] shadow transition-all', value ? 'left-[22px]' : 'left-[3px]')} />
      </button>
    </div>
  )
}

/* Настройки */
export function Settings() {
  const nav = useNavigate()
  /* Настройки хранятся на устройстве: выключенный push не должен включаться сам.
     Имя лежит отдельным полем и падает в дефолт, только пока его не меняли —
     иначе русский дефолт застрял бы в EN-интерфейсе. */
  const [prefs, setPrefs] = usePersist('tt_settings', {
    quiet: true,
    push: { tasks: true, chats: true, deals: true, tips: false },
    name: null as string | null,
  })
  const quiet = prefs.quiet
  const setQuiet = (v: boolean) => setPrefs(p => ({ ...p, quiet: v }))
  const push = prefs.push
  const setPush = (fn: (p: typeof prefs.push) => typeof prefs.push) => setPrefs(p => ({ ...p, push: fn(p.push) }))
  const name = prefs.name ?? t('Алина Валеева')
  const setName = (v: string) => setPrefs(p => ({ ...p, name: v }))
  const [editName, setEditName] = useState(false)
  const [androidGone, setAndroidGone] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [cityPick, setCityPick] = useState(false)
  const { city, cityRegion, setCity, theme, setTheme, lang, setLang } = useStore()
  return (
    <div className="pb-28">
      <TopBar back title={t('Настройки')} />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card px-4 py-1.5">
          <Row label={theme === 'dark' ? t('🌙 Тёмная тема') : t('☀️ Светлая тема')} value={theme === 'dark'} onChange={v => setTheme(v ? 'dark' : 'light')} />
          <div className="flex items-center justify-between py-3.5">
            <span className="text-[13px] font-medium">{t('Язык интерфейса')}</span>
            <div className="flex bg-[var(--track)] rounded-full p-[3px]">
              {(['ru', 'en'] as const).map(l => (
                <button key={l} onClick={() => { if (l !== lang) { setLang(l); reloadToRoot() } }}
                  className={cn('press px-3.5 py-1.5 rounded-full text-[11px] font-bold transition-all', lang === l ? 'grad text-white shadow' : 'text-[var(--soft)]')}>
                  {l === 'ru' ? 'Русский' : 'English'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card px-4 py-1.5">
          <div className="flex items-center gap-3 py-3.5 border-b border-[var(--track)]">
            <div className="w-10 h-10 rounded-full bg-[#C98A8A] text-white font-serif-d text-[16px] flex items-center justify-center">{name[0] ?? t('А')}</div>
            <div className="flex-1">
              {editName ? (
                <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && setEditName(false)} autoFocus
                  className="w-full bg-[var(--bg)] rounded-lg px-3 py-2 text-[13px] outline-none" />
              ) : <b className="text-[13px]">{name}</b>}
              <p className="text-[10px] text-[var(--soft)]">+7 917 ···-45-67</p>
            </div>
            <button onClick={() => setEditName(!editName)} className="text-[10.5px] font-bold text-[var(--rose-deep)] press">{editName ? t('Готово') : t('Изменить')}</button>
          </div>
          <Row label={t('Push: дедлайны задач')} value={push.tasks} onChange={v => setPush(p => ({ ...p, tasks: v }))} />
          <Row label={t('Push: сообщения')} value={push.chats} onChange={v => setPush(p => ({ ...p, chats: v }))} />
          <Row label={t('Push: сделки и оплаты')} value={push.deals} onChange={v => setPush(p => ({ ...p, deals: v }))} />
          <Row label={t('Советы ИИ-координатора')} value={push.tips} onChange={v => setPush(p => ({ ...p, tips: v }))} />
          <button onClick={() => setCityPick(true)} className="press w-full flex items-center justify-between py-3.5 border-b border-[var(--track)] last:border-none text-left">
            <span className="text-[13px] font-medium">{t('Город свадьбы')}</span>
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--soft)]"><MapPin size={13} className="text-[var(--rose-deep)]" />{t(city)} · {t(cityRegion)}</span>
          </button>
        </div>
        <div className="card px-4 py-1.5">
          <div className="flex items-center gap-3 py-3.5 border-b border-[var(--track)]">
            <Moon size={16} className="text-[var(--ink2)]" />
            <span className="flex-1 text-[13px] font-medium">{t('Тихие часы')}</span>
            <button onClick={() => setQuiet(!quiet)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', quiet ? 'grad' : 'bg-[var(--track)]')} aria-label={t('Тихие часы')}>
              <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-[var(--card)] shadow transition-all', quiet ? 'left-[22px]' : 'left-[3px]')} />
            </button>
          </div>
          <p className="text-[10.5px] text-[var(--soft)] py-3">{t('22:00–09:00 — только критичные уведомления. В день X тихие часы отключены автоматически.')}</p>
        </div>
        <div className="card px-4 py-1.5">
          <div className="flex items-center gap-3 py-3.5 border-b border-[var(--track)]">
            <MonitorSmartphone size={16} className="text-[var(--ink2)]" />
            <div className="flex-1"><b className="text-[13px]">iPhone · Safari</b><p className="text-[10px] text-[var(--sage-deep)]">{t('● текущая сессия')}</p></div>
          </div>
          {!androidGone && (
            <div className="flex items-center gap-3 py-3.5">
              <MonitorSmartphone size={16} className="text-[var(--ink2)]" />
              <div className="flex-1"><b className="text-[13px]">Android · Chrome</b><p className="text-[10px] text-[var(--soft)]">{t('2 дня назад')}</p></div>
              <button onClick={() => setAndroidGone(true)} className="text-[10.5px] font-bold text-[var(--rose-deep)] press">{t('Завершить')}</button>
            </div>
          )}
        </div>
        <button onClick={() => nav('/auth')} className="press w-full card-s py-4 text-[13px] font-semibold text-[var(--rose-deep)] flex items-center justify-center gap-2"><LogOut size={15} />{t('Выйти со всех устройств')}</button>
        {confirmDelete ? (
          <button onClick={() => { localStorage.clear(); nav('/') }} className="press w-full py-3 text-[12px] font-bold text-[var(--rose-deep)]">{t('Подтвердить удаление — данные сотрутся')}</button>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="press w-full py-3 text-[11.5px] font-semibold text-[var(--soft2)]">{t('Удалить аккаунт и все данные')}</button>
        )}
        <p className="flex items-center justify-center gap-1.5 text-[10px] text-[var(--soft2)]"><Shield size={11} />{t('Данные защищены по 152-ФЗ · удаление аккаунта — по запросу')}</p>
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
    { id: '#1042', topic: t('оплата вне платформы'), status: t('Отвечен · ждём вашу оценку'), ok: true },
  ])
  const send = () => {
    if (!msg.trim()) return
    setTickets(tk => [{ id: `#${1043 + tk.length}`, topic: msg.trim(), status: t('Принят · ответим до 24 ч'), ok: false }, ...tk])
    setMsg(''); setWriting(false)
  }
  const faq = [
    [t('Как работает бронирование даты?'), t('Мягкая бронь (hold) держит дату 72 часа. После подтверждения подрядчиком и отметки об авансе дата закрывается для других пар.')],
    [t('Платформа берёт комиссию?'), t('Нет. Сейчас «Тили-тили» полностью бесплатна и для пар, и для подрядчиков.')],
    [t('Деньги проходят через приложение?'), t('Нет, оплата — напрямую подрядчику по договору. Мы агрегатор и не являемся стороной сделки.')],
    [t('Что если подрядчик отменит бронь?'), t('Слот станет «пожарным», ИИ сразу предложит трёх свободных на вашу дату замен, а задача появится в чек-листе.')],
    [t('Как гость отвечает на приглашение?'), t('По именной ссылке или QR — без установки приложения. RSVP занимает около минуты.')],
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Поддержка')} sub={t('Отвечаем до 24 ч · в день X — до 2 ч')} />
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {faq.map(([q, a], k) => (
          <button key={k} onClick={() => setOpen(open === k ? null : k)} className="press w-full card-s p-4 text-left fade-up">
            <div className="flex items-center justify-between gap-3">
              <b className="text-[13px]">{q}</b>
              <HelpCircle size={15} className={cn('shrink-0 transition-colors', open === k ? 'text-[var(--rose-deep)]' : 'text-[var(--soft2)]')} />
            </div>
            {open === k && <p className="text-[12px] text-[var(--soft)] leading-relaxed mt-2.5 fade-in">{a}</p>}
          </button>
        ))}
        {tickets.map(tk => (
          <div key={tk.id} className="card-s p-4 flex items-center gap-3 fade-up">
            <Tile icon="💬" tile={tk.ok ? 'bg-[var(--sage-soft)]' : 'bg-[var(--honey)]'} size={42} />
            <div className="flex-1">
              <b className="text-[12.5px] block truncate">{t('Тикет')}{tk.id} · {tk.topic}</b>
              <p className={cn('text-[10px] mt-0.5', tk.ok ? 'text-[var(--sage-deep)]' : 'text-[var(--honey-deep)]')}>● {tk.status}</p>
            </div>
          </div>
        ))}
        {writing ? (
          <div className="card p-4 fade-up">
            <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={3} autoFocus placeholder={t('Опишите вопрос…')} className="w-full bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none resize-none placeholder:text-[var(--soft2)]" />
            <div className="flex gap-2.5 mt-3">
              <button onClick={() => setWriting(false)} className="press flex-1 h-[44px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--soft)]">{t('Отмена')}</button>
              <button onClick={send} className="press flex-1 h-[44px] rounded-full grad text-white text-[12px] font-semibold">{t('Отправить тикет')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setWriting(true)} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-2" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            {t('Написать в поддержку')}
          </button>
        )}
        <p className="text-center text-[10px] text-[var(--soft2)]">hello@tili-tili.ru · Telegram @tilitili_help</p>
      </div>
    </div>
  )
}
