import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Bus, Hotel, Plus, Send, UtensilsCrossed, Copy, Check, Trash2, Users, MapPin, Clock3 } from 'lucide-react'
import { AiTip, Bar, SectionHead, TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { t } from '@/lib/i18n'
import { copyText, pct, plural } from '@/lib/utils'
import { fmt } from '@/lib/money'
import { rub } from '@/lib/money'
import { useStore } from '@/lib/store'
import type { Slot } from '@/lib/types'
import type { components } from '@/lib/api/schema'
import { useApi, explainError } from '@/lib/api/useApi'
import { getBuses, getGuests, getHotels, getMenuPoll } from '@/lib/api/weddingData'
import { addBus, addHotel, deleteBus, deleteHotel, notifyPickup, patchBus, putMenuPoll, remindMenuPoll, type BroadcastResult, type MenuOptionDraft } from '@/lib/api/weddingWrite'
import { shortWeddingDate } from '@/lib/weddingDate'

type BusRoute = components['schemas']['BusRoute']

/*
 * Перевозчик маршрута — сделка из слота «Транспорт» (контракт v0.30.0,
 * фича 006). Предлагаются только живые брони — как сделки для договора в
 * мастере: у кандидата перевозчик ещё не утверждён, и подпись «Автобус №1 ·
 * Такси «Ветер»» у гостей была бы обещанием. Сделку другой категории сервер
 * не привяжет (422 `not_transport`), отменённую — тоже (409 `deal_cancelled`).
 */
const LIVE_DEAL: ReadonlySet<string> = new Set(['booked', 'paid_deposit', 'done'])
const carriers = (slots: Slot[]): Slot[] =>
  slots.filter(s => s.categoryId === 'transport' && !!s.dealId && LIVE_DEAL.has(s.dealState ?? ''))

/* Черновик маршрута — строки полей как они набраны; `dealId` пустой — без перевозчика. */
interface BusDraft { name: string; from: string; time: string; seats: string; dealId: string }
const EMPTY_BUS: BusDraft = { name: '', from: '', time: '', seats: '', dealId: '' }
const draftOf = (b: BusRoute): BusDraft =>
  ({ name: b.name ?? '', from: b.from ?? '', time: b.time ?? '', seats: b.seats != null ? String(b.seats) : '', dealId: b.dealId ?? '' })

/*
 * Поля маршрута — одни на «Добавить автобус» и на «Изменить». Перевозчик —
 * выбор из транспортных сделок мозаики; подсказка «сделок нет» — только по
 * её ответу: без него «нет» было бы утверждением о том, чего не видели.
 */
function BusFields({ draft, onChange, slots, slotsState }: {
  draft: BusDraft
  onChange: (d: BusDraft) => void
  slots: Slot[]
  slotsState: 'idle' | 'loading' | 'ready' | 'error'
}) {
  const set = (patch: Partial<BusDraft>) => onChange({ ...draft, ...patch })
  const deals = carriers(slots)
  return (
    <>
      <input value={draft.name} onChange={e => set({ name: e.target.value })} placeholder={t('Название (Автобус №3)')} aria-label={t('Название маршрута')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
      <input value={draft.from} onChange={e => set({ from: e.target.value })} placeholder={t('Точка сбора')} aria-label={t('Точка сбора')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
      <div className="flex gap-2">
        {/* Время — полем времени, а не строкой: сервер принимает ЧЧ:ММ. */}
        <input value={draft.time} onChange={e => set({ time: e.target.value })} type="time" aria-label={t('Время отправления')} className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none tabular" />
        <input value={draft.seats} onChange={e => set({ seats: e.target.value })} placeholder={t('Мест')} aria-label={t('Мест')} inputMode="numeric" className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
      </div>
      <select value={draft.dealId} onChange={e => set({ dealId: e.target.value })} aria-label={t('Перевозчик')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none">
        <option value="">{t('Без перевозчика')}</option>
        {deals.map(d => <option key={d.dealId} value={d.dealId}>{d.vendor ?? t(d.label)}</option>)}
      </select>
      {!deals.length && slotsState === 'ready' && (
        <p className="text-[10.5px] text-[var(--soft2)] px-1 leading-relaxed">{t('Перевозчик заводится в слоте «Транспорт» — маршрут можно завести и без него')}</p>
      )}
      {!deals.length && slotsState === 'loading' && <p className="text-[10.5px] text-[var(--soft2)] px-1">{t('Загружаем…')}</p>}
      {slotsState === 'error' && <p role="alert" className="text-[10.5px] text-[var(--rose-ink)] px-1 leading-relaxed">{t('Сервер недоступен. Попробуйте позже')}</p>}
    </>
  )
}

/*
 * Итог рассылки словами из ответа 202 (`BroadcastResult`, фича 005): скольким
 * из команды ушло и скольких гостей касается. Число, которого сервер не
 * назвал, — прочерк, а не ноль (R-178). Гостям не доставляется ничего — эту
 * часть подписи каждый экран добавляет своими словами.
 */
const broadcastSummary = (res: BroadcastResult | undefined): string =>
  `${t('Команде ушло:')} ${res?.notified ?? '—'} · ${t('касается гостей:')} ${res?.recipients ?? '—'}`

/* ---------- ЛОГИСТИКА: автобусы + отельный блок ---------- */

/*
 * Маршруты и отельные блоки живут на сервере.
 *
 * Раньше они лежали в `tt_buses` и `tt_hotels` на телефоне того, кто их завёл:
 * второй из пары видел два выдуманных автобуса из мока, а гость — вообще
 * ничего, потому что его браузер этих ключей не знает. Занятые места (`taken`,
 * `booked`) считает сервер атомарно при записи гостя — на клиенте их взять
 * неоткуда и вычислять нельзя: двое жмут «записаться» одновременно.
 *
 * Промокод и срок брони вводит пара — их даёт отель. Прежний экран
 * генерировал код формулой `TILI${1000 + номер * 7}` и подписывал «бронь до
 * 20 мая»: по такому коду в отеле не знают ничего.
 */
export function Logistics() {
  const { weddingId, slots, slotsState } = useStore()
  /*
   * `?deal=` — из карточки транспортной сделки («Добавить маршрут для гостей»,
   * фича 006): форма раскрыта сразу, перевозчик предвыбран. Тот же приём, что
   * `?deal=` у мастера договора. Сервер сам проверит, что сделка транспортная
   * и живая, — экран передаёт выбор как есть.
   */
  const [params] = useSearchParams()
  const preDeal = params.get('deal')
  const [busForm, setBusForm] = useState(() => preDeal !== null)
  const [hotelForm, setHotelForm] = useState(false)
  const [draft, setDraft] = useState<BusDraft>(() => ({ ...EMPTY_BUS, dealId: preDeal ?? '' }))
  const [hn, setHn] = useState(''); const [hr, setHr] = useState(''); const [hp, setHp] = useState('')
  const [hd, setHd] = useState(''); const [hc, setHc] = useState('')
  /* Итог рассылки — словами из ответа сервера, а не галочкой. */
  const [notified, setNotified] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* Удаление маршрута или блока с бронями гостей — необратимое: каскад уносит
     их записи, а сообщить им нечем. Первое нажатие только предупреждает
     (ревью D3-22); пустая строка удаляется сразу. */
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const busesQ = useApi(() => weddingId ? getBuses(weddingId) : Promise.resolve([]), [weddingId])
  const hotelsQ = useApi(() => weddingId ? getHotels(weddingId) : Promise.resolve([]), [weddingId])
  const buses = busesQ.data ?? []
  const hotels = hotelsQ.data ?? []

  const write = async (fn: () => Promise<unknown>) => {
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — логистика живёт в ней')); return }
    setBusy(true)
    setErr(null)
    try { await fn(); busesQ.reload(); hotelsQ.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  }

  const addBusRoute = () => void write(async () => {
    if (!draft.name.trim()) return
    await addBus(weddingId!, draft.name.trim(), draft.from.trim(), draft.time.trim(), Math.max(1, parseInt(draft.seats, 10) || 20), draft.dealId || null)
    setDraft({ ...EMPTY_BUS, dealId: preDeal ?? '' }); setBusForm(false)
  })
  const removeBus = (busId: string) => void write(async () => { await deleteBus(weddingId!, busId); setConfirmDel(null) })

  /*
   * Правка маршрута («Изменить», контракт v0.30.0, фича 006). До этого маршрут
   * можно было только завести и удалить — опечатка во времени стоила записей
   * гостей. Отказ сервера — под «Сохранить» в карточке, а не в общей строке
   * экрана: мест меньше занятых персон — 409 `bus_full`, сделка не из слота
   * «Транспорт» — 422 `not_transport`, отменённая — 409 `deal_cancelled`;
   * форма при этом остаётся с введённым. Снятый перевозчик уходит `null`.
   */
  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<BusDraft>(EMPTY_BUS)
  const [editErr, setEditErr] = useState<string | null>(null)
  const openEdit = (b: BusRoute) => { setEditId(b.id ?? null); setEditDraft(draftOf(b)); setEditErr(null); setConfirmDel(null) }
  const saveBus = (b: BusRoute) => {
    const name = editDraft.name.trim()
    if (!name || !b.id) return
    setEditErr(null)
    void write(async () => {
      try {
        await patchBus(weddingId!, b.id!, {
          name,
          ...(editDraft.from.trim() ? { from: editDraft.from.trim() } : {}),
          ...(editDraft.time ? { time: editDraft.time } : {}),
          /* Пустое или испорченное число мест — оставить как было, а не «1»:
             сервер ответил бы 409 на маршрут, где уже сидят гости. */
          seats: parseInt(editDraft.seats, 10) || (b.seats ?? 1),
          dealId: editDraft.dealId || null,
        })
      } catch (e) { setEditErr(explainError(e)); return }
      setEditId(null)
    })
  }

  const addHotelBlock = () => void write(async () => {
    if (!hn.trim()) return
    // поле «₽/ночь» — рубли, на сервер уходят копейки
    const price = parseInt(hp, 10)
    await addHotel(
      weddingId!,
      hn.trim(),
      Math.max(1, parseInt(hr, 10) || 10),
      price ? rub(price) : undefined,
      hd || undefined,
      hc.trim() || undefined,
    )
    setHn(''); setHr(''); setHp(''); setHd(''); setHc(''); setHotelForm(false)
  })
  const removeHotel = (hotelId: string) => void write(async () => { await deleteHotel(weddingId!, hotelId); setConfirmDel(null) })

  /*
   * Точки сбора: сервер уведомляет команду в приложении и записывает факт
   * рассылки. Гостям не уходит ничего — SMS и почта не подключены, очереди
   * доставки нет. До ревью D3-06 кнопка обещала «Точки сбора поставлены в
   * очередь ✓», и пара считала, что гости всё получили. Говорим то, что
   * сервер сделал: по `notified` и `recipients` из его ответа (`BroadcastResult`,
   * контракт v0.29.0) — скольким из команды ушло и скольких гостей касается.
   */
  const notify = () => void write(async () => {
    setNotified(null)
    const res = await notifyPickup(weddingId!)
    setNotified(res?.debounced
      ? t('Команде уже сообщали меньше минуты назад — повторно не пишем.')
      : `${broadcastSummary(res)} · ${t('гостям пока не доставляется — отправьте точки сбора сами')}`)
  })

  const copy = (code: string) => {
    copyText(code)
    setCopied(code); setTimeout(() => setCopied(null), 1600)
  }

  const totalSeats = buses.reduce((a, b) => a + (b.seats ?? 0), 0)
  const totalTaken = buses.reduce((a, b) => a + (b.taken ?? 0), 0)

  return (
    <div className="pb-28">
      <TopBar back title={t('Логистика гостей')} sub={t('Как все доберутся и где переночуют')} />
      <AsyncState q={busesQ} />
      {err && <p role="alert" className="px-5 mt-3 text-[12px] text-[var(--rose-ink)]">{err}</p>}

      {/* АВТОБУСЫ */}
      {/* «0/0 мест занято» без ответа сервера — не «пусто», а «неизвестно». */}
      <SectionHead title={t('Трансфер для гостей')} sub={ready(busesQ) ? `${totalTaken}/${totalSeats} ${t('мест занято')}` : undefined} />
      <div className="px-5 mt-2 space-y-2.5 stagger">
        <div className="card-s px-4 py-3 text-[11px] text-[var(--soft)] leading-relaxed">
          {t('Гость выбирает автобус в своём приглашении — места считаются сами, обзванивать никого не нужно.')}
        </div>
        {!buses.length && ready(busesQ) && (
          <div className="card p-6 text-center fade-up">
            <span className="w-12 h-12 rounded-2xl bg-[var(--blue)] mx-auto flex items-center justify-center"><Bus size={20} className="text-[var(--ink2)]" /></span>
            <b className="text-[13.5px] block mt-3">{t('Маршрутов пока нет')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Добавьте точку сбора и время — гости запишутся сами прямо в приглашении.')}</p>
          </div>
        )}
        {buses.map(b => (
          <div key={b.id} className="card p-4 fade-up">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-2xl bg-[var(--blue)] flex items-center justify-center shrink-0"><Bus size={18} className="text-[var(--ink2)]" /></span>
              <div className="min-w-0 flex-1">
                <b className="text-[13.5px]">{b.name}</b>
                <p className="text-[11px] text-[var(--soft)] flex items-center gap-1 mt-0.5">
                  {b.from && <><MapPin size={10} /> {b.from}</>}
                  {b.time && <><Clock3 size={10} /> {b.time}</>}
                </p>
                {/* Кто везёт — по `carrier` из ответа (фича 006). «Без перевозчика»
                    только при `dealId: null`: без поля сервер о перевозчике не
                    говорил ничего, и утверждать «без» нельзя. Отменённая сделка
                    обнуляет поле — маршрут остаётся, подпись честно пропадает. */}
                {b.carrier ? (
                  <p className="text-[10.5px] text-[var(--ink2)] mt-0.5 truncate">{t('Перевозчик:')} {b.carrier}</p>
                ) : b.dealId === null ? (
                  <p className="text-[10px] text-[var(--soft2)] mt-0.5">{t('без перевозчика')}</p>
                ) : null}
              </div>
              <span className="text-[11px] font-bold text-[var(--ink2)]">{b.taken}/{b.seats}</span>
              {editId !== b.id && (
                <button disabled={busy} onClick={() => openEdit(b)} className="press text-[10.5px] font-semibold px-2.5 h-8 rounded-full bg-[var(--bg)] text-[var(--ink2)] disabled:opacity-50">{t('Изменить')}</button>
              )}
              {confirmDel === b.id ? (
                <button disabled={busy} onClick={() => removeBus(b.id ?? '')} className="press text-[10.5px] font-bold px-3 py-1.5 rounded-full bg-[var(--rose-deep)] text-[var(--card)] text-left leading-tight disabled:opacity-50">
                  {`${t('Удалить маршрут?')} ${b.taken ?? 0} ${plural(b.taken ?? 0, t('гость потеряет место'), t('гостя потеряют место'), t('гостей потеряют место'))}`}
                </button>
              ) : (
                <button disabled={busy} onClick={() => ((b.taken ?? 0) > 0 ? setConfirmDel(b.id ?? '') : removeBus(b.id ?? ''))} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center text-[var(--soft)] disabled:opacity-50" aria-label={t('Удалить')}><Trash2 size={13} /></button>
              )}
            </div>
            <div className="mt-3"><Bar pct={pct(b.taken, b.seats)} /></div>
            {(b.seats ?? 0) - (b.taken ?? 0) <= 5 && <p className="text-[10px] text-[var(--rose-deep)] font-semibold mt-2">{t('Осталось мало мест — добавьте ещё один автобус')}</p>}
            {editId === b.id && (
              <div className="mt-3 space-y-2">
                <BusFields draft={editDraft} onChange={setEditDraft} slots={slots} slotsState={slotsState} />
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setEditId(null)} className="press flex-1 h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Отмена')}</button>
                  <button disabled={busy || !editDraft.name.trim()} onClick={() => saveBus(b)} className="press flex-1 h-11 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{busy ? t('Сохраняем…') : t('Сохранить')}</button>
                </div>
                {editErr && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] px-1 leading-relaxed">{editErr}</p>}
              </div>
            )}
          </div>
        ))}
        {busForm ? (
          <div className="card p-4 space-y-2 fade-up">
            <BusFields draft={draft} onChange={setDraft} slots={slots} slotsState={slotsState} />
            <div className="flex gap-2 pt-1">
              <button onClick={() => setBusForm(false)} className="press flex-1 h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Отмена')}</button>
              <button disabled={busy} onClick={addBusRoute} className="press flex-1 h-11 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{t('Добавить автобус')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setBusForm(true)} className="press w-full card-s py-3.5 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить автобус')}</button>
        )}
        {/* Кнопка названа по тому, что делает сервер: уведомляет команду.
            Гостям с этого экрана не уходит ничего (см. `notify`). */}
        <button disabled={busy || !buses.length} onClick={notify} className="press w-full h-[46px] rounded-full bg-[var(--ink)] text-[var(--bg)] text-[12.5px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
          <Send size={14} />{t('Сообщить команде о точках сбора')}
        </button>
        {notified && <p className="text-[11px] text-[var(--soft)] px-1 leading-relaxed">{notified}</p>}
        <p className="text-[10px] text-[var(--soft2)] px-1 leading-relaxed">{t('Гостям точки сбора не рассылаются — перешлите их сами; команда получит уведомление в приложении.')}</p>
      </div>

      {/* ОТЕЛЬНЫЙ БЛОК */}
      <SectionHead title={t('Отельный блок')} sub={t('для иногородних гостей')} />
      <div className="px-5 mt-2 space-y-2.5 stagger">
        {/* Отели — свой запрос: отказ на нём раньше не показывался вовсе. */}
        <AsyncState q={hotelsQ} />
        <div className="card-s px-4 py-3 text-[11px] text-[var(--soft)] leading-relaxed">
          {t('Договоритесь с отелем о блоке номеров со скидкой и внесите его сюда — гости займут номера прямо в приглашении, а вы увидите, сколько осталось.')}
        </div>
        {!hotels.length && ready(hotelsQ) && (
          <div className="card p-6 text-center fade-up">
            <span className="w-12 h-12 rounded-2xl bg-[var(--lav)] mx-auto flex items-center justify-center"><Hotel size={20} className="text-[var(--ink2)]" /></span>
            <b className="text-[13.5px] block mt-3">{t('Отельных блоков пока нет')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Договоритесь с отелем о скидке для гостей и добавьте блок — за невыкупленные номера платить не придётся.')}</p>
          </div>
        )}
        {hotels.map(h => (
          <div key={h.id} className="card p-4 fade-up">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-2xl bg-[var(--lav)] flex items-center justify-center shrink-0"><Hotel size={18} className="text-[var(--ink2)]" /></span>
              <div className="min-w-0 flex-1">
                <b className="text-[13.5px]">{h.name}</b>
                <p className="text-[11px] text-[var(--soft)] mt-0.5">
                  {[h.price?.amount != null ? `${fmt(h.price.amount)}${t('/ночь')}` : '', h.deadline ? `${t('бронь до ')}${shortWeddingDate(h.deadline)}` : ''].filter(Boolean).join(' · ')}
                </p>
              </div>
              {confirmDel === h.id ? (
                <button disabled={busy} onClick={() => removeHotel(h.id ?? '')} className="press text-[10.5px] font-bold px-3 py-1.5 rounded-full bg-[var(--rose-deep)] text-[var(--card)] text-left leading-tight disabled:opacity-50">
                  {`${t('Удалить блок?')} ${h.booked ?? 0} ${plural(h.booked ?? 0, t('гость потеряет номер'), t('гостя потеряют номер'), t('гостей потеряют номер'))}`}
                </button>
              ) : (
                <button disabled={busy} onClick={() => ((h.booked ?? 0) > 0 ? setConfirmDel(h.id ?? '') : removeHotel(h.id ?? ''))} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center text-[var(--soft)] disabled:opacity-50" aria-label={t('Удалить')}><Trash2 size={13} /></button>
              )}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1"><Bar pct={pct(h.booked, h.rooms)} /></div>
              <span className="text-[11px] font-bold text-[var(--ink2)]">{h.booked}/{h.rooms} {t('номеров')}</span>
            </div>
            {/* Промокод показываем только когда он есть: генерировать его на
                клиенте бессмысленно — в отеле о таком коде не знают. */}
            {h.promo && (
              <button onClick={() => copy(h.promo!)} className="press mt-3 w-full h-10 rounded-xl bg-[var(--bg)] text-[12px] font-bold tracking-widest flex items-center justify-center gap-2">
                {copied === h.promo ? <><Check size={13} className="text-[var(--sage-deep)]" />{t('Скопировано')}</> : <><Copy size={13} />{t('Промокод: ')}{h.promo}</>}
              </button>
            )}
          </div>
        ))}
        {hotelForm ? (
          <div className="card p-4 space-y-2 fade-up">
            <input value={hn} onChange={e => setHn(e.target.value)} placeholder={t('Название отеля')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <div className="flex gap-2">
              <input value={hr} onChange={e => setHr(e.target.value)} placeholder={t('Номеров')} inputMode="numeric" className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
              <input value={hp} onChange={e => setHp(e.target.value)} placeholder={t('₽/ночь')} inputMode="numeric" className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            </div>
            <div className="flex gap-2">
              <input value={hd} onChange={e => setHd(e.target.value)} type="date" aria-label={t('Бронь до')} className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
              <input value={hc} onChange={e => setHc(e.target.value)} placeholder={t('Промокод отеля')} className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setHotelForm(false)} className="press flex-1 h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Отмена')}</button>
              <button disabled={busy} onClick={addHotelBlock} className="press flex-1 h-11 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{t('Добавить отель')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setHotelForm(true)} className="press w-full card-s py-3.5 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить отельный блок')}</button>
        )}
        {/* Подсказка про «3 из 6 номеров» убрана: числа в ней стояли
            константами и не сходились ни с одним блоком. */}
      </div>
    </div>
  )
}

/* ---------- КЕЙТЕРИНГ: опрос гостей по меню ---------- */

export function Catering() {
  const { weddingId } = useStore()
  const [adding, setAdding] = useState(false)
  const [optName, setOptName] = useState('')
  /* Итог напоминания — словами из ответа сервера (см. `remind`). */
  const [reminded, setReminded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /*
   * Опрос живёт на сервере вместе с голосами гостей.
   *
   * Раньше он лежал в `tt_menu_poll` на телефоне пары с тремя выдуманными
   * блюдами и готовыми голосами (4 / 2 / 1). Гость голосовал у себя, пара
   * видела свои цифры — два разных ответа на один вопрос, и оба неверные.
   */
  const q = useApi(() => weddingId ? getMenuPoll(weddingId) : Promise.resolve(null), [weddingId])
  const poll = q.data
  const options = poll?.options ?? []
  const answered = options.reduce((a, o) => a + (o.votes ?? 0), 0)

  /*
   * Порции и голоса — разные единицы, и сравнивать их нельзя.
   *
   * `expectedPortions` сервер считает по персонам: запись с «+1» это двое.
   * Голос же один на запись гостя. «1 из 2 ответили» при одном госте с парой
   * читается как «половина молчит», хотя ответили все. Поэтому голоса
   * сравниваем с числом гостей, а порции показываем отдельной строкой — их
   * ждёт кейтеринг.
   */
  const portions = poll?.expectedPortions ?? 0
  const gq = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const attending = (gq.data ?? []).filter(g => g.status === 'yes').length
  const pending = Math.max(0, attending - answered)

  const write = async (fn: () => Promise<unknown>) => {
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — опрос живёт в ней')); return }
    setBusy(true)
    setErr(null)
    try { await fn(); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  }

  /*
   * Последний опрос, который сервер принял, и ответ, что был на экране в тот
   * момент. Пока свежий ответ его не заменил — или пропал, если перечитывание
   * сорвалось, — следующий PUT строится отсюда: опрос на экране в это окно
   * прежний, и PUT из него удалял только что добавленный вариант, а из пустого
   * экрана — все варианты вместе с голосами (ревью R3-02).
   */
  const [sent, setSent] = useState<{ weddingId: string; question: string; options: MenuOptionDraft[]; shown: typeof poll } | null>(null)
  const accepted = sent && sent.weddingId === weddingId && (sent.shown === poll || poll === null) ? sent : null

  /* Опрос заменяется целиком: отдельного пути «добавить вариант» нет, и
     отправлять надо все прежние варианты — пропущенный сервер поймёт как
     удалённый вместе с голосами за него. */
  const addOption = () => void write(async () => {
    if (!optName.trim()) return
    const question = accepted ? accepted.question : (poll?.question || t('Что приготовить на горячее?'))
    const kept = accepted ? accepted.options : options.map(o => ({ id: o.id, name: o.name ?? '' }))
    const next = [...kept, { name: optName.trim() }]
    await putMenuPoll(weddingId!, question, next)
    setSent({ weddingId: weddingId!, question, options: next, shown: poll })
    setOptName(''); setAdding(false)
  })

  /*
   * «Напомнить» уведомляет команду в приложении — гостям не уходит ничего:
   * SMS и почты нет, очереди доставки тоже. До ревью D3-06 кнопка отвечала
   * «В очереди ✓», обещая доставку, которой нет. Говорим по ответу сервера.
   */
  const remind = () => void write(async () => {
    setReminded(null)
    const res = await remindMenuPoll(weddingId!)
    setReminded(res?.debounced
      ? t('Команде уже сообщали меньше минуты назад — повторно не пишем.')
      : `${broadcastSummary(res)} · ${t('гостям пока не доставляется — напомните сами')}`)
  })

  return (
    <div className="pb-28">
      <TopBar back title={t('Меню и кейтеринг')} sub={t('Опрос гостей · сводка для площадки')} />
      <AsyncState q={q} />
      {err && <p role="alert" className="px-5 mt-3 text-[12px] text-[var(--rose-ink)]">{err}</p>}

      <div className="px-5 mt-3 card p-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-2xl bg-[var(--honey)] flex items-center justify-center shrink-0"><UtensilsCrossed size={18} className="text-[var(--ink2)]" /></span>
          <div className="flex-1">
            {/* «Опрос ещё не составлен» и «0 из 0 ответили» — утверждения об
                опросе, а без ответа сервера об опросе неизвестно ничего. */}
            <b className="text-[13.5px]">{ready(q) ? (poll?.question || t('Опрос ещё не составлен')) : t('Опрос гостей')}</b>
            <p className="text-[11px] text-[var(--soft)] mt-0.5">{ready(q) && ready(gq) ? `${answered} ${t('из')} ${attending} ${t('ответили · опрос в приглашении')}` : '—'}</p>
          </div>
        </div>
        <div className="mt-4 space-y-2.5">
          {options.map(o => (
            <div key={o.id} className="flex items-center gap-3">
              {o.icon && <span className="text-[18px] w-7 text-center">{o.icon}</span>}
              <div className="flex-1 min-w-0">
                <div className="flex justify-between text-[11.5px] mb-1">
                  <span className="font-medium truncate">{o.name}</span>
                  <b>{o.votes ?? 0}</b>
                </div>
                <Bar pct={pct(o.votes, answered)} />
              </div>
            </div>
          ))}
        </div>
        {adding ? (
          <div className="mt-4 flex gap-2">
            <input value={optName} onChange={e => setOptName(e.target.value)} placeholder={t('Название блюда')} className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            {/* Закрыта и пока опрос перечитывается: PUT из прежнего опроса
                удалил бы только что добавленный вариант. И когда опроса нет
                вовсе (первый GET упал, принятой копии нет): PUT из пустого
                экрана стёр бы варианты вместе с голосами. */}
            <button disabled={busy || q.refreshing || (poll === null && !accepted)} onClick={addOption} className="press h-11 px-5 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{t('Добавить')}</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="press mt-4 w-full card-s py-3 text-[12px] font-semibold flex items-center justify-center gap-2"><Plus size={14} />{t('Добавить вариант блюда')}</button>
        )}
      </div>

      <div className="px-5 mt-3 space-y-2.5">
        {pending > 0 && (
          <div className="card-s px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-[var(--peach)] flex items-center justify-center shrink-0"><Users size={15} className="text-[var(--ink2)]" /></span>
              {/* Глагол согласуется с числом вместе с существительным: «1 гость ещё не выбрали» — ошибка. */}
              <p className="text-[11.5px] flex-1"><b>{pending}</b> {plural(pending, t('гость ещё не выбрал блюдо'), t('гостя ещё не выбрали блюдо'), t('гостей ещё не выбрали блюдо'))}</p>
              {/* Кнопка уведомляет команду — и называется по тому, что делает
                  сервер; итог стоит под строкой словами из его ответа. */}
              <button disabled={busy} onClick={remind} className="press text-[11px] font-bold text-[var(--rose-deep)] shrink-0 disabled:opacity-50">{t('Напомнить')}</button>
            </div>
            {reminded && <p className="text-[10.5px] text-[var(--soft)] mt-2 leading-relaxed">{reminded}</p>}
          </div>
        )}
        {options.length > 0 && (
          <div className="card p-4">
            <b className="text-[13px]">{t('Сводка для кейтеринга')}</b>
            <div className="mt-2.5 space-y-1.5 text-[12px] text-[var(--soft)]">
              {options.map(o => <p key={o.id}>{o.icon} {o.name} — <b className="text-[var(--ink)]">{o.votes ?? 0}</b></p>)}
              {/* Строка «Аллергии — 2 (орехи, лактоза)» убрана: числа стояли
                  константами. Ограничения по еде гость указывает в своём RSVP,
                  и они видны в списке гостей. */}
            </div>
            {/* Плашка «Автоматически уйдёт кейтерингу 31 мая» убрана: такой
                рассылки нет, а дата в ней не зависела от даты свадьбы. */}
            {/* Порции — то, что нужно кейтерингу: гость с «+1» это две тарелки.
                Считает их сервер, здесь только показ. */}
            <p className="text-[12px] mt-2.5">{t('Готовить на')} <b>{portions}</b> {plural(portions, t('персону'), t('персоны'), t('персон'))}</p>
            <p className="text-[10.5px] text-[var(--soft2)] mt-3 leading-relaxed">{t('Цифры обновляются по ответам гостей — передайте их кейтерингу сами.')}</p>
          </div>
        )}
        <AiTip text={t('Опрос встроен в приглашения: гость отвечает на RSVP и сразу выбирает горячее — один тап, без регистрации.')} />
      </div>
    </div>
  )
}
