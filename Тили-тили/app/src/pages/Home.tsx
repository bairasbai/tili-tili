import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Bell, Sparkles, CalendarDays, Mail, BarChart3, Map, Lightbulb } from 'lucide-react'
import { useApi } from '@/lib/api/useApi'
import { getBudget, getGuests, getTasks, getWedding } from '@/lib/api/weddingData'
import { AiTip, Bar, SectionHead, Tile } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { t as tr } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { countdownTo, daysUntil, formatWeddingDate, shortWeddingDate } from '@/lib/weddingDate'

export default function Home() {
  const nav = useNavigate()
  const { slots, weddingDate, weddingId } = useStore()
  /* «Сейчас» снимается один раз за монтирование: время в теле компонента
   * запрещено (R-04), а отсчёт до свадьбы не обязан тикать посекундно —
   * до неё месяцы. */
  const [now] = useState(() => new Date())
  const left = countdownTo(weddingDate, now)
  const booked = slots.filter(s => s.state === 'booked')

  /*
   * Главная берёт те же числа, что и разделы, — с сервера.
   *
   * Пока она считала по мокам, а бюджет и гости уже читали сервер, экран
   * противоречил сам себе: здесь «677 000 ₽ из 1 200 000» и «5 гостей», а на
   * своих экранах — ноль и ноль. Пара перестаёт верить обоим числам, и
   * правильнее из них не то, которое красивее.
   */
  const bq = useApi(() => weddingId ? getBudget(weddingId) : Promise.resolve(null), [weddingId])
  const gq = useApi(() => weddingId ? getGuests(weddingId) : Promise.resolve([]), [weddingId])
  const tq = useApi(() => weddingId ? getTasks(weddingId) : Promise.resolve([]), [weddingId])
  const wq = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])

  const serverGuests = gq.data ?? []
  const persons = (status: 'yes' | 'no' | 'pending') =>
    serverGuests.filter(g => (g.status ?? 'pending') === status).reduce((a, g) => a + 1 + (g.plusOne ? 1 : 0), 0)

  const serverTasks = tq.data ?? []
  const doneCount = serverTasks.filter(x => x.done).length
  const totalTasks = serverTasks.length
  const donePct = totalTasks ? Math.round((doneCount / totalTasks) * 100) : 0

  /* Бюджет целиком с сервера: свои статьи расхода он уже учёл. Прибавлять к
     его сумме локальный список `tt_budget_custom` было двойным счётом — та же
     статья попадала в итог дважды, как только доезжала на сервер. */
  const budgetTotal = bq.data?.total?.amount ?? 0
  const spent = bq.data?.spent?.amount ?? 0
  const budgetPct = budgetTotal ? Math.round((spent / budgetTotal) * 100) : 0
  /*
   * О чём сказать на главной. Берём первое незакрытое из того, что видно по
   * данным, и молчим, когда сказать нечего: подсказка «ни о чём» обесценивает
   * все остальные.
   */
  const homeTip = !weddingDate
    ? tr('Выберите дату свадьбы — от неё считаются сроки в чек-листе и занятость подрядчиков.')
    : totalTasks && doneCount === 0
      ? tr('Чек-лист готов. Начните с первого пункта — остальные подтянутся по срокам.')
      : serverGuests.length === 0
        ? tr('Добавьте гостей — от их числа зависят площадка, кейтеринг и рассадка.')
        : tr('Спросите Тиля, если не знаете, с чего продолжить.')
  /* Ни имени, ни города не выдумываем: пустая свадьба выглядит пустой, а не
     чужой. Раньше подставлялись «Алина & Тимур» и «Уфа» из моков. */
  const title = wq.data?.title ?? tr('Ваша свадьба')
  const cityName = wq.data?.city?.name ?? null
  const guestsPlanned = wq.data?.guestsPlanned ?? null
  const style = wq.data?.style ?? null

  return (
    <div className="pb-28">
      <div className="flex items-center justify-between px-5 pt-7 pb-1">
        <span className="font-serif-d text-[20px]">{tr('Тили-')}<em className="grad-text not-italic font-semibold">{tr('тили')}</em></span>
        <button onClick={() => nav('/notifications')} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center relative" style={{ boxShadow: 'var(--shadow)' }} aria-label={tr('Уведомления')}>
          <Bell size={17} />
          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#C98A8A]" />
        </button>
      </div>

      {/* Hero-карточка пары */}
      <div className="px-5 mt-3 fade-up">
        <div className="grad-anim sheen rounded-[32px] p-6 text-[var(--on-grad)] relative overflow-hidden" style={{ boxShadow: '0 24px 60px -20px rgba(201,138,138,.55)' }}>
          <div className="absolute w-56 h-56 rounded-full bg-[var(--card)]/15 -top-24 -right-16" />
          <div className="absolute w-40 h-40 rounded-full bg-[var(--card)]/10 -bottom-16 -left-10" />
          <div className="absolute inset-0 rounded-[32px]" style={{ border: '1px solid rgba(255,255,255,.35)' }} />
          <h1 className="font-serif-d text-[28px] relative">{title}</h1>
          {/* Площадка и час брались из мока — «Усадьба «Липовый сад» · 16:00» стояли
              у всех. Площадка появится, когда её забронируют; час дня — в тайминге. */}
          <p className="text-[12px] opacity-90 mt-1.5 relative">💍 {[weddingDate ? formatWeddingDate(weddingDate) : tr('Дата не выбрана'), cityName].filter(Boolean).join(' · ')}</p>
          <div className="grid grid-cols-4 gap-2 mt-5 relative">
            {[
              [weddingDate ? daysUntil(weddingDate, now) : '—', tr('дней до')],
              [`${donePct}%`, tr('готово')],
              [persons('yes'), tr('гостей')],
              [`${booked.length}/${slots.length}`, tr('команда')],
            ].map(([v, l]) => (
              <div key={String(l)} className="bg-[var(--card)]/25 rounded-2xl py-3 text-center backdrop-blur-sm">
                <b className="text-[19px] block tabular">{v}</b>
                <span className="text-[8.5px] opacity-90">{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Обратный отсчёт */}
      <div className="px-5 fade-up" style={{ animationDelay: '.1s' }}>
        <div className="card p-5 mt-4 text-center">
          <div className="flex justify-center -space-x-3.5">
            <div className="w-14 h-14 rounded-full grad p-[2.5px]">
              <div className="w-full h-full rounded-full bg-[#C98A8A] text-[var(--on-grad)] font-serif-d text-[22px] flex items-center justify-center border-2 border-white">{tr('А')}</div>
            </div>
            <div className="w-14 h-14 rounded-full grad p-[2.5px]">
              <div className="w-full h-full rounded-full bg-[#A9BCA0] text-[var(--on-grad)] font-serif-d text-[22px] flex items-center justify-center border-2 border-white">{tr('Т')}</div>
            </div>
          </div>
          <b className="font-serif-d text-[16px] block mt-2.5">{title}</b>
          {/* Город, стиль и число гостей — то, что известно о свадьбе. Чего
              нет, того не рисуем: раньше пустые поля подменялись моком. */}
          <p className="text-[11px] text-[var(--soft)] mt-1">
            {[cityName ? `📍 ${cityName}` : null, style ? `🎨 ${style}` : null, guestsPlanned ? `🥂 ${guestsPlanned} ${tr('гостей')}` : null].filter(Boolean).join(' · ') || tr('Город пока не выбран')}
          </p>
          <div className="grid grid-cols-4 gap-2 mt-4">
            {[[left.m, tr('МЕС')], [left.d, tr('ДН')], [left.h, tr('ЧАС')], [left.min, tr('МИН')]].map(([v, l]) => (
              <div key={String(l)} className="bg-[var(--bg)] rounded-2xl py-3">
                <b className="text-[19px] block tabular">{String(v).padStart(2, '0')}</b>
                <span className="text-[8px] tracking-[.14em] text-[var(--soft)]">{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Бюджет */}
      <div className="px-5 fade-up" style={{ animationDelay: '.15s' }}>
        <button className="press w-full text-left card p-5 mt-4" onClick={() => nav('/wedding/budget')}>
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">{tr('Бюджет')}</span>
            <span className="text-[12px] font-bold text-[var(--rose-deep)]">{budgetPct}%</span>
          </div>
          <div className="flex justify-between items-baseline mt-1.5">
            <b className="font-serif-d text-[22px] tabular">{fmt(spent)}</b>
            <span className="text-[11px] text-[var(--soft)]">{tr('из')} {fmt(budgetTotal)}</span>
          </div>
          <div className="mt-3"><Bar pct={budgetPct} /></div>
        </button>
      </div>

      {/* Совет ИИ */}
      <div className="px-5 fade-up" style={{ animationDelay: '.2s' }}>
        {/* Подсказка строится из состояния свадьбы, а не выбирается из
            заготовленного списка. Здесь стояло «Топ-фотографы Уфы на июнь
            разбираются за 8 месяцев. Свободных на 14.06 осталось 6» — цифры
            и дата ни с чем не связаны, а «осталось 6» выглядит как результат
            запроса к каталогу, которого не было. */}
        <div className="mt-4"><AiTip text={homeTip} onPress={() => nav('/assistant')} /></div>
      </div>

      {/* Быстрые действия */}
      <div className="px-5 mt-4 grid grid-cols-3 md:grid-cols-6 gap-2.5 fade-up" style={{ animationDelay: '.18s' }}>
        {([
          { Ico: Sparkles, tile: 'bg-[var(--rose-soft)]', l: tr('Спросить'), to: '/assistant' },
          { Ico: CalendarDays, tile: 'bg-[var(--honey)]', l: tr('Тайминг'), to: '/wedding/timeline' },
          { Ico: Mail, tile: 'bg-[var(--lav)]', l: tr('Пригласить'), to: '/wedding/invites' },
          { Ico: BarChart3, tile: 'bg-[var(--sage-soft)]', l: tr('Сравнить'), to: '/compare' },
          { Ico: Map, tile: 'bg-[var(--blue)]', l: tr('Площадки'), to: '/venues' },
          { Ico: Lightbulb, tile: 'bg-[var(--rose-soft)]', l: tr('Идеи'), to: '/inspiration' },
        ]).map(({ Ico, tile, l, to }) => (
          <button key={l} onClick={() => nav(to)} className="press card-s py-3 flex flex-col items-center gap-1.5">
            <span className={`w-9 h-9 rounded-[12px] ${tile} flex items-center justify-center`}><Ico size={16} className="text-[var(--ink2)]" /></span>
            <span className="text-[9.5px] font-semibold text-[var(--ink2)]">{l}</span>
          </button>
        ))}
      </div>

      {/* Ближайшие дедлайны */}
      <div className="px-5 fade-up" style={{ animationDelay: '.22s' }}>
        <SectionHead title={tr('Ближайшие дедлайны')} link={tr('Чек-лист →')} onLink={() => nav('/wedding/checklist')} />
        <div className="card px-4 py-1.5 mt-2">
          {serverTasks.filter(x => !x.done).slice(0, 3).map((t, i, arr) => (
            <button key={t.id} onClick={() => nav('/wedding/checklist')} className={`press w-full flex items-center gap-3 py-3 text-left ${i !== arr.length - 1 ? 'border-b border-[var(--track)]' : ''}`}>
              {/* Признака срочности в контракте нет — цветной точки, которая
                  что-то означает, тоже. Срок сервер считает от даты свадьбы:
                  показываем его, пока даты нет — период («за 9 месяцев»). */}
              <span className="flex-1 text-[12.5px] font-medium truncate">{t.title}</span>
              <span className="text-[10px] font-bold shrink-0 text-[var(--soft)]">{t.due ? shortWeddingDate(t.due) : t.period ? `${t.period} ${tr('мес')}` : ''}</span>
            </button>
          ))}
        </div>
      </div>

      {/* RSVP сводка */}
      <div className="px-5 fade-up" style={{ animationDelay: '.26s' }}>
        <button onClick={() => nav('/wedding/guests')} className="press w-full card p-4 mt-3.5 flex items-center gap-3 text-left">
          <Tile icon="💌" tile="bg-[var(--lav)]" size={44} />
          <div className="flex-1">
            <b className="text-[13px]">{tr('Приглашения')}</b>
            <p className="text-[11px] text-[var(--soft)] mt-0.5">{persons('yes')}{tr(' подтвердили')} · {persons('pending')} {tr('ждут ответа')}</p>
          </div>
          <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] shrink-0">RSVP →</span>
        </button>
      </div>

      {/* Команда */}
      <div className="px-5">
        <SectionHead title={tr('Моя команда')} sub={tr('Уже забронировано')} link={tr('Все →')} onLink={() => nav('/wedding')} />
        <div className="space-y-2.5 mt-2 stagger">
          {booked.map(s => (
            <button key={s.id} onClick={() => nav('/wedding')} className="press w-full card-s p-3.5 flex items-center gap-3 text-left fade-up">
              <Tile icon={s.icon} tile={s.tile} cat={s.categoryId} />
              <div className="flex-1 min-w-0">
                <b className="text-[13.5px] block truncate">{s.vendor}</b>
                <span className="text-[10.5px] text-[var(--soft)]">{s.label}</span>
                {s.price && <span className="text-[12px] text-[var(--rose-deep)] font-bold block mt-0.5 tabular">{fmt(s.price)}</span>}
              </div>
              <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] shrink-0">{tr('✓ Забронирован')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
