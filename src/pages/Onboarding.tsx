import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/* Сцены онбординга: кольца → торт → букет → зал */
const scenes = [
  { icon: '💍', title: 'Все специалисты', text: 'Фотографы, декораторы, кондитеры — 35 категорий рядом с вами, в одном приложении.', tile: 'bg-[var(--rose-soft)]' },
  { icon: '🎂', title: 'Один день', text: 'Тайминг, план Б на дождь и live-режим: «+15 минут задержка» — и все участники узнают сразу.', tile: 'bg-[var(--honey)]' },
  { icon: '💐', title: 'Гости без хаоса', text: 'Именные приглашения, RSVP, рассадка и чат дня X. Мама справится за три тапа.', tile: 'bg-[var(--sage-soft)]' },
  { icon: '🏛️', title: 'Одно приложение', text: 'Договоры из шаблонов, бюджет с лимитами и ИИ-координатор, который помнит всё за вас.', tile: 'bg-[var(--lav)]' },
]

export default function Onboarding() {
  const nav = useNavigate()
  const [i, setI] = useState(0)
  const s = scenes[i]
  const last = i === scenes.length - 1
  return (
    <div className="min-h-dvh flex flex-col relative overflow-hidden">
      <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full opacity-40 blur-3xl" style={{ background: 'var(--rose-soft)' }} />
      <div className="absolute -bottom-20 -left-20 w-72 h-72 rounded-full opacity-40 blur-3xl" style={{ background: 'var(--sage-soft)' }} />

      <div className="flex justify-between items-center px-6 pt-8">
        <span className="font-serif-d text-[20px]">Тили-<em className="grad-text not-italic font-semibold">тили</em></span>
        <button onClick={() => nav('/auth')} className="text-[12px] text-[var(--soft)] font-medium press">Пропустить</button>
      </div>

      <div key={i} className="flex-1 flex flex-col items-center justify-center px-8 text-center fade-up">
        <div className={cn('w-[150px] h-[150px] rounded-[44px] flex items-center justify-center text-[64px] pop', s.tile)} style={{ boxShadow: 'var(--shadow)' }}>
          {s.icon}
        </div>
        <h1 className="font-serif-d text-[34px] mt-9 leading-tight">{s.title}</h1>
        <p className="text-[14px] text-[var(--soft)] leading-relaxed mt-4 max-w-[300px] font-light">{s.text}</p>
      </div>

      <div className="px-6 pb-[max(32px,env(safe-area-inset-bottom))]">
        <div className="flex justify-center gap-2 mb-6">
          {scenes.map((_, k) => (
            <span key={k} className={cn('h-1.5 rounded-full transition-all duration-500', k === i ? 'w-6 bg-[#C98A8A]' : 'w-1.5 bg-[#EAD9CF]')} />
          ))}
        </div>
        <div className="flex gap-3">
          {i > 0 && (
            <button onClick={() => setI(i - 1)} className="press w-[54px] h-[54px] rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label="Назад">
              <ChevronLeft size={20} />
            </button>
          )}
          <button
            onClick={() => (last ? nav('/auth') : setI(i + 1))}
            className="press flex-1 h-[54px] rounded-full grad text-white font-semibold text-[14px] tracking-wide flex items-center justify-center gap-2"
            style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
          >
            {last ? 'Начать' : 'Далее'} <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
