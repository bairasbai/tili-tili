// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StoreProvider, useStore } from './store'

function Probe() {
  const { theme, setTheme } = useStore()
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>toggle</button>
    </div>
  )
}

describe('theme toggle (regression: stale useMemo deps)', () => {
  beforeEach(() => localStorage.clear())

  it('setTheme flips context theme light→dark→light', () => {
    render(<StoreProvider><Probe /></StoreProvider>)
    expect(screen.getByTestId('theme').textContent).toBe('light')
    fireEvent.click(screen.getByText('toggle'))
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    expect(localStorage.getItem('tt_theme')).toBe('dark')
    fireEvent.click(screen.getByText('toggle'))
    expect(screen.getByTestId('theme').textContent).toBe('light')
    expect(localStorage.getItem('tt_theme')).toBe('light')
  })
})
