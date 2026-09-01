import { useNavigate } from 'react-router'
import { Bell } from 'lucide-react'
import { couple, aiTips } from '@/lib/data'
import { AiTip, Bar, SectionHead, Tile } from '@/components/chrome'
import { useStore } from '@/lib/store'

export default function Home() {
  const nav = useNavigate()
  const { slots } = useStore()
  const booked = slots.filter(s => s.state === 'booked')
  const teamPct = Math.round((couple.teamBooked / couple.teamTotal) * 100)
  const budgetPct = Math.round((couple.budgetSpent / couple.budgetTotal) * 100)

  return (
    <div className="pb-28">
      <div className="flex items-center justify-between px-5 pt-7 pb-1">
        <span className="font-serif-d text-[20px]">Тили-<em className="grad-text not-italic font-semibold">тили</em></span>
        <button onClick={() => nav('/notifications')} className="press w-10 h-10 rounded-full bg-white flex items-center justify-center relative" style={{ boxShadow: 'var(--shadow)' }} aria-label="Уведомления">
          <Bell size={17} />
          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#C98A8A]" />
        </button>
      </div>

      {/* Hero-карточка пары */}
      <div className="px-5 mt-3 fade-up">
        <div className="grad rounded-[32px] p-6 text-white relative overflow-hidden">
          <div className="absolute w-56 h-56 rounded-full bg-white/15 -top-24 -right-16" />
          <h1 className="font-serif-d text-[28px] relative">{couple.bride} & {couple.groom}</h1>
          <p className="text-[12px] opacity-90 mt-1.5 relative">💍 {couple.date} · {couple.venue} · 16:00</p>
          <div className="grid grid-cols-4 gap-2 mt-5 relative">
            {[
              [couple.daysLeft, 'дней до'],
              [`${teamPct}%`, 'готово'],
              [couple.guestsConfirmed, 'гостей'],
              ['4/14', 'команда'],
            ].map(([v, l]) => (
              <div key={String(l)} className="bg-white/25 rounded-2xl py-3 text-center backdrop-blur-sm">
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
            <div className="w-14 h-14 rounded-full bg-[#C98A8A] text-white font-serif-d text-[22px] flex items-center justify-center border-[3.5px] border-white">А</div>
            <div className="w-14 h-14 rounded-full bg-[#A9BCA0] text-white font-serif-d text-[22px] flex items-center justify-center border-[3.5px] border-white">Т</div>
          </div>
          <b className="font-serif-d text-[16px] block mt-2.5">{couple.full}</b>
          <p className="text-[11px] text-[#93897F] mt-1">📍 {couple.city} · 🎨 {couple.style} · 🥂 {couple.guestsTotal} гостей</p>
          <div className="grid grid-cols-4 gap-2 mt-4">
            {[[couple.countdown.m, 'МЕС'], [couple.countdown.d, 'ДН'], [couple.countdown.h, 'ЧАС'], [couple.countdown.min, 'МИН']].map(([v, l]) => (
              <div key={String(l)} className="bg-[#FBF6F1] rounded-2xl py-3">
                <b className="text-[19px] block tabular">{String(v).padStart(2, '0')}</b>
                <span className="text-[8px] tracking-[.14em] text-[#93897F]">{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Бюджет */}
      <div className="px-5 fade-up" style={{ animationDelay: '.15s' }}>
        <button className="press w-full text-left card p-5 mt-4" onClick={() => nav('/wedding/budget')}>
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] tracking-[.2em] uppercase text-[#93897F] font-semibold">Бюджет</span>
            <span className="text-[12px] font-bold text-[#B57171]">{budgetPct}%</span>
          </div>
          <div className="flex justify-between items-baseline mt-1.5">
            <b className="font-serif-d text-[22px] tabular">{couple.budgetSpent.toLocaleString('ru-RU')} ₽</b>
            <span className="text-[11px] text-[#93897F]">из {couple.budgetTotal.toLocaleString('ru-RU')} ₽</span>
          </div>
          <div className="mt-3"><Bar pct={budgetPct} /></div>
        </button>
      </div>

      {/* Совет ИИ */}
      <div className="px-5 fade-up" style={{ animationDelay: '.2s' }}>
        <div className="mt-4"><AiTip text={aiTips[0]} onPress={() => nav('/assistant')} /></div>
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
                <span className="text-[10.5px] text-[#93897F]">{s.label}</span>
                {s.price && <span className="text-[12px] text-[#B57171] font-bold block mt-0.5 tabular">{s.price.toLocaleString('ru-RU')} ₽</span>}
              </div>
              <span className="text-[9px] font-bold px-2.5 py-1.5 rounded-full bg-[#E6EEE2] text-[#7E9A74] shrink-0">✓ Забронирован</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
