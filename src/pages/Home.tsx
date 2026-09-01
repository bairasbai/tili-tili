import { useNavigate } from 'react-router'
import { Bell } from 'lucide-react'
import { couple, aiTips, tasks, guests } from '@/lib/data'
import { AiTip, Bar, SectionHead, Tile } from '@/components/chrome'
import { useStore } from '@/lib/store'

export default function Home() {
  const nav = useNavigate()
  const { slots, city } = useStore()
  const booked = slots.filter(s => s.state === 'booked')
  const spent = booked.reduce((a, s) => a + (s.price ?? 0), 0)
  const teamPct = Math.round((booked.length / couple.teamTotal) * 100)
  const budgetPct = Math.round((spent / couple.budgetTotal) * 100)

  return (
    <div className="pb-28">
      <div className="flex items-center justify-between px-5 pt-7 pb-1">
        <span className="font-serif-d text-[20px]">Тили-<em className="grad-text not-italic font-semibold">тили</em></span>
        <button onClick={() => nav('/notifications')} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center relative" style={{ boxShadow: 'var(--shadow)' }} aria-label="Уведомления">
          <Bell size={17} />
          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#C98A8A]" />
        </button>
      </div>

      {/* Hero-карточка пары */}
      <div className="px-5 mt-3 fade-up">
        <div className="grad-anim sheen rounded-[32px] p-6 text-white relative overflow-hidden" style={{ boxShadow: '0 24px 60px -20px rgba(201,138,138,.55)' }}>
          <div className="absolute w-56 h-56 rounded-full bg-[var(--card)]/15 -top-24 -right-16" />
          <div className="absolute w-40 h-40 rounded-full bg-[var(--card)]/10 -bottom-16 -left-10" />
          <div className="absolute inset-0 rounded-[32px]" style={{ border: '1px solid rgba(255,255,255,.35)' }} />
          <h1 className="font-serif-d text-[28px] relative">{couple.bride} & {couple.groom}</h1>
          <p className="text-[12px] opacity-90 mt-1.5 relative">💍 {couple.date} · {couple.venue} · 16:00</p>
          <div className="grid grid-cols-4 gap-2 mt-5 relative">
            {[
              [Math.max(0, Math.ceil((Date.UTC(2027, 5, 14) - Date.now()) / 86400000)), 'дней до'],
              [`${teamPct}%`, 'готово'],
              [couple.guestsConfirmed, 'гостей'],
              [`${booked.length}/${couple.teamTotal}`, 'команда'],
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
              <div className="w-full h-full rounded-full bg-[#C98A8A] text-white font-serif-d text-[22px] flex items-center justify-center border-2 border-white">А</div>
            </div>
            <div className="w-14 h-14 rounded-full grad p-[2.5px]">
              <div className="w-full h-full rounded-full bg-[#A9BCA0] text-white font-serif-d text-[22px] flex items-center justify-center border-2 border-white">Т</div>
            </div>
          </div>
          <b className="font-serif-d text-[16px] block mt-2.5">{couple.full}</b>
          <p className="text-[11px] text-[var(--soft)] mt-1">📍 {city} · 🎨 {couple.style} · 🥂 {couple.guestsTotal} гостей</p>
          <div className="grid grid-cols-4 gap-2 mt-4">
            {[[couple.countdown.m, 'МЕС'], [couple.countdown.d, 'ДН'], [couple.countdown.h, 'ЧАС'], [couple.countdown.min, 'МИН']].map(([v, l]) => (
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
            <span className="text-[10px] tracking-[.2em] uppercase text-[var(--soft)] font-semibold">Бюджет</span>
            <span className="text-[12px] font-bold text-[#B57171]">{budgetPct}%</span>
          </div>
          <div className="flex justify-between items-baseline mt-1.5">
            <b className="font-serif-d text-[22px] tabular">{spent.toLocaleString('ru-RU')} ₽</b>
            <span className="text-[11px] text-[var(--soft)]">из {couple.budgetTotal.toLocaleString('ru-RU')} ₽</span>
          </div>
          <div className="mt-3"><Bar pct={budgetPct} /></div>
        </button>
      </div>

      {/* Совет ИИ */}
      <div className="px-5 fade-up" style={{ animationDelay: '.2s' }}>
        <div className="mt-4"><AiTip text={aiTips[0]} onPress={() => nav('/assistant')} /></div>
      </div>

      {/* Быстрые действия */}
      <div className="px-5 mt-4 grid grid-cols-3 gap-2.5 fade-up" style={{ animationDelay: '.18s' }}>
        {[
          ['✦', 'bg-[var(--rose-soft)]', 'Спросить', '/assistant'],
          ['📅', 'bg-[var(--honey)]', 'Тайминг', '/wedding/timeline'],
          ['💌', 'bg-[var(--lav)]', 'Пригласить', '/wedding/invites'],
          ['📊', 'bg-[var(--sage-soft)]', 'Сравнить', '/compare'],
          ['🗺', 'bg-[var(--blue)]', 'Площадки', '/venues'],
          ['✨', 'bg-[var(--rose-soft)]', 'Идеи', '/inspiration'],
        ].map(([ic, tile, l, to]) => (
          <button key={l} onClick={() => nav(to)} className="press card-s py-3 flex flex-col items-center gap-1.5">
            <span className={`w-9 h-9 rounded-[12px] ${tile} flex items-center justify-center text-[15px]`}>{ic}</span>
            <span className="text-[9.5px] font-semibold text-[var(--ink2)]">{l}</span>
          </button>
        ))}
      </div>

      {/* Ближайшие дедлайны */}
      <div className="px-5 fade-up" style={{ animationDelay: '.22s' }}>
        <SectionHead title="Ближайшие дедлайны" link="Чек-лист →" onLink={() => nav('/wedding/checklist')} />
        <div className="card px-4 py-1.5 mt-2">
          {tasks.filter(t => !t.done).slice(0, 3).map((t, i, arr) => (
            <button key={t.id} onClick={() => nav('/wedding/checklist')} className={`press w-full flex items-center gap-3 py-3 text-left ${i !== arr.length - 1 ? 'border-b border-[var(--track)]' : ''}`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${t.urgent ? 'bg-[#C98A8A]' : 'bg-[#A9BCA0]'}`} />
              <span className="flex-1 text-[12.5px] font-medium truncate">{t.title}</span>
              <span className={`text-[10px] font-bold shrink-0 ${t.urgent ? 'text-[#B57171]' : 'text-[var(--soft)]'}`}>{t.due}</span>
            </button>
          ))}
        </div>
      </div>

      {/* RSVP сводка */}
      <div className="px-5 fade-up" style={{ animationDelay: '.26s' }}>
        <button onClick={() => nav('/wedding/guests')} className="press w-full card p-4 mt-3.5 flex items-center gap-3 text-left">
          <Tile icon="💌" tile="bg-[var(--lav)]" size={44} />
          <div className="flex-1">
            <b className="text-[13px]">Приглашения</b>
            <p className="text-[11px] text-[var(--soft)] mt-0.5">{guests.filter(g => g.status === 'yes').length * 3} подтвердили · {guests.filter(g => g.status === 'pending').length * 4} ждут ответа</p>
          </div>
          <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--rose-soft)] text-[#B57171] shrink-0">RSVP →</span>
        </button>
      </div>

      {/* Команда */}
      <div className="px-5">
        <SectionHead title="Моя команда" sub="Уже забронировано" link={`Все →`} onLink={() => nav('/wedding')} />
        <div className="space-y-2.5 mt-2 stagger">
          {booked.map(s => (
            <button key={s.id} onClick={() => nav('/wedding')} className="press w-full card-s p-3.5 flex items-center gap-3 text-left fade-up">
              <Tile icon={s.icon} tile={s.tile} />
              <div className="flex-1 min-w-0">
                <b className="text-[13.5px] block truncate">{s.vendor}</b>
                <span className="text-[10.5px] text-[var(--soft)]">{s.label}</span>
                {s.price && <span className="text-[12px] text-[#B57171] font-bold block mt-0.5 tabular">{s.price.toLocaleString('ru-RU')} ₽</span>}
              </div>
              <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--sage-soft)] text-[#7E9A74] shrink-0">✓ Забронирован</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
