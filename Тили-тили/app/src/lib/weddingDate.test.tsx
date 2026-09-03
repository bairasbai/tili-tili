// @vitest-environment jsdom
/*
 * Дата свадьбы: выбор в квизе, показ на экранах и обратный отсчёт.
 *
 * До этой работы дату нельзя было выбрать вообще: в квизе стояли три
 * готовые строки («14 июня 2027», «Примерно — лето 2027», «Ещё не решили»),
 * ответы квиза выбрасывались, а на экранах показывалась константа из
 * `lib/data.ts`. Обратный отсчёт был нарисованным числом.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { StoreProvider } from './store'
import Quiz from '@/pages/Quiz'
import { Us } from '@/pages/Us'
import { VendorDetail } from '@/pages/Search'
import { vendors } from './data'
import {
  countdownTo,
  dateRange,
  dateToIso,
  daysUntil,
  formatWeddingDate,
  inRange,
  isRealIso,
  shortWeddingDate,
} from './weddingDate'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('арифметика даты', () => {
  it('несуществующий день не проходит', () => {
    expect(isRealIso('2027-02-30')).toBe(false)
    expect(isRealIso('2027-13-01')).toBe(false)
    expect(isRealIso('2028-02-29')).toBe(true)
  })

  it('показ даты не зависит от часового пояса', () => {
    // Хранение объектом Date давало «13 июня» человеку восточнее Москвы:
    // полночь по UTC — это уже следующий день по местному.
    expect(formatWeddingDate('2027-06-14')).toBe('14 июня 2027 г.')
    expect(shortWeddingDate('2027-06-14')).toBe('14.06.2027')
    expect(formatWeddingDate(null)).toBe('')
  })

  it('диапазон выбора — год назад и пять лет вперёд', () => {
    const now = new Date(2026, 8, 3, 12)
    const { min, max } = dateRange(now)
    expect(dateToIso(min)).toBe('2025-09-03')
    expect(dateToIso(max)).toBe('2031-09-03')
    expect(inRange('2027-06-14', now)).toBe(true)
    expect(inRange('2032-01-01', now)).toBe(false)
  })

  it('дней до свадьбы считается, а прошедшая даёт ноль', () => {
    const now = new Date(2027, 5, 4, 12)
    expect(daysUntil('2027-06-14', now)).toBe(10)
    // «−12 дней до свадьбы» на главной читается как поломка.
    expect(daysUntil('2027-05-01', now)).toBe(0)
  })

  it('обратный отсчёт считает месяцы календарём, а не делением на 30', () => {
    const now = new Date(2027, 3, 14, 16, 0)
    // С 14 апреля до 14 июня ровно два месяца, а не «1 месяц 29 дней».
    expect(countdownTo('2027-06-14', now)).toEqual({ m: 2, d: 0, h: 0, min: 0 })
    expect(countdownTo('2027-04-15', now)).toEqual({ m: 0, d: 1, h: 0, min: 0 })
    expect(countdownTo('2027-01-01', now)).toEqual({ m: 0, d: 0, h: 0, min: 0 })
  })
})

const renderPage = (ui: React.ReactElement) =>
  render(
    <MemoryRouter>
      <StoreProvider>{ui}</StoreProvider>
    </MemoryRouter>,
  )

describe('квиз', () => {
  it('первый шаг — календарь, а не три готовые строки', () => {
    renderPage(<Quiz />)
    expect(screen.getByText('Когда ваша свадьба?')).toBeTruthy()
    /* Раньше здесь стоял выбор из «14 июня 2027», «Примерно — лето 2027»
     * и «Ещё не решили»: 2027 год был единственным возможным. */
    expect(screen.queryByText('14 июня 2027')).toBeNull()
    expect(screen.getByText('Выбрать день в календаре')).toBeTruthy()
  })

  it('календарь открывается и выбранный день остаётся на экране', () => {
    renderPage(<Quiz />)
    fireEvent.click(screen.getByText('Выбрать день в календаре'))
    expect(screen.getByRole('dialog', { name: 'Выбор даты свадьбы' })).toBeTruthy()

    // Любой доступный день месяца — не только тот, что придумали в моке.
    const day = screen.getAllByRole('button').find(b => b.textContent === '15' && !(b as HTMLButtonElement).disabled)
    expect(day).toBeTruthy()
    fireEvent.click(day!)
    expect(screen.queryByRole('dialog', { name: 'Выбор даты свадьбы' })).toBeNull()
    expect(screen.getByText(/\d{1,2}\s\S+\s\d{4}/)).toBeTruthy()
  })

  it('без даты дальше пускает: «ещё не решили» — тоже ответ', () => {
    renderPage(<Quiz />)
    const next = screen.getByText('Далее').closest('button') as HTMLButtonElement
    // Шаг обязателен, пока не сказали ни «дата», ни «не решили».
    expect(next.disabled).toBe(true)
    fireEvent.click(screen.getByText('Ещё не решили'))
    expect(next.disabled).toBe(false)
  })

  it('выбранная дата переживает квиз и попадает в состояние', () => {
    renderPage(<Quiz />)
    fireEvent.click(screen.getByText('Выбрать день в календаре'))
    const day = screen.getAllByRole('button').find(b => b.textContent === '20' && !(b as HTMLButtonElement).disabled)
    fireEvent.click(day!)

    // Шаг даты пройден — идём дальше по квизу до конца.
    fireEvent.click(screen.getByText('Далее'))
    // Город: берём готовую подсказку, чтобы не открывать второй оверлей.
    fireEvent.click(screen.getByText('Уфа'))
    fireEvent.click(screen.getByText('Далее'))
    // Остальные шесть шагов — первый вариант из списка.
    for (let step = 0; step < 6; step++) {
      const options = screen.getAllByRole('button').filter(b => b.className.includes('card-s'))
      fireEvent.click(options[0]!)
      fireEvent.click(screen.queryByText('Далее') ?? screen.getByText('Создать мою свадьбу ✨'))
    }
    /* Раньше `finishOnboarding` только ставил флаг: что человек выбрал,
     * исчезало между последним «Далее» и главным экраном. */
    const saved = JSON.parse(localStorage.getItem('tt_wedding_date') ?? 'null') as string | null
    expect(saved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(saved!.endsWith('-20')).toBe(true)
    // И весь остальной опрос тоже: он и есть план свадьбы.
    expect(JSON.parse(localStorage.getItem('tt_quiz')!).guests).toBeTruthy()
  })
})

describe('стили в квизе', () => {
  /** Доходит до шага стиля: дата → город → гости → бюджет → формат → стиль. */
  const toStyleStep = () => {
    renderPage(<Quiz />)
    fireEvent.click(screen.getByText('Ещё не решили'))
    fireEvent.click(screen.getByText('Далее'))
    fireEvent.click(screen.getByText('Уфа'))
    fireEvent.click(screen.getByText('Далее'))
    for (let step = 0; step < 3; step++) {
      const options = screen.getAllByRole('button').filter(b => b.className.includes('card-s'))
      fireEvent.click(options[0]!)
      fireEvent.click(screen.getByText('Далее'))
    }
  }

  it('стилей двенадцать, а не шесть', () => {
    toStyleStep()
    expect(screen.getByText('Стиль и настроение?')).toBeTruthy()
    for (const style of ['🤍 Классика', '🌾 Рустик', '🍇 Усадьба', '⚓️ Морская', '🍋 Средиземноморская']) {
      expect(screen.getByText(style)).toBeTruthy()
    }
    const options = screen.getAllByRole('button').filter(b => b.className.includes('card-s'))
    expect(options).toHaveLength(12)
  })

  it('под каждым стилем написано, что он значит', () => {
    toStyleStep()
    /* Название вроде «Рустик» ничего не говорит тому, кто первый раз
     * выбирает свадьбу, — а выбор влияет на всю выдачу каталога. */
    expect(screen.getByText(/Амбар или база отдыха вместо банкетного зала/)).toBeTruthy()
    expect(screen.getByText(/Свечи вместо прожекторов|свечи вместо прожекторов/)).toBeTruthy()

    const options = screen.getAllByRole('button').filter(b => b.className.includes('card-s'))
    // Пустых карточек быть не должно: объяснение есть у каждого стиля.
    for (const option of options) expect(option.textContent!.length).toBeGreaterThan(20)
  })

  it('выбранный стиль сохраняется вместе с остальным квизом', () => {
    toStyleStep()
    fireEvent.click(screen.getByText('🍇 Усадьба'))
    fireEvent.click(screen.getByText('Далее'))
    for (let step = 0; step < 2; step++) {
      const options = screen.getAllByRole('button').filter(b => b.className.includes('card-s'))
      fireEvent.click(options[0]!)
      fireEvent.click(screen.queryByText('Далее') ?? screen.getByText('Создать мою свадьбу ✨'))
    }
    expect(JSON.parse(localStorage.getItem('tt_quiz')!).style).toBe('🍇 Усадьба')
  })
})

describe('телефон подрядчика', () => {
  const openCard = (id: string) =>
    render(
      <MemoryRouter initialEntries={[`/vendor/${id}`]}>
        <StoreProvider>
          <Routes>
            <Route path="/vendor/:id" element={<VendorDetail />} />
          </Routes>
        </StoreProvider>
      </MemoryRouter>,
    )

  it('до брони номера нет — есть объяснение, почему', () => {
    const v = vendors[0]!
    // В моке фотограф уже забронирован — освобождаем слот, чтобы проверить
    // именно состояние «до брони».
    localStorage.setItem(
      'tt_slots',
      JSON.stringify({
        s2: { state: 'empty', vendor: null, price: null, status: null, external: false, invited: false, phone: null },
      }),
    )
    openCard(v.id)
    /* Номер в открытом каталоге — готовая база для обзвона, и будущая
     * комиссия со сделок при нём не работает (решение владельца
     * 2026-09-03: показываем после брони). */
    expect(screen.queryByText(v.phone)).toBeNull()
    expect(screen.getByText(/Телефон откроется после брони/)).toBeTruthy()
  })

  it('после брони номер виден и звонится', () => {
    const v = vendors[0]!
    // Слот фотографа занят этим же подрядчиком — значит, сделка есть.
    localStorage.setItem(
      'tt_slots',
      JSON.stringify({
        s2: { state: 'booked', vendor: v.name, price: 85000, status: 'Забронировано', external: false, invited: false, phone: null },
      }),
    )
    openCard(v.id)
    expect(screen.getByText(v.phone)).toBeTruthy()
    const call = screen.getByText('Позвонить') as HTMLAnchorElement
    expect(call.getAttribute('href')).toBe(`tel:${v.phone.replace(/[^+\d]/g, '')}`)
  })

  it('бронь другого подрядчика чужого номера не открывает', () => {
    const v = vendors[0]!
    localStorage.setItem(
      'tt_slots',
      JSON.stringify({
        s2: { state: 'booked', vendor: 'Кто-то другой', price: 1, status: 'Забронировано', external: false, invited: false, phone: null },
      }),
    )
    openCard(v.id)
    expect(screen.queryByText(v.phone)).toBeNull()
  })
})

describe('смена даты позже', () => {
  it('на экране «Мы» дата открывает календарь и меняется', () => {
    localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
    renderPage(<Us />)
    // Подсказка квиза «дату можно изменить позже» должна быть выполнимой.
    fireEvent.click(screen.getByText(/14 июня 2027/))
    expect(screen.getByRole('dialog', { name: 'Выбор даты свадьбы' })).toBeTruthy()

    const day = screen.getAllByRole('button').find(b => b.textContent === '21' && !(b as HTMLButtonElement).disabled)
    fireEvent.click(day!)
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe('2027-06-21')
  })

  it('без даты экран зовёт её выбрать, а не показывает пустоту', () => {
    renderPage(<Us />)
    expect(screen.getByText(/Выбрать дату свадьбы/)).toBeTruthy()
  })
})
