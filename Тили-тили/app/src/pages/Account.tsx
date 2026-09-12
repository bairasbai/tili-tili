import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Shield, Smartphone, ChevronRight, Eye, HelpCircle, LogOut, MapPin, MonitorSmartphone, Moon } from 'lucide-react'
import { TopBar, Tile } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { CityPicker } from '@/components/CityPicker'
import { useStore } from '@/lib/store'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getI18nLang, t, reloadToRoot } from '@/lib/i18n'
import { api, ApiError, saveTokens } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { getPolicy } from '@/lib/api/legal'
import { LEGAL_TEXT_VERSION, formatRedaction } from '@/lib/legal'
import { deleteAllPushSubscriptions, endSession, getMe, getPushSubscriptions, getSessions, patchMe, signOutEverywhere, signOutHere, forgetLocally, withdrawConsent, JOIN_CODE_KEY } from '@/lib/api/auth'
import { getNotifications, markNotificationRead, notificationRoute } from '@/lib/api/notifications'
import { getVendorProfile } from '@/lib/api/vendor'
import { cancelWedding, listMyWeddings, pickMyWedding } from '@/lib/api/wedding'
import { getWedding } from '@/lib/api/weddingData'
import { devicePushState, disableDevicePush, enableDevicePush, pushSupported, type DevicePushState } from '@/lib/push'
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

/** «60:00», «0:45»: таймер повторной отправки в минутах и секундах — сервер может просить и час. */
const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

/**
 * Код приглашения в команду, отложенный до входа (ревью D1-21).
 *
 * `/join/:code` открывается без входа, а «Принять» требует его: раньше человек
 * получал «Сначала войдите» без перехода и без памяти о коде — после входа его
 * ждал шаг «Кто вы?», где приглашённому предлагали завести СВОЮ свадьбу.
 * В sessionStorage, не в localStorage: код живёт до конца этого захода.
 */
function takeJoinCode(): string | null {
  try {
    const code = sessionStorage.getItem(JOIN_CODE_KEY)
    if (code) sessionStorage.removeItem(JOIN_CODE_KEY)
    return code
  } catch { return null }
}

/* Вход: телефон → OTP → роль */
export function Auth() {
  const nav = useNavigate()
  const { adoptWeddings, finishOnboarding } = useStore()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState(['', '', '', ''])
  const [sec, setSec] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /*
   * 152-ФЗ: согласие даётся явным действием, галочка не может стоять заранее.
   *
   * Живёт в состоянии экрана, а не в хранилище (ревью D1-12). В `localStorage`
   * она переживала вход и не была привязана ни к человеку, ни к номеру:
   * брошенный вход оставлял её отмеченной следующему на этом устройстве
   * (второй партнёр, мама), а истёкшая сессия возвращала на вход с уже
   * стоящей галочкой — и каждый повторный вход писал новую строку `consents`
   * без явного действия. Доказательство согласия — запись сервера
   * (`POST /users/me/consent`), не дата в чужом браузере. Смена номера и
   * возврат на первый шаг галочку снимают: подпись ставится под конкретным
   * номером, а не под устройством.
   */
  const [consent, setConsent] = useState(false)
  /*
   * Токены и согласие уже на месте, осталось решить, куда идти. Отдельное
   * состояние нужно на случай отказа `GET /weddings`: код из SMS одноразовый,
   * повторить «Войти» нельзя, а повторить выбор пути — можно («Продолжить»).
   */
  const [signedIn, setSignedIn] = useState(false)
  const [joinCodeDraft, setJoinCodeDraft] = useState<string | null>(null)
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
  /* Отсчёт идёт и на шаге номера: 429 на «Получить код» называет срок
     (`Retry-After`), и кнопка закрыта до него — иначе повтор уходил в тот же
     отказ (фича 005, T017). На шаге кода — как раньше. */
  useEffect(() => {
    if (step > 1 || sec <= 0) return
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
      /* Ограничитель назвал срок (`Retry-After`, ревью D6-13) — таймер повтора
         считает от него, а не от выдуманных 60 секунд: сервер может просить час. */
      if (e instanceof ApiError && e.status === 429 && e.retryAfter != null) setSec(e.retryAfter)
    } finally {
      setBusy(false)
    }
  }

  /*
   * Куда идти после входа (ревью D1-03, D1-21).
   *
   * Раньше после кода всех ждал один шаг «Кто вы?», а единственный видимый
   * путь дальше — «Мы планируем свадьбу» — вёл в квиз, который создавал
   * ВТОРУЮ свадьбу вернувшемуся на новом устройстве: настоящая, с гостями и
   * сделками, пропадала с экрана. Теперь сначала спрашиваем сервер.
   *
   * Порядок: отложенный код приглашения → своя свадьба → выбор роли. Код
   * важнее списка: помощника позвали в чужую свадьбу, и ему нужен приём,
   * а не собственная главная.
   */
  const afterSignIn = async () => {
    setBusy(true); setErr(null)
    try {
      const joinCode = takeJoinCode()
      if (joinCode) { nav(`/join/${encodeURIComponent(joinCode)}`); return }
      const list = await listMyWeddings()
      /* Список отдаётся стору: он закрывает сверку и выбирает свадьбу, иначе
         после выхода и повторного входа сверка висела бы в `idle` навсегда. */
      adoptWeddings(list)
      const mine = pickMyWedding(list)
      if (mine) {
        finishOnboarding()
        nav('/home')
        return
      }
      setStep(2)
    } catch (e) {
      /* Список не пришёл — не гадаем, есть ли свадьба: показываем причину и
         «Продолжить». Код из SMS уже погашен, повторить можно только этот шаг.
         Стору — «не пришёл», а не «едет»: иначе экраны ждали бы сверку вечно. */
      adoptWeddings(null)
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
      /*
       * Часовой пояс устройства — в профиль (ревью D4-04). Тихие часы и лимит
       * push сервер считает по `users.tz`, а клиент его никогда не отправлял:
       * пара во Владивостоке получала push ночью и тишину весь рабочий день.
       * Ошибка — молча: пояс не стоит того, чтобы ломать вход.
       */
      void patchMe({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => undefined)
      setSignedIn(true)
    } catch (e) {
      setCode(['', '', '', ''])
      setErr(explain(e))
      setBusy(false)
      return
    }
    await afterSignIn()
  }

  /* Назад с шага кода — на шаг номера; согласие при этом снимается (D1-12). */
  const back = () => {
    if (step === 0) { nav('/'); return }
    setConsent(false)
    setStep((step - 1) as 0 | 1)
  }
  /* Смена уже набранного номера снимает галочку: подпись стояла под другим
     номером. Пока номер только набирается, порядок «галочка, потом цифры»
     не наказывается — это один и тот же человек и одно действие. */
  const changePhone = (value: string) => {
    const digits = value.replace(/[^\d]/g, '').slice(0, 10)
    if (consent && phone.length === 10 && digits !== phone) setConsent(false)
    /* Срок из 429 относится к набранному номеру (лимиты — по номеру и паре
       номер+адрес): другой номер — другой запрос, ждать за него нечего. */
    if (step === 0 && digits !== phone) setSec(0)
    setPhone(digits)
  }
  const openJoin = () => {
    const code = (joinCodeDraft ?? '').trim().toUpperCase()
    if (code) nav(`/join/${encodeURIComponent(code)}`)
  }
  /* Вошли, но не узнали, куда идти (список свадеб не пришёл): кнопка
     повторяет только этот шаг — код из SMS уже погашен. */
  const primaryLocked = busy || (signedIn ? false : step === 0 ? !consent || phone.length !== 10 || sec > 0 : code.join('').length !== 4)

  return (
    <div className="min-h-dvh flex flex-col">
      <div className="flex items-center px-5 pt-7">
        <button onClick={back} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
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
            <input type="tel" autoComplete="tel" value={phone} onChange={e => changePhone(e.target.value)}
              inputMode="tel" placeholder="917 123-45-67" className="bg-transparent outline-none text-[15px] w-full placeholder:text-[var(--soft2)]" />
          </div>
          <button
            onClick={() => canConsent && setConsent(!consent)}
            disabled={!canConsent}
            className="press w-full flex items-start gap-3 mt-5 text-left disabled:opacity-60"
            role="checkbox"
            aria-checked={consent}
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
                className="card-s w-full aspect-square text-center text-[22px] font-bold outline-none focus:ring-2 focus:ring-[var(--rose)]" />
            ))}
          </div>
          <button onClick={() => { if (sec === 0) void requestCode() }} className={cn('text-[12px] font-semibold mt-6 press', sec > 0 ? 'text-[var(--soft2)]' : 'text-[var(--rose-ink)]')}>
            {sec > 0 ? `${t('Отправить код повторно · ')}${mmss(sec)}` : t('Отправить код повторно')}
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
            {/* Приглашённому в чужую свадьбу заводить свою незачем (D1-21):
                код из ссылки ДРУГ/КООРД/ПАРА ведёт на приём приглашения. */}
            {joinCodeDraft === null ? (
              <button onClick={() => setJoinCodeDraft('')} className="press w-full card p-5 flex items-center gap-4 text-left fade-up">
                <div className="w-[52px] h-[52px] rounded-[18px] bg-[var(--lav)] flex items-center justify-center text-[24px]">🤝</div>
                <div className="flex-1"><b className="text-[15px]">{t('У меня есть приглашение в команду')}</b><p className="text-[11.5px] text-[var(--soft)] mt-0.5">{t('Код из ссылки, которую прислала пара')}</p></div>
                <ChevronRight size={18} className="text-[var(--soft2)]" />
              </button>
            ) : (
              <div className="card p-5 fade-up">
                <b className="text-[15px]">{t('У меня есть приглашение в команду')}</b>
                <div className="card-s flex items-center gap-3 px-4 py-3 mt-3">
                  <input value={joinCodeDraft} onChange={e => setJoinCodeDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && openJoin()} autoFocus
                    placeholder="ДРУГ-7F3K" className="bg-transparent outline-none text-[15px] w-full tracking-[.12em] placeholder:text-[var(--soft2)]" />
                </div>
                <button onClick={openJoin} disabled={!joinCodeDraft.trim()} className="press w-full h-[44px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13px] mt-3 disabled:opacity-40">
                  {t('Открыть приглашение')}
                </button>
              </div>
            )}
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
            onClick={() => void (signedIn ? afterSignIn() : step === 0 ? requestCode() : submitCode())}
            disabled={primaryLocked}
            className={cn('press w-full h-[54px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px]', primaryLocked && 'opacity-40')}
            style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
          >
            {busy ? t('Секунду…') : signedIn ? t('Продолжить') : step === 0 ? (sec > 0 ? `${t('Получить код')} · ${mmss(sec)}` : t('Получить код')) : t('Войти')}
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
  /* Без своей свадьбы человек в приложении — подрядчик: ссылки уведомлений
     переводятся в маршруты его кабинета, а не в экраны пары. */
  const { weddingId } = useStore()
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

  /* Время снимается один раз при монтировании: конструктор даты без аргументов
     в теле компонента — то же нарушение чистоты рендера, что и `Date.now()`
     (D4-22); линт ловит только второе. */
  const [today] = useState(() => new Date().toDateString())
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
              const to = notificationRoute(n.link, { vendor: !weddingId })
              return (
                <button key={n.id} onClick={() => { markRead(n.id); if (to) nav(to) }} className="press w-full card-s p-4 flex gap-3 fade-up relative text-left">
                  {!isRead(n) && <span className="absolute top-4 right-4 w-2 h-2 rounded-full bg-[var(--rose)]" />}
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
/*
 * Push на это устройство.
 *
 * Отдельно от видов уведомлений: те — про сервер (какие новости писать),
 * это — про браузер (разрешение и подписка). Состояние берётся у самого
 * браузера, а не хранится: подписка могла исчезнуть с очисткой данных сайта.
 */
/**
 * Адрес подписки этого устройства — его знает только браузер. По нему сервер
 * помечает строку списка как `mine`; нет воркера или подписки — null, и
 * «это устройство» экран не называет.
 */
async function thisDeviceEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    return sub?.endpoint ?? null
  } catch { return null }
}

/** Дата подписки словами; пусто — сервер её не прислал. */
function subscribedSince(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short' })
}

/** `top` — рисовать ли верхнюю границу: её нет, когда строка в карточке первая. */
function DevicePushRow({ top = true }: { top?: boolean }) {
  const [state, setState] = useState<DevicePushState | 'loading'>('loading')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void devicePushState().then(s => { if (alive) setState(s) }).catch(() => { if (alive) setState('unsupported') })
    return () => { alive = false }
  }, [])
  /*
   * На каких устройствах push включён — с сервера (`GET /users/me/push-subscriptions`,
   * контракт v0.29.0): хост push-службы, дата и «это устройство». До фичи 005
   * человек видел только тумблер этого браузера и не знал, что ноутбук в
   * офисе продолжает получать push. Снять чужую по одной нельзя — её адрес
   * знает только то устройство (D4-10); «снять на всех» — `DELETE` без параметра.
   */
  const list = useApi(() => thisDeviceEndpoint().then(getPushSubscriptions), [])
  const [confirmAll, setConfirmAll] = useState(false)
  const toggle = () => void (async () => {
    setBusy(true)
    setErr(null)
    try {
      if (state === 'on' || state === 'unverified') { await disableDevicePush(); setState('off') } else { await enableDevicePush(); setState('on') }
      list.reload()
    } catch (e) {
      /* Сервер без ключей отвечает 501 своим текстом — его и показываем;
         отказ браузера приходит словами из `lib/push.ts`. */
      setErr(e instanceof ApiError ? explainError(e) : e instanceof Error ? e.message : t('Что-то пошло не так'))
    } finally { setBusy(false) }
  })()
  /* Снять везде: сначала подписка этого браузера (иначе он держал бы адрес,
     о котором сервер уже не знает, — «unverified»), затем все серверные. */
  const removeAll = () => void (async () => {
    setBusy(true)
    setErr(null)
    try {
      await disableDevicePush().catch(() => undefined)
      await deleteAllPushSubscriptions()
      setConfirmAll(false)
      if (state === 'on' || state === 'unverified') setState('off')
      list.reload()
    } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()
  const text = state === 'loading' ? t('Загружаем…')
    : state === 'unsupported' ? t('Этот браузер не умеет push — уведомления остаются в приложении')
    : state === 'no-key' ? t('Push появится, когда будут подключены ключи Web Push — уведомления пока в приложении')
    : state === 'denied' ? t('Уведомления запрещены в настройках браузера')
    : state === 'on' ? t('Push включён на этом устройстве')
    /* Подписка в браузере есть, а привязана ли она к этому аккаунту, сервер не
       сообщает (ревью D4-06): на общем устройстве она может быть чужой. */
    : state === 'unverified' ? t('В браузере подписка есть, но привязана ли она к вашему аккаунту, проверить нельзя. Чтобы push точно приходили сюда, выключите и включите заново.')
    : t('Push на этом устройстве выключен')
  const canToggle = state === 'on' || state === 'off' || state === 'unverified'
  const looksOn = state === 'on' || state === 'unverified'
  return (
    <div className={cn('py-3.5', top && 'border-t border-[var(--track)]')}>
      <div className="flex items-center gap-3">
        <Smartphone size={16} className="text-[var(--ink2)]" />
        <span className="flex-1 text-[13px] font-medium">{t('Push на этом устройстве')}</span>
        {canToggle && (
          <button disabled={busy} onClick={toggle} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative disabled:opacity-50', looksOn ? 'grad' : 'bg-[var(--track)]')} aria-label={t('Push на этом устройстве')}>
            <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-[var(--card)] shadow transition-all', looksOn ? 'left-[22px]' : 'left-[3px]')} />
          </button>
        )}
      </div>
      <p className="text-[10.5px] text-[var(--soft)] mt-1">{text}</p>
      {err && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-1">{err}</p>}
      <AsyncState q={list} />
      {ready(list) && (
        <div className="mt-2">
          {(list.data ?? []).length ? (list.data ?? []).map(sub => (
            <div key={sub.id} className="flex items-center gap-2 py-1.5 text-[11px]">
              <MonitorSmartphone size={13} className="text-[var(--ink2)] shrink-0" />
              <span className="flex-1 min-w-0 truncate">{sub.endpointHost ?? t('Неизвестное устройство')}</span>
              {sub.mine && <span className="text-[9.5px] font-bold text-[var(--sage-deep)] shrink-0">{t('это устройство')}</span>}
              <span className="text-[10px] text-[var(--soft)] shrink-0">{subscribedSince(sub.createdAt)}</span>
            </div>
          )) : <p className="text-[10.5px] text-[var(--soft)]">{t('Push не включён ни на одном устройстве')}</p>}
          {!!(list.data ?? []).length && (
            <button disabled={busy} onClick={() => (confirmAll ? removeAll() : setConfirmAll(true))} className="press text-[10.5px] font-bold text-[var(--rose-deep)] mt-1 disabled:opacity-50">
              {confirmAll ? t('Снять на всех устройствах?') : t('Снять push на всех устройствах')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/*
 * Режим подрядчика (`vendor`, фича 007): тот же экран по адресу
 * `/vendor-app/settings`. Тема, язык, push на устройстве и подписки, сессии,
 * выход и удаление аккаунта — общие для обеих ролей. Блоки свадьбы — город,
 * отмена, всё, что читает `weddingId`, — скрыты: подрядчик может быть и парой,
 * но в кабинете он подрядчик. Виды уведомлений и тихие часы здесь тоже не
 * показываются: настройки уведомлений подрядчика по видам — отдельная фича
 * (спека 007, A2), а «дедлайны задач» — про чек-лист пары. Своё — строка
 * «Посмотреть анкету глазами пары» и «Выйти» только на этом устройстве.
 */
export function Settings({ vendor = false }: { vendor?: boolean }) {
  const nav = useNavigate()
  const me = useApi(() => getMe(), [])
  const sessions = useApi(() => getSessions(), [])
  /* Своя анкета — только в кабинете и только ради ссылки «глазами пары»:
     404 здесь — «анкеты ещё нет», ссылки не будет; остальные отказы тоже
     не роняют настройки — они не про анкету. */
  const profile = useApi(
    () => (vendor ? getVendorProfile().catch(() => null) : Promise.resolve(null)),
    [vendor],
  )
  const [leavingHere, setLeavingHere] = useState(false)
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
   *
   * Сам выход — `signOutEverywhere()` в `lib/api/auth.ts`: он общий с
   * «Выйти из аккаунта» на экране «Мы» (D1-20/D4-05) и снимает push этого
   * устройства до очистки токенов (D4-06).
   *
   * После очистки устройства — память стора (RF-01): переход на вход не
   * перезагружает страницу, и свадьба с мозаикой жила в памяти дальше — её
   * открывал «Назад» без токена. То же у удаления и отзыва согласия ниже.
   */
  const { forgetSession } = useStore()
  const signOut = async () => {
    await signOutEverywhere()
    forgetSession()
    nav('/auth')
  }
  /* «Выйти» в кабинете — только это устройство: гасится своя сессия по
     идентификатору из списка (ERR-0233), чужие остаются. */
  const signOutThisDevice = async () => {
    if (leavingHere) return
    setLeavingHere(true)
    await signOutHere()
    forgetSession()
    nav('/auth')
  }

  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  /* 409 `active_deals`: удаление держат сделки, а отзыв согласия их не
     проверяет — предлагаем его (D1-23). */
  const [offerWithdraw, setOfferWithdraw] = useState(false)
  const deleteAccount = async () => {
    setDeleteErr(null)
    try {
      await api.delete('/users/me')
    } catch (e) {
      /* Не удалили на сервере — не делаем вид, что удалили: данные остаются,
         а причина показывается словами сервера. Молчащий catch здесь прятал
         409 `active_deals` («сначала завершите сделки») — кнопка выглядела
         сломанной (R-128). */
      setDeleteErr(
        e instanceof ApiError
          ? (e.isDown ? t('Сервер недоступен. Попробуйте позже') : e.message)
          : t('Что-то пошло не так'),
      )
      if (e instanceof ApiError && e.status === 409) setOfferWithdraw(true)
      return
    }
    /* Аккаунт помечен удалённым, сессии погашены — подписка push этого
       устройства не должна пережить его (тот же случай, что D4-06). */
    await disableDevicePush().catch(() => undefined)
    forgetLocally()
    forgetSession()
    nav('/')
  }

  /*
   * Отзыв согласия (D1-23). Политика обещает «отозвать можно в любой момент —
   * это то же действие, что удаление аккаунта», а в приложении пути к
   * `DELETE /users/me/consent` не было: человек с забронированным фотографом
   * упирался в 409 удаления и отозвать согласие не мог. Два шага одной
   * кнопкой, как у удаления; второй называет, что именно сделает сервер.
   */
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  const [withdrawErr, setWithdrawErr] = useState<string | null>(null)
  const [withdrawBusy, setWithdrawBusy] = useState(false)
  const withdraw = async () => {
    if (withdrawBusy) return
    setWithdrawBusy(true)
    setWithdrawErr(null)
    try {
      await withdrawConsent()
    } catch (e) {
      setWithdrawErr(explainError(e))
      setConfirmWithdraw(false)
      setWithdrawBusy(false)
      return
    }
    await disableDevicePush().catch(() => undefined)
    forgetLocally()
    forgetSession()
    nav('/auth')
  }

  /* Отказ завершения чужой сессии — словами под списком (D1-18): раньше
     `then` без `catch` молчал, и строка оставалась как ни в чём не бывало. */
  const [sessionErr, setSessionErr] = useState<string | null>(null)
  const endOther = (id: string) => {
    setSessionErr(null)
    void endSession(id).then(() => sessions.reload()).catch((e: unknown) => setSessionErr(explainError(e)))
  }
  const [cityPick, setCityPick] = useState(false)
  const { weddingId, setWeddingId, city, cityRegion, setCity, theme, setTheme, lang, setLang } = useStore()

  /*
   * Отмена свадьбы (фича 003).
   *
   * Кнопка только у пары. Роль берём из `members` свадьбы, а не из наличия
   * идентификатора: он есть и у помощника, которого позвали в проект, а
   * отменять чужую свадьбу ему нечем. Пока роль не пришла, блока нет вовсе:
   * показать «Отменить свадьбу» до ответа сервера значит предложить действие,
   * права на которое ещё не известны.
   *
   * Два шага на одной кнопке — как у удаления аккаунта ниже: второе нажатие
   * называет цену вслух. Но второй шаг не всегда подтверждение: если отмену
   * уже запросил партнёр, сервер ИСПОЛНИТ её сразу, и человек должен знать
   * это до нажатия (FR-002).
   */
  /* В кабинете свадьбу не читаем вовсе: блока отмены там нет, и запрос о
     чужой для этого экрана роли был бы холостым. */
  const wedding = useApi(() => (weddingId && !vendor ? getWedding(weddingId) : Promise.resolve(null)), [weddingId, vendor])
  const iAmCouple = !vendor && !!prof?.id && wedding.data?.members?.some(m => m.user?.id === prof.id && m.role === 'couple')
  const requestedBy = wedding.data?.cancelRequestedBy ?? null
  /* Свой же запрос предупреждением не считается: человек и так помнит, что
     нажимал. Предупреждение — только про партнёра. */
  const partnerAsked = !!requestedBy && !!prof?.id && requestedBy !== prof.id
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelErr, setCancelErr] = useState<string | null>(null)
  /* Чем кончился запрос: ждём второго партнёра или свадьбы больше нет. */
  const [cancelDone, setCancelDone] = useState<'waiting' | 'cancelled' | null>(null)

  const cancelOurWedding = async () => {
    if (!weddingId || cancelBusy) return
    setCancelBusy(true)
    setCancelErr(null)
    try {
      const res = await cancelWedding(weddingId)
      if (res?.state === 'cancelled') {
        /* Свадьбы больше нет — телефон забывает её сразу. Иначе каждый экран
           до следующего запуска получает «не найдено» по идентификатору,
           которого на сервере уже нет (FR-004). */
        setWeddingId(null)
        setCancelDone('cancelled')
      } else {
        /* `confirmation_required`: свадьба на месте, ждём второго. */
        setCancelDone('waiting')
        setConfirmCancel(false)
      }
    } catch (e) {
      /* Отказ сервера — его словами: 403 «не пара» и лежащий сервер читаются
         по-разному, а свадьба в обоих случаях остаётся. */
      setCancelErr(explainError(e))
      /* И шаг подтверждения начинается заново. Взведённая кнопка рядом с
         сообщением об отказе — необратимое действие, оставленное под пальцем:
         человек читает ошибку, жмёт туда же «ещё раз» — и при удачном ответе
         свадьбы нет, а второго предупреждения он не видел. */
      setConfirmCancel(false)
    } finally {
      setCancelBusy(false)
    }
  }
  return (
    <div className="pb-28">
      <TopBar back title={t('Настройки')} sub={vendor ? t('Кабинет подрядчика') : undefined} fallback={vendor ? '/vendor-app' : undefined} />
      <div className="px-5 mt-3 space-y-3.5">
        {/* Своя анкета так, как её откроет пара, — и неопубликованной тоже:
            владельца сервер пускает (контракт v0.30.1). Без анкеты строки нет. */}
        {vendor && ready(profile) && profile.data?.id && (
          <button onClick={() => nav(`/vendor/${profile.data?.id ?? ''}`)} className="press w-full card px-4 py-3.5 flex items-center gap-3 text-left">
            <Eye size={16} className="text-[var(--rose-deep)]" />
            <span className="flex-1 text-[13px] font-medium">{t('Посмотреть анкету глазами пары')}</span>
            <ChevronRight size={16} className="text-[var(--soft)]" />
          </button>
        )}
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
          {/* Профиль и тумблеры — только по ответу сервера. До него «Имя не
              указано» и включённые push — утверждения о профиле, которого
              экран не видел; тумблер при этом ещё и отправлял бы правку. */}
          {ready(me) && <>
          <div className="flex items-center gap-3 py-3.5 border-b border-[var(--track)] last:border-none">
            <div className="w-10 h-10 rounded-full bg-[var(--rose)] text-[var(--on-grad)] font-serif-d text-[16px] flex items-center justify-center">{name[0] ?? '·'}</div>
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
          {/* Это виды уведомлений в приложении (и push, когда он включён на
              устройстве ниже). Подпись «Push: …» обещала push, которого
              клиент до блока 8 аудита не умел вовсе. Подрядчику виды не
              показываются: его матрица (лиды/сделки/чаты) — отдельная фича. */}
          {!vendor && <>
          <Row label={t('Уведомления: дедлайны задач')} value={push.tasks} onChange={v => setPush('tasks', v)} />
          <Row label={t('Уведомления: сообщения')} value={push.chats} onChange={v => setPush('chats', v)} />
          <Row label={t('Уведомления: сделки и оплаты')} value={push.deals} onChange={v => setPush('deals', v)} />
          </>}
          {/* Тумблер «Советы ИИ-координатора» убран: таких уведомлений никто не
              шлёт (ни одной задачи с видом «совет» в бэкенде), а переключатель
              для того, чего нет, — обещание (R-174). Поле `push.tips` в
              контракте остаётся — вернётся вместе с советами. */}
          </>}
          {!vendor && (
          <button onClick={() => setCityPick(true)} className="press w-full flex items-center justify-between py-3.5 border-b border-[var(--track)] last:border-none text-left">
            <span className="text-[13px] font-medium">{t('Город свадьбы')}</span>
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--soft)]"><MapPin size={13} className="text-[var(--rose-deep)]" />{t(city)} · {t(cityRegion)}</span>
          </button>
          )}
        </div>
        <div className="card px-4 py-1.5">
          {!vendor && <>
          <div className="flex items-center gap-3 py-3.5 border-b border-[var(--track)]">
            <Moon size={16} className="text-[var(--ink2)]" />
            <span className="flex-1 text-[13px] font-medium">{t('Тихие часы')}</span>
            {/* Тумблер — тоже утверждение: «22:00–09:00» из значений по
                умолчанию при лежащем сервере выдавалось за настройку человека. */}
            {ready(me) && (
              <button onClick={() => setQuiet(!quiet)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', quiet ? 'grad' : 'bg-[var(--track)]')} aria-label={t('Тихие часы')}>
                <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-[var(--card)] shadow transition-all', quiet ? 'left-[22px]' : 'left-[3px]')} />
              </button>
            )}
          </div>
          <p className="text-[10.5px] text-[var(--soft)] py-3">
            {!ready(me)
              ? (me.loading ? t('Загружаем…') : t('Настройки не загрузились'))
              : quiet
                ? `${prof?.quietHours?.from ?? '22:00'}–${prof?.quietHours?.to ?? '09:00'} — ${t('только критичные уведомления. В день X тихие часы отключены автоматически.')}`
                : t('Тихих часов нет: уведомления приходят в любое время суток.')}
          </p>
          </>}
          {/* Push на устройстве — обеим ролям: без ключей сервер ответит 501
              своими словами и подрядчику, и паре (R-174). В кабинете строка
              стоит первой в карточке — верхней границы у неё тогда нет. */}
          <DevicePushRow top={!vendor} />
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
                <button onClick={() => endOther(d.id ?? '')} className="text-[10.5px] font-bold text-[var(--rose-deep)] press">{t('Завершить')}</button>
              )}
            </div>
          ))}
          {sessionErr && <p role="alert" className="text-[11px] text-[var(--rose-ink)] py-2">{sessionErr}</p>}
        </div>
        {/* У пары кнопка выхода стоит на экране «Мы»; в кабинете экрана «Мы»
            нет — «Выйти» здесь, и гасит она только эту сессию: со всех
            устройств — кнопкой ниже. */}
        {vendor && (
          <button onClick={() => void signOutThisDevice()} disabled={leavingHere} className="press w-full card-s py-4 text-[13px] font-semibold text-[var(--rose-deep)] flex items-center justify-center gap-2 disabled:opacity-50">
            <LogOut size={15} />{leavingHere ? t('Секунду…') : t('Выйти')}
          </button>
        )}
        <button onClick={() => void signOut()} className="press w-full card-s py-4 text-[13px] font-semibold text-[var(--rose-deep)] flex items-center justify-center gap-2"><LogOut size={15} />{t('Выйти со всех устройств')}</button>
        {/* Отмена свадьбы: только паре и только по ответу сервера о роли. */}
        {cancelDone === 'cancelled' ? (
          <div className="card px-4 py-5 text-center">
            <b className="text-[13px]">{t('Свадьба отменена')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Брони сняты, подрядчики узнают об этом.')}</p>
            <button onClick={() => nav('/quiz')} className="press mt-4 w-full h-[46px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13px]">
              {t('Начать новую свадьбу')}
            </button>
          </div>
        ) : iAmCouple ? (
          <div className="card px-4 py-4">
            {partnerAsked && (
              <p className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed mb-3">
                {t('Партнёр уже запросил отмену — ваше нажатие исполнит её: брони снимутся, даты уйдут подрядчикам')}
              </p>
            )}
            {confirmCancel ? (
              <button disabled={cancelBusy} onClick={() => void cancelOurWedding()} className="press w-full py-2 text-[12px] font-bold text-[var(--rose-deep)] disabled:opacity-50">
                {t('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам')}
              </button>
            ) : (
              <button disabled={cancelBusy} onClick={() => setConfirmCancel(true)} className="press w-full py-2 text-[12px] font-semibold text-[var(--soft2)] disabled:opacity-50">
                {t('Отменить свадьбу')}
              </button>
            )}
            {cancelBusy && <p className="text-[11px] text-center text-[var(--soft)] mt-2">{t('Загружаем…')}</p>}
            {/* Запрос создан: свадьба на месте, дальше слово за вторым. */}
            {cancelDone === 'waiting' && <p className="text-[11.5px] text-center text-[var(--soft)] mt-2 leading-relaxed">{t('Ждём подтверждения партнёра — запрос действует 72 часа')}</p>}
            {cancelErr && <p role="alert" className="text-[11px] text-center text-[var(--rose-ink)] mt-2">{cancelErr}</p>}
          </div>
        ) : null}
        {confirmDelete ? (
          <button onClick={() => void deleteAccount()} className="press w-full py-3 text-[12px] font-bold text-[var(--rose-deep)]">{t('Подтвердить удаление — данные сотрутся')}</button>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="press w-full py-3 text-[11.5px] font-semibold text-[var(--soft2)]">{t('Удалить аккаунт и все данные')}</button>
        )}
        {deleteErr && <p role="alert" className="text-[11px] text-center text-[var(--rose-deep)]">{deleteErr}</p>}
        {offerWithdraw && (
          <p className="text-[11px] text-center text-[var(--soft)] leading-relaxed px-4">
            {t('Удаление держат сделки. Отозвать согласие можно и с ними — это тоже удалит аккаунт, кнопка ниже.')}
          </p>
        )}
        {confirmWithdraw ? (
          <div className="card px-4 py-4 text-center">
            <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed">
              {t('Согласие будет отозвано, аккаунт помечен на удаление, все сессии закрыты; данные сотрутся через 30 дней. Живые сделки при этом не проверяются.')}
            </p>
            <button disabled={withdrawBusy} onClick={() => void withdraw()} className="press w-full py-3 text-[12px] font-bold text-[var(--rose-deep)] disabled:opacity-50">
              {withdrawBusy ? t('Секунду…') : t('Подтвердить отзыв согласия')}
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmWithdraw(true)} className="press w-full py-3 text-[11.5px] font-semibold text-[var(--soft2)]">{t('Отозвать согласие на обработку данных')}</button>
        )}
        {withdrawErr && <p role="alert" className="text-[11px] text-center text-[var(--rose-deep)]">{withdrawErr}</p>}
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
