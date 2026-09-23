import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { Clock3, Send } from 'lucide-react'
import { ApiError } from '@/lib/api/client'
import { useApi, explainError } from '@/lib/api/useApi'
import { ErrorState } from '@/components/AsyncState'
import { getGuestVendor, getGuestVendorMessages, postGuestVendorMessage } from '@/lib/api/guestVendor'
import { formatTime, formatWeddingDate } from '@/lib/weddingDate'
import { t } from '@/lib/i18n'

/*
 * Кабинет гостя-подрядчика (SB-01, ERR-0272, R-272, review-016).
 *
 * Пара приглашает уже знакомого им подрядчика в свой слот отдельной ссылкой
 * (`Wedding.tsx`, карточка «Пригласить в приложение» → `POST …/external/invite`,
 * `slots.ts:534`): «по ссылке он зайдёт как гость-подрядчик — без регистрации
 * в каталоге: увидит дату, тайминг и чат с вами». Экран повторяет паттерн
 * гостевых поверхностей (`Invite.tsx` / `GuestDayChat`): токен только из URL, никогда не
 * сохраняется в `localStorage` — у подрядчика нет аккаунта, и это не его
 * устройство, а рабочий телефон, с которого он мог заходить и как гость на
 * другую свадьбу. Ни гостей, ни бюджета, ни остальной команды, ни денег на
 * этом экране нет (контракт их не отдаёт).
 */

type GuestVendorPage = Awaited<ReturnType<typeof getGuestVendor>>

type PageResult = { token: string; page: GuestVendorPage | null; error: unknown }

/** Загрузка кабинета: 410 — ссылка мертва (полный экран, ничего больше), остальное — обычный отказ с «Повторить». */
function useGuestVendorPage(token: string) {
  const [result, setResult] = useState<PageResult | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    getGuestVendor(token)
      .then(p => { if (alive) setResult({ token, page: (p ?? null) as GuestVendorPage | null, error: null }) })
      .catch((e: unknown) => { if (alive) setResult({ token, page: null, error: e }) })
    return () => { alive = false }
  }, [token, tick])

  const reload = useCallback(() => setTick(n => n + 1), [])
  /* Ответ устаревшего токена (маршрут сменился без размонтирования — не
     бывает при `:token` в пути, но проверка дешёвая и на месте, как в
     `Invite.tsx`'s `useRsvpPage`) на экран не попадает. */
  const current = result?.token === token ? result : null
  const page = current?.page ?? null
  const error: unknown = current?.error ?? null
  const dead = error instanceof ApiError && error.status === 410
  return { page, loading: current === null, error, dead, reload }
}

export default function GuestVendor() {
  const { token } = useParams<{ token: string }>()
  const q = useGuestVendorPage(token ?? '')

  if (q.loading) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p className="text-[13px] text-[var(--soft)]">{t('Загружаем…')}</p>
    </div>
  )

  /* 410 — ссылка отозвана или истекла: полноэкранное сообщение и ничего
     больше (ни тайминга, ни композитора чата — им нечего показывать без
     живой ссылки, R-172: заглушка не притворяется содержимым). */
  if (q.dead) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p role="alert" className="font-serif-d text-[20px]">{t('Ссылка истекла или отозвана')}</p>
    </div>
  )

  if (q.error || !q.page) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <ErrorState error={explainError(q.error)} retry={q.reload} />
    </div>
  )

  return <GuestVendorView page={q.page} token={token ?? ''} />
}

function GuestVendorView({ page, token }: { page: GuestVendorPage; token: string }) {
  const timeline = page?.timeline ?? []
  const holdHours = page?.holdHours

  return (
    <div className="min-h-dvh px-6 pt-12 pb-16 max-w-[430px] mx-auto">
      <div className="text-center">
        <h1 className="font-serif-d text-[28px]">{page?.slot?.label ?? t('Свадьба')}</h1>
        {/* Дата — только словами сервера: пока пара её не выбрала, число
            подрядчику никто не обещал (R-178). */}
        <p className="text-[12.5px] text-[var(--soft)] mt-2">
          {page?.weddingDate ? formatWeddingDate(page.weddingDate) : t('Пара ещё не выбрала дату')}
        </p>
        {/* Срок мягкой брони — справочно, как у сделки (план §18.3); показан
            только когда сервер прислал число (R-178), а не как «0 ч». */}
        {holdHours != null && (
          <p className="text-[11px] text-[var(--honey-deep)] mt-2">{t('мягкая бронь')} {holdHours} {t('ч')}</p>
        )}
      </div>

      <div className="rounded-[24px] p-5 mt-8 card">
        <p className="text-[11px] font-semibold flex items-center gap-1.5"><Clock3 size={12} className="text-[var(--rose-ink)]" />{t('Программа')}</p>
        {timeline.length ? (
          <ul className="mt-2 space-y-2">
            {timeline.map(e => (
              <li key={e.id} className="flex gap-3 text-[12.5px]">
                <b className="tabular shrink-0 w-[46px]">{e.startsAt ? formatTime(e.startsAt) : '—'}</b>
                <span className="min-w-0">
                  <span className="font-medium">{e.name}</span>
                  {e.location && <span className="block text-[10.5px] text-[var(--soft)]">{e.location}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11.5px] mt-2 text-[var(--soft)]">{t('Тайминг пуст')}</p>
        )}
      </div>

      <GuestVendorChat token={token} />
    </div>
  )
}

/*
 * Чат с парой. Список перечитывается после каждой отправки (не оптимистичная
 * вставка): проще и без риска задвоить свою реплику со следующим её приходом
 * в списке. Живого канала нет — контракт не даёт сокета этому токену — вместо
 * опроса короткая подсказка обновить страницу.
 */
function GuestVendorChat({ token }: { token: string }) {
  const q = useApi(() => getGuestVendorMessages(token), [token])
  const [textVal, setTextVal] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const items = q.data?.items ?? []

  const send = () => void (async () => {
    const body = textVal.trim()
    if (!body || sending) return
    setSending(true)
    setErr(null)
    try {
      await postGuestVendorMessage(token, body)
      setTextVal('')
      q.reload()
    } catch (e) { setErr(explainError(e)) } finally { setSending(false) }
  })()

  return (
    <div className="rounded-[24px] p-5 mt-6 card">
      <p className="text-[11px] font-semibold">{t('Написать паре')}</p>
      {q.error ? (
        <p role="alert" className="text-[11.5px] mt-2 text-[var(--rose-ink)]">{q.error}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {!q.loading && items.length === 0 && <p className="text-[11.5px] text-[var(--soft)]">{t('Сообщений пока нет')}</p>}
          {items.map(m => (
            <p key={m.id} className="text-[12.5px]">
              {/* Отправитель — по `mine` от сервера (как в `GuestDayChat`): у
                  своего подрядчика нет аккаунта, поэтому пустой `senderId` в
                  этом виде чата однозначно значит «подрядчик», а `mine`
                  решает, чья это реплика для читающего. */}
              {!m.mine && <span className="block text-[9.5px] text-[var(--soft)]">{t('Пара')}</span>}
              {m.text}
            </p>
          ))}
        </div>
      )}
      <p className="text-[10px] text-[var(--soft)] mt-3">{t('Обновите страницу, чтобы увидеть новые сообщения')}</p>
      <div className="flex gap-2.5 mt-3">
        <input value={textVal} onChange={e => setTextVal(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
          placeholder={t('Сообщение…')} className="flex-1 bg-[var(--card)] rounded-full px-5 h-[44px] text-[13px] outline-none placeholder:text-[var(--soft2)]" style={{ boxShadow: 'var(--shadow)' }} />
        <button disabled={sending || !textVal.trim()} onClick={send} aria-label={t('Отправить')}
          className="press w-[44px] h-[44px] rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0 disabled:opacity-40">
          <Send size={16} />
        </button>
      </div>
      {err && <p role="alert" className="text-[11.5px] mt-2 text-[var(--rose-ink)]">{err}</p>}
    </div>
  )
}
