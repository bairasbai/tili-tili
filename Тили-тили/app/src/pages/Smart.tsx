import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ChevronLeft, CloudRain, Zap, Heart } from 'lucide-react'

import { useStore } from '@/lib/store'
import { TopBar, AiTip, Bar } from '@/components/chrome'
import { explainError, useApi } from '@/lib/api/useApi'
import { AsyncState, num, ready } from '@/components/AsyncState'
import { getGuests, getPlanB, getSlots, getTimeline, getWedding } from '@/lib/api/weddingData'
import { getAlbum } from '@/lib/api/gifts'
import { getGuestReviews, sendCoupleReview } from '@/lib/api/reviews'
import { activatePlanB, setTaskDone, shiftTimeline, type DayXBroadcast } from '@/lib/api/weddingWrite'
import { recallDay, rememberDay } from '@/lib/offlineDay'
import { formatWeddingDate } from '@/lib/weddingDate'
import { getAvailability, getCategories, getFavorites, getVendors, reviewsPendingRating } from '@/lib/api/catalog'
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
 *
 * С `?cat=` здесь верх выдачи категории (три первых по рейтингу, с ротацией
 * новичков сервера), а не кандидаты пары — и подпись так и говорит; слово
 * «кандидаты» остаётся за избранным, которое пара отобрала сама (ревью
 * D5-19). Упавший календарь одного подрядчика называется словами, а не
 * «…» навсегда.
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
    /* По самой оценке, не по числу отзывов: до третьего отзыва сервер отдаёт
       `rating: null`, и клетка печатала «★ null · 2 отзывов» (ревью D5-02). */
    [t('Рейтинг'), v => (v.rating != null
      ? `★ ${v.rating}${v.reviewsCount != null ? ` · ${v.reviewsCount} ${plural(v.reviewsCount, t('отзыв'), t('отзыва'), t('отзывов'))}` : ''}`
      : (v.reviewsCount ?? 0) > 0 ? reviewsPendingRating(v.reviewsCount ?? 0) : t('Новый'))],
    ...(weddingDate
      ? ([[t('Свободен на вашу дату'), v => {
          const f = free.data?.[v.id ?? '']
          /* `null` — календарь этого подрядчика не пришёл, и это не «ждём»:
             троеточие здесь стояло бессрочно (ERR-0160). */
          if (f === null) return t('календарь не загрузился')
          return f === undefined ? '…' : f ? t('✓ Да') : t('✕ Занят')
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
      <TopBar back title={t('Сравнение')} sub={ready(q)
        ? catId
          ? `${list.length === 1 ? t('первый в выдаче') : `${t('первые')} ${list.length} ${t('в выдаче')}`}${catTitle ? ` · ${catTitle}` : ''}`
          : `${list.length} ${plural(list.length, t('кандидат'), t('кандидата'), t('кандидатов'))} ${t('из избранного')}`
        : catTitle ?? undefined} />
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
 * и рассылается команде и подрядчикам (гостям канала нет — SMS не
 * подключены), план Б — в `POST …/planb/activate`.
 * Статусов подрядчиков («едет», «на месте») в контракте нет вовсе, и
 * рисовать их нельзя: пара приняла бы выдумку за факт в день, когда цена
 * ошибки максимальна.
 *
 * Палитра — тёмная в любой теме, как велит план (§10.2: «режим дня X —
 * тёмный, строго производная»). Токены для этого не выдумываются заново:
 * корень экрана несёт `data-theme="dark"`, и внутри действуют те же
 * переменные темы, что и у всего приложения в тёмном режиме. Раньше десяток
 * цветов стоял в JSX буквами (ревью D4-22, R-01).
 */
export function DayX() {
  const nav = useNavigate()
  const { weddingId, slots, slotsState } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /* Отказ открыть чат — под той кнопкой, которую нажали: экран длинный, и
     строка у верхней карточки для нижней кнопки не видна (RF-04). */
  const [chatErr, setChatErr] = useState<{ at: 'day' | 'crew' | 'team'; text: string } | null>(null)
  /* Какая из кнопок чата ждёт адрес: своя переменная, чтобы не перебивать
     «Двигаем…» у сдвига тайминга. */
  const [chatBusy, setChatBusy] = useState<string | null>(null)
  const [confirmPlanB, setConfirmPlanB] = useState(false)
  // Время снимаем один раз за отрисовку: в теле компонента его брать нельзя (R-04).
  const [now, setNow] = useState(() => new Date())

  const w = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const q = useApi(() => weddingId ? getTimeline(weddingId) : Promise.resolve([]), [weddingId])
  /* План Б спрашиваем и здесь. Без этого день X предлагал «Активировать» уже
     включённый сценарий, а экран «План Б» рядом писал «активирован»: два
     экрана отвечали на один вопрос по-разному, и второе нажатие разослало бы
     команде и гостям повторную рассылку. */
  const pb = useApi(() => weddingId ? getPlanB(weddingId) : Promise.resolve(null), [weddingId])
  /*
   * Офлайн-копия (План §3.1, §12): на площадке сеть пропадает, а тайминг и
   * телефоны команды нужны именно там. Воркер API не кэширует — копия одна,
   * явная, только для этого экрана (`lib/offlineDay.ts`). Показывается лишь
   * когда сервер НЕ ОТВЕТИЛ (ошибка без данных), и всегда с меткой «на HH:MM»:
   * человек видит, чему верит. Пока ответ есть — копия молча обновляется.
   */
  const snapshot = useMemo(() => recallDay(weddingId), [weddingId])
  const offline = !q.data && !!q.error && snapshot ? snapshot : null
  const events = q.data ?? offline?.timeline ?? []
  const planBOn = !!pb.data?.activatedAt || (!pb.data && !!pb.error && !!offline?.planBActivatedAt)
  const reloadTimeline = q.reload
  const reloadPlanB = pb.reload

  /*
   * Экран живёт весь день открытым у координатора. Раньше «сейчас» снималось
   * один раз при монтировании, а тайминг перечитывался только после своих
   * действий: блок «СЕЙЧАС» оставался тем, что был при открытии, и сдвиг
   * «+15 мин», сделанный парой с другого телефона, сюда не доходил (ревью
   * D4-13, R-171). Раз в минуту — часы вперёд и тайминг с планом Б заново.
   *
   * Заново — через `reload()`, а не счётчиком в зависимостях запроса (RF-02):
   * смена зависимостей для `useApi` — «другой запрос», данные стираются до
   * ответа, и раз в минуту карточка «СЕЙЧАС» превращалась в «Загружаем…»,
   * «+15 мин» выключалась, а вместо бейджа «Включён» появлялась «Активировать».
   */
  useEffect(() => {
    const id = setInterval(() => { setNow(new Date()); reloadTimeline(); reloadPlanB() }, 60_000)
    return () => clearInterval(id)
  }, [reloadTimeline, reloadPlanB])

  /* «Сейчас» — это блок, который уже начался и ещё не сменился следующим.
     Раньше здесь стояла «Фотосессия до 16:30» независимо от времени суток. */
  const started = events.filter(e => e.startsAt && new Date(e.startsAt) <= now)
  const current = started[started.length - 1]
  const next = events.find(e => e.startsAt && new Date(e.startsAt) > now)

  const liveTeam = slots.filter(s => s.vendor && (s.dealState === 'booked' || s.dealState === 'paid_deposit' || s.dealState === 'done'))
  const team = slotsState === 'error' && offline ? offline.team : liveTeam
  /* Копия снимается с живого ответа целиком — тайминг, план Б и команда
     вместе, чтобы не смешивать вчерашних подрядчиков с сегодняшними часами. */
  useEffect(() => {
    if (!weddingId || !q.data || pb.loading || pb.error || slotsState !== 'ready') return
    rememberDay({
      weddingId,
      /* Эффект, не рендер: момент снятия копии (сторож D4-22 — про тело компонента). */
      savedAt: new Date(Date.now()).toISOString(),
      timeline: q.data,
      planBActivatedAt: pb.data?.activatedAt ?? null,
      team: liveTeam.map(t => ({ id: t.id, label: t.label, vendor: t.vendor, vendorId: t.vendorId, phone: t.phone })),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- liveTeam выводится из slots; slotsState покрывает их смену
  }, [weddingId, q.data, pb.data, pb.loading, pb.error, slotsState])

  /*
   * Чем кончилось действие — словами из ответа (`DayXBroadcast`, фича 005):
   * скольких ответивших «да» гостей касается сдвиг или план Б. Им сообщает
   * команда — канала до гостей нет, и `notifiedGuests` (всегда ноль, D4-18)
   * экран не читает. Сервер числа не назвал — строки нет, а не «касается 0».
   */
  const [outcome, setOutcome] = useState<string | null>(null)
  const act = (name: string, fn: () => Promise<DayXBroadcast | undefined>) => void (async () => {
    if (!weddingId) return
    setBusy(name)
    setErr(null)
    setOutcome(null)
    try {
      const res = await fn()
      const affected = res?.guestsAffected
      if (typeof affected === 'number') {
        setOutcome(`${name === 'shift' ? t('Сдвиг принят') : t('План Б включён')} · ${t('касается гостей:')} ${affected} — ${t('сообщите им сами, приложение гостям не пишет')}`)
      }
      reloadTimeline(); reloadPlanB()
    } catch (e) {
      setErr(explainError(e))
      /* Подтверждение снимается и при отказе: иначе кнопка оставалась в
         «Подтвердить», и следующий тап включал план Б без второго вопроса
         (ревью 015, FA5). */
      setConfirmPlanB(false)
    } finally { setBusy(null) }
  })()
  /*
   * Сдвиг и план Б — неповторимые действия: каждый вызов двигает все будущие
   * блоки и шлёт команде и подрядчикам критическое уведомление мимо тихих
   * часов. После своего POST экран перечитывает тайминг и план Б, и до ответа
   * на нём прежние часы и прежнее «не включён» — человек читает это как
   * «не сработало» и жмёт снова (ревью R3-01). Пока свежий ответ в пути,
   * обе кнопки закрыты.
   */
  const stale = q.refreshing || pb.refreshing

  /* Адрес чата знает только сервер, и он может отказать: 429 ограничителя,
     истёкшая сессия, обрыв сети. Раньше промис висел без `catch` — кнопка
     молча не делала ничего, а ошибка уходила в `unhandledrejection` (RF-04,
     R-148); в день свадьбы «Написать всей команде» просто не отвечала. */
  const openChat = (at: 'day' | 'crew' | 'team', key: string, route: () => Promise<string>) => void (async () => {
    setChatBusy(key)
    setChatErr(null)
    try { nav(await route()) } catch (e) { setChatErr({ at, text: explainError(e) }) } finally { setChatBusy(null) }
  })()
  const chatErrAt = (at: 'day' | 'crew' | 'team') =>
    chatErr?.at === at ? <p role="alert" className="text-[11.5px] mt-2 text-[var(--rose-ink)]">{chatErr.text}</p> : null

  const time = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div data-theme="dark" className="min-h-dvh pb-10 bg-[var(--dark-bg)] text-[var(--dark-ink)]">
      <div className="px-5 pt-7 flex items-center justify-between">
        <button onClick={() => goBack(x => nav(x), (to, o) => nav(to, o))} className="press w-10 h-10 rounded-full flex items-center justify-center bg-[var(--card)]" aria-label={t('Назад')}><ChevronLeft size={18} /></button>
        <div className="text-center">
          <b className="font-serif-d text-[19px]">{w.data?.date ? formatWeddingDate(w.data.date) : t('День X')}</b>
          <p className="text-[9.5px] tracking-[.2em] font-bold text-[var(--dark-gold)]">{t('РЕЖИМ ДНЯ СВАДЬБЫ')}</p>
        </div>
        <div className="w-10" />
      </div>
      {offline && (
        <p role="status" className="mx-5 mt-3 rounded-2xl px-4 py-2.5 text-[11.5px] leading-relaxed bg-[var(--card)] opacity-90">
          {t('Сервер не отвечает — показана копия с этого телефона')}: {t('тайминг на')} {time(offline.savedAt)}. {t('Сдвиг и план Б без сети не сработают.')}
        </p>
      )}

      <div className="px-5 mt-5">
        <div className="rounded-[26px] p-5 bg-[var(--card)]">
          {current ? (
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <span className="text-[9px] tracking-[.2em] font-bold text-[var(--dark-gold)]">{t('СЕЙЧАС')}</span>
                <b className="font-serif-d text-[21px] block mt-1 truncate">{current.name}</b>
                <p className="text-[11px] opacity-60 mt-0.5">
                  {time(current.startsAt)}{next ? ` · ${t('дальше')} ${time(next.startsAt)} · ${next.name}` : ''}
                </p>
              </div>
              <span className="text-[10px] font-bold px-3 py-1.5 rounded-full shrink-0 bg-[var(--rose-deep)] text-[var(--card)]">● LIVE</span>
            </div>
          ) : (
            <div>
              <span className="text-[9px] tracking-[.2em] font-bold text-[var(--dark-gold)]">{next ? t('ДАЛЬШЕ') : t('ТАЙМИНГ')}</span>
              {/* До первого блока и после последнего честнее сказать это
                  словами, чем показывать «идёт фотосессия». */}
              {/* «Тайминг пуст» — про пришедший тайминг: при отказе сервера
                  экран дня X говорил координатору, что программы нет. */}
              <b className="font-serif-d text-[21px] block mt-1">{next ? next.name : ready(q) || offline ? t('Тайминг пуст') : q.loading ? t('Загружаем…') : t('Тайминг не загрузился')}</b>
              <p className="text-[11px] opacity-60 mt-0.5">
                {next ? `${t('начало в')} ${time(next.startsAt)}` : ready(q) || offline ? t('Соберите тайминг заранее — в день свадьбы он ведёт всю команду') : (q.error ?? '')}
              </p>
            </div>
          )}

          <div className="flex gap-2.5 mt-4">
            {/* Сдвиг уходит на сервер и рассылается команде и подрядчикам.
                Раньше он копился в браузере пары и не доходил ни до кого. */}
            {/* Из офлайн-копии сдвигать нечего: запрос не дойдёт, а кнопка обещала бы. */}
            <button disabled={!!busy || stale || !events.length || !!offline} onClick={() => act('shift', () => shiftTimeline(weddingId!, 15))} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold disabled:opacity-50 bg-[var(--dark-gold)] text-[var(--on-grad)]">
              {busy === 'shift' ? t('Двигаем…') : t('+15 мин всей программе')}
            </button>
            <button disabled={chatBusy === 'chat:day'} onClick={() => openChat('day', 'chat:day', dayChatRoute)} className="press flex-1 h-[44px] rounded-full text-[12px] font-bold border border-[var(--line)] disabled:opacity-50">{chatBusy === 'chat:day' ? t('Открываем чат…') : t('Чат дня X')}</button>
          </div>
          {chatErrAt('day')}
        </div>

        {err && <p role="alert" className="text-[12px] mt-3 text-[var(--rose-ink)]">{err}</p>}
        {outcome && <p role="status" className="text-[11.5px] mt-3 opacity-80">{outcome}</p>}

        <div className="mt-4 relative pl-6">
          {!offline && <AsyncState q={q} />}
          <div className="absolute left-[7px] top-2 bottom-2 w-[1.5px] opacity-50" style={{ background: 'linear-gradient(var(--dark-gold), transparent)' }} />
          {events.map(e => (
            <div key={e.id} className="relative mb-4">
              <span className={cn('absolute -left-[19.5px] top-1.5 w-[9px] h-[9px] rounded-full', e.id === current?.id ? 'bg-[var(--rose-deep)]' : 'bg-[var(--dark-gold)]')} style={{ boxShadow: '0 0 12px var(--dark-gold-glow)' }} />
              <span className="text-[9.5px] tracking-[.15em] font-bold text-[var(--dark-gold)]">{time(e.startsAt)}</span>
              <b className="font-serif-d text-[15px] block">{e.name}</b>
              {e.location && <p className="text-[10.5px] opacity-50">{e.location}</p>}
            </div>
          ))}
          {!events.length && (ready(q) || offline) && (
            <p className="text-[11.5px] opacity-60">{t('Тайминг ещё не собран. Его можно собрать на экране «Тайминг дня».')}</p>
          )}
        </div>

        {/* Раньше здесь стояли четыре подрядчика со статусами «на месте» и
            «едет · 20 мин» и телефоны +7 000 000-00-00. Ни статусов, ни
            телефонов такого рода сервер не знает: показываем свою команду и
            путь к разговору с ней. */}
        <div className="mt-5">
          <b className="text-[13px]">{t('Ваша команда')}</b>
          {/* Состав команды известен только вместе с мозаикой. */}
          {!team.length && <p className="text-[11px] opacity-60 mt-1.5">{slotsState === 'ready' ? t('Забронированных подрядчиков пока нет') : slotsState === 'error' ? t('Сервер недоступен — команда не загрузилась') : t('Загружаем…')}</p>}
          <div className="flex gap-2 mt-2.5 overflow-x-auto no-scrollbar">
            {team.map(s => (
              /* Без сети чат не открыть — из копии остаётся телефон (виден
                 паре после брони), и в день свадьбы он важнее переписки. */
              offline && slotsState === 'error' ? (
                <a key={s.id} href={s.phone ? `tel:${s.phone}` : undefined} aria-disabled={!s.phone} className={cn('press flex items-center gap-2 px-4 h-[42px] rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 bg-[var(--card)]', !s.phone && 'opacity-50')}>
                  <span className="w-6 h-6 rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[10px]">{(s.vendor ?? '?')[0]}</span>
                  {`${s.vendor} · ${t(s.label)}`}{s.phone ? ` · ${s.phone}` : ` · ${t('телефона нет')}`}
                </a>
              ) : (
              <button key={s.id} disabled={chatBusy === `chat:${s.id}`} onClick={() => openChat('crew', `chat:${s.id}`, () => chatRouteForVendor(s.vendorId))} className="press flex items-center gap-2 px-4 h-[42px] rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 bg-[var(--card)] disabled:opacity-50">
                <span className="w-6 h-6 rounded-full grad flex items-center justify-center text-[var(--on-grad)] text-[10px]">{(s.vendor ?? '?')[0]}</span>
                {chatBusy === `chat:${s.id}` ? t('Открываем чат…') : `${s.vendor} · ${t(s.label)}`}
              </button>
              )
            ))}
          </div>
          {chatErrAt('crew')}
        </div>

        <div className="rounded-[26px] p-5 mt-4 bg-[var(--card)]">
          <div className="flex items-center gap-3">
            <CloudRain size={20} className="text-[var(--dark-gold)]" />
            <div className="flex-1">
              <b className="text-[13.5px]">{t('План Б: дождь')}</b>
              {/* Что активация делает на самом деле: сценарий фиксируется на
                  сервере, команде уходит уведомление. Тайминг она не
                  пересобирает, гостям не пишет — канала к ним нет (ревью
                  D4-07). Обещать иначе значит оставить гостей без звонка. */}
              <p className="text-[10.5px] opacity-60 mt-0.5">{t('Церемония переносится под крышу. Сценарий фиксируется, команде уходит уведомление; гостям сообщите сами.')}</p>
            </div>
            {/* Необратимое действие: уведомление уходит всей команде сразу.
                Поэтому подтверждение в два нажатия, как у отмены сделки, —
                комментарий обещал это и раньше, а кнопка срабатывала с
                первого касания. */}
            {planBOn ? (
              <span className="text-[11px] font-bold px-3 py-2 rounded-full shrink-0 bg-[var(--sage-deep)] text-[var(--card)]">{t('Включён')}</span>
            ) : (
              /* Пока состояние плана Б не пришло, кнопка закрыта: без ответа
                 «не включён» — догадка, и по ней ушла бы повторная рассылка.
                 Подтверждение снимается сразу после принятого сервером
                 запроса: иначе до свежего ответа кнопка стояла бы в
                 «Подтвердить», и одно касание слало бы рассылку второй раз. */
              <button
                disabled={!!busy || stale || !ready(pb)}
                title={!ready(pb) ? (pb.error ?? t('Загружаем…')) : undefined}
                onClick={() => (confirmPlanB ? act('planb', async () => { const res = await activatePlanB(weddingId!); setConfirmPlanB(false); return res }) : setConfirmPlanB(true))}
                className={cn('press px-4 h-[38px] rounded-full text-[11px] font-bold border disabled:opacity-50', confirmPlanB ? 'bg-[var(--rose-deep)] border-[var(--rose-deep)] text-[var(--card)]' : 'border-[var(--line)]')}
              >
                {busy === 'planb' ? t('Включаем…') : confirmPlanB ? t('Подтвердить') : t('Активировать')}
              </button>
            )}
          </div>
        </div>

        {/* SOS-координатора в контракте нет: отдельного пути «позвать
            координатора» не существует, а телефон +7 000 000-00-00 был
            выдуман. Пишем в командный чат — там координатор и сидит. */}
        <button disabled={chatBusy === 'chat:team'} onClick={() => openChat('team', 'chat:team', teamChatRoute)} className="press w-full h-[52px] rounded-full mt-4 text-[13.5px] font-bold flex items-center justify-center gap-2 bg-[var(--rose-deep)] text-[var(--card)] disabled:opacity-50">
          <Zap size={16} /> {chatBusy === 'chat:team' ? t('Открываем чат…') : t('Написать всей команде')}
        </button>
        {chatErrAt('team')}
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
  const { weddingId } = useStore()
  const w = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const guests = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const album = useApi(() => weddingId ? getAlbum(weddingId) : Promise.resolve([]), [weddingId])
  const reviews = useApi(() => weddingId ? getGuestReviews(weddingId) : Promise.resolve([]), [weddingId])
  /* Мозаика читается здесь своим запросом, а не из стора: у слота в сторе
     нет даты завершения сделки, а окно отзыва считается от неё (`doneAt`). */
  const slotsQ = useApi(() => weddingId ? getSlots(weddingId) : Promise.resolve([]), [weddingId])
  const [rating, setRating] = useState(false)
  // Сегодняшний день — один раз за монтирование: в теле компонента время не берут (R-04).
  const [today] = useState(() => new Date().toISOString().slice(0, 10))

  const date = w.data?.date ?? null
  const photos = album.data ?? []
  const guestReviews = reviews.data ?? []
  /* Команда — те, с кем есть сделка. Свой подрядчик (§11) сюда не попадает:
     он не из каталога, и отзыв о нём публиковать негде. */
  const team = (slotsQ.data ?? []).filter(s => s.deal?.vendor?.id && (s.deal.state === 'booked' || s.deal.state === 'paid_deposit' || s.deal.state === 'done'))
  /* Итоги — только по пришедшим ответам: «0 гостей · 0 кадров» после свадьбы
     при лежащем сервере читается как «никто не пришёл и не снимал». */
  const guestCount = guests.data?.length ?? 0
  const stats: [string, string][] = [
    [num(slotsQ, team.length), plural(team.length, t('подрядчик'), t('подрядчика'), t('подрядчиков'))],
    [num(guests, guestCount), plural(guestCount, t('гость'), t('гостя'), t('гостей'))],
    [num(album, photos.length), plural(photos.length, t('кадр от гостей'), t('кадра от гостей'), t('кадров от гостей'))],
    [num(reviews, guestReviews.length), plural(guestReviews.length, t('отзыв гостя'), t('отзыва гостей'), t('отзывов гостей'))],
  ]
  const statsError = guests.error ?? album.error
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
            {date && date < today ? t('Поздравляем! Ваша свадьба состоялась') : t('Итоги соберутся здесь после дня свадьбы')}
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
        {statsError && ready(w) && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] mt-2 px-1 leading-relaxed">{statsError}</p>}

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
            <AsyncState q={slotsQ} />
            {ready(slotsQ) && !team.length && <p className="text-[12px] text-[var(--soft)] text-center py-3">{t('Пока некого оценивать — в команде нет забронированных подрядчиков')}</p>}
            {team.map(s => (
              <CoupleReviewRow key={s.id} vendorId={s.deal?.vendor?.id ?? ''} name={s.deal?.vendor?.name ?? ''} done={s.deal?.state === 'done'} doneAt={s.deal?.doneAt ?? null} />
            ))}
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
 *
 * Второе условие сервера — окно в 14 дней от завершения сделки
 * (`REVIEW_WINDOW_DAYS` в `routes/reviews.ts`, 403 после). Раньше форма
 * стояла у каждой завершённой сделки, и «через год» упиралось в отказ уже
 * после набранного текста (ревью D4-26). Срок считается от `doneAt` сделки;
 * без него сервер берёт дату создания сделки, которой у экрана нет, — тогда
 * форма открыта, а дата не называется: выдумывать её нельзя.
 */
const REVIEW_WINDOW_DAYS = 14

function CoupleReviewRow({ vendorId, name, done, doneAt }: { vendorId: string; name: string; done: boolean; doneAt: string | null }) {
  const [stars, setStars] = useState(0)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Момент открытия — один раз за монтирование (R-04).
  const [openedAt] = useState(() => Date.now())

  const deadline = doneAt ? new Date(doneAt).getTime() + REVIEW_WINDOW_DAYS * 86_400_000 : null
  const closed = deadline !== null && openedAt > deadline
  const deadlineText = deadline !== null
    ? new Date(deadline).toLocaleDateString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long' })
    : null

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
        {done && closed && <span className="text-[9.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--track)] text-[var(--track-ink)]">{t('Окно для отзыва закрылось')}</span>}
      </div>
      {done && closed && (
        <p className="text-[11px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Отзыв принимается 14 дней после завершения сделки — срок вышел')} {deadlineText}</p>
      )}
      {done && !closed && !sent && (
        <>
          <div className="flex items-center gap-1.5 mt-2">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setStars(n)} className="press text-[17px]" aria-label={`${n}`} style={{ color: n <= stars ? 'var(--gold-soft)' : 'var(--track)' }}>★</button>
            ))}
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={t('Что получилось, а что нет')} className="w-full mt-2 px-4 py-3 rounded-xl bg-[var(--bg)] text-[12.5px] outline-none resize-none placeholder:text-[var(--soft2)]" />
          {deadlineText && <p className="text-[10.5px] text-[var(--soft2)] mt-1.5">{t('Отзыв принимается до')} {deadlineText}</p>}
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
    /* Гостям канала нет — SMS не подключены (хвост владельца), поэтому
       «гости получают уведомление» здесь не стояло бы честно ни в одной
       форме. Уведомление уходит команде, гостям звонит пара. */
    how: t('План Б площадки согласован при бронировании: церемония переносится в зал, тенты и прозрачные зонты — красивые фото даже в дождь. При активации команде уйдёт уведомление; гостям о новой точке сбора сообщите сами.'),
    action: 'rain',
  },
  {
    icon: '🔌', title: t('Отключили электричество на площадке'),
    how: t('При бронировании площадка подтверждает наличие генератора — это пункт чек-листа договора. Запасной сценарий: свечи и накамерный свет фотографа превращают паузу в «зажжение семейного очага».'),
  },
  {
    icon: '⏰', title: t('Всё отстаёт от тайминга'),
    /* «Запас 15 минут заложен заранее» — автоплан такого не гарантирует; запас
       — дело пары при сборке тайминга. */
    how: t('В режиме дня X тайминг сдвигается одним тапом, и вся команда получает обновление. Запас в каждый блок закладывайте при сборке тайминга — тогда гости не заметят.'),
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
    /* Сводка для кейтеринга считает ровно по ответам гостей — запас в неё
       никто не «закладывает автоматически»; это совет, а не функция. */
    how: t('Попросите кейтеринг и площадку держать запас +2 места и порции: в сводке для кейтеринга стоит точное число по ответам гостей, запас добавьте сами. Координатор добавляет стулья без вашего участия.'),
  },
  {
    icon: '🚗', title: t('Автобус с гостями сломался или водитель приехал не туда'),
    /* Приложения для водителя нет: маршрут ему передают руками. */
    how: t('Маршрут и точки сбора передайте водителю заранее — приложения для водителя нет, и «думать сам» он не должен. Запасной вариант: второй автобус из раздела Логистики или такси-контракт, эскалация на координатора.'),
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

  /* Активация — необратимое уведомление всей команде, поэтому в два
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
          {/* «0%» без ответа сервера — не готовность, а её отсутствие. */}
          <div className="flex justify-between text-[12px] mb-2"><span className="font-semibold">{t('Чек-лист накануне')}</span><b className="tabular">{num(q, `${pct}%`)}</b></div>
          {ready(q) && <Bar pct={pct} />}
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
            ушли, когда не уходило ничего. Слова — ровно о том, что сервер
            сделал: записал сценарий и уведомил команду. Тайминг он не
            пересобирает, гостям не пишет — канала нет (ревью D4-07, R-174);
            «гости получили новую точку сбора» оставило бы их без звонка. */}
        {activated && (
          <div className="card p-4 fade-up" style={{ border: '1.5px solid var(--sage-deep)' }}>
            <b className="text-[13px]">🌧 {t('План «дождь» активирован')}</b>
            <p className="text-[11.5px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Сценарий зафиксирован, команде ушло уведомление. Гостям сообщите сами — SMS пока нет.')}</p>
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
                    <button disabled={busy} onClick={() => (confirmRain ? activate() : setConfirmRain(true))} className={cn('press mt-3 h-10 px-5 rounded-full text-[12px] font-semibold disabled:opacity-50', confirmRain ? 'bg-[var(--rose-deep)] text-[var(--card)]' : 'grad text-[var(--on-grad)]')}>
                      {busy ? t('Включаем…') : confirmRain ? t('Подтвердить: команде уйдёт уведомление') : t('Активировать план «дождь»')}
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
