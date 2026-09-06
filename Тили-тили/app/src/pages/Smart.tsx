import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ChevronLeft, CloudRain, Zap, Heart } from 'lucide-react'

import { useStore } from '@/lib/store'
import { TopBar, AiTip, Bar } from '@/components/chrome'
import { explainError, useApi } from '@/lib/api/useApi'
import { AsyncState, ready } from '@/components/AsyncState'
import { getGuests, getPlanB, getTimeline, getWedding } from '@/lib/api/weddingData'
import { getAlbum } from '@/lib/api/gifts'
import { getGuestReviews, sendCoupleReview } from '@/lib/api/reviews'
import { activatePlanB, setTaskDone, shiftTimeline } from '@/lib/api/weddingWrite'
import { formatWeddingDate } from '@/lib/weddingDate'
import { getAvailability, getCategories, getFavorites, getVendors } from '@/lib/api/catalog'
import { cn, goBack, plural } from '@/lib/utils'
import { chatRouteForVendor, dayChatRoute, teamChatRoute, tillyChatRoute } from '@/lib/api/chats'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'

/*
 * ИИ-координатор «Тиль».
 *
 * Экран был имитацией разговора. Переписка лежала в `tt_assistant`, «Тиль»
 * отвечала тремя ветками `if` по подстрокам: на «алкогол» — норма спиртного
 * на 80 гостей, на «забыл» — «Проверил проект: пустые слоты — DJ, декоратор,
 * транспорт, платье, кольца. Ближайший дедлайн — приглашения до 1 марта»,
 * на всё остальное — «Принято! Записал в план». Ни проекта, ни слотов, ни
 * дедлайнов она не читала: числа были написаны в коде. В шапке стояло
 * «42/50 сообщений сегодня» — счётчика не существовало. Точки «печатает…»
 * шли по таймеру на 900 мс.
 *
 * Разговор с Тиль — обычный чат свадьбы (`kind: tilly`), он заводится вместе
 * со свадьбой. Модели за ним пока нет, и сервер отвечает честно: вопрос
 * сохранён, ответ придёт, когда помощник заработает. Это и есть правда, а
 * выдуманный совет про 0,5 л игристого на человека пара приняла бы за расчёт
 * по своей свадьбе.
 *
 * Экран остаётся адресом `/assistant`: на него ведут подсказка на главной,
 * пустой поиск и уведомления. Он открывает настоящую переписку.
 */
export function Assistant() {
  const nav = useNavigate()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void tillyChatRoute()
      .then(route => { if (alive) nav(route, { replace: true }) })
      .catch(e => { if (alive) setErr(explainError(e)) })
    return () => { alive = false }
  }, [nav])

  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => goBack(x => nav(x), (to, o) => nav(to, o))} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}><ChevronLeft size={17} /></button>
        <div className="w-[38px] h-[38px] rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[15px]">✦</div>
        <div className="flex-1"><b className="text-[14px]">{t('Тиль')}</b></div>
      </div>
      <div className="flex-1 flex items-center justify-center px-8 text-center">
        {err
          ? <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed">{err}</p>
          : <p className="text-[12px] text-[var(--soft)]">{t('Открываем переписку…')}</p>}
      </div>
    </div>
  )
}

/*
 * Сравнение кандидатов.
 *
 * Экран сравнивал три подрядчика из `lib/data.ts` — фотографа, видеографа и
 * площадку — под подписью «3 кандидата · категория «Фотограф»», приписывал всем
 * «Свободен 14.06 ✓ Да» и советовал первого как «лучшее соотношение цены и
 * рейтинга». Кнопка «Выбрать» отправляла на сервер имя подрядчика там, где
 * нужен идентификатор: запрос отваливался с 422, ошибка не всплывала нигде, а
 * экран ставил галочку «✓ В команде» и уводил на мозаику. Ничего не
 * бронировалось.
 *
 * Теперь кандидаты приходят с сервера, а «Выбрать» открывает анкету: цена
 * сделки зависит от пакета, и придумывать её на экране сравнения нельзя.
 */
export function Compare() {
  const nav = useNavigate()
  const { city, weddingDate, favorites } = useStore()
  const [params] = useSearchParams()
  const catId = params.get('cat')

  const cats = useApi(() => getCategories(), [])
  /* Категория задана — сравниваем её выдачу. Нет — избранное: это и есть
     короткий список, который пара сама себе отобрала. */
  const q = useApi(
    () => catId
      ? getVendors({ categoryId: catId, city, limit: 3 }).then(r => r?.items ?? [])
      : getFavorites().then(list => (list ?? []).slice(0, 3)),
    [catId, city, favorites.length],
  )
  const list = q.data ?? []
  const catTitle = (cats.data ?? []).find(c => c.id === catId)?.title

  /*
   * Занятость спрашиваем по каждому кандидату отдельно: общего пути «кто
   * свободен в этот день» в контракте нет. Без даты свадьбы строки нет вовсе —
   * «свободен» без дня ничего не значит.
   */
  const month = (weddingDate ?? '').slice(0, 7)
  const free = useApi(
    async () => {
      if (!weddingDate || !list.length) return {} as Record<string, boolean>
      const pairs = await Promise.all(list.map(async v => {
        try {
          const a = await getAvailability(v.id ?? '', month)
          return [v.id ?? '', !(a?.busyDates ?? []).includes(weddingDate)] as const
        } catch {
          /* Календарь одного подрядчика не должен ронять сравнение остальных. */
          return [v.id ?? '', null] as const
        }
      }))
      return Object.fromEntries(pairs) as Record<string, boolean | null>
    },
    [weddingDate, month, list.map(v => v.id).join(',')],
  )

  const rows: [string, (v: (typeof list)[number]) => string][] = [
    [t('Цена «от»'), v => (v.priceFrom?.amount != null ? fmt(v.priceFrom.amount) : '—')],
    [t('Рейтинг'), v => (v.reviewsCount ? `★ ${v.rating} · ${v.reviewsCount}${t(' отзывов')}` : t('Новый'))],
    ...(weddingDate
      ? ([[t('Свободен на вашу дату'), v => {
          const f = free.data?.[v.id ?? '']
          return f === undefined || f === null ? '…' : f ? t('✓ Да') : t('✕ Занят')
        }]] as [string, (v: (typeof list)[number]) => string][])
      : []),
    [t('Видео-визитка'), v => (v.hasVideo ? t('▶ Есть') : '—')],
    [t('Проверен'), v => (v.verified ? t('✓ Да') : '—')],
  ]

  if (!list.length) {
    return (
      <div className="pb-28">
        <TopBar back title={t('Сравнение')} sub={catTitle ?? t('Избранное')} />
        <AsyncState q={q} />
        {ready(q) && (
          <div className="px-5 mt-8 text-center">
            <p className="text-[12.5px] text-[var(--soft)] leading-relaxed">
              {catId ? t('В этой категории пока некого сравнивать') : t('Добавьте подрядчиков в избранное — здесь они встанут рядом')}
            </p>
            <button onClick={() => nav(catId ? `/search/${catId}` : '/search')} className="press mt-4 px-5 h-[42px] rounded-full grad text-[var(--on-grad)] text-[12.5px] font-semibold">{t('Открыть каталог')}</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="pb-28">
      <TopBar back title={t('Сравнение')} sub={ready(q) ? `${list.length} ${plural(list.length, t('кандидат'), t('кандидата'), t('кандидатов'))}${catTitle ? ` · ${catTitle}` : ''}` : catTitle ?? undefined} />
      <AsyncState q={q} />
      <div className="px-5 mt-3 overflow-x-auto no-scrollbar">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr>
              <td className="w-[110px]" />
              {list.map(v => (
                <td key={v.id} className="p-1.5 align-top">
                  {/* Плашки «Рекомендуем» здесь нет: она вешалась на первого в
                      списке и означала лишь порядок выдачи. */}
                  <div className="card-s p-3 text-center">
                    <span className="text-[24px]">{(cats.data ?? []).find(c => c.id === v.categoryId)?.icon ?? '📋'}</span>
                    <b className="font-serif-d text-[13px] block mt-1.5 leading-tight">{v.name}</b>
                  </div>
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, fn]) => (
              <tr key={label}>
                <td className="p-1.5 text-[11px] text-[var(--soft)] font-medium">{label}</td>
                {list.map(v => <td key={v.id} className="p-1.5"><div className="bg-[var(--card)] rounded-xl px-2.5 py-2.5 text-[11.5px] text-center font-medium" style={{ boxShadow: 'var(--shadow)' }}>{fn(v)}</div></td>)}
              </tr>
            ))}
            <tr>
              <td />
              {list.map(v => (
                <td key={v.id} className="p-1.5">
                  {/* Ведём в анкету, а не бронируем отсюда: цена сделки зависит
                      от выбранного пакета, а в выдаче есть только «от». */}
                  <button onClick={() => nav(`/vendor/${v.id}`)} className="press w-full h-[40px] rounded-full text-[11px] font-bold grad text-[var(--on-grad)]">
                    {t('Открыть анкету')}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/*
 * День X — тёмный режим пары в день свадьбы.
 *
 * Экран был выдуман целиком: «14 июня · День X» в заголовке, «СЕЙЧАС ·
 * Фотосессия · до 16:30 · парк у усадьбы», тайминг из `lib/data.ts`, четыре
 * подрядчика со статусами «на месте» и «едет · 20 мин» и четыре телефона
 * `+7 000 000-00-00`. Кнопка «+15 мин задержка» копила число в `tt_dayx`
 * браузера, а «План Б» переключал там же тумблер: у пары всё менялось, а
 * команда об этом не узнавала.
 *
 * Теперь тайминг приходит с сервера, сдвиг уходит в `POST …/timeline/shift`
 * и рассылается команде и гостям, план Б — в `POST …/planb/activate`.
 * Статусов подрядчиков («едет», «на месте») в контракте нет вовсе, и
 * рисовать их нельзя: пара приняла бы выдумку за факт в день, когда цена
 * ошибки максимальна.
 */
export function DayX() {
  const nav = useNavigate()
  const { weddingId, slots } = useStore()
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirmPlanB, setConfirmPlanB] = useState(false)
  // Время снимаем один раз за отрисовку: в теле компонента его брать нельзя (R-04).
  const [now] = useState(() => new Date())

  const w = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const q = useApi(() => weddingId ? getTimeline(weddingId) : Promise.resolve([]), [weddingId, tick])
  const events = q.data ?? []
  /* План Б спрашиваем и здесь. Без этого день X предлагал «Активировать» уже
     включённый сценарий, а экран «План Б» рядом писал «активирован»: два
     экрана отвечали на один вопрос по-разному, и второе нажатие разослало бы
     команде и гостям повторную рассылку. */
  const pb = useApi(() => weddingId ? getPlanB(weddingId) : Promise.resolve(null), [weddingId, tick])
  const planBOn = !!pb.data?.activatedAt

  /* «Сейчас» — это блок, который уже начался и ещё не сменился следующим.
     Раньше здесь стояла «Фотосессия до 16:30» независимо от времени суток. */
  const started = events.filter(e => e.startsAt && new Date(e.startsAt) <= now)
  const current = started[started.length - 1]
  const next = events.find(e => e.startsAt && new Date(e.startsAt) > now)

  const team = slots.filter(s => s.vendor && (s.dealState === 'booked' || s.dealState === 'paid_deposit' || s.dealState === 'done'))

  const act = (name: string, fn: () => Promise<unknown>) => void (async () => {
    if (!weddingId) return
    setBusy(name)
    setErr(null)
    try { await fn(); setTick(n => n + 1) } catch (e) { setErr(explainError(e)) } finally { setBusy(null) }
  })()

  const time = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div className="min-h-dvh pb-10" style={{ background: 'linear-gradient(180deg,#1E1A16,#0E0C0A)', color: '#EFE9DF' }}>
      <div className="px-5 pt-7 flex items-center justify-between">
        <button onClick={() => goBack(x => nav(x), (to, o) => nav(to, o))} className="press w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#2A2520' }} aria-label={t('Назад')}><ChevronLeft size={18} /></button>
        <div className="text-center">
          <b className="font-serif-d text-[19px]">{w.data?.date ? formatWeddingDate(w.data.date) : t('День X')}</b>
          <p className="text-[9.5px] tracking-[.2em] font-bold" style={{ color: '#C9A96A' }}>{t('РЕЖИМ ДНЯ СВАДЬБЫ')}</p>
        </div>
        <div className="w-10" />
      </div>

      <div className="px-5 mt-5">
        <div className="rounded-[26px] p-5" style={{ background: '#2A2520' }}>
          {current ? (
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <span className="text-[9px] tracking-[.2em] font-bold" style={{ color: '#C9A96A' }}>{t('СЕЙЧАС')}</span>
                <b className="font-serif-d text-[21px] block mt-1 truncate">{current.name}</b>
                <p className="text-[11px] opacity-60 mt-0.5">
                  {time(current.startsAt)}{next ? ` · ${t('дальше')} ${time(next.startsAt)} · ${next.name}` : ''}
                </p>
              </div>
              <span className="text-[10px] font-bold px-3 py-1.5 rounded-full shrink-0" style={{ background: '#C4705A' }}>● LIVE</span>
            </div>
          ) : (
            <div>
              <span className="text-[9px] tracking-[.2em] font-bold" style={{ color: '#C9A96A' }}>{next ? t('ДАЛЬШЕ') : t('ТАЙМИНГ')}</span>
              {/* До первого блока и после последнего честнее сказать это
                  словами, чем показывать «идёт фотосессия». */}
              <b className="font-serif-d text-[21px] block mt-1">{next ? next.name : t('Тайминг пуст')}</b>
              <p className="text-[11px] opacity-60 mt-0.5">
                {next ? `${t('начало в')} ${time(next.startsAt)}` : t('Соберите тайминг заранее — в день свадьбы он ведёт всю команду')}
              </p>
            </div>
          )}

          <div className="flex gap-2.5 mt-4">
            {/* Сдвиг уходит на сервер и рассылается команде и гостям. Раньше
                он копился в браузере пары и не доходил ни до кого. */}
            <button disabled={busy === 'shift' || !events.length} onClick={() => act('shift', () => shiftTimeline(weddingId!, 15))} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold disabled:opacity-50" style={{ background: '#C9A96A', color: '#141210' }}>
              {busy === 'shift' ? t('Двигаем…') : t('+15 мин всей программе')}
            </button>
            <button onClick={() => void (async () => nav(await dayChatRoute()))()} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold border border-[#4a443c]">{t('Чат дня X')}</button>
          </div>
        </div>

        {err && <p role="alert" className="text-[12px] mt-3" style={{ color: '#E5A3A3' }}>{err}</p>}

        <div className="mt-4 relative pl-6">
          <AsyncState q={q} />
          <div className="absolute left-[7px] top-2 bottom-2 w-[1.5px]" style={{ background: 'linear-gradient(rgba(201,169,106,.7),rgba(201,169,106,.1))' }} />
          {events.map(e => (
            <div key={e.id} className="relative mb-4">
              <span className="absolute -left-[19.5px] top-1.5 w-[9px] h-[9px] rounded-full" style={{ background: e.id === current?.id ? '#C4705A' : '#C9A96A', boxShadow: '0 0 12px rgba(201,169,106,.8)' }} />
              <span className="text-[9.5px] tracking-[.15em] font-bold" style={{ color: '#C9A96A' }}>{time(e.startsAt)}</span>
              <b className="font-serif-d text-[15px] block">{e.name}</b>
              {e.location && <p className="text-[10.5px] opacity-50">{e.location}</p>}
            </div>
          ))}
          {!events.length && ready(q) && (
            <p className="text-[11.5px] opacity-60">{t('Тайминг ещё не собран. Его можно собрать на экране «Тайминг дня».')}</p>
          )}
        </div>

        {/* Раньше здесь стояли четыре подрядчика со статусами «на месте» и
            «едет · 20 мин» и телефоны +7 000 000-00-00. Ни статусов, ни
            телефонов такого рода сервер не знает: показываем свою команду и
            путь к разговору с ней. */}
        <div className="mt-5">
          <b className="text-[13px]">{t('Ваша команда')}</b>
          {!team.length && <p className="text-[11px] opacity-60 mt-1.5">{t('Забронированных подрядчиков пока нет')}</p>}
          <div className="flex gap-2 mt-2.5 overflow-x-auto no-scrollbar">
            {team.map(s => (
              <button key={s.id} onClick={() => void (async () => nav(await chatRouteForVendor(s.vendorId)))()} className="press flex items-center gap-2 px-4 h-[42px] rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0" style={{ background: '#2A2520' }}>
                <span className="w-6 h-6 rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[10px]">{(s.vendor ?? '?')[0]}</span>
                {s.vendor} · {t(s.label)}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-[26px] p-5 mt-4" style={{ background: '#2A2520' }}>
          <div className="flex items-center gap-3">
            <CloudRain size={20} style={{ color: '#C9A96A' }} />
            <div className="flex-1">
              <b className="text-[13.5px]">{t('План Б: дождь')}</b>
              <p className="text-[10.5px] opacity-60 mt-0.5">{t('Церемония переносится под крышу, тайминг пересобирается, команда и гости получают новую точку сбора.')}</p>
            </div>
            {/* Необратимое действие: рассылка уходит всей команде и всем
                гостям сразу. Поэтому подтверждение в два нажатия, как у отмены
                сделки, — комментарий обещал это и раньше, а кнопка срабатывала
                с первого касания. */}
            {planBOn ? (
              <span className="text-[11px] font-bold px-3 py-2 rounded-full shrink-0" style={{ background: '#7E9A74', color: '#fff' }}>{t('Включён')}</span>
            ) : (
              <button
                disabled={busy === 'planb'}
                onClick={() => (confirmPlanB ? act('planb', () => activatePlanB(weddingId!)) : setConfirmPlanB(true))}
                className="press px-4 h-[38px] rounded-full text-[11px] font-bold border border-[#4a443c] disabled:opacity-50"
                style={confirmPlanB ? { background: '#C4705A', borderColor: '#C4705A' } : undefined}
              >
                {busy === 'planb' ? t('Включаем…') : confirmPlanB ? t('Подтвердить') : t('Активировать')}
              </button>
            )}
          </div>
        </div>

        {/* SOS-координатора в контракте нет: отдельного пути «позвать
            координатора» не существует, а телефон +7 000 000-00-00 был
            выдуман. Пишем в командный чат — там координатор и сидит. */}
        <button onClick={() => void (async () => nav(await teamChatRoute()))()} className="press w-full h-[52px] rounded-full mt-4 text-[13.5px] font-bold flex items-center justify-center gap-2" style={{ background: '#C4705A', color: '#fff' }}>
          <Zap size={16} /> {t('Написать всей команде')}
        </button>
      </div>
    </div>
  )
}

/* После свадьбы */
function SectionHeadSm({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mt-1 mb-2.5">
      <h3 className="font-serif-d text-[17px]">{title}</h3>
      {sub && <p className="text-[10.5px] text-[var(--soft)] mt-0.5">{sub}</p>}
    </div>
  )
}

/*
 * «После свадьбы» — итоги.
 *
 * Экран был витриной: «Алина & Тимур», 14 подрядчиков, 76 гостей, 312 фото и
 * два выдуманных отзыва гостей — одни и те же числа у любой пары. Отзыв команде
 * складывался в `tt_after_stars` браузера и до подрядчика не доходил, а «отзывы
 * гостей» читались из `tt_guest_reviews`: пара видела мок вместо того, что ей
 * действительно написали её гости.
 *
 * Теперь всё считается по своей свадьбе, а отзывы ходят на сервер обе стороны.
 */
export function After() {
  const { weddingId, slots } = useStore()
  const w = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const guests = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const album = useApi(() => weddingId ? getAlbum(weddingId) : Promise.resolve([]), [weddingId])
  const reviews = useApi(() => weddingId ? getGuestReviews(weddingId) : Promise.resolve([]), [weddingId])
  const [rating, setRating] = useState(false)

  const date = w.data?.date ?? null
  const photos = album.data ?? []
  const guestReviews = reviews.data ?? []
  /* Команда — те, с кем есть сделка. Свой подрядчик (§11) сюда не попадает:
     он не из каталога, и отзыв о нём публиковать негде. */
  const team = slots.filter(s => s.vendorId && (s.dealState === 'booked' || s.dealState === 'paid_deposit' || s.dealState === 'done'))
  const stats: [number, string][] = [
    [team.length, plural(team.length, t('подрядчик'), t('подрядчика'), t('подрядчиков'))],
    [guests.data?.length ?? 0, plural(guests.data?.length ?? 0, t('гость'), t('гостя'), t('гостей'))],
    [photos.length, plural(photos.length, t('кадр от гостей'), t('кадра от гостей'), t('кадров от гостей'))],
    [guestReviews.length, plural(guestReviews.length, t('отзыв гостя'), t('отзыва гостей'), t('отзывов гостей'))],
  ]
  const icons = ['🤝', '🥂', '📸', '★']

  return (
    <div className="pb-28">
      <TopBar back title={t('После свадьбы')} sub={formatWeddingDate(date) || t('дата пока не назначена')} />
      <AsyncState q={w} />
      <div className="px-5 mt-3">
        <div className="grad rounded-[32px] p-7 text-[var(--on-grad)] text-center relative overflow-hidden fade-up">
          <Heart size={26} className="mx-auto opacity-90" />
          <h2 className="font-serif-d text-[26px] mt-3">{w.data?.title ?? t('Ваша свадьба')}</h2>
          {/* Свадьба может быть ещё впереди: экран открыт из раздела «Мы»
              всегда, и «Поздравляем, ваша свадьба состоялась» до неё —
              неправда. */}
          <p className="text-[12px] opacity-90 mt-1">
            {date && date < new Date().toISOString().slice(0, 10) ? t('Поздравляем! Ваша свадьба состоялась') : t('Итоги соберутся здесь после дня свадьбы')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-4 stagger">
          {stats.map(([v, l], i) => (
            <div key={l} className="card-s p-4 text-center fade-up">
              <span className="text-[20px]">{icons[i]}</span>
              <b className="font-serif-d text-[24px] block mt-1 tabular">{v}</b>
              <span className="text-[10px] text-[var(--soft)]">{l}</span>
            </div>
          ))}
        </div>

        {/* Кнопка «Скачать общий альбом (ZIP)» убрана: она рисовала прогресс
            интервалом и заканчивалась словами «ссылка отправлена», хотя ни
            архива, ни письма не существовало. Архив появится вместе с
            файловым хранилищем — тем же, что нужно загрузке кадров. */}
        <p className="text-[10.5px] text-[var(--soft)] leading-relaxed mt-4 px-1">
          {t('Общий архив альбома появится вместе с файловым хранилищем — тогда же, когда гости смогут загружать кадры.')}
        </p>

        <button onClick={() => setRating(!rating)} className="press w-full card-s mt-3 py-4 text-[13px] font-semibold">{rating ? t('Скрыть') : t('Оставить отзывы команде')}</button>
        {rating && (
          <div className="mt-3 space-y-2.5 fade-up">
            {!team.length && <p className="text-[12px] text-[var(--soft)] text-center py-3">{t('Пока некого оценивать — в команде нет забронированных подрядчиков')}</p>}
            {team.map(s => <CoupleReviewRow key={s.id} vendorId={s.vendorId!} name={s.vendor ?? ''} done={s.dealState === 'done'} />)}
          </div>
        )}

        <div className="mt-4">
          <SectionHeadSm title={t('Отзывы от гостей')} sub={t('гости отмечены значком и не смешиваются с вашими отзывами')} />
          <AsyncState q={reviews} />
          <div className="flex flex-col gap-2">
            {guestReviews.map(r => (
              <div key={r.id} className="card-s p-4">
                <div className="flex items-center justify-between gap-2">
                  <b className="text-[12.5px] flex-1">{r.vendorName ?? t('Подрядчик')}</b>
                  <span className="text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--blue)] text-[var(--blue-ink)]">{t('Гость свадьбы')}</span>
                </div>
                <div className="flex items-center gap-1 mt-1.5 text-[11px]" style={{ color: 'var(--gold-soft)' }}>{'★'.repeat(r.rating ?? 0)}<span className="text-[var(--track)]">{'★'.repeat(5 - (r.rating ?? 0))}</span></div>
                {r.text && <p className="text-[11.5px] text-[var(--ink2)] mt-1.5 leading-relaxed">{r.text}</p>}
              </div>
            ))}
            {!guestReviews.length && ready(reviews) && (
              <p className="text-[11.5px] text-[var(--soft)] py-2">{t('Гости пока не оставили отзывов. Форма открывается им после дня свадьбы.')}</p>
            )}
          </div>
          <p className="text-[10.5px] text-[var(--soft2)] mt-2.5 leading-relaxed">{t('Отзывы гостей видны вам и учитываются в рейтинге подрядчика отдельно от отзывов пар.')}</p>
        </div>
        <p className="text-center text-[10.5px] text-[var(--soft2)] mt-5">{t('Проект и документы хранятся бессрочно. Встретимся в годовщину 💌')}</p>
      </div>
    </div>
  )
}

/*
 * Отзыв пары об одном подрядчике.
 *
 * Право на отзыв даёт завершённая сделка — это проверяет сервер, и до неё
 * форма не открывается: звёзды, которые никуда не уйдут, хуже честной строки
 * «после завершения сделки».
 */
function CoupleReviewRow({ vendorId, name, done }: { vendorId: string; name: string; done: boolean }) {
  const [stars, setStars] = useState(0)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const send = () => void (async () => {
    if (!stars || !text.trim()) return
    setBusy(true)
    setErr(null)
    try { await sendCoupleReview(vendorId, stars, text.trim()); setSent(true) } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <b className="text-[12.5px] flex-1">{name}</b>
        {!done && <span className="text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--track)] text-[var(--track-ink)]">{t('после завершения сделки')}</span>}
      </div>
      {done && !sent && (
        <>
          <div className="flex items-center gap-1.5 mt-2">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setStars(n)} className="press text-[17px]" aria-label={`${n}`} style={{ color: n <= stars ? 'var(--gold-soft)' : 'var(--track)' }}>★</button>
            ))}
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={t('Что получилось, а что нет')} className="w-full mt-2 px-4 py-3 rounded-xl bg-[var(--bg)] text-[12.5px] outline-none resize-none placeholder:text-[var(--soft2)]" />
          {err && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] mt-1.5">{err}</p>}
          <button disabled={busy || !stars || !text.trim()} onClick={send} className="press w-full h-[42px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold mt-2 disabled:opacity-40">
            {busy ? t('Отправляем…') : t('Отправить отзыв')}
          </button>
        </>
      )}
      {sent && <p className="text-[11.5px] text-[var(--sage-deep)] font-medium mt-1.5">{t('✓ Отзыв отправлен')}</p>}
    </div>
  )
}

/* План Б: плохие сценарии дня X и готовые решения */
const planBRisks = [
  {
    icon: '🎤', title: t('Подрядчик не приехал или отменил в последний день'),
    /* Про эскроу и автоматический возврат аванса здесь было написано зря:
       платёжного провайдера нет, деньги идут напрямую подрядчику по договору,
       и возвращает их он. Штрафа рейтинга за отмену в коде тоже нет. */
    how: t('«Горячая замена»: каталог показывает только свободных на вашу дату. Аванс возвращает подрядчик по договору — потому договор и нужен; шаблон есть в разделе «Документы».'),
    action: 'search',
  },
  {
    icon: '🌧', title: t('Дождь или непогода на выездной церемонии'),
    how: t('План Б площадки согласован при бронировании: церемония переносится в зал, тенты и прозрачные зонты — красивые фото даже в дождь. Гости получают уведомление об изменении точки сбора.'),
    action: 'rain',
  },
  {
    icon: '🔌', title: t('Отключили электричество на площадке'),
    how: t('При бронировании площадка подтверждает наличие генератора — это пункт чек-листа договора. Запасной сценарий: свечи и накамерный свет фотографа превращают паузу в «зажжение семейного очага».'),
  },
  {
    icon: '⏰', title: t('Всё отстаёт от тайминга'),
    how: t('В режиме дня X Тиль сдвигает тайминг одним тапом и рассылает обновления всей команде. Запас 15 минут в каждом блоке заложен заранее — гости не заметят.'),
  },
  {
    icon: '🍰', title: t('Торт повредили при доставке'),
    how: t('Не выносить целиком: кондитер разрезает за кулисами и подаёт порционно — гости не догадаются. Фото торта делаются до выноса, при заказе.'),
  },
  {
    icon: '🥂', title: t('Гость перебрал или неловкий тост'),
    how: t('Ведущий тактично забирает микрофон и уводит программу дальше — это прописано в брифе ведущего. Координатор тихо вызывает такси до отеля, бармен наливает меньше.'),
  },
  {
    icon: '👶', title: t('Дети устроили истерику посреди церемонии'),
    how: t('В каталоге есть слот «Няня/аниматор» — дети заняты отдельно, за своим столом. Или формат «только взрослые»: пометка в приглашении.'),
  },
  {
    icon: '👥', title: t('Приехали незваные +1, мест не хватает'),
    how: t('Кейтеринг и площадка всегда держат запас +2 места и порции — заложено в сводку автоматически. Координатор добавляет стулья без вашего участия.'),
  },
  {
    icon: '🚗', title: t('Автобус с гостями сломался или водитель приехал не туда'),
    how: t('Маршрут и точки сбора у водителя в приложении — он не «думает сам». Запасной вариант: второй автобус из раздела Логистики или такси-контракт, эскалация на координатора.'),
  },
  {
    icon: '💍', title: t('Забыли кольца или паспорта'),
    how: t('Чек-лист ниже отдаёт кольца и паспорта свидетелям ещё накануне — проверено поколениями свадеб.'),
  },
]


export function PlanB() {
  const nav = useNavigate()
  const { weddingId } = useStore()
  const [open, setOpen] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /*
   * Чек-лист накануне ведёт сервер: он один на всю команду, и координатор
   * должен видеть те же галочки, что и пара. Локальный `tt_planb` держал их
   * в одном браузере — второй человек видел пустой список, а после смены
   * телефона отметки пропадали совсем.
   *
   * Пункты плана Б — обычные задачи вида `planb`, поэтому и отмечаются через
   * `PATCH …/tasks/{taskId}`: отдельного пути у контракта нет намеренно.
   */
  const q = useApi(() => weddingId ? getPlanB(weddingId) : Promise.resolve(null), [weddingId])
  const checklist = q.data?.checklist ?? []
  /* Галочка отзывается сразу, запрос уходит следом. Отказ возвращает её
     обратно: показывать отмеченным то, чего сервер не принял, нельзя. */
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const isDone = (id: string, serverDone: boolean) => pending[id] ?? serverDone

  const toggle = (id: string, next: boolean) => {
    if (!weddingId || !id) return
    setPending(m => ({ ...m, [id]: next }))
    setErr(null)
    void setTaskDone(weddingId, id, next)
      .then(() => q.reload())
      .catch(e => {
        setPending(m => { const rest = { ...m }; delete rest[id]; return rest })
        setErr(explainError(e))
      })
  }

  const doneCount = checklist.filter(c => isDone(c.id ?? '', !!c.done)).length
  const pct = checklist.length ? Math.round(doneCount / checklist.length * 100) : 0
  const activated = !!q.data?.activatedAt

  /* Активация — необратимая рассылка всей команде и гостям, поэтому в два
     нажатия. Раньше кнопка называлась «Активировать план «дождь» (демо)» и
     переключала переменную на экране: пара видела «Уведомления ушли: площадка,
     декоратор, фотограф, координатор», а не уходило ничего. */
  const [confirmRain, setConfirmRain] = useState(false)
  const activate = () => {
    if (!weddingId || busy) return
    setBusy(true)
    setErr(null)
    void activatePlanB(weddingId, 'rain')
      .then(() => { setConfirmRain(false); q.reload() })
      .catch(e => setErr(explainError(e)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="pb-28">
      <TopBar back title={t('План Б')} sub={t('Готовы ко всему, что может пойти не так')} />
      <AsyncState q={q} />
      <div className="px-5 mt-3 space-y-3">
        <div className="card p-4">
          <div className="flex justify-between text-[12px] mb-2"><span className="font-semibold">{t('Чек-лист накануне')}</span><b className="tabular">{pct}%</b></div>
          <Bar pct={pct} />
          <div className="mt-3 space-y-2">
            {checklist.map(c => {
              const id = c.id ?? ''
              const checked = isDone(id, !!c.done)
              return (
                <button key={id} onClick={() => toggle(id, !checked)} className="press w-full flex items-center gap-3 text-left">
                  <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0', checked ? 'grad text-[var(--on-grad)]' : 'bg-[var(--track)] text-[var(--track-ink)]')}>{checked ? '✓' : ''}</span>
                  <span className={cn('text-[12px] leading-snug', checked && 'line-through text-[var(--soft2)]')}>{c.title}</span>
                </button>
              )
            })}
          </div>
        </div>

        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] px-1">{err}</p>}

        {/* Плашка стоит на ответе сервера, а не на локальном тумблере: до
            этого она загоралась от нажатия и утверждала, что уведомления
            ушли, когда не уходило ничего. */}
        {activated && (
          <div className="card p-4 fade-up" style={{ border: '1.5px solid #7E9A74' }}>
            <b className="text-[13px]">🌧 {t('План «дождь» активирован')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Команда и гости получили новую точку сбора, тайминг пересобран.')}</p>
          </div>
        )}

        <div className="space-y-2.5 stagger">
          {planBRisks.map((r, i) => (
            <div key={r.title} className="card fade-up overflow-hidden">
              <button onClick={() => setOpen(o => o === i ? null : i)} className="press w-full p-4 flex items-center gap-3 text-left">
                <span className="text-[20px] w-8 text-center shrink-0">{r.icon}</span>
                <span className="flex-1 text-[12.5px] font-semibold leading-snug">{r.title}</span>
                <span className={cn('text-[var(--soft2)] transition-transform', open === i && 'rotate-90')}>›</span>
              </button>
              {open === i && (
                <div className="px-4 pb-4 -mt-1 fade-in">
                  <p className="text-[11.5px] text-[var(--soft)] leading-relaxed">{r.how}</p>
                  {r.action === 'search' && (
                    <button onClick={() => nav('/search')} className="press mt-3 h-10 px-5 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Найти горячую замену →')}</button>
                  )}
                  {r.action === 'rain' && !activated && (
                    <button disabled={busy} onClick={() => (confirmRain ? activate() : setConfirmRain(true))} className={cn('press mt-3 h-10 px-5 rounded-full text-[12px] font-semibold disabled:opacity-50', confirmRain ? 'bg-[#C4705A] text-white' : 'grad text-[var(--on-grad)]')}>
                      {busy ? t('Включаем…') : confirmRain ? t('Подтвердить: команда и гости получат новую точку сбора') : t('Активировать план «дождь»')}
                    </button>
                  )}
                  {r.action === 'rain' && activated && (
                    <p className="text-[11px] text-[var(--sage-deep)] mt-3 font-semibold">{t('План «дождь» уже активирован')}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Раньше здесь обещалась «SOS-кнопка», которой в приложении нет:
            отдельного пути «позвать координатора» контракт не знает. Зато
            есть командный чат — там и координатор, и подрядчики. */}
        <AiTip text={t('Самый частый совет профессионалов: не решайте проблемы сами в день X. Для этого есть командный чат — ваша задача только наслаждаться днём.')} />
      </div>
    </div>
  )
}
