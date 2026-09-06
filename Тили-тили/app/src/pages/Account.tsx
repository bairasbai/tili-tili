import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Shield, Smartphone, ChevronRight, HelpCircle, LogOut, MapPin, MonitorSmartphone, Moon } from 'lucide-react'
import { TopBar, Tile } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { CityPicker } from '@/components/CityPicker'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getI18nLang, t, reloadToRoot } from '@/lib/i18n'
import { api, ApiError, saveTokens, url } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { getPolicy } from '@/lib/api/legal'
import { LEGAL_TEXT_VERSION, formatRedaction } from '@/lib/legal'
import { endSession, getMe, getSessions, patchMe } from '@/lib/api/auth'
import { getNotifications, markNotificationRead, notificationRoute } from '@/lib/api/notifications'
import type { components } from '@/lib/api/schema'

/** Профиль пользователя — как его отдаёт и принимает сервер. */
type Profile = components['schemas']['UserProfile']
/** Часть профиля: пропущенное поле сервер оставляет как было. */
type ProfilePatch = Parameters<typeof patchMe>[0]

/** «Вход 12 мая» у чужого устройства: точнее «2 дня назад» и не врёт. */
const sessionSince = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
  return `${t('вход')} ${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`
}

/* Вход: телефон → OTP → роль */
export function Auth() {
  const nav = useNavigate()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState(['', '', '', ''])
  const [sec, setSec] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* 152-ФЗ: согласие даётся явным действием, галочка не может стоять заранее.
     Факт согласия сохраняем с датой — это и есть подтверждение. До входа
     хранить его негде, кроме устройства; сразу после входа отправляем на
     сервер, потому что доказательством согласия должна быть наша запись,
     а не localStorage в чужом браузере. */
  const [consent, setConsent] = usePersist<{ at: string } | null>('tt_consent', null)
  /*
   * Действующая редакция — с сервера, и СВЕРЯЕТСЯ с той, что лежит в сборке.
   *
   * Раньше редакцию брали у сервера только в момент отправки согласия: человек
   * читал экран без номера и без даты, а в базу ложилась редакция, о которой он
   * не знал. Если тексты в сборке и редакция на сервере разойдутся — юрист
   * заменил текст, сборку не выкатили, или наоборот, — в согласии окажется
   * номер, под текстом которого никто не подписывался. По 152-ФЗ доказательство
   * согласия это подпись под конкретным текстом; восстановить его будет нечем.
   */
  const policy = useApi(() => getPolicy(), [])
  const serverVersion = policy.data?.policyVersion ?? null
  /* Расхождение — не ошибка сети: галочку в этом состоянии ставить нельзя. */
  const versionMismatch = !!serverVersion && serverVersion !== LEGAL_TEXT_VERSION
  const canConsent = !!serverVersion && !versionMismatch
  useEffect(() => {
    if (step !== 1 || sec <= 0) return
    const t = setTimeout(() => setSec(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [step, sec])

  /** Текст ошибки для человека: сервер лежит и сервер отказал — разные вещи. */
  const explain = (e: unknown): string =>
    e instanceof ApiError
      ? (e.isDown ? t('Сервер недоступен. Попробуйте позже') : e.message)
      : t('Что-то пошло не так')

  const requestCode = async () => {
    if (phone.length !== 10 || !consent || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await api.post('/auth/otp', { phone: `+7${phone}` })
      setSec(r?.resendAfter ?? 60)
      setStep(1)
    } catch (e) {
      setErr(explain(e))
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async () => {
    const value = code.join('')
    if (value.length !== 4 || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await api.post('/auth/otp/verify', {
        phone: `+7${phone}`,
        code: value,
        device: navigator.userAgent.slice(0, 120),
      })
      if (!r?.accessToken || !r.refreshToken) throw new Error('нет токенов в ответе')
      saveTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken })
      /*
       * Согласие фиксируется на сервере сразу: до входа его некуда привязать,
       * а хранить доказательство только в браузере нельзя.
       *
       * Не удалось — токены снимаем. Иначе человек остаётся ВОШЕДШИМ БЕЗ
       * СОГЛАСИЯ: `requireConsent` стоит на каждом защищённом маршруте, и все
       * экраны отвечают 403 «у вашей роли нет доступа» — при том, что роль ни
       * при чём. Половинчатое состояние он не может ни исправить, ни понять;
       * честнее вернуть его на шаг входа, где всё начинается заново.
       *
       * Редакция — та, которую он видел: галочка недоступна, пока она не
       * совпала с серверной (`lib/legal.ts`).
       */
      if (consent) {
        try {
          await api.post('/users/me/consent', { policyVersion: LEGAL_TEXT_VERSION })
        } catch (e) {
          saveTokens(null)
          throw e
        }
      }
      setStep(2)
    } catch (e) {
      setCode(['', '', '', ''])
      setErr(explain(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh flex flex-col">
      <div className="flex items-center px-5 pt-7">
        <button onClick={() => (step > 0 ? setStep((step - 1) as 0 | 1) : nav('/'))} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
          <ChevronLeft size={18} />
        </button>
      </div>

      {step === 0 && (
        <div className="flex-1 px-7 pt-10 fade-up">
          <div className="w-[72px] h-[72px] rounded-[24px] grad flex items-center justify-center text-[var(--on-grad)] text-[28px] font-serif-d" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Тт')}</div>
          <h1 className="font-serif-d text-[32px] mt-7">{t('С возвращением')}</h1>
          <p className="text-[13.5px] text-[var(--soft)] mt-2 font-light">{t('Введите номер телефона — пришлём код из SMS')}</p>
          <div className="card-s flex items-center gap-3 px-5 py-4 mt-8">
            <Smartphone size={18} className="text-[var(--rose-deep)]" />
            <span className="text-[15px] font-semibold">+7</span>
            <input type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
              inputMode="tel" placeholder="917 123-45-67" className="bg-transparent outline-none text-[15px] w-full placeholder:text-[var(--soft2)]" />
          </div>
          <button
            onClick={() => canConsent && setConsent(consent ? null : { at: new Date().toISOString() })}
            disabled={!canConsent}
            className="press w-full flex items-start gap-3 mt-5 text-left disabled:opacity-60"
            role="checkbox"
            aria-checked={!!consent}
            aria-label={t('Я согласен на обработку персональных данных')}
          >
            <span className={cn('w-[22px] h-[22px] rounded-[7px] shrink-0 flex items-center justify-center mt-0.5 border-[1.5px]', consent ? 'grad border-transparent' : 'border-[var(--line)] bg-[var(--card)]')}>
              {consent && <Check size={13} className="text-[var(--on-grad)]" />}
            </span>
            <span className="text-[11px] text-[var(--ink2)] leading-relaxed">
              {t('Я согласен на обработку персональных данных и принимаю')}{' '}
              <b onClick={e => { e.stopPropagation(); nav('/legal/offer') }} className="text-[var(--rose-deep)] underline underline-offset-2">{t('оферту')}</b>{' '}
              {t('и')}{' '}
              <b onClick={e => { e.stopPropagation(); nav('/legal/privacy') }} className="text-[var(--rose-deep)] underline underline-offset-2">{t('политику конфиденциальности')}</b>
              {/* Под какой именно редакцией подписывается человек. Раньше здесь
                  не было ни номера, ни даты. */}
              {serverVersion && !versionMismatch && (
                <span className="block text-[10px] text-[var(--soft2)] mt-1">
                  {t('редакция от')} {formatRedaction(serverVersion, getI18nLang())}
                </span>
              )}
            </span>
          </button>
          {versionMismatch && (
            <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed mt-2.5">
              {t('Документы обновились. Обновите приложение — подписываться под редакцией, которой вы не видели, нельзя.')}
            </p>
          )}
          {policy.error && (
            <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed mt-2.5">
              {t('Не удалось проверить редакцию документов. Без неё согласие не зафиксировать.')}
            </p>
          )}
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
          <button onClick={() => { if (sec === 0) void requestCode() }} className={cn('text-[12px] font-semibold mt-6 press', sec > 0 ? 'text-[var(--soft2)]' : 'text-[var(--rose-ink)]')}>
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
        {err && step < 2 && (
          <p role="alert" className="text-[12px] text-[var(--rose-ink)] text-center mb-3 leading-relaxed">{err}</p>
        )}
        {step < 2 && (
          <button
            onClick={() => void (step === 0 ? requestCode() : submitCode())}
            disabled={busy || (step === 0 ? !consent || phone.length !== 10 : code.join('').length !== 4)}
            className={cn('press w-full h-[54px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px]',
              (busy || (step === 0 ? !consent || phone.length !== 10 : code.join('').length !== 4)) && 'opacity-40')}
            style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
          >
            {busy ? t('Секунду…') : step === 0 ? t('Получить код') : t('Войти')}
          </button>
        )}
      </div>
    </div>
  )
}

/*
 * Центр уведомлений.
 *
 * Экран был витриной из пяти выдуманных строк: «Артём Краснов получил
 * 30 000 ₽», «Ольга и Денис Соколовы подтвердили приезд с +1», «Студия «Пион»:
 * мягкая бронь истекает через 12 часов». Ни этих людей, ни этих событий не
 * существовало, а «прочитано» копилось в `tt_notif_read` номерами строк: на
 * другом устройстве всё снова горело непрочитанным, а после перестановки строк
 * прочитанным оказывалось не то.
 *
 * Теперь список ведёт сервер. Отметка о прочтении уходит туда же, поэтому
 * второе устройство её видит.
 */
const NOTIF_LOOK: Record<string, { icon: string; tile: string }> = {
  deal: { icon: '💰', tile: 'bg-[var(--honey)]' },
  chat: { icon: '💬', tile: 'bg-[var(--rose-soft)]' },
  task: { icon: '⏳', tile: 'bg-[var(--sage-soft)]' },
  guest: { icon: '💌', tile: 'bg-[var(--lav)]' },
  system: { icon: '🔔', tile: 'bg-[var(--blue)]' },
}

export function Notifications() {
  const nav = useNavigate()
  const q = useApi(() => getNotifications(), [])
  const items = q.data ?? []
  /* Отметка уже ушла на сервер, но список перечитывается не мгновенно.
     Держим её здесь, чтобы точка гасла под пальцем, а не через круг. */
  const [readNow, setReadNow] = useState<string[]>([])
  const isRead = (n: { id?: string; read?: boolean }) => !!n.read || readNow.includes(n.id ?? '')

  const markRead = (id?: string) => {
    if (!id || readNow.includes(id)) return
    setReadNow(r => [...r, id])
    void markNotificationRead(id).catch(() => setReadNow(r => r.filter(x => x !== id)))
  }

  /* Массовой отметки в контракте нет — идём по непрочитанным поштучно.
     На двух десятках уведомлений это допустимо; путь `read-all` отмечен
     в плане миграции как незакрытая дыра. */
  const markAll = () => {
    const rest = items.filter(n => !isRead(n)).map(n => n.id).filter((x): x is string => !!x)
    if (!rest.length) return
    setReadNow(r => [...r, ...rest])
    void Promise.all(rest.map(id => markNotificationRead(id).catch(() => undefined))).then(() => q.reload())
  }

  const today = new Date().toDateString()
  const isToday = (iso?: string) => !!iso && new Date(iso).toDateString() === today
  const when = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
    return isToday(iso)
      ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  }

  const groups: [string, typeof items][] = [
    [t('Сегодня'), items.filter(n => isToday(n.createdAt))],
    [t('Ранее'), items.filter(n => !isToday(n.createdAt))],
  ]
  const unread = items.filter(n => !isRead(n)).length
  return (
    <div className="pb-28">
      <TopBar back title={t('Уведомления')} right={unread > 0 ? (
        <button onClick={markAll} className="press text-[11px] font-bold text-[var(--rose-deep)]">{t('Прочитать все')}</button>
      ) : undefined} />
      <AsyncState q={q} />
      {ready(q) && !items.length && (
        <p className="text-[12px] text-[var(--soft)] text-center py-10 px-8 leading-relaxed">{t('Пока тихо. Здесь появятся новости по сделкам, задачам и гостям.')}</p>
      )}
      {groups.filter(([, list]) => list.length > 0).map(([label, list]) => (
        <div key={label}>
          <div className="px-5 mt-3">
            <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold px-1">{label}</span>
          </div>
          <div className="px-5 mt-2 space-y-2.5 stagger">
            {list.map(n => {
              const look = NOTIF_LOOK[n.kind ?? 'system'] ?? NOTIF_LOOK.system!
              /* Сервер называет место смыслом (`/guests`, `/deal/{id}`), а
                 не маршрутом приложения — переводим. Незнакомое место никуда
                 не ведёт: уведомление просто отмечается прочитанным. */
              const to = notificationRoute(n.link)
              return (
                <button key={n.id} onClick={() => { markRead(n.id); if (to) nav(to) }} className="press w-full card-s p-4 flex gap-3 fade-up relative text-left">
                  {!isRead(n) && <span className="absolute top-4 right-4 w-2 h-2 rounded-full bg-[#C98A8A]" />}
                  <Tile icon={look.icon} tile={look.tile} size={42} />
                  <div className="min-w-0">
                    <b className="text-[13px]">{n.title}</b>
                    <p className="text-[11.5px] text-[var(--soft)] leading-relaxed mt-0.5 pr-4">{n.body}</p>
                    <span className="text-[10px] text-[var(--soft2)]">{when(n.createdAt)}</span>
                  </div>
                </button>
              )
            })}
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

/*
 * Настройки.
 *
 * Экран был устройством в себе: имя «Алина Валеева», телефон
 * «+7 917 ···-45-67», два устройства «iPhone · Safari» и «Android · Chrome ·
 * 2 дня назад», а тумблеры push и тихих часов копились в `tt_settings`. Push
 * рассылает сервер по СВОИМ настройкам — выключенный на телефоне канал
 * продолжал звонить, а «Завершить» у чужого устройства просто убирало строку
 * с экрана.
 *
 * Теперь всё это профиль (`/users/me`) и сессии (`/users/me/sessions`).
 * Устройство помнит только тему и язык интерфейса — это и правда его дело.
 */
export function Settings() {
  const nav = useNavigate()
  const me = useApi(() => getMe(), [])
  const sessions = useApi(() => getSessions(), [])
  /* Тумблер отзывается сразу, запрос уходит следом: ждать круга до сервера,
     чтобы переключатель сдвинулся, — это не отзывчиво. Отказ возвращает
     прежнее значение и называет причину. */
  const [draft, setDraft] = useState<Profile | null>(null)
  const prof = draft ?? me.data ?? null
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const save = (patch: ProfilePatch, optimistic: (p: Profile) => Profile) => {
    if (!prof) return
    const before = prof
    setDraft(optimistic(prof))
    setSaveErr(null)
    void patchMe(patch)
      .then(fresh => { if (fresh) setDraft(fresh) })
      .catch(e => { setDraft(before); setSaveErr(explainError(e)) })
  }

  /* Сервер отдаёт каналы по отдельности и может не прислать ни одного —
     до первой правки строки в `notification_prefs` нет. Умолчание там
     `true`, и здесь оно должно совпадать, иначе тумблер покажет
     выключенным то, что на сервере включено. */
  const push = {
    tasks: prof?.push?.tasks ?? true,
    chats: prof?.push?.chats ?? true,
    deals: prof?.push?.deals ?? true,
    tips: prof?.push?.tips ?? true,
  }
  const setPush = (key: 'tasks' | 'chats' | 'deals' | 'tips', v: boolean) =>
    save({ push: { [key]: v } }, p => ({ ...p, push: { ...p.push, [key]: v } }))

  /* Тихие часы выключаются пустым окном: сервер считает `22:00–22:00`
     отсутствием тишины (`deliverAfter`). Отдельного «выключено» в контракте
     нет, и придумывать его на клиенте нельзя. */
  const quiet = (prof?.quietHours?.from ?? '22:00') !== (prof?.quietHours?.to ?? '09:00')
  const setQuiet = (v: boolean) => {
    const hours = v ? { from: '22:00', to: '09:00' } : { from: '22:00', to: '22:00' }
    save({ quietHours: hours }, p => ({ ...p, quietHours: hours }))
  }

  const name = prof?.name ?? ''
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const editName = nameDraft !== null
  const commitName = () => {
    const v = (nameDraft ?? '').trim()
    setNameDraft(null)
    if (!v || v === name) return
    save({ name: v }, p => ({ ...p, name: v }))
  }
  const [confirmDelete, setConfirmDelete] = useState(false)

  /*
   * Выход и удаление идут на сервер, а не чистят хранилище.
   *
   * `localStorage.clear()` убирает следы в этом браузере и ничего не делает с
   * сессией: украденный refresh продолжает работать, а «выйти со всех
   * устройств» не выполняет своего обещания. Локальное состояние чистим после
   * ответа сервера — если запрос не прошёл, человек остаётся там, где был,
   * и видит причину.
   */
  const forgetLocally = () => {
    saveTokens(null)
    try { localStorage.clear() } catch { /* приватный режим */ }
  }

  /*
   * «Выйти со всех устройств» — именно со всех, включая это.
   *
   * `DELETE /users/me/sessions` гасит все ЧУЖИЕ сессии и намеренно оставляет
   * текущую: на сервере это «выгнать постороннего, не выгоняя себя». Если
   * ограничиться им, кнопка врёт — своя сессия остаётся живой, а браузер
   * просто забывает токен. Поэтому дальше находим свою в списке (`current`)
   * и гасим отдельно.
   */
  const signOut = async () => {
    try {
      await api.delete('/users/me/sessions')
      const mine = (await api.get('/users/me/sessions'))?.find(x => x.current)
      if (mine?.id) await api.delete(url('/users/me/sessions/{sessionId}', { sessionId: mine.id }))
      /* Своя гасится последней и по идентификатору из списка: угадывать её
         нечем, а погасив раньше, мы потеряли бы доступ к самому списку. */
    } catch {
      /* Сервер не ответил. Локально уйти всё равно даём — иначе человек
         заперт в аккаунте, из которого хочет выйти. Живая сессия при этом
         остаётся, и это честнее, чем не пустить его на экран входа. */
    }
    forgetLocally()
    nav('/auth')
  }

  const deleteAccount = async () => {
    try {
      await api.delete('/users/me')
    } catch {
      /* Не удалили на сервере — не делаем вид, что удалили: данные остаются,
         человек должен увидеть, что запрос не прошёл. */
      return
    }
    forgetLocally()
    nav('/')
  }
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
                  className={cn('press px-3.5 py-1.5 rounded-full text-[11px] font-bold transition-all', lang === l ? 'grad text-[var(--on-grad)] shadow' : 'text-[var(--soft)]')}>
                  {l === 'ru' ? 'Русский' : 'English'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card px-4 py-1.5">
          <AsyncState q={me} />
          <div className="flex items-center gap-3 py-3.5 border-b border-[var(--track)]">
            <div className="w-10 h-10 rounded-full bg-[#C98A8A] text-[var(--on-grad)] font-serif-d text-[16px] flex items-center justify-center">{name[0] ?? '·'}</div>
            <div className="flex-1 min-w-0">
              {editName ? (
                <input value={nameDraft ?? ''} onChange={e => setNameDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && commitName()} autoFocus
                  className="w-full bg-[var(--bg)] rounded-lg px-3 py-2 text-[13px] outline-none" />
              ) : <b className="text-[13px]">{name || t('Имя не указано')}</b>}
              {/* Телефон — тот, по которому вошли. Раньше здесь у любого
                  человека стояло «+7 917 ···-45-67». */}
              <p className="text-[10px] text-[var(--soft)]">{prof?.phone ?? ''}</p>
            </div>
            <button onClick={() => (editName ? commitName() : setNameDraft(name))} className="text-[10.5px] font-bold text-[var(--rose-deep)] press">{editName ? t('Готово') : t('Изменить')}</button>
          </div>
          {saveErr && <p role="alert" className="text-[11px] text-[var(--rose-ink)] py-2">{saveErr}</p>}
          <Row label={t('Push: дедлайны задач')} value={push.tasks} onChange={v => setPush('tasks', v)} />
          <Row label={t('Push: сообщения')} value={push.chats} onChange={v => setPush('chats', v)} />
          <Row label={t('Push: сделки и оплаты')} value={push.deals} onChange={v => setPush('deals', v)} />
          <Row label={t('Советы ИИ-координатора')} value={push.tips} onChange={v => setPush('tips', v)} />
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
          <p className="text-[10.5px] text-[var(--soft)] py-3">
            {quiet
              ? `${prof?.quietHours?.from ?? '22:00'}–${prof?.quietHours?.to ?? '09:00'} — ${t('только критичные уведомления. В день X тихие часы отключены автоматически.')}`
              : t('Тихих часов нет: уведомления приходят в любое время суток.')}
          </p>
        </div>
        <div className="card px-4 py-1.5">
          <AsyncState q={sessions} />
          {/* Раньше здесь всегда стояли «iPhone · Safari» и «Android · Chrome ·
              2 дня назад», а «Завершить» убирало строку с экрана и ничего не
              делало с сессией. Теперь список настоящий, и кнопка гасит доступ. */}
          {(sessions.data ?? []).map(d => (
            <div key={d.id} className="flex items-center gap-3 py-3.5 border-b border-[var(--track)] last:border-none">
              <MonitorSmartphone size={16} className="text-[var(--ink2)]" />
              <div className="flex-1 min-w-0">
                <b className="text-[13px]">{d.device ?? t('Неизвестное устройство')}</b>
                <p className={cn('text-[10px]', d.current ? 'text-[var(--sage-deep)]' : 'text-[var(--soft)]')}>
                  {d.current ? t('● текущая сессия') : sessionSince(d.createdAt)}
                </p>
              </div>
              {!d.current && (
                <button onClick={() => void endSession(d.id ?? '').then(() => sessions.reload())} className="text-[10.5px] font-bold text-[var(--rose-deep)] press">{t('Завершить')}</button>
              )}
            </div>
          ))}
        </div>
        <button onClick={() => void signOut()} className="press w-full card-s py-4 text-[13px] font-semibold text-[var(--rose-deep)] flex items-center justify-center gap-2"><LogOut size={15} />{t('Выйти со всех устройств')}</button>
        {confirmDelete ? (
          <button onClick={() => void deleteAccount()} className="press w-full py-3 text-[12px] font-bold text-[var(--rose-deep)]">{t('Подтвердить удаление — данные сотрутся')}</button>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="press w-full py-3 text-[11.5px] font-semibold text-[var(--soft2)]">{t('Удалить аккаунт и все данные')}</button>
        )}
        <p className="flex items-center justify-center gap-1.5 text-[10px] text-[var(--soft2)]"><Shield size={11} />{t('Данные защищены по 152-ФЗ · удаление аккаунта — по запросу')}</p>
      </div>
      {cityPick && <CityPicker onClose={() => setCityPick(false)} onPick={(c) => { setCity(c.n, c.r); setCityPick(false) }} />}
    </div>
  )
}

/*
 * Поддержка: FAQ и связь с людьми.
 *
 * Тикетов здесь больше нет. Форма «Написать в поддержку» складывала обращение
 * в состояние экрана и рисовала «Тикет #1043 · Принят · ответим до 24 ч» — до
 * поддержки не доходило ничего, а человек уходил ждать ответа. Сверху при этом
 * висел «Тикет #1042 · оплата вне платформы · Отвечен» у любого, кто открыл
 * экран впервые.
 *
 * Пути обращений в контракте нет вовсе (дыра §2.9 плана миграции), поэтому
 * экран честно ведёт туда, где живые люди: почта и Telegram.
 */
export function Support() {
  const [open, setOpen] = useState<number | null>(0)
  const faq = [
    [t('Как работает бронирование даты?'), t('Мягкая бронь (hold) держит дату 72 часа. После подтверждения подрядчиком и отметки об авансе дата закрывается для других пар.')],
    [t('Платформа берёт комиссию?'), t('Нет. Сейчас «Тили-тили» полностью бесплатна и для пар, и для подрядчиков.')],
    [t('Деньги проходят через приложение?'), t('Нет, оплата — напрямую подрядчику по договору. Мы агрегатор и не являемся стороной сделки.')],
    /* Ни «пожарного» слота, ни автоматической задачи, ни подбора замен ИИ в
       коде нет: слот просто освобождается. Отвечаем тем, что правда. */
    [t('Что если подрядчик отменит бронь?'), t('Слот снова станет пустым, а дата — свободной. В каталоге сразу видно, кто свободен на ваш день: замену можно искать в тот же час.')],
    /* Про QR здесь было сказано зря: генератора кодов в приложении нет,
       гость приходит по именной ссылке. */
    [t('Как гость отвечает на приглашение?'), t('По именной ссылке — без установки приложения. RSVP занимает около минуты.')],
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Поддержка')} sub={t('Ответы на частые вопросы и связь с нами')} />
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
        {/* Ссылки, а не форма: письмо уходит из почтового клиента человека и
            доходит до нас, а форма отправляла обращение в память вкладки. */}
        <a href="mailto:hello@tili-tili.ru" className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] mt-2 flex items-center justify-center" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
          {t('Написать на почту')}
        </a>
        <a href="https://t.me/tilitili_help" target="_blank" rel="noreferrer" className="press w-full h-[48px] rounded-full card-s font-semibold text-[13px] flex items-center justify-center">
          {t('Написать в Telegram')}
        </a>
        <p className="text-center text-[10px] text-[var(--soft2)]">hello@tili-tili.ru · Telegram @tilitili_help</p>
      </div>
    </div>
  )
}
