// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { searchCities } from './cities'
import { inviteThemes } from './inviteThemes'
import { committedTotal } from './budget'
import type { Slot } from './types'
import { rub } from '@/lib/money'
import { CityPicker } from '@/components/CityPicker'

const wrap = (ui: React.ReactElement) => render(<MemoryRouter><StoreProvider>{ui}</StoreProvider></MemoryRouter>)

describe('E2E smoke: ключевые сценарии', () => {
  it('CityPicker: печатаем «сиб» → виден Сибай с регионом', () => {
    wrap(<CityPicker onPick={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/Начните вводить/), { target: { value: 'сиб' } })
    expect(screen.getByText('Сибай')).toBeTruthy()
  })

  it('Обязательства считаются по броням и мягким броням, а не по всем слотам', () => {
    /* Раньше проверка гоняла мок-мозаику из `lib/data.ts`. Мока больше нет, а
       правило осталось: в обязательства идут `booked` и `hold` с ценой. */
    const slots: Slot[] = [
      { id: 's1', categoryId: 'venue', label: 'Площадка', icon: '', tile: '', state: 'booked', price: rub(250000) },
      { id: 's2', categoryId: 'photo', label: 'Фотограф', icon: '', tile: '', state: 'hold', price: rub(85000) },
      { id: 's3', categoryId: 'dj', label: 'DJ', icon: '', tile: '', state: 'candidate', price: rub(60000) },
      { id: 's4', categoryId: 'cake', label: 'Кондитер', icon: '', tile: '', state: 'booked' },
      { id: 's5', categoryId: 'decor', label: 'Декор', icon: '', tile: '', state: 'empty' },
    ]
    // суммы хранятся в копейках — решение владельца 2026-09-02
    expect(committedTotal(slots)).toBe(rub(250000 + 85000))
  })

  /* Проверка «бюджетные категории покрывают категории слотов» снята: карту
     категорий держит сервер (`BUDGET_BY_VENDOR_CATEGORY`), и сверяет её его
     же тест. Клиентская копия карты снесена вместе с моками — сверять было
     бы нечего. */

  it('Все 10 сценариев приглашений валидны', () => {
    expect(inviteThemes).toHaveLength(10)
    for (const t of inviteThemes) {
      expect(t.id).toBeTruthy(); expect(t.name).toBeTruthy()
      expect(['curtains', 'doors', 'lift', 'fade']).toContain(t.opening)
    }
  })

  it('Поиск городов: соседние регионы доступны (выездные свадьбы)', () => {
    expect(searchCities('магнитогорск')[0]?.r).toBe('Челябинская область')
    expect(searchCities('орск')[0]?.r).toBe('Оренбургская область')
  })
})
