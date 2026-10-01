import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { Send } from 'lucide-react'
import { ApiError } from '@/lib/api/client'
import { useApi, explainError } from '@/lib/api/useApi'
import { ErrorState } from '@/components/AsyncState'
import { OfflineProgramView, ProgramReader } from '@/components/ProgramReader'
import { useExternalProgramNamespace, useProgramOnline } from '@/lib/offlineProgramHooks'
import { acknowledgeExternalProgram, getExternalProgram, getGuestVendor, getGuestVendorMessages, postGuestVendorMessage } from '@/lib/api/guestVendor'
import { formatWeddingDate } from '@/lib/weddingDate'
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

type PageResult = { token: string; tick: number; page: GuestVendorPage | null; error: unknown }

/** Загрузка кабинета: 410 — ссылка мертва (полный экран, ничего больше), остальное — обычный отказ с «Повторить». */
function useGuestVendorPage(token: string) {
  const [result, setResult] = useState<PageResult | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    getGuestVendor(token)
      .then(p => { if (alive) setResult({ token, tick, page: (p ?? null) as GuestVendorPage | null, error: null }) })
      .catch((e: unknown) => { if (alive) setResult({ token, tick, page: null, error: e }) })
    return () => { alive = false }
  }, [token, tick])

  const reload = useCallback(() => setTick(n => n + 1), [])
  /* Ответ устаревшего токена (маршрут сменился без размонтирования — не
     бывает при `:token` в пути, но проверка дешёвая и на месте, как в
     `Invite.tsx`'s `useRsvpPage`) на экран не попадает. */
  const current = result?.token === token && result.tick === tick ? result : null
  const page = current?.page ?? null
  const error: unknown = current?.error ?? null
  const dead = error instanceof ApiError && error.status === 410
  return { page, loading: current === null, error, dead, reload }
}

export default function GuestVendor() {
  const { token } = useParams<{ token: string }>()
  const online = useProgramOnline()
  const scope = useExternalProgramNamespace(token ?? '')
  if (scope.pending) return <p className="px-5 py-8 text-sm">{t('Загружаем…')}</p>
  if (!online) return <div className="min-h-dvh px-5 pt-8 pb-16 max-w-[640px] mx-auto"><p role="alert" className="text-sm mb-3">{t('Нет связи с сервером')}</p><OfflineProgramView namespace={scope.namespace} reload={() => {}} /></div>
  return <GuestVendorPageRead key={token} token={token ?? ''} namespace={scope.namespace} />
}

function GuestVendorPageRead({ token, namespace }: { token: string; namespace: string | null }) {
  const q = useGuestVendorPage(token)
  const [refusal, setRefusal] = useState<ApiError | null>(null)
  const onRefused = useCallback((error: ApiError) => setRefusal(error), [])
  const retry = () => { setRefusal(null); q.reload() }

  if (q.loading) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p className="text-[13px] text-[var(--soft)]">{t('Загружаем…')}</p>
    </div>
  )

  /* 410 — ссылка отозвана или истекла: полноэкранное сообщение и ничего
     больше (ни тайминга, ни композитора чата — им нечего показывать без
     живой ссылки, R-172: заглушка не притворяется содержимым). */
  if (q.dead || refusal?.status === 410) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p role="alert" className="font-serif-d text-[20px]">{t('Ссылка истекла или отозвана')}</p>
    </div>
  )

  if (!refusal && q.error instanceof ApiError && q.error.isDown) return <div className="min-h-dvh px-5 pt-8 pb-16 max-w-[640px] mx-auto"><OfflineProgramView namespace={namespace} reload={retry} reloadDisabled={false} /></div>

  if (refusal || q.error || !q.page) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <ErrorState error={explainError(refusal ?? q.error)} retry={retry} />
    </div>
  )

  return <GuestVendorView page={q.page} token={token} namespace={namespace} onRefused={onRefused} />
}

function GuestVendorView({ page, token, namespace, onRefused }: { page: GuestVendorPage; token: string; namespace: string | null; onRefused: (error: ApiError) => void }) {
  const holdHours = page?.holdHours
  const [readOnly, setReadOnly] = useState(false)

  return (
    <div className="min-h-dvh px-5 pt-8 pb-16 max-w-[640px] mx-auto break-words">
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

      <div className="mt-8"><ProgramReader namespace={namespace} read={() => getExternalProgram(token)}
        acknowledge={(proof, tag) => acknowledgeExternalProgram(token, proof, tag)} onRefused={onRefused} onOfflineChange={setReadOnly} /></div>
      {!readOnly && <GuestVendorChat token={token} onRefused={onRefused} />}
    </div>
  )
}

function linkRefusal(error: unknown, onRefused: (error: ApiError) => void) {
  if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) onRefused(error)
}

/*
 * Чат с парой. Список перечитывается после каждой отправки (не оптимистичная
 * вставка): проще и без риска задвоить свою реплику со следующим её приходом
 * в списке. Живого канала нет — контракт не даёт сокета этому токену — вместо
 * опроса короткая подсказка обновить страницу.
 */
function GuestVendorChat({ token, onRefused }: { token: string; onRefused: (error: ApiError) => void }) {
  const q = useApi(() => getGuestVendorMessages(token).catch((error: unknown) => { linkRefusal(error, onRefused); throw error }), [token, onRefused])
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
    } catch (e) { linkRefusal(e, onRefused); setErr(explainError(e)) } finally { setSending(false) }
  })()

  return (
    <section aria-label={t('Написать паре')} className="border-t border-[var(--line)] pt-5 mt-6">
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
    </section>
  )
}
