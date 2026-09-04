import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { guestToken, redeemInvite } from '@/lib/api/guest'
import { explainError } from '@/lib/api/useApi'
import { ApiError } from '@/lib/api/client'
import { t } from '@/lib/i18n'

/*
 * Обмен ссылки-приглашения на токен гостя.
 *
 * Пара присылает одноразовый код. Браузер гостя меняет его на персональный
 * токен, код в этот момент гаснет — ссылка, попавшая в общий чат, не пустит
 * второго. Токен дальше живёт в хранилище этого браузера: аккаунта у гостя
 * нет, и другого способа опознать его не существует.
 *
 * Экран промежуточный: он ничего не спрашивает, только меняет код и уводит на
 * приглашение. Отдельный он потому, что обмен нужно сделать ровно один раз —
 * внутри страницы приглашения он повторялся бы на каждой перерисовке.
 */
export default function InviteRedeem() {
  const { code } = useParams()
  const nav = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  const [used, setUsed] = useState(false)

  /*
   * Обмен делается ровно один раз за жизнь экрана.
   *
   * Код одноразовый: второй вызов гасит уже погашенный и получает 410. В
   * разработке React монтирует эффекты дважды — и гость, у которого обмен
   * прошёл, видел «ссылка уже использована» вместо приглашения. Ref, а не
   * состояние: он нужен до перерисовки, синхронно.
   */
  const started = useRef(false)

  useEffect(() => {
    if (!code || started.current) return
    started.current = true
    /*
     * Отмены по размонтированию здесь нет намеренно. Обычно ответ устаревшего
     * запроса выбрасывают, но этот запрос необратим: код уже погашен, и
     * второго шанса не будет. В разработке React размонтирует эффект сразу
     * после монтирования — с отменой единственная попытка отбрасывалась, токен
     * сохранялся, а гость навсегда оставался на «Открываем приглашение…».
     */
    void redeemInvite(code)
      .then(() => nav('/invite', { replace: true }))
      .catch((e: unknown) => {
        /* Токен уже есть — значит, по этой ссылке на этом устройстве уже
           заходили, и вести надо на приглашение, а не в тупик. */
        if (guestToken()) { nav('/invite', { replace: true }); return }
        /* 410 без токена — код погашен на другом устройстве. Это не ошибка
           приложения, а конец жизни одноразовой ссылки, и говорить о нём надо
           словами гостя, а не кодом состояния. */
        if (e instanceof ApiError && e.status === 410) setUsed(true)
        else setErr(explainError(e))
      })
  }, [code, nav])

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      {!err && !used && <p className="text-[13px] text-[var(--soft)]">{t('Открываем приглашение…')}</p>}
      {used && (
        <>
          <p className="font-serif-d text-[22px]">{t('Ссылка уже использована')}</p>
          <p className="text-[12.5px] text-[var(--soft)] mt-3 leading-relaxed">
            {t('Каждая ссылка открывается один раз — так приглашение не уходит дальше по чатам. Попросите пару выслать новую.')}
          </p>
        </>
      )}
      {err && (
        <>
          <p role="alert" className="text-[13px] text-[var(--rose-ink)] leading-relaxed">{err}</p>
          <button onClick={() => nav(0)} className="press mt-4 px-5 h-[42px] rounded-full card-s text-[12.5px] font-semibold">{t('Повторить')}</button>
        </>
      )}
    </div>
  )
}
