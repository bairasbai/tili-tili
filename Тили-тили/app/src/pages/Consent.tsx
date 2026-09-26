import { startTransition, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getI18nLang, t, reloadToRoot } from '@/lib/i18n'
import { api, ApiError, clearConsentOutdated } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { getPolicy } from '@/lib/api/legal'
import { LEGAL_TEXT_VERSION, formatRedaction } from '@/lib/legal'
import { getMe, signOutHere, withdrawConsent, forgetLocally } from '@/lib/api/auth'
import { disableDevicePush } from '@/lib/push'
import { listMyWeddings } from '@/lib/api/wedding'
import { useStore } from '@/lib/store'

/*
 * Гейт устаревшего согласия (F4, RL-1).
 *
 * Живое согласие есть, но под прежней редакцией: сервер отвечает 403
 * `consent_outdated` на любом пути за `requireConsent` и тем же кодом
 * закрывает живой канал. Гейт стоит в `Shell` вместо маршрутов (`App.tsx`),
 * а не на своём адресе — иначе «Назад» и deep-link его обходили бы (R1).
 *
 * Кнопки «Назад» здесь нет: единственные выходы — принять новую редакцию,
 * выйти или отозвать согласие целиком. Документы (`/legal/offer`,
 * `/legal/privacy`) и выход остаются доступны — они в allow-list сервера
 * и в списке свободных путей гейта (`App.tsx`, `consentGateFree`).
 */
export function ConsentGate({ onDone }: { onDone: () => void }) {
  const nav = useNavigate()
  const { adoptWeddings, refreshSlots, forgetSession } = useStore()

  const [consent, setConsent] = useState(false)
  const [adult, setAdult] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [signOutErr, setSignOutErr] = useState<string | null>(null)
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  const [withdrawErr, setWithdrawErr] = useState<string | null>(null)

  /*
   * Действующая редакция — с сервера, сверяется с той, что лежит в сборке
   * (как на экране входа, `Account.tsx:100-104`). Расхождение — не отказ
   * сети: подписываться под текстом, которого сборка не видела, нельзя.
   */
  const policy = useApi(() => getPolicy(), [])
  const serverVersion = policy.data?.policyVersion ?? null
  const versionMismatch = !!serverVersion && serverVersion !== LEGAL_TEXT_VERSION
  const canConsent = !!serverVersion && !versionMismatch

  /*
   * Принято на другом устройстве, или выкат откатили (несчастливые пути F4):
   * проба своего профиля снимает гейт без второй подписи. 403 или сеть —
   * ничего, гейт остаётся.
   */
  useEffect(() => {
    let alive = true
    getMe()
      .then(() => {
        if (!alive) return
        clearConsentOutdated()
        onDone()
      })
      .catch(() => undefined)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const accept = async () => {
    if (!consent || !adult || busy) return
    setBusy(true); setErr(null)
    try {
      await api.post('/users/me/consent', { policyVersion: LEGAL_TEXT_VERSION, adult })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        /* Редакция сменилась, пока гейт был открыт — подпись под старым
           текстом всё равно не встала бы (несчастливые пути F4). */
        setConsent(false); setAdult(false)
        policy.reload()
      } else {
        setErr(explainError(e))
      }
      setBusy(false)
      return
    }
    clearConsentOutdated()
    /* Стартовая сверка стора упала на 403 и сама не повторится
       (`store.tsx:170-201,:278`) — пересверяем явно, как после входа. */
    void listMyWeddings().then(adoptWeddings, () => adoptWeddings(null))
    refreshSlots()
    setBusy(false)
    onDone()
  }

  const signOut = async () => {
    if (busy) return
    setBusy(true); setSignOutErr(null)
    try {
      await signOutHere()
    } catch (e) {
      /* Отказ по делу — словами под кнопкой, токены на месте (как
         `Account.tsx:836-849`, `signOutThisDevice`). */
      setSignOutErr(explainError(e))
      setBusy(false)
      return
    }
    setBusy(false)
    /*
     * `forgetSession()` (сброс `onboarded` и памяти) и `nav('/auth')` — одним
     * переходом (F4-F-G5-07/G5r5): `<Router>` (`react-router` 7, `useTransitions`
     * не выключен ни здесь, ни в `main.tsx`) применяет переход адреса через
     * `startTransition` и потому рендерится ПОЗЖЕ обычных `setState`. Без общего
     * `startTransition` между вызовами успевает проскочить кадр со старым адресом
     * (`/home`) и уже сброшенным `onboarded`, и маршрут `/home` сам уводит на `/`
     * (`App.tsx`, `element={onboarded ? <Home/> : <Navigate to="/" replace/>}`)
     * раньше, чем адрес долетает до `/auth`. Один `startTransition` заставляет обе
     * части (стор и роутер) отрисоваться одним кадром, минуя этот кадр.
     */
    startTransition(() => {
      forgetSession()
      onDone()
      nav('/auth', { replace: true })
    })
  }

  const confirmWithdrawConsent = async () => {
    if (busy) return
    setBusy(true); setWithdrawErr(null)
    /* Пока токен ещё жив (D4-06) — иначе следующий вошедший на этом
       устройстве продолжает получать чужой push. */
    await disableDevicePush().catch(() => undefined)
    try {
      await withdrawConsent()
    } catch (e) {
      setWithdrawErr(explainError(e))
      setBusy(false)
      setConfirmWithdraw(false)
      return
    }
    forgetLocally()
    setBusy(false)
    /* Тот же приём, что у `signOut()` выше (F4-F-G5-07/G5r5). */
    startTransition(() => {
      forgetSession()
      onDone()
      nav('/auth', { replace: true })
    })
  }

  return (
    <div className="min-h-dvh flex flex-col px-7 pt-10 fade-up">
      <h1 className="font-serif-d text-[32px]">{t('Мы обновили документы')}</h1>
      <p className="text-[13.5px] text-[var(--soft)] mt-2 font-light">
        {t('Чтобы продолжить, прочитайте новую редакцию и подтвердите согласие')}
      </p>

      <button
        onClick={() => canConsent && setConsent(!consent)}
        disabled={!canConsent}
        className="press w-full flex items-start gap-3 mt-8 text-left disabled:opacity-60"
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
          {serverVersion && !versionMismatch && (
            <span className="block text-[10px] text-[var(--soft2)] mt-1">
              {t('редакция от')} {formatRedaction(serverVersion, getI18nLang())}
            </span>
          )}
        </span>
      </button>

      <button
        onClick={() => canConsent && setAdult(!adult)}
        disabled={!canConsent}
        className="press w-full flex items-start gap-3 mt-3 text-left disabled:opacity-60"
        role="checkbox"
        aria-checked={adult}
        aria-label={t('Мне есть 18 лет')}
      >
        <span className={cn('w-[22px] h-[22px] rounded-[7px] shrink-0 flex items-center justify-center mt-0.5 border-[1.5px]', adult ? 'grad border-transparent' : 'border-[var(--line)] bg-[var(--card)]')}>
          {adult && <Check size={13} className="text-[var(--on-grad)]" />}
        </span>
        <span className="text-[11px] text-[var(--ink2)] leading-relaxed">{t('Мне есть 18 лет')}</span>
      </button>

      {versionMismatch && (
        <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed mt-2.5">
          {t('Документы обновились. Обновите приложение — подписываться под редакцией, которой вы не видели, нельзя.')}
          {' '}<button onClick={() => reloadToRoot()} className="press font-semibold underline underline-offset-2">{t('Обновить приложение')}</button>
        </p>
      )}
      {policy.error && (
        <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed mt-2.5">
          {t('Не удалось проверить редакцию документов. Без неё согласие не зафиксировать.')}
          {' '}<button onClick={policy.reload} className="press font-semibold underline underline-offset-2">{t('Повторить')}</button>
        </p>
      )}

      <div className="flex-1" />

      {err && (
        <p role="alert" className="text-[12px] text-[var(--rose-ink)] text-center mb-3 leading-relaxed">{err}</p>
      )}
      <button
        onClick={() => void accept()}
        disabled={!consent || !adult || busy}
        className={cn('press w-full h-[54px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px]', (!consent || !adult || busy) && 'opacity-40')}
        style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
      >
        {busy ? t('Секунду…') : t('Принять')}
      </button>

      {signOutErr && (
        <p role="alert" className="text-[12px] text-[var(--rose-ink)] text-center mt-3 leading-relaxed">{signOutErr}</p>
      )}
      <button onClick={() => void signOut()} disabled={busy} className="press w-full text-center text-[12.5px] font-semibold text-[var(--ink2)] mt-3 disabled:opacity-60">
        {busy ? t('Секунду…') : t('Выйти')}
      </button>

      {withdrawErr && (
        <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] text-center mt-3 leading-relaxed">{withdrawErr}</p>
      )}
      {!confirmWithdraw ? (
        <button onClick={() => setConfirmWithdraw(true)} disabled={busy} className="press w-full text-center text-[11.5px] text-[var(--soft2)] mt-4 mb-6 disabled:opacity-60">
          {t('Не согласен — удалить аккаунт')}
        </button>
      ) : (
        <div className="card p-4 mt-4 mb-6">
          <p className="text-[11.5px] text-[var(--ink2)] leading-relaxed">
            {t('Согласие будет отозвано, аккаунт помечен на удаление, все сессии закрыты; данные сотрутся через 30 дней. Живые сделки при этом не проверяются.')}
          </p>
          <button onClick={() => void confirmWithdrawConsent()} disabled={busy} className="press w-full h-[44px] rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] font-semibold text-[13px] mt-3 disabled:opacity-60">
            {busy ? t('Секунду…') : t('Подтвердить отзыв согласия')}
          </button>
        </div>
      )}
    </div>
  )
}
