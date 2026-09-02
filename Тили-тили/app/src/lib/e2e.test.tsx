// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { searchCities } from './cities'
import { inviteThemes } from './inviteThemes'
import { initialSlots, budgetItems } from './data'
import { CityPicker } from '@/components/CityPicker'

const wrap = (ui: React.ReactElement) => render(<MemoryRouter><StoreProvider>{ui}</StoreProvider></MemoryRouter>)

describe('E2E smoke: ключевые сценарии', () => {
  it('CityPicker: печатаем «сиб» → виден Сибай с регионом', () => {
    wrap(<CityPicker onPick={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/Начните вводить/), { target: { value: 'сиб' } })
    expect(screen.getByText('Сибай')).toBeTruthy()
  })

  it('Бизнес-логика бюджета: сумма забронированных слотов считается верно', () => {
    const booked = initialSlots.filter(s => (s.state === 'booked' || s.state === 'hold') && s.price)
    const sum = booked.reduce((a, s) => a + (s.price ?? 0), 0)
    expect(sum).toBe(250000 + 85000 + 120000 + 60000 + 45000)
  })

  it('Бюджетные категории покрывают все категории слотов', () => {
    const catOf: Record<string, string> = { venue: 'Площадка и кейтеринг', photo: 'Фото и видео', video: 'Фото и видео', dress: 'Одежда и красота', stylist: 'Одежда и красота', rings: 'Одежда и красота', host: 'Развлечения и декор', dj: 'Развлечения и декор', florist: 'Развлечения и декор', decor: 'Развлечения и декор', cake: 'Развлечения и декор', transport: 'Прочее' }
    for (const s of initialSlots) expect(catOf[s.categoryId]).toBeDefined()
    const names = new Set(budgetItems.map(b => b.name))
    for (const cat of Object.values(catOf)) expect(names.has(cat)).toBe(true)
  })

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
