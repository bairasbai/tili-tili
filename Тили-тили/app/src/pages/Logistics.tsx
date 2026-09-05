import { useState } from 'react'
import { Bus, Hotel, Plus, Send, UtensilsCrossed, Copy, Check, Trash2, Users, MapPin, Clock3 } from 'lucide-react'
import { AiTip, Bar, SectionHead, TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { t } from '@/lib/i18n'
import { copyText, pct, plural } from '@/lib/utils'
import { fmt } from '@/lib/data'
import { rub } from '@/lib/money'
import { useStore } from '@/lib/store'
import { useApi, explainError } from '@/lib/api/useApi'
import { getBuses, getGuests, getHotels, getMenuPoll } from '@/lib/api/weddingData'
import { addBus, addHotel, deleteBus, deleteHotel, notifyPickup, putMenuPoll, remindMenuPoll } from '@/lib/api/weddingWrite'
import { shortWeddingDate } from '@/lib/weddingDate'


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
  const { weddingId } = useStore()
  const [busForm, setBusForm] = useState(false)
  const [hotelForm, setHotelForm] = useState(false)
  const [bn, setBn] = useState(''); const [bf, setBf] = useState(''); const [bt, setBt] = useState(''); const [bs, setBs] = useState('')
  const [hn, setHn] = useState(''); const [hr, setHr] = useState(''); const [hp, setHp] = useState('')
  const [hd, setHd] = useState(''); const [hc, setHc] = useState('')
  const [notified, setNotified] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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
    if (!bn.trim()) return
    await addBus(weddingId!, bn.trim(), bf.trim(), bt.trim(), Math.max(1, parseInt(bs, 10) || 20))
    setBn(''); setBf(''); setBt(''); setBs(''); setBusForm(false)
  })
  const removeBus = (busId: string) => void write(() => deleteBus(weddingId!, busId))

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
  const removeHotel = (hotelId: string) => void write(() => deleteHotel(weddingId!, hotelId))

  const notify = () => void write(async () => {
    await notifyPickup(weddingId!)
    setNotified(true)
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
      <SectionHead title={t('Трансфер для гостей')} sub={`${totalTaken}/${totalSeats} ${t('мест занято')}`} />
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
              </div>
              <span className="text-[11px] font-bold text-[var(--ink2)]">{b.taken}/{b.seats}</span>
              <button disabled={busy} onClick={() => removeBus(b.id ?? '')} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center text-[var(--soft)] disabled:opacity-50" aria-label={t('Удалить')}><Trash2 size={13} /></button>
            </div>
            <div className="mt-3"><Bar pct={pct(b.taken, b.seats)} /></div>
            {(b.seats ?? 0) - (b.taken ?? 0) <= 5 && <p className="text-[10px] text-[var(--rose-deep)] font-semibold mt-2">{t('Осталось мало мест — добавьте ещё один автобус')}</p>}
          </div>
        ))}
        {busForm ? (
          <div className="card p-4 space-y-2 fade-up">
            <input value={bn} onChange={e => setBn(e.target.value)} placeholder={t('Название (Автобус №3)')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <input value={bf} onChange={e => setBf(e.target.value)} placeholder={t('Точка сбора')} className="w-full h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            <div className="flex gap-2">
              {/* Время — полем времени, а не строкой: сервер принимает ЧЧ:ММ. */}
              <input value={bt} onChange={e => setBt(e.target.value)} type="time" aria-label={t('Время отправления')} className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none tabular" />
              <input value={bs} onChange={e => setBs(e.target.value)} placeholder={t('Мест')} inputMode="numeric" className="flex-1 h-11 px-4 rounded-xl bg-[var(--bg)] text-[13px] outline-none" />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setBusForm(false)} className="press flex-1 h-11 rounded-full bg-[var(--bg)] text-[12px] font-semibold">{t('Отмена')}</button>
              <button disabled={busy} onClick={addBusRoute} className="press flex-1 h-11 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{t('Добавить автобус')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setBusForm(true)} className="press w-full card-s py-3.5 text-[12.5px] font-semibold flex items-center justify-center gap-2"><Plus size={15} />{t('Добавить автобус')}</button>
        )}
        {/* Рассылка идёт очередью: сервер отвечает «принято», а не «доставлено». */}
        <button disabled={busy || !buses.length} onClick={notify} className="press w-full h-[46px] rounded-full bg-[var(--ink)] text-[var(--bg)] text-[12.5px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
          <Send size={14} />{notified ? t('Точки сбора поставлены в очередь ✓') : t('Отправить гостям точки сбора')}
        </button>
      </div>

      {/* ОТЕЛЬНЫЙ БЛОК */}
      <SectionHead title={t('Отельный блок')} sub={t('для иногородних гостей')} />
      <div className="px-5 mt-2 space-y-2.5 stagger">
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
              <button disabled={busy} onClick={() => removeHotel(h.id ?? '')} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center text-[var(--soft)] disabled:opacity-50" aria-label={t('Удалить')}><Trash2 size={13} /></button>
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
  const [reminded, setReminded] = useState(false)
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

  /* Опрос заменяется целиком: отдельного пути «добавить вариант» нет, и
     отправлять надо все прежние варианты — пропущенный сервер поймёт как
     удалённый вместе с голосами за него. */
  const addOption = () => void write(async () => {
    if (!optName.trim()) return
    await putMenuPoll(
      weddingId!,
      poll?.question || t('Что приготовить на горячее?'),
      [...options.map(o => ({ id: o.id, name: o.name ?? '' })), { name: optName.trim() }],
    )
    setOptName(''); setAdding(false)
  })

  const remind = () => void write(async () => {
    await remindMenuPoll(weddingId!)
    setReminded(true)
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
            <b className="text-[13.5px]">{poll?.question || t('Опрос ещё не составлен')}</b>
            <p className="text-[11px] text-[var(--soft)] mt-0.5">{answered} {t('из')} {attending} {t('ответили · опрос в приглашении')}</p>
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
            <button disabled={busy} onClick={addOption} className="press h-11 px-5 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">{t('Добавить')}</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="press mt-4 w-full card-s py-3 text-[12px] font-semibold flex items-center justify-center gap-2"><Plus size={14} />{t('Добавить вариант блюда')}</button>
        )}
      </div>

      <div className="px-5 mt-3 space-y-2.5">
        {pending > 0 && (
          <div className="card-s px-4 py-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-[var(--peach)] flex items-center justify-center shrink-0"><Users size={15} className="text-[var(--ink2)]" /></span>
            <p className="text-[11.5px] flex-1"><b>{pending}</b> {plural(pending, t('гость'), t('гостя'), t('гостей'))} {t('ещё не выбрали блюдо')}</p>
            <button disabled={busy} onClick={remind} className="press text-[11px] font-bold text-[var(--rose-deep)] shrink-0 disabled:opacity-50">{reminded ? t('Напомнили ✓') : t('Напомнить')}</button>
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
