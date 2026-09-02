import { describe, it, expect } from 'vitest'
import { CITIES, searchCities, nearestCity, POPULAR_CITIES } from './cities'

describe('cities', () => {
  it('находит райцентр по префиксу (Сибай)', () => {
    const r = searchCities('сиб')
    expect(r[0].n).toBe('Сибай')
    expect(r[0].r).toBe('Башкортостан')
  })
  it('ищет без учёта регистра и ё/е', () => {
    expect(searchCities('БАЙМАК')[0].n).toBe('Баймак')
    expect(searchCities('березовка').some(c => c.n === 'Николо-Берёзовка')).toBe(true)
  })
  it('ищет по району', () => {
    expect(searchCities('белорецкий').length).toBeGreaterThan(0)
  })
  it('пусто при <2 символов', () => {
    expect(searchCities('у')).toEqual([])
  })
  it('геолокация: Кумертау → ближайший Сибай или Кумертау', () => {
    const c = nearestCity(52.77, 55.78)
    expect(['Сибай', 'Кумертау', 'Баймак']).toContain(c?.n)
  })
  it('геолокация: Москва → Москва', () => {
    expect(nearestCity(55.7558, 37.6173)?.n).toBe('Москва')
  })
  it('популярные непустые и все из базы', () => {
    expect(POPULAR_CITIES.length).toBeGreaterThan(10)
    for (const c of POPULAR_CITIES) expect(CITIES).toContain(c)
  })
})
