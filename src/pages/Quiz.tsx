import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, Check, MapPin, Search } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CityPicker } from '@/components/CityPicker'
import { t } from '@/lib/i18n'

interface Step { q: string; hint?: string; opts: string[]; multi?: boolean }

const steps: Step[] = [
  { q: t('Когда ваша свадьба?'), hint: t('Дату можно изменить позже'), opts: [t('14 июня 2027'), t('Примерно — лето 2027'), t('Ещё не решили')] },
  { q: t('Сколько гостей?'), opts: [t('До 30'), '30–60', '60–100', '100+'] },
  { q: t('Общий бюджет?'), hint: t('Можно примерно — поможем распределить'), opts: [t('До 500 тыс ₽'), t('500 тыс — 1 млн ₽'), t('1–2 млн ₽'), t('2 млн+ ₽'), t('Пока не знаем')] },
  { q: t('Какой формат?'), opts: [t('Классика: ЗАГС + банкет'), t('Выездная церемония'), t('Камерная свадьба'), t('Банкет+ на 2 дня')] },
  { q: t('Стиль и настроение?'), opts: [t('🤍 Классика'), t('🌿 Бохо'), t('◻️ Минимализм'), t('✨ Люкс'), t('🌾 Рустик'), t('🖤 Модерн')] },
  { q: t('Кто планирует?'), opts: [t('Сами'), t('С помощью агентства'), t('Ищем координатора')] },
  { q: t('Что уже забронировано?'), multi: true, opts: [t('Площадка'), t('Фотограф'), t('Видеограф'), t('Ведущий'), t('Пока ничего')] },
]

export default function Quiz() {
  const nav = useNavigate()
  const { finishOnboarding, city, cityRegion, setCity } = useStore()
  const [i, setI] = useState(0)
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const [picker, setPicker] = useState(false)
  const CITY_STEP = 1
  const total = steps.length + 1 // + шаг города
  const cityDone = i === CITY_STEP && !!answers[CITY_STEP]
  const s = i < CITY_STEP ? steps[i] : steps[i - 1]
  const sel = answers[i] ?? []
  const last = i === total - 1
  const canNext = i === CITY_STEP ? cityDone : sel.length > 0

  const pick = (o: string) => {
    setAnswers(a => {
      const cur = a[i] ?? []
      if (s?.multi) return { ...a, [i]: cur.includes(o) ? cur.filter(x => x !== o) : [...cur, o] }
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
          <button onClick={() => setI(i - 1)} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
            <ChevronLeft size={18} />
          </button>
        ) : <div className="w-10" />}
        <div className="flex-1 h-1.5 rounded-full bg-[var(--track)] overflow-hidden">
          <div className="h-full grad rounded-full transition-all duration-500" style={{ width: `${((i + 1) / total) * 100}%` }} />
        </div>
        <span className="text-[11px] text-[var(--soft)] font-semibold w-8 text-right tabular">{i + 1}/{total}</span>
      </div>

      {i === CITY_STEP ? (
        <div key="city" className="flex-1 px-6 pt-8 fade-up">
          <h1 className="font-serif-d text-[30px] leading-tight">{t('Город праздника?')}</h1>
          <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('Работаем по всей России — от Уфы до райцентров вроде Сибая и Баймака')}</p>
          <button onClick={() => setPicker(true)} className="press w-full mt-6 card-s p-4 flex items-center gap-3 text-left">
            <Search size={16} className="text-[var(--soft2)]" />
            {cityDone ? (
              <span className="flex-1 flex items-center gap-2">
                <b className="text-[14px]">{city}</b>
                <span className="text-[10.5px] text-[var(--soft)]">{cityRegion}</span>
              </span>
            ) : (
              <span className="flex-1 text-[13.5px] text-[var(--soft2)]">{t('Начните вводить название…')}</span>
            )}
            <MapPin size={15} className="text-[#C98A8A]" />
          </button>
          <div className="flex flex-wrap gap-2 mt-4">
            {[t('Уфа'), t('Сибай'), t('Баймак'), t('Стерлитамак'), t('Москва'), t('Казань')].map(n => (
              <button key={n} onClick={() => { setCity(n, n === 'Москва' ? 'Москва' : n === 'Казань' ? 'Татарстан' : 'Башкортостан'); setAnswers(a => ({ ...a, [i]: [n] })) }}
                className={cn('press px-3.5 py-2 rounded-full text-[11.5px] font-semibold', sel.includes(n) ? 'grad text-white' : 'bg-[var(--card)] text-[var(--ink2)]')}
                style={{ boxShadow: 'var(--shadow)' }}>{n}</button>
            ))}
          </div>
          <p className="text-[10.5px] text-[var(--soft2)] mt-5 leading-relaxed">{t('💡 Подрядчики из соседних городов (Магнитогорск, Орск, Уфа) автоматически попадут в выдачу с отметкой «выезд».')}</p>
        </div>
      ) : (
      <div key={i} className="flex-1 px-6 pt-8 fade-up">
        <h1 className="font-serif-d text-[30px] leading-tight">{s.q}</h1>
        {s.hint && <p className="text-[12.5px] text-[var(--soft)] mt-2">{s.hint}</p>}
        {s.multi && <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('Можно выбрать несколько')}</p>}
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
      )}

      <div className="px-6 pb-[max(28px,env(safe-area-inset-bottom))] pt-4">
        <button
          onClick={next}
          disabled={!canNext}
          className={cn('press w-full h-[54px] rounded-full grad text-white font-semibold text-[14px] tracking-wide transition-opacity', !canNext && 'opacity-40')}
          style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
        >
          {last ? t('Создать мою свадьбу ✨') : t('Далее')}
        </button>
        {!last && <button onClick={next} className="w-full text-center text-[12px] text-[var(--soft)] mt-3 press">{t('Пропустить вопрос')}</button>}
      </div>

      {picker && (
        <CityPicker
          onClose={() => setPicker(false)}
          onPick={(c) => { setCity(c.n, c.r); setAnswers(a => ({ ...a, [i]: [c.n] })); setPicker(false) }}
        />
      )}
    </div>
  )
}
