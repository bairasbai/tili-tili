import { createElement, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Download, Check, Copy, FileText, Plus, Armchair, Bus, Pencil, Trash2, RefreshCw } from 'lucide-react'
import { contractTemplates } from '@/lib/contractTemplates'
import { dressPalettes } from '@/lib/dressPalettes'
import { fmt } from '@/lib/money'
import type { DealState, Slot } from '@/lib/types'
import { inviteThemes } from '@/lib/inviteThemes'
import { useStore } from '@/lib/store'
import { Bar, Tile, TopBar } from '@/components/chrome'
import { AsyncState } from '@/components/AsyncState'
import { ComplaintSheet } from '@/components/ComplaintSheet'
import { OfferComparisonTerms } from '@/components/OfferComparisonTerms'
import { explainError, useApi, type AsyncData } from '@/lib/api/useApi'
import { OrderDraft } from '@/components/OrderDraft'
import { OrderTerms } from '@/components/OrderTerms'
import { OrderResourcePlan } from '@/components/OrderResourcePlan'
import { OrderResourceCommitments } from '@/components/OrderResourceCommitments'
import { getVendorBookingPolicy } from '@/lib/api/orders'
import { listMyWeddings, saveInviteDesign } from '@/lib/api/wedding'
import { createContract, guestInviteLink } from '@/lib/api/weddingWrite'
import { getDealEvents } from '@/lib/api/slots'
import { chatRouteForVendor } from '@/lib/api/chats'
import { ApiError, isAuthorized, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { ready } from '@/components/AsyncState'
import { getBuses, getGuests, getWedding } from '@/lib/api/weddingData'
import { addTable, deleteTable, patchGuest, patchTable } from '@/lib/api/weddingWrite'
import { catIcon } from '@/lib/icons'
import { cn, copyText, escapeHtml, pct } from '@/lib/utils'
import { getI18nLang, t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'
import { useSeating, type SeatingRead } from '@/lib/useSeating'
import { useRegisteredProgramNamespace } from '@/lib/offlineProgramHooks'
import { offlineGeneration } from '@/lib/offlineAccess'

/*
 * Карточка сделки.
 *
 * Экран был полностью выдуман: имя подрядчика, даты платежей, история из
 * четырёх событий и слот `s4` в обработчиках — всё это стояло в разметке
 * константами и не зависело ни от какой сделки. Теперь он показывает одну
 * настоящую сделку, найденную по идентификатору из адреса.
 *
 * Шесть состояний — решение владельца 2026-09-02, План §8.1. Двигать их можно
 * только вперёд по цепочке: сервер отвечает 409 на любой другой переход,
 * поэтому кнопка предлагает ровно один следующий шаг.
 */
const DEAL_STEPS: ReadonlyArray<{ state: DealState; label: string }> = [
  { state: 'candidate', label: 'Не связывались' },
  { state: 'contacted', label: 'Написали' },
  { state: 'negotiating', label: 'Переговоры' },
  { state: 'booked', label: 'Забронировано' },
  { state: 'paid_deposit', label: 'Аванс внесён' },
  { state: 'done', label: 'Выполнено' },
]

export function Deal() {
  const { slots, slotsState, weddingsState } = useStore()
  const { id } = useParams()
  const s = slots.find(x => x.dealId === id)
  if (!s) return (
    <div className="pb-28">
      <TopBar back title={t('Сделка')} />
      {/* Три случая, и раньше все три выглядели как «Загружаем…»: при
          недоступном сервере экран обещал загрузку до конца сеанса. */}
      <p className="px-5 mt-6 text-[13px] text-[var(--soft)]">
        {slotsState === 'error'
          ? t('Сервер недоступен. Попробуйте позже')
          : slotsState === 'ready' ? t('Сделка не найдена')
          : slotsState === 'idle' ? noWeddingText(weddingsState) : t('Загружаем…')}
      </p>
    </div>
  )
  return <DealView key={s.dealId} s={s} />
}

/*
 * Мозаика не запрашивается (`idle`) — это не только «без входа»: на новом
 * устройстве свадьба не записана, пока список свадеб едет; список мог не
 * прийти; у вошедшего свадьбы может не быть вовсе. Раньше по адресу сделки
 * из закладки вошедший читал «Войдите» (ревью R3-03). Те же слова у экрана
 * слота (`Wedding.tsx`); `idle` списка при живом входе — сверка ещё не
 * началась, как на главной.
 */
function noWeddingText(weddingsState: 'idle' | 'loading' | 'ready' | 'error'): string {
  if (!isAuthorized()) return t('Войдите, чтобы увидеть свою свадьбу')
  if (weddingsState === 'ready') return t('Свадьбы пока нет')
  if (weddingsState === 'error') return t('Сервер недоступен. Попробуйте позже')
  return t('Загружаем…')
}

/*
 * Видит ли этот человек деньги сделки.
 *
 * Помощнику и координатору сервер не отдаёт ни `price`, ни `paid` (в ответе
 * этих полей нет вовсе), паре `paid` приходит всегда — даже нулём. По этому
 * признаку и различаем роли: рисовать помощнику «Оплачено 0 ₽» значит выдать
 * скрытое за факт (R-178), а кнопки оплаты и отмены для его роли всегда 403.
 */
const seesMoney = (s: Slot): boolean => s.price !== undefined || s.paid !== undefined

/*
 * Маршруты для гостей у транспортной сделки (контракт v0.30.0, фича 006).
 *
 * Перевозчик — подрядчик, маршрут — его работа глазами гостей: до этого пара
 * бронировала «Автобусы Уфы» и отдельно руками заводила «Автобус №1», и никто
 * не подсказывал сделать маршрут. Список — из `GET …/logistics/buses` по
 * `dealId` этой сделки; «занято» считает сервер. До ответа — ничего: «пока
 * нет» без ответа было бы нулём вместо «неизвестно» (R-178). Кнопка ведёт в
 * логистику с `?deal=` — форма там раскрывается с этим перевозчиком, а
 * `POST` уходит уже из неё (§5 п. 5: за кнопкой запрос, здесь — переход).
 */
function DealRoutes({ dealId }: { dealId: string }) {
  const nav = useNavigate()
  const { weddingId } = useStore()
  const q = useApi(() => weddingId ? getBuses(weddingId) : Promise.resolve([]), [weddingId])
  const mine = (q.data ?? []).filter(b => b.dealId === dealId)
  return (
    <div className="card p-5">
      <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Маршруты для гостей')}</span>
      <AsyncState q={q} />
      {ready(q) && !mine.length && (
        <p className="text-[12px] text-[var(--soft)] mt-3">{t('Маршрутов для гостей пока нет')}</p>
      )}
      <div className="mt-3 space-y-2.5">
        {mine.map(b => (
          <div key={b.id} className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <b className="text-[12.5px] block truncate">{b.name}</b>
              <p className="text-[10.5px] text-[var(--soft)]">{[b.from, b.time].filter(Boolean).join(' · ')}</p>
            </div>
            <span className="text-[11px] font-bold text-[var(--ink2)] shrink-0 tabular">{t('занято')} {b.taken} {t('из')} {b.seats}</span>
          </div>
        ))}
      </div>
      <button onClick={() => nav(`/wedding/logistics?deal=${encodeURIComponent(dealId)}`)} className="press mt-3 w-full h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold flex items-center justify-center gap-2">
        <Bus size={14} />{t('Добавить маршрут для гостей')}
      </button>
    </div>
  )
}

function DealView({ s }: { s: Slot }) {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const { weddingId, paySlot, cancelBooking, advanceDealTo, refreshSlots } = useStore()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dispute, setDispute] = useState(false)
  /* Занятость — по ответу сервера, а не по таймеру `useBusy` (700 мс): отмена
     на медленной сети идёт дольше, и второй тап уходил вторым запросом
     (ревью 015, FB7). */
  const [busy, setBusy] = useState(false)
  const [resourceOpenRequest, setResourceOpenRequest] = useState(0)
  const inFlight = useRef(false), active = useRef(false), sessionGeneration = useRef(0)
  const currentScope = `${weddingId ?? ''}:${s.id}:${s.dealId ?? ''}:${s.vendorId ?? ''}:${s.dealState ?? ''}:${seesMoney(s)}`
  const scope = useRef(currentScope)
  scope.current = currentScope
  useEffect(() => {
    active.current = true
    const invalidate = () => { sessionGeneration.current++; active.current = false }
    const changed = onSessionChanged(invalidate), expired = onSessionExpired(invalidate)
    return () => { invalidate(); changed(); expired() }
  }, [])
  const run = (fn: () => Promise<unknown>) => void (async () => {
    if (inFlight.current || !active.current) return
    inFlight.current = true
    setBusy(true)
    try { await fn() } finally { inFlight.current = false; if (active.current) setBusy(false) }
  })()

  const at = DEAL_STEPS.findIndex(x => x.state === s.dealState)
  const next = at >= 0 ? DEAL_STEPS[at + 1] : undefined
  const cancelled = s.dealState === 'cancelled'
  /* Выполненную сделку не отменяют: услуга оказана и оплачена, дата прошла.
     Сервер отвечает на такой переход 409, и кнопки здесь быть не должно. */
  const finished = s.dealState === 'done'
  const money = seesMoney(s)

  /* Каждое действие здесь необратимо на той стороне: двигает сделку, освобождает
     дату в календаре подрядчика или фиксирует деньги. Ошибку показываем словами. */
  const guard = (fn: () => Promise<unknown>) => run(async () => {
    setErr(null)
    try { await fn() } catch (e) { if (active.current) setErr(explainError(e)) }
  })

  // Discover the current strategy only on the person's explicit action.
  // The server transaction remains authoritative for financial transitions.
  const agreeBooking = async () => {
    const selectedScope = scope.current, selectedSession = sessionGeneration.current
    const current = () => active.current && isAuthorized() && scope.current === selectedScope && sessionGeneration.current === selectedSession
    if (!s.dealId || !weddingId || !money) return
    const weddings = await listMyWeddings()
    if (!current()) return
    if (weddings.find(w => w.id === weddingId)?.role !== 'couple') {
      setErr(t('Бронирование может согласовать только текущая пара. Обновите сведения.')); return
    }
    if (s.vendorId) {
      const policy = await getVendorBookingPolicy(s.vendorId)
      if (!current()) return
      if (!policy || !['legacy_day', 'resources'].includes(policy.mode) || typeof policy.revision !== 'string' ||
        !/^(0|[1-9]\d{0,18})$/.test(policy.revision) || BigInt(policy.revision) > 9223372036854775807n ||
        (policy.mode === 'resources' && policy.revision === '0')) {
        setErr(t('Способ бронирования пока неизвестен. Повторите проверку перед действием.')); return
      }
      if (policy.mode === 'resources') { setResourceOpenRequest(n => n + 1); return }
    }
    if (!current()) return
    try { await advanceDealTo(s.dealId, 'booked') }
    catch (e) {
      if (!current()) return
      if (e instanceof ApiError && e.code === 'resource_booking_required') {
        setResourceOpenRequest(n => n + 1); return
      }
      throw e
    }
  }

  /* Адрес переписки выдаёт сервер, и он может отказать (429, истёкшая сессия,
     сеть). Раньше промис висел без `catch`: кнопка молча не делала ничего, а
     ошибка уходила в `unhandledrejection` (RF-04, R-148). */
  const [chatBusy, setChatBusy] = useState(false)
  const openChat = async () => {
    setErr(null)
    setChatBusy(true)
    try { nav(await chatRouteForVendor(s.vendorId)) } catch (e) { setErr(explainError(e)) } finally { setChatBusy(false) }
  }

  return (
    <div className="pb-28">
      <TopBar back title={t('Сделка')} sub={`${t(s.label)} · ${s.vendor ?? t('Исполнитель не выбран')}`} />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <div className={cn('w-[52px] h-[52px] rounded-[18px] flex items-center justify-center shrink-0', s.tile)}>
              {createElement(catIcon(s.categoryId), { size: 24, className: 'text-[var(--ink2)]' })}
            </div>
            <div className="flex-1 min-w-0">
              <b className="font-serif-d text-[17px] block truncate">{s.vendor ?? t('Исполнитель не выбран')}</b>
              <p className="text-[11px] text-[var(--soft)]">{t(s.label)}</p>
              {/* Пакет из брони (`Deal.packageName`, фича 005) — только когда он есть. */}
              {s.packageName && <p className="text-[11px] text-[var(--ink2)] mt-0.5 truncate">{t('Пакет:')} {s.packageName}</p>}
              {s.packageIncludes && s.packageIncludes.length > 0 && <ul className="mt-2 list-disc pl-4 text-[11px] text-[var(--ink2)]">{s.packageIncludes.map((part, index) => <li key={index}>{part}</li>)}</ul>}
            </div>
            {s.status && <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--honey)] text-[var(--honey-ink)] shrink-0">{t(s.status)}</span>}
          </div>
          <OfferComparisonTerms terms={s.comparisonTerms} />
          <div className="grid grid-cols-6 gap-1 mt-5">
            {DEAL_STEPS.map((step, k) => {
              /* Пройденным считаем шаг не позже текущего: «выполнено» ставилось
                 галочкой всем шестерым сразу, включая те, до которых не дошли. */
              const done = at >= 0 && k <= at
              return (
                <div key={step.state} className="min-w-0 flex flex-col items-center">
                    <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold', done ? 'grad text-[var(--on-grad)]' : 'bg-[var(--track)] text-[var(--track-ink)]')}>{done ? '✓' : k + 1}</span>
                    <span className={cn('text-[8px] leading-tight mt-1 text-center break-words w-full', done ? 'text-[var(--sage-deep)] font-bold' : 'text-[var(--soft2)]')}>{t(step.label)}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Сумма — та, что записана в сделке, и та, что по ней уже внесена.
            Этапы и сроки живут на экране «График платежей» (018-A) — отсюда
            ссылка на него, а не своя копия графика: раньше здесь стояли «аванс
            10 фев» и «доплата 14 июн» с суммами, не связанными ни с какой
            сделкой. */}
        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Оплаты')}</span>
          {money ? (
            <>
              {/* Сумму платежей считает сервер: до этого её в ответе не было, и
                  строка могла показать только факт оплаты, но не остаток долга. */}
              <div className="flex justify-between items-center mt-3">
                <span className="text-[12.5px]">{t('Оплачено')}</span>
                <b className={cn('tabular text-[13px]', (s.paid ?? 0) > 0 ? 'text-[var(--sage-deep)]' : 'text-[var(--soft)]')}>
                  {fmt(s.paid ?? 0)}{s.price != null && ` ${t('из')} ${fmt(s.price)}`}
                </b>
              </div>
              {s.price != null && s.price > 0 && (
                <div className="mt-2.5">
                  <Bar pct={pct(s.paid ?? 0, s.price)} />
                  <p className="text-[10.5px] text-[var(--soft)] mt-1.5">
                    {s.price - (s.paid ?? 0) > 0
                      ? `${t('осталось')} ${fmt(s.price - (s.paid ?? 0))}`
                      : t('оплачено полностью')}
                  </p>
                </div>
              )}
              <div className="h-[1.5px] bg-[var(--track)] my-3" />
              <div className="flex justify-between items-center">
                <b className="text-[13px]">{t('Итого по договору')}</b>
                <b className="font-serif-d text-[17px] text-[var(--rose-deep)] tabular">{s.price != null ? fmt(s.price) : '—'}</b>
              </div>
              {/* Оплата отсюда пишет весь остаток без этапа; разнести деньги по этапам и
                  отметить часть суммы — на графике (ревью 018, F-03). */}
              <Link to="/wedding/payments" className="block text-[12px] underline mt-3">{t('График платежей')} →</Link>
            </>
          ) : (
            /* Сервер не отдал денег — их не показываем и не выдумываем нулём:
               помощник и координатор сумм не видят по матрице доступа. */
            <p className="text-[12px] text-[var(--soft)] mt-3 leading-relaxed">{t('Суммы и оплаты по сделке видит только пара.')}</p>
          )}
        </div>

        {/* `revision` — состояние и оплаченное: после действия на этом же
            экране журнал обязан перечитаться, иначе он показывает историю до
            последнего шага и выглядит так, будто шага не было. */}
      {money && s.dealId && <OrderDraft dealId={s.dealId} initiallyOpen={s.external && searchParams.get('agreement') === '1'} onExternalContactChanged={refreshSlots} />}
        {money && s.dealId && <OrderResourcePlan dealId={s.dealId} />}
        {money && s.dealId && <OrderTerms dealId={s.dealId} />}
        {money && s.dealId && <OrderResourceCommitments dealId={s.dealId} onChanged={refreshSlots} openRequest={resourceOpenRequest} />}
        {money && s.dealId && <DealJournal dealId={s.dealId} revision={`${s.dealState ?? ''}:${s.paid ?? 0}`} />}

        {/* Маршруты для гостей — только у живой брони в слоте «Транспорт»: до
            брони перевозчик не утверждён (форма маршрута его и не предложит),
            после отмены сервер сам снимает сделку с маршрутов, и список здесь
            был бы всегда пуст. Лимузин пары — та же сделка без маршрута. */}
        {s.categoryId === 'transport' && s.dealId && (s.dealState === 'booked' || s.dealState === 'paid_deposit' || finished) && (
          <DealRoutes dealId={s.dealId} />
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <button disabled={chatBusy} onClick={() => void openChat()} className="press card-s py-3.5 text-[13px] font-semibold disabled:opacity-50">{chatBusy ? t('Открываем чат…') : t('Написать')}</button>
          <button onClick={() => nav(`/wedding/documents/new?deal=${s.dealId ?? ''}`)} className="press card-s py-3.5 text-[13px] font-semibold flex items-center justify-center gap-1.5"><FileText size={14} />{t('Договор')}</button>
          {/* «Внести аванс» — отдельный путь контракта, остальные шаги двигает
              PATCH сделки. Разные адреса, поэтому и кнопки разные. Двигать
              сделку и отменять её может только пара: остальным ролям эти
              кнопки не рисуем — сервер ответил бы им 403 (ревью D2-21). */}
          {cancelled ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">{t('Сделка отменена')}</div>
          ) : !money ? (
            <div className="card-s col-span-2 py-3.5 text-[12.5px] font-semibold text-[var(--soft)] text-center">{t('Только просмотр — шаги, оплату и отмену делает пара')}</div>
          ) : s.dealState === 'booked' ? (
            <button disabled={busy} onClick={() => guard(() => paySlot(s.id))} className="press card-s py-3.5 text-[13px] font-semibold text-[var(--sage-deep)] disabled:opacity-50">{busy ? t('Проводим…') : t('✓ Отметить оплату')}</button>
          ) : next ? (
            <button disabled={busy || !s.dealId} onClick={() => guard(() => next.state === 'booked' ? agreeBooking() : advanceDealTo(s.dealId!, next.state))} className="press card-s py-3.5 text-[13px] font-semibold disabled:opacity-50">{busy ? t('Проводим…') : t(next.state === 'booked' ? 'Согласовать бронирование' : next.label)}</button>
          ) : (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--sage-deep)] text-center">{t('✓ Выполнено')}</div>
          )}
          {cancelled ? (
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">{t('Заказ отменён')}</div>
          ) : !money ? null : finished ? (
            /* Выполненное не отменяется (ревью D2-02): работа сделана, деньги
               внесены — сервер отвечает 409, и предлагать это нечестно. */
            <div className="card-s py-3.5 text-[13px] font-semibold text-[var(--soft)] text-center">{t('Работа выполнена — отмена невозможна')}</div>
          ) : confirmCancel ? (
            <button disabled={busy} onClick={() => guard(async () => { await cancelBooking(s.id); setConfirmCancel(false); nav('/wedding') })} className="press py-3.5 rounded-[18px] bg-[var(--rose-deep)] text-[var(--card)] text-[13px] font-semibold disabled:opacity-50">{t('Точно отменить?')}</button>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="press card-s py-3.5 text-[13px] font-semibold text-[var(--rose-deep)]">{t('Отменить сделку')}</button>
          )}
        </div>
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}

        <div className="card p-5">
          <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Защита сделки')}</span>
          <div className="mt-3 space-y-2.5 text-[12px] text-[var(--soft)] leading-relaxed">
            <p>💸 <b className="text-[var(--ink)]">{t('Оплата:')}</b> {t('деньги идут напрямую подрядчику — приложение фиксирует факт оплаты, но не держит их у себя.')}</p>
            <p>📅 <b className="text-[var(--ink)]">{t('Отмена:')}</b> {t('условия возврата — в договоре со сторонами. Отмена снимает бронь этого заказа; другие заказы и их обязательства сохраняются.')}</p>
            <p>⚖️ <b className="text-[var(--ink)]">{t('Спор:')}</b> {t('откройте спор — жалоба уйдёт модерации, а переписка и договор останутся в приложении.')}</p>
          </div>
          {/* Спор — жалоба на сделку (`POST /complaints`, §18.2): раньше кнопка вела
              на почту поддержки, и очередь модерации спора не видела. */}
          <button onClick={() => setDispute(true)} className="press mt-3 w-full h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Открыть спор')}</button>
          {dispute && s.dealId && <ComplaintSheet target="deal" targetId={s.dealId} title={`${t('Сделка')}: ${s.label}`} onClose={() => setDispute(false)} />}
        </div>
        {/* Правила «30 дней» и «блокировки до решения модерации» в коде нет:
            отзыв о сделке принимается только по завершённой, отменённую не
            оценить ни одной из сторон — это и говорим. */}
        <p className="text-[10px] text-[var(--soft2)] text-center leading-relaxed">{t('Отзыв о сделке возможен только по завершённой: после отмены его не оставит ни одна из сторон.')}</p>
      </div>
    </div>
  )
}

/*
 * Журнал сделки: что и когда с ней происходило.
 *
 * Раньше на этом экране стояла выдуманная история из четырёх событий —
 * одинаковая у всех пар. Настоящие события писались в базу с самого начала,
 * но прочитать их было негде: при споре «мы договаривались о другой сумме»
 * доказательство лежало и молчало.
 *
 * Автор события приходит ролью, а не именем: ни пара, ни подрядчик не
 * получают отсюда чужой идентификатор.
 */
const EVENT_STATE: Record<string, string> = {
  candidate: 'Не связывались',
  contacted: 'Написали',
  negotiating: 'Переговоры',
  booked: 'Забронировано',
  paid_deposit: 'Аванс внесён',
  done: 'Выполнено',
  cancelled: 'Сделка отменена',
}

const EVENT_BY: Record<string, string> = {
  couple: 'вы',
  vendor: 'подрядчик',
  system: 'автоматически',
}

function DealJournal({ dealId, revision }: { dealId: string; revision: string }) {
  const q = useApi(() => getDealEvents(dealId), [dealId, revision])
  const events = q.data ?? []

  return (
    <div className="card p-5">
      <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{t('Что происходило')}</span>
      <AsyncState q={q} />
      {!events.length && ready(q) && (
        <p className="text-[12px] text-[var(--soft)] mt-3">{t('Пока ничего не происходило')}</p>
      )}
      <div className="mt-3 space-y-3">
        {events.map(e => (
          <div key={e.id} className="flex gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--rose-deep)] mt-1.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] font-medium">
                {/* Правка цены несёт свой текст — старую и новую сумму; у перехода
                    состояния текста нет, и его даёт словарь. */}
                {e.kind === 'price' ? (e.note ?? t('Цена изменена')) : e.fromState === null && e.toState === 'candidate' ? t('Создан черновик заказа') : t(EVENT_STATE[e.toState ?? ''] ?? e.toState ?? '')}
              </p>
              <p className="text-[10.5px] text-[var(--soft2)] mt-0.5">
                {e.at ? new Date(e.at).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : ''}
                {e.by && ` · ${t(EVENT_BY[e.by] ?? e.by)}`}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/*
 * Договор из шаблона.
 *
 * Документ оформляет сервер: `POST /deals/{dealId}/contract` подставляет
 * стороны, дату, сумму и город и кладёт запись в документы свадьбы —
 * экран «Документы» показывает её черновиком. До ревью D2-03 кнопка
 * «Сгенерировать договор» меняла только экран: запрос не уходил, поле
 * паспортных данных было неуправляемым, и введённое исчезало, а список
 * документов оставался пустым (R-176, R-174).
 *
 * Скачивание DOCX (Word-совместимый HTML) и PDF (окно печати) остаётся на
 * клиенте: файлы на сервере появятся вместе с хранилищем (`pdfUrl` честно
 * `null`). Текст собирается из тех же данных, что ушли на сервер, — в нём
 * стоят ФИО из формы, а не название свадьбы. Раньше здесь были константы:
 * «г. Уфа», «Алина Козлова и Тимур Волков» и «торжество 14.06.2027».
 */
export interface ContractFacts {
  city: string
  customer: string
  /** Паспортные данные заказчика — так, как введены в форме. */
  passport: string
  vendor: string
  date: string
  amount: string
}

function contractHTML(name: string, f: ContractFacts) {
  // строки переводим заранее: внутри шаблонной строки работает только ${…}
  const [cust, exec, subject, price, p3, p4] = [
    t('Заказчик:'), t('Исполнитель:'),
    t('1. Предмет договора: услуги на свадебное торжество '),
    t('2. Стоимость услуг: '),
    t('3. Ответственность сторон и форс-мажор — по ГК РФ.'),
    t('4. Сформировано в приложении «Тили-тили» (tili-tili.ru).'),
  ]
  // f.vendor — чужая анкета (имя подрядчика), f.customer/f.passport — форма
  // пользователя: оба идут в HTML не как код, а как экранированная строка
  // (R-273, F-RL5-01 — document.write отдавал их разметке без экранирования).
  const customer = f.passport ? `${f.customer}, ${f.passport}` : f.customer
  return `<h1>${escapeHtml(name)}</h1><p>${escapeHtml(f.city)}${new Date().toLocaleDateString('ru-RU')}</p>
  <p><b>${cust}</b> ${escapeHtml(customer)}<br><b>${exec}</b> ${escapeHtml(f.vendor)}</p>
  <p>${subject}${escapeHtml(f.date)}.</p><p>${price}${escapeHtml(f.amount)}.</p><p>${p3}</p><p>${p4}</p>`
}

/*
 * Шаблон экрана → код шаблона сервера. У сервера пять шаблонов, у экрана
 * шесть карточек: декоратор и кондитер идут универсальным договором.
 */
const TEMPLATE_CODE: Record<string, string> = {
  c1: 'photographer',
  c2: 'venue',
  c3: 'host',
  c4: 'universal',
  c5: 'universal',
  c6: 'universal',
}
function downloadDocx(name: string, f: ContractFacts) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body style="font-family:Georgia,serif">${contractHTML(name, f)}</body></html>`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }))
  a.download = 'dogovor-tili-tili.doc'
  a.click(); URL.revokeObjectURL(a.href)
}
function downloadPdf(name: string, f: ContractFacts) {
  const w = window.open('', '_blank')
  if (!w) return
  w.document.write(`<html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head><body style="font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.6">${contractHTML(name, f)}<script>window.onload=()=>window.print()${'<'}/script></body></html>`)
  w.document.close()
}

/* Мастер договора: шаблон → данные → запрос на сервер → готово */
export function ContractWizard() {
  const nav = useNavigate()
  const { weddingDate, weddingId, slots, slotsState, weddingsState } = useStore()
  /* Договор всегда про конкретную сделку: её идентификатор приходит из адреса
     (`?deal=`), имя исполнителя и сумма берутся из мозаики. Без сделки
     оформлять нечего — сервер принимает договор только по ней. */
  const [params, setParams] = useSearchParams()
  const dealId = params.get('deal')
  const slot = dealId ? slots.find(x => x.dealId === dealId) : undefined
  /*
   * Без `?deal=` — выбор сделки из мозаики (фича 005): мастер открывают и с
   * экрана «Документы», а не только из карточки сделки, и «недоступно»
   * там читалось как поломка. Предлагаются только те, по которым сервер
   * договор примет — забронированные, с авансом и выполненные (иначе 409
   * `not_booked`). Выбор пишется в адрес: дальше мастер работает как из
   * карточки. Мозаика не пришла — «не знаю», а не «сделок нет».
   */
  const contractable = slots.filter(x => x.dealId && (x.dealState === 'booked' || x.dealState === 'paid_deposit' || x.dealState === 'done'))
  const wq = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const [step, setStep] = useState(0)
  const [tpl, setTpl] = useState(0)
  /* Стороны договора — поля формы (сервер требует оба), паспортные данные
     уходят вместе с ними в `fields`. Исполнитель подставляется из сделки,
     но правится: в договоре стоит ФИО, а в каталоге — название студии. */
  const [customerName, setCustomerName] = useState('')
  const [performerDraft, setPerformerDraft] = useState<string | null>(null)
  const [passport, setPassport] = useState('')
  const [created, setCreated] = useState<{ version?: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ctpl = contractTemplates[tpl]
  const performerName = performerDraft ?? slot?.vendor ?? ''

  const facts: ContractFacts = {
    /* «г.» отдельным ключом переводить нечего — в английском такого сокращения
       нет, а пустой перевод неотличим от забытого. Пишем полной строкой. */
    city: wq.data?.city?.name ? `${t('Город: ')}${wq.data.city.name} · ` : '',
    customer: customerName.trim() || t('уточняется'),
    passport: passport.trim(),
    vendor: performerName.trim() || '______________________',
    date: weddingDate ? formatWeddingDate(weddingDate) : t('уточняется'),
    amount: slot?.price != null ? fmt(slot.price) : t('уточняется'),
  }

  /* Пока запрос идёт, кнопка выключена: второе нажатие оформило бы вторую
     версию того же договора. */
  const generate = () => void (async () => {
    if (!dealId || busy) return
    setBusy(true)
    setErr(null)
    try {
      const doc = await createContract(dealId, TEMPLATE_CODE[ctpl.id] ?? 'universal', {
        customerFullName: customerName.trim(),
        performerFullName: performerName.trim(),
        ...(passport.trim() ? { customerPassport: passport.trim() } : {}),
      })
      setCreated({ version: doc?.version })
    } catch (e) {
      /* 409 `not_booked`, 422 `fields_missing`, 403 для команды — словами
         сервера: он один знает, чего не хватило. */
      setErr(explainError(e))
    } finally { setBusy(false) }
  })()

  if (created) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center fade-up">
      <div className="w-[92px] h-[92px] rounded-full grad flex items-center justify-center text-[var(--on-grad)] pop" style={{ boxShadow: 'var(--shadow-lift)' }}><Check size={38} strokeWidth={2.5} /></div>
      <h1 className="font-serif-d text-[28px] mt-7">{t('Договор готов')}</h1>
      {/* Документ записан на сервере черновиком; файлы к нему появятся вместе
          с хранилищем, а «загрузите скан в сделку» обещало загрузку, которой
          нет. Скачать текст можно отсюда — он собран из тех же данных. */}
      <p className="text-[13px] text-[var(--soft)] mt-3 font-light leading-relaxed">
        «{t(ctpl.name)}»{created.version != null ? ` · ${t('версия')} ${created.version}` : ''}{t(' — черновик записан в документы свадьбы. Скачайте текст и подпишите с подрядчиком — загрузка сканов появится вместе с файловым хранилищем.')}
      </p>
      <div className="flex gap-2.5 mt-8 w-full">
        <button onClick={() => downloadPdf(t(ctpl.name), facts)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> PDF</button>
        <button onClick={() => downloadDocx(t(ctpl.name), facts)} className="press flex-1 h-[52px] rounded-full bg-[var(--card)] font-semibold text-[13px] flex items-center justify-center gap-2" style={{ boxShadow: 'var(--shadow)' }}><Download size={15} /> DOCX</button>
      </div>
      <button onClick={() => nav('/wedding/documents')} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] mt-2.5" style={{ boxShadow: 'var(--shadow-lift)' }}>{t('Открыть «Документы»')}</button>
    </div>
  )

  const canGenerate = !!dealId && !busy

  /* `pb-28` под таб-бар: с `pb-10` «Далее» на телефоне лежала под ним (живая проверка 2026-09-18). */
  return (
    <div className="min-h-dvh flex flex-col pb-28">
      <TopBar back title={t('Новый договор')} sub={`${t('Шаг ')}${step + 1}${t(' из 2')}`} />
      {/* Заказчик и город берутся из свадьбы: если она не пришла, «уточняется»
          в договоре должно сопровождаться причиной, а не молчанием. */}
      {wq.error && <p role="alert" className="px-5 mt-2 text-[12px] text-[var(--rose-ink)] leading-relaxed">{wq.error}</p>}
      {/* Без сделки кнопка недоступна, и человек выбирает сделку здесь — а не
          жмёт в пустоту (см. `contractable`). */}
      {!dealId && (
        <div className="px-5 mt-2">
          <p className="text-[12px] text-[var(--rose-ink)] leading-relaxed">{t('Договор оформляется по сделке — выберите, с кем он:')}</p>
          {slotsState === 'ready' && !contractable.length && (
            <p className="text-[12px] text-[var(--soft)] leading-relaxed mt-1.5">{t('Забронированных сделок пока нет — договор появится вместе с первой бронью.')}</p>
          )}
          {slotsState === 'error' && <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed mt-1.5">{t('Сервер недоступен. Попробуйте позже')}</p>}
          {slotsState === 'loading' && <p className="text-[12px] text-[var(--soft)] mt-1.5">{t('Загружаем…')}</p>}
          {slotsState === 'idle' && <p className="text-[12px] text-[var(--soft)] mt-1.5">{noWeddingText(weddingsState)}</p>}
          <div className="space-y-2 mt-2.5">
            {contractable.map(x => (
              <button key={x.dealId} onClick={() => setParams({ deal: x.dealId! }, { replace: true })} className="press w-full card-s p-3.5 flex items-center gap-3 text-left">
                <div className="flex-1 min-w-0">
                  <b className="text-[13px] block truncate">{x.vendor ?? t('Исполнитель не выбран')}</b>
                  <p className="text-[10.5px] text-[var(--soft)]">{t(x.label)}{x.price != null ? ` · ${fmt(x.price)}` : ''}</p>
                </div>
                <FileText size={14} className="text-[var(--soft)] shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
      {step === 0 ? (
        <div className="px-5 mt-3 space-y-2.5 stagger">
          {contractTemplates.map((c, k) => (
            <button key={c.id} onClick={() => setTpl(k)} className={cn('press w-full card-s p-4 flex items-center gap-3 text-left fade-up', tpl === k && 'ring-2 ring-[var(--rose)]')}>
              <Tile icon={c.icon} tile={c.tile} size={42} />
              <div className="flex-1"><b className="text-[13px]">{t(c.name)}</b><p className="text-[10.5px] text-[var(--soft)]">{t(c.desc)}</p></div>
              <span className={cn('w-5 h-5 rounded-full border-2', tpl === k ? 'bg-[var(--rose)] border-[var(--rose)]' : 'border-[var(--line)]')} />
            </button>
          ))}
        </div>
      ) : (
        <div className="px-5 mt-3 fade-up">
          <div className="card p-5 space-y-3.5">
            {/* Аванс из списка убран: его размер брался константой 30 000 ₽ и
                не был связан ни с какой сделкой. */}
            <div>
              <span className="text-[10px] tracking-[.14em] uppercase text-[var(--rose-deep)] font-semibold">{t('Заказчик *')}</span>
              <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder={t('ФИО заказчика — как в паспорте')} className="w-full mt-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            </div>
            <div>
              <span className="text-[10px] tracking-[.14em] uppercase text-[var(--rose-deep)] font-semibold">{t('Исполнитель *')}</span>
              <input value={performerName} onChange={e => setPerformerDraft(e.target.value)} placeholder={t('ФИО или название исполнителя')} className="w-full mt-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            </div>
            {[[t('Дата оказания услуги'), facts.date], [t('Сумма'), facts.amount]].map(([l, v]) => (
              <div key={l}>
                <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{l}</span>
                <p className="text-[13.5px] font-medium mt-0.5">{v}</p>
              </div>
            ))}
            <div>
              <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold">{t('Паспортные данные заказчика')}</span>
              <input value={passport} onChange={e => setPassport(e.target.value)} placeholder={t('Заполните перед подписанием')} className="w-full mt-1 bg-[var(--bg)] rounded-xl px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
            </div>
          </div>
          <p className="text-[10px] text-[var(--soft2)] mt-3 text-center">{t('Шаблон — информационный, не заменяет консультацию юриста')}</p>
          {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-3 text-center leading-relaxed">{err}</p>}
        </div>
      )}
      <div className="px-5 mt-auto pt-6">
        {step === 0 ? (
          <button onClick={() => setStep(1)} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px]" style={{ boxShadow: 'var(--shadow-lift)' }}>{t('Далее')}</button>
        ) : (
          <button disabled={!canGenerate} onClick={generate} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] disabled:opacity-50" style={{ boxShadow: 'var(--shadow-lift)' }}>
            {busy ? t('Оформляем…') : t('Сгенерировать договор ✨')}
          </button>
        )}
      </div>
    </div>
  )
}

/* Рассадка */
/*
 * Рассадка: столы и гости с сервера.
 *
 * Место гостя — поле `tableId` у самого гостя, а не отдельная карта в браузере:
 * рассаживают вдвоём, и `tt_seating` на одном телефоне второй из пары не видел.
 * «Без стола» по-прежнему вычисляется, а не хранится — иначе гость оказывался
 * бы одновременно за столом и в списке нерассаженных.
 *
 * Значок горячего убран: он выдавался хешем от имени гостя и подписывался «из
 * опроса меню». Настоящий ответ гостя лежит в `diet`, и показываем теперь его.
 */
const DIET_ICON: Record<string, string> = {
  vegetarian: '🥦',
  vegan: '🥦',
  halal: '🍽',
  kosher: '🍽',
  gluten_free: '🌾',
  other: '🍽',
}

export function Seating() {
  const { weddingId } = useStore()
  const namespace = useRegisteredProgramNamespace()
  return <SeatingReader key={JSON.stringify([weddingId, namespace])} weddingId={weddingId} />
}

function SeatingReader({ weddingId }: { weddingId: string | null }) {
  const { q, copy, live, online, refusal } = useSeating(weddingId)
  if (live && weddingId) return <SeatingEditor weddingId={weddingId} q={q} />
  const attending = copy?.guests.filter(g => g.status !== 'no') ?? []
  return <div className="pb-28">
    <TopBar back title={t('Рассадка')} />
    {refusal ? <p role="alert" className="px-5 py-4 text-[12px]">{explainError(refusal)}</p> : <AsyncState q={q} />}
    {!refusal && copy && <div className="px-5 space-y-4">
      <div role="status" className="py-3 border-b border-[var(--line)] text-[12px] leading-relaxed">
        <p>{t('Сохранённая рассадка — только чтение')}</p>
        <p>{t('Актуальность и доступ не проверены.')}</p>
        <p>{t('Гости и столы прочитаны отдельно; единая версия не подтверждена')}</p>
        <p>{t('Гости: ')}{new Date(copy.guestsReadAt).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU')}</p>
        <p>{t('Столы: ')}{new Date(copy.tablesReadAt).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU')}</p>
      </div>
      <section>
        <h2 className="text-[13px] font-semibold">{t('Без стола:')}</h2>
        {attending.filter(g => !g.tableId).map(g => <p key={g.id} className="text-[12px] break-words">{g.name}</p>)}
        {!attending.some(g => !g.tableId) && <p className="text-[12px]">{attending.length ? t('все рассажены ✓') : t('гостей пока нет')}</p>}
      </section>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {copy.tables.map(tb => {
          const people = attending.filter(g => g.tableId === tb.id)
          return <section key={tb.id} className="border-t border-[var(--line)] pt-3 min-w-0">
            <h2 className="text-[14px] font-semibold break-words">{tb.name}</h2>
            <p className="text-[12px] tabular">{people.length}/{tb.capacity}</p>
            {people.map(g => <p key={g.id} className="text-[12px] break-words py-1">{g.name}</p>)}
            {!people.length && <p className="text-[12px]">{t('Пусто')}</p>}
          </section>
        })}
      </div>
    </div>}
    {!refusal && !copy && !online && <p className="px-5 py-3 text-[12px]">{t('Сохранённой рассадки для этой сессии и свадьбы нет')}</p>}
    {!refusal && online && !q.loading && !q.refreshing && !q.error && !q.forbidden && !live && <button onClick={q.reload} aria-label={t('Перечитать рассадку')} title={t('Перечитать рассадку')} className="mx-5 h-11 w-11 flex items-center justify-center"><RefreshCw size={18} /></button>}
  </div>
}

function SeatingEditor({ weddingId, q }: { weddingId: string; q: AsyncData<SeatingRead> }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const guestsQ = { ...q, data: q.data?.guests ?? null }
  const tablesQ = { ...q, data: q.data?.tables ?? null }

  // Рассаживать начинают до того, как ответят все, поэтому за столы попадают и
  // ждущие ответа. Исключаются только отказавшиеся.
  //
  // WP02: every row is one person; plusOne describes a primary family member.
  const attending = (guestsQ.data ?? [])
    .filter(g => g.status !== 'no')
    .map(g => ({ id: g.id ?? '', name: g.name ?? '', tableId: g.tableId ?? null, diet: g.diet ?? null, persons: 1 }))

  const tables = (tablesQ.data ?? []).map(tb => {
    const guests = attending.filter(g => g.tableId === tb.id)
    return {
      id: tb.id ?? '',
      name: tb.name ?? '',
      capacity: tb.capacity ?? 8,
      guests,
      seated: guests.reduce((a, g) => a + g.persons, 0),
    }
  })
  const unseated = attending.filter(g => !g.tableId)
  const selectedGuest = attending.find(g => g.id === selected)
  /* One selected person occupies one seat. */
  const fits = (tb: { seated: number; capacity: number }) => !!selectedGuest && tb.seated + selectedGuest.persons <= tb.capacity

  const write = async (fn: () => Promise<unknown>, onFailure: (e: unknown) => void = e => setErr(explainError(e))) => {
    /* Без свадьбы записывать некуда. Молчаливый выход отсюда читается как
       поломка: кнопка нажимается и ничего не происходит. */
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — рассадка живёт в ней')); return }
    if (busy || !navigator.onLine || q.refreshing || q.loading) return
    setBusy(true)
    setErr(null)
    try { await fn(); q.reload() } catch (e) {
      onFailure(e)
      if (e instanceof ApiError && e.isDown) q.reload()
    } finally { setBusy(false) }
  }
  const seat = (tableId: string) => {
    const tb = tables.find(x => x.id === tableId)
    if (!selectedGuest || !tb) return
    /* Полный стол — словами, а не молчанием: молчаливое «ничего не
       произошло» на нажатии читается как поломка. Сервер держит ту же
       границу (409 `table_full`) — на случай второго устройства. */
    if (!fits(tb)) { setErr(t('Стол заполнен — выберите другой или добавьте стол')); return }
    void write(async () => { await patchGuest(weddingId!, selectedGuest.id, { tableId }); setSelected(null) })
  }
  /* Снятие со стола шлёт именно `null`: пропущенное поле сервер читает как
     «не трогать», и гость остался бы сидеть там, откуда его убрали. */
  const unseat = (guestId: string) => void write(() => patchGuest(weddingId!, guestId, { tableId: null }))

  const addNewTable = () => void write(() => addTable(weddingId!, `${t('Стол №')}${tables.length + 1}`, 8))

  /*
   * Переименовать, сменить вместимость, убрать стол (контракт v0.29.0,
   * фича 005). До этого промах по «Добавить стол» жил в рассадке навсегда.
   * Правка идёт в карточке стола, и её отказ — там же, под «Сохранить»:
   * вместимость меньше числа посаженных сервер отклоняет 409 `table_full`
   * своими словами. Удаление — через второй тап: гости стола уходят в
   * «без стола» на сервере, экран после ответа перечитывает оба списка.
   */
  const [editId, setEditId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [capDraft, setCapDraft] = useState('')
  const [editErr, setEditErr] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const openEdit = (tb: { id: string; name: string; capacity: number }) => {
    setEditId(tb.id); setNameDraft(tb.name); setCapDraft(String(tb.capacity)); setEditErr(null); setConfirmDel(null)
  }
  const saveTable = (tableId: string) => {
    const name = nameDraft.trim()
    const capacity = parseInt(capDraft, 10)
    if (!name || !Number.isFinite(capacity) || capacity < 1) return
    setEditErr(null)
    void write(async () => {
      await patchTable(weddingId!, tableId, { name, capacity })
      setEditId(null)
    }, e => setEditErr(explainError(e)))
  }
  const removeTable = (tableId: string) => void write(async () => {
    await deleteTable(weddingId!, tableId)
    setConfirmDel(null)
    if (editId === tableId) setEditId(null)
  })

  /* Each mutation addresses one explicit person; never queue offline writes. */
  const autoSeat = () => void write(async () => {
    const free = tables.map(tb => ({ id: tb.id, left: tb.capacity - tb.seated }))
    for (const g of unseated) {
      if (!navigator.onLine || q.data?.generation !== offlineGeneration()) break
      const spot = free.find(f => f.left >= g.persons)
      if (!spot) continue
      await patchGuest(weddingId!, g.id, { tableId: spot.id })
      spot.left -= g.persons
    }
    setSelected(null)
  })

  const selectedName = selectedGuest?.name

  return (
    <div className="pb-28">
      <TopBar back title={t('Рассадка')} sub={selectedName ? `${t('Сажаем: ')}${selectedName}${t(' — выберите стол')}` : t('Выберите гостя, затем стол')} />
      <AsyncState q={guestsQ} />
      {/* Столы — второй запрос со своими состояниями: раньше его отказ
          выглядел как «столов пока нет». */}
      {ready(guestsQ) && <AsyncState q={tablesQ} />}
      <div className="px-5 mt-3">
        <div className="px-1 py-3 flex flex-wrap items-center gap-2 border-b border-[var(--line)]">
          <span className="text-[10px] tracking-[.14em] uppercase text-[var(--soft)] font-semibold shrink-0">{t('Без стола:')}</span>
          {unseated.map(g => (
            <button key={g.id} onClick={() => setSelected(s => s === g.id ? null : g.id)} className={cn('press text-[12px] font-medium px-3 py-2 rounded-lg max-w-full break-words text-left transition-all', selected === g.id ? 'grad text-[var(--on-grad)]' : 'bg-[var(--card)]')}>{g.name}</button>
          ))}
          {/* «все рассажены» и «гостей пока нет» — только по пришедшему списку. */}
          {!unseated.length && <span className="text-[10.5px] text-[var(--sage-deep)] font-semibold">{!ready(guestsQ) ? '—' : attending.length ? t('все рассажены ✓') : t('гостей пока нет')}</span>}
        </div>
      </div>
      {err && <p role="alert" className="px-5 mt-3 text-[12px] text-[var(--rose-ink)]">{err}</p>}
      {/* Состав столов и «N/M» — только по пришедшему списку гостей (ревью
          D3-12): пока он грузится или упал, «0/8» и «Пусто» под честным
          «Сервер недоступен» читались как факт о рассадке. */}
      {ready(guestsQ) && (
      <div className="px-5 mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 stagger">
        {tables.map(tb => (
          <div key={tb.id} onClick={() => seat(tb.id)} className={cn('card p-4 min-w-0 text-left fade-up transition-all', fits(tb) && 'ring-2 ring-[var(--sage)] cursor-pointer')}>
            {editId === tb.id ? (
              /* Клики в форме не сажают выбранного гостя за этот стол. */
              <div className="space-y-1.5" onClick={e => e.stopPropagation()}>
                <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value.slice(0, 60))} onKeyDown={e => e.key === 'Enter' && saveTable(tb.id)} aria-label={t('Название стола')} className="w-full h-8 px-2.5 rounded-lg bg-[var(--bg)] text-[12px] font-semibold outline-none" />
                <div className="flex items-center gap-1.5">
                  <Armchair size={10} className="text-[var(--soft)]" />
                  <input value={capDraft} onChange={e => setCapDraft(e.target.value.replace(/\D/g, '').slice(0, 3))} onKeyDown={e => e.key === 'Enter' && saveTable(tb.id)} inputMode="numeric" aria-label={t('Мест за столом')} className="w-12 h-7 px-2 rounded-lg bg-[var(--bg)] text-[11px] outline-none tabular" />
                  <span className="text-[9px] text-[var(--soft)]">{t('мест')}</span>
                  <div className="flex-1" />
                  <button disabled={busy || !nameDraft.trim() || !parseInt(capDraft, 10)} onClick={() => saveTable(tb.id)} className="press text-[10px] font-bold text-[var(--sage-deep)] disabled:opacity-50">{t('Сохранить')}</button>
                  <button onClick={() => setEditId(null)} className="press text-[10px] text-[var(--soft)]">{t('Отмена')}</button>
                </div>
                {editErr && <p role="alert" className="text-[10.5px] text-[var(--rose-ink)] leading-snug">{editErr}</p>}
              </div>
            ) : (
              <div>
                <b className="block font-serif-d text-[16px] break-words">{tb.name}</b>
                <div className="flex items-center gap-1.5 min-h-9">
                <span className="text-[9px] text-[var(--soft)] flex items-center gap-1 shrink-0"><Armchair size={10} /> {tb.seated}/{tb.capacity}</span>
                <span className="flex-1" />
                <button onClick={e => { e.stopPropagation(); openEdit(tb) }} className="press h-9 w-9 flex items-center justify-center text-[var(--soft)] shrink-0" aria-label={t('Переименовать стол')} title={t('Переименовать стол')}><Pencil size={15} /></button>
                {confirmDel === tb.id ? (
                  <button disabled={busy} onClick={e => { e.stopPropagation(); removeTable(tb.id) }} className="press text-[9px] font-bold px-2 py-0.5 rounded-full bg-[var(--rose-deep)] text-[var(--card)] shrink-0 disabled:opacity-50">{t('Удалить?')}</button>
                ) : (
                  <button onClick={e => { e.stopPropagation(); setConfirmDel(tb.id) }} className="press h-9 w-9 flex items-center justify-center text-[var(--soft)] shrink-0" aria-label={t('Удалить стол')} title={t('Удалить стол')}><Trash2 size={15} /></button>
                )}
                </div>
              </div>
            )}
            <div className="mt-2.5 space-y-1.5 min-h-[60px]">
              {tb.guests.length ? tb.guests.map(g => (
                <button key={g.id} disabled={busy} onClick={e => { e.stopPropagation(); unseat(g.id) }} className="press w-full text-left text-[12px] bg-[var(--bg)] rounded-lg px-2.5 py-2 flex items-center gap-1.5 disabled:opacity-50">
                  {g.diet && <span className="text-[10px] shrink-0">{DIET_ICON[g.diet] ?? '🍽'}</span>}
                  <span className="min-w-0 break-words">{g.name}</span>
                </button>
              )) : <div className="text-[10.5px] text-[var(--soft2)] py-3 text-center border-[1.5px] border-dashed border-[var(--line)] rounded-xl">{t('Пусто')}</div>}
            </div>
          </div>
        ))}
        {!tables.length && ready(tablesQ) && <p className="col-span-2 text-[12px] text-[var(--soft)] text-center py-4">{t('Столов пока нет — добавьте первый')}</p>}
      </div>
      )}
      <div className="px-5 mt-4 space-y-3">
        <button onClick={autoSeat} disabled={busy || !unseated.length || !tables.length} className={cn('press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] flex items-center justify-center gap-2', (busy || !unseated.length || !tables.length) && 'opacity-40')} style={{ boxShadow: 'var(--shadow-lift)' }}>✨ {t('Рассадить автоматически')}</button>
        {/* Легенда описывает то, что гость сам указал в RSVP. Прежняя обещала
            «из опроса меню» три значка, которые выдавались хешем имени. */}
        <div className="px-1 py-3 flex flex-wrap items-center gap-3 text-[10.5px] text-[var(--soft)] border-t border-[var(--line)]">
          <span className="font-semibold tracking-[.12em] uppercase shrink-0">{t('Легенда:')}</span>
          <span>🥦 {t('вег')}</span><span>🌾 {t('без глютена')}</span><span>🍽 {t('особое меню')}</span>
          <span className="ml-auto">{t('из ответа гостя')}</span>
        </div>
        <button disabled={busy} onClick={addNewTable} className="press w-full card-s py-4 text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50"><Plus size={15} />{t('Добавить стол')}</button>
        {/* Убраны подсказка про «тётю Люду и дядю Рафика», которых нет среди
            гостей, и плашка «подрядчик получает обновление и подтверждает»:
            рассадка никому не рассылается. */}
        <button onClick={() => window.print()} className="press w-full h-[52px] rounded-full bg-[var(--ink)] text-[var(--bg)] font-semibold text-[13.5px] flex items-center justify-center gap-2"><Download size={15} />{t('PDF для печати А3')}</button>
      </div>
    </div>
  )
}

/* Редактор приглашений: сценарий → текст → вопросы гостям → именные ссылки */
export function InviteEditor() {
  const nav = useNavigate()
  const { weddingDate, weddingId } = useStore()
  /*
   * Текст, тема и дресс-код хранятся у свадьбы: их видит гость. Редактор
   * начинается с того, что лежит на сервере, — правка живёт в состоянии
   * экрана до «Сохранить оформление». До ревью D3-04 текст и тема читались
   * из `tt_invite_*` этого браузера: второй из пары видел умолчания, превью
   * «то, что увидит гость» врало, а сохранение перезаписывало на сервере то,
   * что гость уже видел. Пока `tt_dress` жил в браузере, гость точно так же
   * получал палитру по умолчанию и принимал её за выбор пары.
   */
  const wq = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const [textDraft, setTextDraft] = useState<string | null>(null)
  const [themeDraft, setThemeDraft] = useState<number | null>(null)
  /* Текст по умолчанию — заготовка для свадьбы, где пара ещё ничего не
     написала (сервер отдаёт пустое поле): она попадёт к гостю только после
     «Сохранить оформление». */
  const inviteText = textDraft ?? wq.data?.inviteText ?? t('Мы хотим разделить с вами самый особенный день нашей жизни. Для нас будет честью видеть вас рядом в этот важный момент.')
  const theme = themeDraft ?? wq.data?.inviteThemeId ?? 0
  /* Чужой номер темы — от старого сценария или испорченного ответа — не
     роняет редактор в ErrorBoundary: берём первую, как и гостевая страница. */
  const th = inviteThemes[theme] ?? inviteThemes[0]!
  const [dress, setDress] = useState<string | null>(null)
  const [dressNote, setDressNote] = useState<string | null>(null)
  /* Палитра по умолчанию подставляется, только когда свадьба пришла и палитры
     у неё нет. До ответа галочка на «d1» выдавала бы за выбор пары то, чего
     сервер не говорил. */
  const dressId = dress ?? (ready(wq) ? (wq.data?.dressCode ?? 'd1') : null)
  const dressText = dressNote ?? wq.data?.dressNote ?? ''
  /* «Сохранено ✓» — пока оформление совпадает с тем, что ушло на сервер: после
     правки текста или темы галочка гаснет, а не висит навсегда (ревью 015). */
  const [savedSnap, setSavedSnap] = useState<string | null>(null)
  const designSnap = JSON.stringify([inviteText, inviteThemes.indexOf(th), dressId ?? 'd1', dressText])
  const saved = savedSnap === designSnap
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /* Ссылки, выданные в этом сеансе: сервер отдаёт их и в списке гостей
     (`inviteUrl`), но список перечитывается после ответа, а копировать
     хочется сразу. */
  const [links, setLinks] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  /* Перевыпуск открытой ссылки — необратимое действие: первое нажатие
     только предупреждает, и предупреждение стоит у конкретного гостя. */
  const [reissueFor, setReissueFor] = useState<string | null>(null)

  /* Гости — с сервера: ссылка именная, и выдаётся она конкретной записи. */
  const gq = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const guestList = gq.data ?? []

  /*
   * Своя роль — из списка свадеб, как на экране команды (ревью RF-09).
   * Оформление (`PATCH /weddings/{id}`) и ссылки (`POST …/invite-link`)
   * сервер принимает только от пары; помощник и координатор открывали полный
   * редактор с «Сохранить оформление» и «Выдать ссылку» у каждого гостя —
   * и получали 403 после нажатия. Им — превью и список гостей без кнопок.
   * Пока роль едет — «Загружаем…», не пришла — причина и «Повторить».
   */
  const mine = useApi(() => listMyWeddings(), [])
  const iAmCouple = (mine.data?.find(w => w.id === weddingId)?.role ?? null) === 'couple'
  const roleKnown = ready(mine) && !!mine.data

  const run = async (id: string, fn: () => Promise<unknown>) => {
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — приглашения живут в ней')); return }
    if (busyId) return // второй запрос, пока идёт первый (Enter, двойной тап) — ревью 015
    setBusyId(id)
    setErr(null)
    try { await fn() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }

  /* Текст и тему сохраняем на сервере: гость открывает приглашение со своего
     устройства, и в localStorage пары заглянуть не может. Уходит номер той
     темы, что показана в превью, — чужой номер с сервера не возвращается ему же. */
  const saveDesign = () => void run('design', async () => {
    await saveInviteDesign(weddingId!, inviteText, inviteThemes.indexOf(th), dressId ?? 'd1', dressText)
    wq.reload()
    setSavedSnap(designSnap)
  })

  /*
   * Ссылка одноразовая и именная. Повторный выпуск гасит прежнюю — и токен
   * гостя вместе с ней: страница гостя перестаёт открываться, а триггер
   * снимает его резерв подарка. Поэтому у гостя, который ссылку уже открыл,
   * стоит не «Выдать ссылку», а «Перевыпустить» с подтверждением словами; у
   * гостя с выданной, но не открытой ссылкой — «Копировать» без запроса
   * (ревью D3-05).
   */
  const issueLink = (guestId: string) => void run(guestId, async () => {
    const res = await guestInviteLink(weddingId!, guestId)
    if (res?.url) setLinks(m => ({ ...m, [guestId]: res.url! }))
    setReissueFor(null)
    gq.reload()
  })

  const copy = (url: string) => {
    copyText(url)
    setCopied(url); setTimeout(() => setCopied(null), 1600)
  }
  return (
    <div className="pb-28">
      <TopBar back title={t('Приглашения')} sub={t('10 сценариев · ссылка · RSVP')} />
      {/* Свадьба — свой запрос: название, город, текст, тема и дресс-код
          приходят из него. Пока он не ответил, редактора нет: редактировать
          умолчания вместо серверного текста и есть та ошибка, которую здесь
          чинили, — «Сохранить» стирало бы то, что гость уже видит. */}
      <AsyncState q={wq} />
      <div className="px-5 mt-3">
        {ready(wq) && (
        <>
        {/* Превью сценария */}
        <div className="card p-6 text-center relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-2" style={{ background: th.accentGrad }} />
          {/*
            * Превью показывает то, что увидит гость, а не мок. Здесь стояли
            * «А♥Т», «Дорогая Марина Ивановна!», имена и город из `lib/data.ts`
            * — пара смотрела на чужую свадьбу. Имя гостя осталось подписью-
            * образцом и названо образцом: у каждого гостя оно своё.
            */}
          <div className="w-[52px] h-[52px] rounded-full mx-auto flex items-center justify-center text-white font-serif-d text-[16px]" style={{ background: th.accentGrad }}>♥</div>
          <p className="font-serif-d italic text-[14px] text-[var(--soft)] mt-4">{t('Имя гостя')}</p>
          <h2 className="font-serif-d text-[26px] mt-2">{wq.data?.title ?? t('Название свадьбы')}</h2>
          <p className="text-[10px] tracking-[.24em] uppercase font-semibold mt-1.5 text-[var(--rose-deep)]">
            {[weddingDate ? formatWeddingDate(weddingDate) : t('дата уточняется'), wq.data?.city?.name].filter(Boolean).join(' · ')}
          </p>
          <p className="text-[11.5px] text-[var(--ink2)] font-light leading-relaxed mt-3">{inviteText}</p>
          {/* Кнопка «Смотреть как гость» убрана: гостевая страница открывается
              по личному токену, и у пары его нет — переход упирался в
              «Нужна ссылка из приглашения». */}
        </div>

        {/* Роль ещё не пришла или не пришла вовсе — на месте редактора
            состояние запроса, а не пустота (R-179). */}
        {weddingId && <AsyncState q={mine} />}
        {roleKnown && !iAmCouple && (
          <p className="text-[12px] text-[var(--soft)] leading-relaxed px-1 mt-4">{t('Оформление и ссылки — у пары')}</p>
        )}

        {iAmCouple && <>
        {/* 10 сценариев */}
        <div className="flex items-baseline justify-between px-1 mt-6 mb-2">
          <h2 className="font-serif-d text-[19px]">{t('Сценарий приглашения')}</h2>
          <span className="text-[10px] text-[var(--soft)]">{t('10 авторских')}</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {inviteThemes.map((x, k) => (
            <button key={x.id} onClick={() => setThemeDraft(k)} className={cn('press rounded-[20px] p-2 text-left bg-[var(--card)]', th === x && 'ring-2 ring-[var(--rose)]')} style={{ boxShadow: 'var(--shadow)' }}>
              <div className="h-[64px] rounded-[14px] flex items-center justify-center text-[22px]" style={{ background: x.overlay }}>{x.emoji}</div>
              <b className="text-[11.5px] block mt-2 px-1">«{t(x.name)}»</b>
              <span className="text-[9px] text-[var(--soft)] block px-1 pb-1 leading-tight">{t(x.desc)}</span>
            </button>
          ))}
        </div>

        {/* Дресс-код и палитра */}
        <div className="card p-4 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Дресс-код и палитра')}</span>
          <div className="space-y-2.5 mt-3">
            {dressPalettes.map(p => (
              <button key={p.id} onClick={() => setDress(p.id)} className={cn('press w-full flex items-center gap-3 rounded-[14px] p-2 text-left', dressId === p.id && 'ring-2 ring-[var(--rose)] bg-[var(--track)]')}>
                <span className="flex -space-x-1.5">
                  {p.colors.map(c => <span key={c} className="w-6 h-6 rounded-full border-2 border-[var(--card)]" style={{ background: c }} />)}
                </span>
                <span className="text-[12px] font-medium flex-1">{t(p.name)}</span>
                {dressId === p.id && <span className="text-[var(--sage-deep)] text-[13px]">✓</span>}
              </button>
            ))}
          </div>
          <input value={dressText} onChange={e => setDressNote(e.target.value)} placeholder={t('Комментарий: например, дамы — без белого')}
            className="w-full bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none mt-3" />
        </div>

        {/* Текст */}
        <div className="card p-4 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Текст приглашения')}</span>
          <textarea value={inviteText} onChange={e => setTextDraft(e.target.value)} rows={3}
            className="w-full mt-2 bg-[var(--bg)] rounded-xl px-4 py-3 text-[12.5px] outline-none leading-relaxed resize-none" />
          <p className="text-[9.5px] text-[var(--soft2)] mt-1.5">{t('Имя гостя подставляется автоматически в начало')}</p>
        </div>
        </>}
        </>
        )}

        {/* Что спросит гостя приглашение, решает не тумблер, а содержимое
            свадьбы. Три переключателя «Придёте с +1? · Предпочтения по еде ·
            Нужен ли трансфер» жили в состоянии экрана и никуда не уходили:
            форма гостя их не читала, а пара думала, что настроила опрос
            (аудит 2026-09-07, блок 5). */}
        <div className="card p-4 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Что спросит приглашение')}</span>
          <p className="text-[11.5px] text-[var(--ink2)] mt-2 leading-relaxed">
            {t('Придёт ли гость, с +1 ли, ограничения по еде и нужен ли трансфер — всегда. Выбор блюда — если составлен опрос, автобус и отель — если добавлены маршруты и блоки.')}
          </p>
          <div className="flex gap-2 mt-3">
            <button onClick={() => nav('/wedding/catering')} className="press flex-1 card-s py-2.5 text-[11.5px] font-semibold">{t('Опрос по меню →')}</button>
            <button onClick={() => nav('/wedding/logistics')} className="press flex-1 card-s py-2.5 text-[11.5px] font-semibold">{t('Трансфер и отели →')}</button>
          </div>
        </div>

        {/* Сохранение оформления: текст и тему видит гость, значит они на
            сервере. Без ответа свадьбы кнопки нет — сохранять было бы нечего,
            кроме умолчаний. Не паре сервер ответит 403 — кнопки нет (RF-09). */}
        {ready(wq) && iAmCouple && (
        <button disabled={busyId === 'design'} onClick={saveDesign} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px] mt-4 flex items-center justify-center gap-2 disabled:opacity-50" style={{ boxShadow: 'var(--shadow-lift)' }}>
          <Check size={15} /> {busyId === 'design' ? t('Сохраняем…') : saved ? t('Оформление сохранено ✓') : t('Сохранить оформление')}
        </button>
        )}

        {/*
          * Именные ссылки вместо «разослать».
          *
          * Здесь стояли счётчик «гостей в рассылке» с кнопками ±, нарисованный
          * QR-квадрат, общая ссылка `tili-tili.ru/i/alina-timur` и кнопка
          * «Разослать приглашения», которая меняла только надпись на экране.
          * Ничего не отправлялось, и ссылки такой не существовало.
          *
          * Рассылку контракт не умеет: SMS и почта не подключены. Зато он
          * выдаёт каждому гостю личную одноразовую ссылку — её пара
          * пересылает сама, любым мессенджером.
          */}
        <div className="card p-5 mt-4">
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--soft)] font-semibold">{t('Именные ссылки')}</span>
          <p className="text-[10.5px] text-[var(--soft)] mt-2 leading-relaxed">
            {t('Каждая ссылка открывается один раз и подставляет имя гостя. Отправьте её сами — так приглашение не разойдётся по чужим чатам.')}
          </p>
          {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-2">{err}</p>}
          <div className="mt-3 space-y-2">
            {!guestList.length && ready(gq) && (
              <p className="text-[12px] text-[var(--soft)] py-2">{t('Список гостей пуст — добавьте гостей, чтобы выдать ссылки')}</p>
            )}
            {guestList.map(g => {
              const id = g.id ?? ''
              /* Выданная и ещё не открытая ссылка приходит в списке гостей —
                 её копируют, а не выпускают заново. */
              const url = links[id] ?? g.inviteUrl ?? null
              const busyHere = busyId === id
              return (
                <div key={g.id} className="flex items-center gap-2">
                  <span className="flex-1 text-[12.5px] truncate">{g.name}</span>
                  {/* Не паре ссылки сервер не отдаёт и выдавать не даёт: только
                      факт, что гость уже открыл свою (RF-09). */}
                  {!iAmCouple ? (
                    g.inviteUrlUsed ? <span className="text-[10.5px] text-[var(--sage-deep)] font-semibold shrink-0">{t('Открыта ✓')}</span> : null
                  ) : url ? (
                    <button onClick={() => copy(url)} className="press text-[11px] font-bold px-3 py-1.5 rounded-full bg-[var(--bg)] flex items-center gap-1.5">
                      {copied === url ? <><Check size={12} className="text-[var(--sage-deep)]" />{t('Скопировано')}</> : <><Copy size={12} />{t('Копировать')}</>}
                    </button>
                  ) : g.inviteUrlUsed ? (
                    reissueFor === id ? (
                      <button disabled={busyHere} onClick={() => issueLink(id)} className="press text-[10.5px] font-bold px-3 py-1.5 rounded-full bg-[var(--rose-deep)] text-[var(--card)] text-left leading-tight disabled:opacity-50">
                        {busyHere ? t('Выдаём…') : t('Точно перевыпустить? Гость потеряет ссылку и резерв подарка')}
                      </button>
                    ) : (
                      <>
                        <span className="text-[10.5px] text-[var(--sage-deep)] font-semibold shrink-0">{t('Открыта ✓')}</span>
                        <span className="text-[10.5px] text-[var(--soft2)]">·</span>
                        <button onClick={() => setReissueFor(id)} className="press text-[11px] font-bold px-3 py-1.5 rounded-full bg-[var(--bg)] text-[var(--rose-deep)]">{t('Перевыпустить')}</button>
                      </>
                    )
                  ) : (
                    <button disabled={busyHere} onClick={() => issueLink(id)} className="press text-[11px] font-bold px-3 py-1.5 rounded-full grad text-[var(--on-grad)] disabled:opacity-50">
                      {busyHere ? t('Выдаём…') : t('Выдать ссылку')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <button onClick={() => nav('/wedding/guests')} className="press mt-4 w-full card-s py-3 text-[12px] font-semibold">{t('К списку гостей →')}</button>
        </div>
      </div>
    </div>
  )
}
