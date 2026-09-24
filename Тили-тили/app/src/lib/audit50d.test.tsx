// @vitest-environment jsdom
/*
 * R-257, страховочная сеть под проход по константам уровня модуля.
 *
 * Русские строки в таких константах теперь лежат под `key()` и переводятся
 * в месте показа. Опасность правки в том, что она ломает ровно то, чего не
 * видно из Москвы: если место показа забыло `t()`, англоязычный человек
 * увидит русские слова — а словарный сторож этого НЕ поймает, потому что
 * ключи размечены и переводы в словаре лежат, просто ими никто не
 * воспользовался.
 *
 * Отсюда форма проверки: экран рисуется по-английски, и у каждой константы
 * спрашивается обе половины — русского ключа на экране нет И перевод виден.
 * Одной первой мало: пустой экран её проходит.
 *
 * Язык ставится в хранилище, а не вызовом `setI18nLang`: `StoreProvider` при
 * монтировании сам читает `tt_lang` и перебивает модульный язык обратно.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, waitFor, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { StoreProvider } from '@/lib/store'
import { setI18nLang } from '@/lib/i18n'
import { Team } from '@/pages/Team'
import Onboarding from '@/pages/Onboarding'

const WEDDING = { id: 'w1', title: 'A ♥ B', date: '2027-06-14', city: { name: 'Ufa' }, tz: 'Asia/Yekaterinburg' }
const ME = { id: 'u1', name: 'Ann', phone: '+79990000000', isStaff: false, push: {}, quietHours: null }
const member = (id: string, name: string, role: string) =>
  ({ user: { id, name }, role, joinedAt: '2026-01-01T00:00:00.000Z' })

/* Фикстуры намеренно латиницей: кириллица в них сделала бы проверку
   «русского на экране нет» ложно-красной на пользовательских данных. */
const ROUTES: Record<string, unknown> = {
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/members': [member('u1', 'Ann', 'couple'), member('u2', 'Mom', 'helper')],
  '/weddings/w1/invites': [],
  '/users/me': ME,
}

function serve() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    const body = ROUTES[path] ?? []
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  }))
}

const openEn = (node: React.ReactNode, at: string, path: string) => {
  localStorage.setItem('tt_lang', 'en')
  setI18nLang('en')
  return render(
    <MemoryRouter initialEntries={[at]}>
      <StoreProvider>
        <Routes><Route path={path} element={node} /></Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
}

/** Обе половины сразу: ключей нет, переводы есть. */
function expectTranslated(text: string, keys: string[], english: string[]) {
  for (const ru of keys) {
    expect(text, 'в EN на экране остался русский ключ «' + ru + '»').not.toContain(ru)
  }
  for (const en of english) {
    expect(text, 'перевода «' + en + '» нет — экран мог просто ничего не нарисовать').toContain(en)
  }
}

describe('R-257: английский интерфейс без русских ключей — Onboarding и Team', () => {
  beforeEach(() => {
    localStorage.clear()
    serve()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
    setI18nLang('ru')
  })

  it('Onboarding: сцены переведены', () => {
    const r = openEn(<Onboarding />, '/', '/')
    expectTranslated(
      r.container.textContent ?? '',
      ['Все специалисты', 'Фотографы, декораторы'],
      ['All vendors'],
    )
  })

  it('Team: роли и права переведены', async () => {
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    const r = openEn(<Team />, '/us/team', '/us/team')
    await waitFor(() => expect(screen.getByText('Partner')).toBeTruthy(), { timeout: 4000 })
    expectTranslated(
      r.container.textContent ?? '',
      ['Партнёр', 'Помощник', 'Координатор', 'Подрядчик', 'Пара',
       'Бюджет и сделки'],
      ['Partner', 'Helper', 'Coordinator', 'Vendor'],
    )
  })
})
