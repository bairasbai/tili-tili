// @vitest-environment jsdom
/*
 * Отложенный переход после подтверждения — регрессия аудита 2026-09-03.
 *
 * «Добавить в свадьбу» и «Выбрать» показывают галочку и через 900 мс уводят
 * на /wedding. Раньше это был голый setTimeout в обработчике: таймер жил
 * дольше экрана и утаскивал человека со страницы, которую он за эти 900 мс
 * успел открыть сам.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

/* Анкета приходит с сервера — кнопка появляется после ответа. Общий набор
   ответов каталога: src/test/catalogMock.ts. */
vi.mock('@/lib/api/catalog', async () => (await import('@/test/catalogMock')).catalogMock())
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const { navSpy } = vi.hoisted(() => ({ navSpy: vi.fn() }))
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => navSpy }
})

import { MemoryRouter, Route, Routes } from 'react-router'
import { StoreProvider } from './store'
import { VendorDetail } from '@/pages/Search'
import { Compare } from '@/pages/Smart'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  navSpy.mockClear()
  localStorage.clear()
})

/* Анкета читает `:id` через useParams — маршрут объявляем, иначе экран
   честно показывает «не найдена». Раньше это скрывала подстановка первого
   подрядчика из мока. */
const renderPage = (ui: React.ReactElement) =>
  render(
    <MemoryRouter initialEntries={['/vendor/v1']}>
      <StoreProvider>
        <Routes><Route path="/vendor/:id" element={ui} /></Routes>
      </StoreProvider>
    </MemoryRouter>,
  )

describe('анкета подрядчика: «Добавить в свадьбу»', () => {
  it('переход происходит, если человек остался на экране', async () => {
    renderPage(<VendorDetail />)
    /* Ждём анкету на настоящих таймерах: с поддельными промис ответа не
       доезжает, и кнопки на экране ещё нет. */
    const add = await screen.findByText('Добавить в свадьбу')
    vi.useFakeTimers()

    fireEvent.click(add)
    expect(navSpy).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(900) })
    expect(navSpy).toHaveBeenCalledWith('/wedding')
  })

  it('уход с экрана до срабатывания отменяет переход', async () => {
    const { unmount } = renderPage(<VendorDetail />)
    const add = await screen.findByText('Добавить в свадьбу')
    vi.useFakeTimers()

    fireEvent.click(add)
    unmount() // человек нажал «назад» и открыл другой экран

    act(() => { vi.advanceTimersByTime(5000) })
    // До фикса таймер переживал экран и уводил на /wedding уже оттуда.
    expect(navSpy).not.toHaveBeenCalled()
  })
})

describe('сравнение кандидатов: выбор подрядчика', () => {
  it('уход с экрана до срабатывания отменяет переход', () => {
    vi.useFakeTimers()
    const { unmount } = renderPage(<Compare />)

    // Кнопка выбора у каждого кандидата своя — берём первую доступную.
    const pick = screen.getAllByText('Выбрать')[0]
    expect(pick).toBeTruthy()
    fireEvent.click(pick!)
    unmount()

    act(() => { vi.advanceTimersByTime(5000) })
    expect(navSpy).not.toHaveBeenCalled()
  })
})
