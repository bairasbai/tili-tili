import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Check } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

interface Step { q: string; hint?: string; opts: string[]; multi?: boolean }

const steps: Step[] = [
  { q: 'Когда ваша свадьба?', hint: 'Дату можно изменить позже', opts: ['14 июня 2027', 'Примерно — лето 2027', 'Ещё не решили'] },
  { q: 'Город праздника?', opts: ['Уфа', 'Москва', 'Казань', 'Другой город'] },
  { q: 'Сколько гостей?', opts: ['До 30', '30–60', '60–100', '100+'] },
  { q: 'Общий бюджет?', hint: 'Можно примерно — поможем распределить', opts: ['До 500 тыс ₽', '500 тыс — 1 млн ₽', '1–2 млн ₽', '2 млн+ ₽', 'Пока не знаем'] },
  { q: 'Какой формат?', opts: ['Классика: ЗАГС + банкет', 'Выездная церемония', 'Камерная свадьба', 'Банкет+ на 2 дня'] },
  { q: 'Стиль и настроение?', opts: ['🤍 Классика', '🌿 Бохо', '◻️ Минимализм', '✨ Люкс', '🌾 Рустик', '🖤 Модерн'] },
  { q: 'Кто планирует?', opts: ['Сами', 'С помощью агентства', 'Ищем координатора'] },
  { q: 'Что уже забронировано?', multi: true, opts: ['Площадка', 'Фотограф', 'Видеограф', 'Ведущий', 'Пока ничего'] },
]

export default function Quiz() {
  const nav = useNavigate()
  const { finishOnboarding } = useStore()
  const [i, setI] = useState(0)
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const s = steps[i]
  const sel = answers[i] ?? []
  const last = i === steps.length - 1
  const canNext = sel.length > 0

  const pick = (o: string) => {
    setAnswers(a => {
      const cur = a[i] ?? []
      if (s.multi) return { ...a, [i]: cur.includes(o) ? cur.filter(x => x !== o) : [...cur, o] }
      return { ...a, [i]: [o] }
    })
  }
  const next = () => {
    if (!last) return setI(i + 1)
    finishOnboarding()
    nav('/home')
  }

  return (
    <div className="min-h-dvh flex flex-col">
      <div className="flex items-center gap-3 px-5 pt-6">
        {i > 0 ? (
          <button onClick={() => setI(i - 1)} className="press w-10 h-10 rounded-full bg-white flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label="Назад">
            <ChevronLeft size={18} />
          </button>
        ) : <div className="w-10" />}
        <div className="flex-1 h-1.5 rounded-full bg-[#F1E9E2] overflow-hidden">
          <div className="h-full grad rounded-full transition-all duration-500" style={{ width: `${((i + 1) / steps.length) * 100}%` }} />
        </div>
        <span className="text-[11px] text-[#93897F] font-semibold w-8 text-right tabular">{i + 1}/{steps.length}</span>
      </div>

      <div key={i} className="flex-1 px-6 pt-8 fade-up">
        <h1 className="font-serif-d text-[30px] leading-tight">{s.q}</h1>
        {s.hint && <p className="text-[12.5px] text-[#93897F] mt-2">{s.hint}</p>}
        {s.multi && <p className="text-[12.5px] text-[#93897F] mt-2">Можно выбрать несколько</p>}
        <div className="mt-6 space-y-2.5 stagger">
          {s.opts.map(o => {
            const on = sel.includes(o)
            return (
              <button key={o} onClick={() => pick(o)} className={cn('press w-full card-s p-4 flex items-center justify-between text-left text-[14px] fade-up', on && 'ring-2 ring-[#C98A8A]')}>
                <span className="font-medium">{o}</span>
                <span className={cn('w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all', on ? 'bg-[#C98A8A] border-[#C98A8A]' : 'border-[#EAD9CF]')}>
                  {on && <Check size={13} color="#fff" strokeWidth={3} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="px-6 pb-[max(28px,env(safe-area-inset-bottom))] pt-4">
        <button
          onClick={next}
          disabled={!canNext}
          className={cn('press w-full h-[54px] rounded-full grad text-white font-semibold text-[14px] tracking-wide transition-opacity', !canNext && 'opacity-40')}
          style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
        >
          {last ? 'Создать мою свадьбу ✨' : 'Далее'}
        </button>
        {!last && <button onClick={next} className="w-full text-center text-[12px] text-[#93897F] mt-3 press">Пропустить вопрос</button>}
      </div>
    </div>
  )
}
