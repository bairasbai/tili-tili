// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { t, setI18nLang } from './i18n'
import { EN } from './i18n.en'

describe('i18n: двуязычие RU/EN', () => {
  it('русский по умолчанию — ключ возвращается как есть', () => {
    setI18nLang('ru')
    expect(t('Главная')).toBe('Главная')
  })
  it('английский переводит и делает fallback на русский', () => {
    setI18nLang('en')
    expect(t('Главная')).toBe('Home')
    expect(t('Такого ключа нет в словаре')).toBe('Такого ключа нет в словаре')
    setI18nLang('ru')
  })
  it('словарь покрывает базовую навигацию и не содержит пустых переводов', () => {
    for (const k of ['Главная', 'Поиск', 'Чаты', 'Мы', 'Настройки', 'Бюджет', 'Гости', 'Тайминг'])
      expect(EN[k], `нет перевода: ${k}`).toBeTruthy()
    for (const v of Object.values(EN)) expect(v.length).toBeGreaterThan(0)
  })
  it('ключи словаря не содержат артефактов кодмода', () => {
    for (const k of Object.keys(EN)) {
      expect(k).not.toContain('t(')
      expect(k.trim()).not.toBe('')
    }
  })
})
