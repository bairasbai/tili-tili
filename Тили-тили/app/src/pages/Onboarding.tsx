import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t, reloadToRoot } from '@/lib/i18n'
import { useStore } from '@/lib/store'

/* Сцены онбординга: кольца → торт → букет → зал */
const scenes = [
  { icon: '💍', title: t('Все специалисты'), text: t('Фотографы, декораторы, кондитеры — 35 категорий рядом с вами, в одном приложении.'), tile: 'bg-[var(--rose-soft)]' },
  /* Обещания — только про то, что есть в коде (R-174): сдвиг тайминга уходит
     уведомлением команде (гостям — когда подключат SMS), а «ИИ-координатора»
     нет — помощник пока собирает вопросы и честно об этом говорит. */
  { icon: '🎂', title: t('Один день'), text: t('Тайминг, план Б на дождь и live-режим: «+15 минут задержка» — и вся команда узнаёт сразу.'), tile: 'bg-[var(--honey)]' },
  { icon: '💐', title: t('Гости без хаоса'), text: t('Именные приглашения, RSVP, рассадка и чат дня X. Мама справится за три тапа.'), tile: 'bg-[var(--sage-soft)]' },
  { icon: '🏛️', title: t('Одно приложение'), text: t('Договоры из шаблонов, бюджет с лимитами и чек-лист, который помнит сроки за вас.'), tile: 'bg-[var(--lav)]' },
]

export default function Onboarding() {
  const nav = useNavigate()
  const [i, setI] = useState(0)
  const { lang, setLang } = useStore()
  const s = scenes[i]
  const last = i === scenes.length - 1
  return (
    <div className="min-h-dvh flex flex-col relative overflow-hidden">
      <div aria-hidden className="absolute -top-24 -right-24 w-72 h-72 rounded-full opacity-40 blur-3xl pointer-events-none" style={{ background: 'var(--rose-soft)' }} />
      <div aria-hidden className="absolute -bottom-20 -left-20 w-72 h-72 rounded-full opacity-40 blur-3xl pointer-events-none" style={{ background: 'var(--sage-soft)' }} />

      <div className="flex justify-between items-center px-6 pt-8">
        <span className="font-serif-d text-[20px]">{t('Тили-')}<em className="grad-text not-italic font-semibold">{t('тили')}</em></span>
        <div className="flex items-center gap-3">
          <button onClick={() => { setLang(lang === 'ru' ? 'en' : 'ru'); reloadToRoot() }}
            className="text-[11px] font-bold text-[var(--rose-ink)] press px-2.5 py-1.5 rounded-full bg-[var(--rose-soft)]">{lang === 'ru' ? 'EN' : 'RU'}</button>
          <button onClick={() => nav('/auth')} className="text-[12px] text-[var(--soft)] font-medium press py-3 -my-3 px-2 -mx-2">{t('Пропустить')}</button>
        </div>
      </div>

      <div key={i} className="flex-1 flex flex-col items-center justify-center px-8 text-center fade-up">
        <div className={cn('w-[150px] h-[150px] rounded-[44px] flex items-center justify-center text-[64px] pop', s.tile)} style={{ boxShadow: 'var(--shadow)' }}>
          {s.icon}
        </div>
        <h1 className="font-serif-d text-[34px] mt-9 leading-tight">{s.title}</h1>
        <p className="text-[14px] text-[var(--soft)] leading-relaxed mt-4 max-w-[300px] font-light">{s.text}</p>
      </div>

      <div className="px-6 pb-[max(32px,env(safe-area-inset-bottom))]">
        <div className="flex justify-center -mt-3 mb-3">
          {scenes.map((_, k) => (
            <button key={k} onClick={() => setI(k)} aria-label={`${t('Слайд')} ${k + 1}`}
              className="w-6 h-11 grid place-items-center press">
              <span className={cn('h-1.5 rounded-full transition-all duration-500', k === i ? 'w-6 bg-[var(--rose)]' : 'w-1.5 bg-[var(--line)]')} />
            </button>
          ))}
        </div>
        <div className="flex gap-3">
          {i > 0 && (
            <button onClick={() => setI(i - 1)} className="press w-[54px] h-[54px] rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
              <ChevronLeft size={20} />
            </button>
          )}
          <button
            onClick={() => (last ? nav('/auth') : setI(i + 1))}
            className="press flex-1 h-[54px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px] tracking-wide flex items-center justify-center gap-2"
            style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
          >
            {last ? t('Начать') : t('Далее')} <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
