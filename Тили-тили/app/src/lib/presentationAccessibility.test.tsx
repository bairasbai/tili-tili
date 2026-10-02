import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DatePicker } from '@/components/DatePicker'
import { CityPicker } from '@/components/CityPicker'
import { AppUpdate } from '@/components/AppUpdate'
import { setI18nLang } from './i18n'
import { projectFile } from '@/test/projectFiles'

vi.mock('@/lib/serviceWorkerUpdate', () => {
  const waiting = {}
  return {
    pendingUpdate: () => waiting,
    subscribeUpdate: () => () => {},
    requestUpdate: vi.fn(() => true),
  }
})

const now = new Date(2026, 9, 2, 12)
type Picker = 'date' | 'city'

function Example({ picker }: { picker: Picker }) {
  const [open, setOpen] = useState(false)
  return <>
    <button onClick={() => setOpen(true)}>Open picker</button>
    <button>Background control</button>
    {open && (picker === 'date'
      ? <DatePicker now={now} value="2026-10-03" onClose={() => setOpen(false)} onPick={() => setOpen(false)} />
      : <CityPicker onClose={() => setOpen(false)} onPick={() => setOpen(false)} />)}
  </>
}

beforeEach(() => { setI18nLang('ru') })
afterEach(() => { cleanup(); setI18nLang('ru') })

describe.each<Picker>(['date', 'city'])('%s picker modal lifecycle', picker => {
  it('moves focus inside and traps Tab and Shift+Tab at both ends', () => {
    render(<Example picker={picker} />)
    const opener = screen.getByRole('button', { name: 'Open picker' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input')]
    const first = controls[0]!
    const last = controls[controls.length - 1]!
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('opens in a fixed portal, contains keyboard focus and restores the opener after repeated Escape', async () => {
    const { container } = render(<Example picker={picker} />)
    const opener = screen.getByRole('button', { name: 'Open picker' })
    const background = screen.getByRole('button', { name: 'Background control' })
    for (let attempt = 0; attempt < 2; attempt++) {
      opener.focus()
      fireEvent.click(opener)
      const dialog = screen.getByRole('dialog')
      expect(container.contains(dialog)).toBe(false)
      expect(dialog.classList.contains('picker-dialog')).toBe(true)
      expect(dialog.classList.contains('app-shell')).toBe(false)
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
      expect(screen.queryByRole('button', { name: 'Background control' })).toBeNull()

      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input')]
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      first.focus()
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(last)
      fireEvent.keyDown(last, { key: 'Tab' })
      expect(document.activeElement).toBe(first)
      background.focus()
      expect(dialog.contains(document.activeElement)).toBe(true)

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(opener))
    }
  })

  it('restores focus when dismissed by the close/cancel button', async () => {
    render(<Example picker={picker} />)
    const opener = screen.getByRole('button', { name: 'Open picker' })
    opener.focus()
    fireEvent.click(opener)
    const close = screen.getByRole('button', { name: picker === 'date' ? 'Закрыть' : 'Отмена' })
    close.focus()
    fireEvent.click(close)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('restores focus after a selection', async () => {
    render(<Example picker={picker} />)
    const opener = screen.getByRole('button', { name: 'Open picker' })
    opener.focus()
    fireEvent.click(opener)
    const choice = picker === 'date'
      ? screen.getByRole('button', { pressed: true })
      : screen.getByRole('button', { name: 'Москва' })
    fireEvent.click(choice)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('date and action names', () => {
  it('keeps current focus through rerenders and calls the latest close callback', () => {
    const previousClose = vi.fn()
    const nextClose = vi.fn()
    const { rerender } = render(<DatePicker now={now} value="2026-10-03" onClose={previousClose} onPick={() => {}} />)
    const nextMonth = screen.getByRole('button', { name: 'Следующий месяц' })
    nextMonth.focus()
    fireEvent.click(nextMonth)
    rerender(<DatePicker now={now} value="2026-10-03" error="Try again" onClose={nextClose} onPick={() => {}} />)
    expect(document.activeElement).toBe(nextMonth)
    fireEvent.keyDown(nextMonth, { key: 'Escape' })
    expect(nextClose).toHaveBeenCalledOnce()
    expect(previousClose).not.toHaveBeenCalled()
  })

  it.each(['ru', 'en'] as const)('announces the full selected date and today separately in %s', lang => {
    setI18nLang(lang)
    render(<DatePicker now={now} value="2026-10-03" onClose={() => {}} onPick={() => {}} />)
    const format = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ru-RU', { dateStyle: 'full' })
    const selected = screen.getByRole('button', { name: format.format(new Date(2026, 9, 3, 12)), pressed: true })
    const today = screen.getByRole('button', { name: format.format(now), pressed: false })
    expect(selected.getAttribute('aria-current')).toBeNull()
    expect(today.getAttribute('aria-current')).toBe('date')
  })

  it.each(['ru', 'en'] as const)('names city-search clearing and keeps typing focus in %s', lang => {
    setI18nLang(lang)
    render(<CityPicker onClose={() => {}} onPick={() => {}} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'Сиб' } })
    const clear = screen.getByRole('button', { name: lang === 'ru' ? 'Очистить поиск города' : 'Clear city search' })
    clear.focus()
    fireEvent.click(clear)
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })

  it.each(['ru', 'en'] as const)('localizes the update-dialog close action in %s', lang => {
    setI18nLang(lang)
    render(<AppUpdate />)
    fireEvent.click(screen.getByRole('button', { name: lang === 'ru' ? 'Обновить приложение' : 'Update the app' }))
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: lang === 'ru' ? 'Закрыть' : 'Close' })).toBeTruthy()
  })
})

describe('presentation CSS regressions (source checks, not browser geometry)', () => {
  const css = projectFile('src/index.css')
  it('clamps sidebar position to the actual shell edge at the desktop breakpoint', () => {
    const sidebar = css.match(/nav\.glass-tab\s*\{([^}]+)\}/)?.[1] ?? ''
    expect(sidebar).toMatch(/left:\s*max\(0px,\s*calc\(50% - 590px\)\)\s*!important/)
    expect(sidebar).toMatch(/transform:\s*none\s*!important/)
    // Expected geometry from the declaration above, including both boundaries.
    for (const width of [900, 1024, 1179, 1180, 1440]) {
      const left = Math.max(0, width / 2 - 590)
      expect(left).toBe(Math.max(0, (width - 1180) / 2))
      expect(left + 216).toBeLessThanOrEqual(width)
    }
  })
  it('keeps the picker fixed and scrollable without the shell sidebar padding', () => {
    const picker = css.match(/\.picker-dialog\s*\{([^}]+)\}/)?.[1] ?? ''
    expect(picker).toMatch(/position:\s*fixed/)
    expect(picker).toMatch(/inset:\s*0/)
    expect(picker).toMatch(/height:\s*100dvh/)
    expect(picker).toMatch(/overflow-y:\s*auto/)
    expect(picker).not.toMatch(/padding-left/)
    expect(css).toMatch(/\.picker-dialog\s*\{\s*max-width:\s*948px/)
  })
})
