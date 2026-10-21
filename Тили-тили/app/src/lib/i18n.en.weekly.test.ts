import { afterEach, describe, expect, it } from 'vitest'
import { t, setI18nLang } from './i18n'
import { EN } from './i18n.en'
import { EN_WEEKLY } from './i18n.en.weekly'

afterEach(() => setI18nLang('ru'))

describe('weekly dictionary through the existing translator', () => {
  it('translates every added key through t without overriding an existing dictionary entry', () => {
    setI18nLang('en')
    expect(Object.keys(EN_WEEKLY)).toHaveLength(17)
    for (const [key, value] of Object.entries(EN_WEEKLY)) {
      expect(value.trim()).not.toBe('')
      expect(t(key)).toBe(EN[key] ?? value)
      expect(t(key)).not.toBe(key)
    }
  })
  it('keeps all existing core translations unchanged', () => {
    setI18nLang('en')
    for (const [key, value] of Object.entries(EN)) expect(t(key)).toBe(value)
  })
  it('keeps Russian keys in Russian mode and unknown strings as fallback', () => {
    setI18nLang('ru')
    for (const key of Object.keys(EN_WEEKLY)) expect(t(key)).toBe(key)
    setI18nLang('en')
    expect(t('weekly-dictionary-unregistered-test-key')).toBe('weekly-dictionary-unregistered-test-key')
  })
})
