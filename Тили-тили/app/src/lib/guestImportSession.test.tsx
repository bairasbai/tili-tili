// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GuestImportPanel } from '@/components/GuestImportPanel'
import { importGuests } from './api/weddingWrite'
import { saveTokens } from './api/client'
import { setI18nLang } from './i18n'

// The component, credential storage, session observers and guards are real.
// Only the HTTP command is controlled; these tests are not PostgreSQL evidence.
vi.mock('./api/weddingWrite', () => ({ importGuests: vi.fn() }))
const request = vi.mocked(importGuests)
const refreshed = vi.fn()
const closed = vi.fn()
const props = { weddingId: 'w1', existing: [], open: true, onImported: refreshed, onClose: closed }
function tokens(user = 'user-a', session = 'session-a', expiry = 2000000000) {
  const payload = btoa(JSON.stringify({ sub: user, sid: session, exp: expiry }))
  return { accessToken: `e30.${payload}.signature`, refreshToken: `refresh-${user}-${session}-${expiry}` }
}
function openFamily() {
  const view = render(<GuestImportPanel {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Список гостей' }), { target: { value: 'Анна, +79170001122' } })
  fireEvent.click(screen.getByRole('button', { name: 'Проверить и дополнить' }))
  fireEvent.click(screen.getByRole('button', { name: 'Добавить человека в семью' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Человек семьи 2' }), { target: { value: 'Борис' } })
  return view
}
function submit() { fireEvent.click(screen.getByRole('button', { name: 'Импортировать приглашения' })) }
function expectBlank() {
  expect((screen.getByRole('textbox', { name: 'Список гостей' }) as HTMLTextAreaElement).value).toBe('')
  expect(screen.queryByRole('textbox', { name: 'Основной человек' })).toBeNull()
  expect(document.body.textContent).not.toContain('Борис')
  expect(document.body.textContent).not.toContain('+79170001122')
  expect(screen.queryByText(/Создано приглашений:/)).toBeNull()
}
function pending() {
  let resolve!: (value: Awaited<ReturnType<typeof importGuests>>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Awaited<ReturnType<typeof importGuests>>>((yes, no) => { resolve = yes; reject = no })
  request.mockReturnValueOnce(promise)
  return { resolve, reject }
}
const success = { created: [{ partySize: 2 }], skipped: [] }

beforeEach(() => {
  vi.clearAllMocks()
  request.mockReset()
  localStorage.clear()
  saveTokens(tokens())
  setI18nLang('ru')
})
afterEach(() => { cleanup(); saveTokens(null); localStorage.clear(); setI18nLang('ru') })

describe('WP02 private import state follows wedding and local session lifetime', () => {
  it.each([
    ['logout', null],
    ['another account', tokens('user-b', 'session-b')],
    ['another session of the same account', tokens('user-a', 'session-b')],
  ])('clears an edited family on %s without requiring a parent key change', (_label, next) => {
    openFamily()
    act(() => saveTokens(next))
    expectBlank()
    expect(request).not.toHaveBeenCalled()
    expect(refreshed).not.toHaveBeenCalled()
  })
  it('clears a hidden draft before it can be reopened under another account', () => {
    const view = openFamily()
    view.rerender(<GuestImportPanel {...props} open={false} />)
    act(() => saveTokens(tokens('user-b', 'session-b')))
    view.rerender(<GuestImportPanel {...props} />)
    expectBlank()
  })
  it('clears paste-stage private data as well as the editable preview', () => {
    render(<GuestImportPanel {...props} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Список гостей' }), { target: { value: 'Анна, +79170001122' } })
    act(() => saveTokens(null))
    expectBlank()
  })
  it('clears the draft when weddingId changes even without an external key', () => {
    const view = openFamily()
    view.rerender(<GuestImportPanel {...props} weddingId="w2" />)
    expectBlank()
  })
  it('retains edited family data during access-token renewal in the same session', async () => {
    openFamily()
    act(() => saveTokens(tokens('user-a', 'session-a', 2000000300)))
    expect((screen.getByRole('textbox', { name: 'Человек семьи 2' }) as HTMLInputElement).value).toBe('Борис')
    request.mockResolvedValueOnce(success)
    submit()
    await screen.findByText('Создано персон: 2')
    expect(request).toHaveBeenCalledWith('w1', [{ name: 'Анна', phone: '+79170001122', members: [{ name: 'Борис' }] }])
    expect(refreshed).toHaveBeenCalledOnce()
  })
  it('retains the draft on an unrelated cross-tab storage event', () => {
    openFamily()
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'other-setting', oldValue: 'a', newValue: 'b', storageArea: localStorage })))
    expect((screen.getByRole('textbox', { name: 'Человек семьи 2' }) as HTMLInputElement).value).toBe('Борис')
  })
  it('clears the draft on a real cross-tab credential replacement', () => {
    openFamily()
    const oldValue = localStorage.getItem('tt_auth')
    const newValue = JSON.stringify(tokens('user-b', 'session-b'))
    act(() => {
      localStorage.setItem('tt_auth', newValue)
      window.dispatchEvent(new StorageEvent('storage', { key: 'tt_auth', oldValue, newValue, storageArea: localStorage }))
    })
    expectBlank()
  })
  it('refuses a stale DOM click in the same React batch as a session change', () => {
    openFamily()
    const button = screen.getByRole('button', { name: 'Импортировать приглашения' })
    request.mockResolvedValueOnce(success)
    act(() => { saveTokens(tokens('user-b', 'session-b')); button.click() })
    expect(request).not.toHaveBeenCalled()
    expectBlank()
  })
  it.each(['success', 'failure'] as const)('ignores late %s after logout without refreshing the next account', async outcome => {
    const gate = pending()
    openFamily()
    submit()
    expect(request).toHaveBeenCalledOnce()
    await act(async () => {
      saveTokens(null)
      if (outcome === 'success') gate.resolve(success)
      else gate.reject(new Error('late private transport error'))
    })
    expectBlank()
    expect(refreshed).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('late private')
  })
  it('does not revive a pending import after observed account A to B to A transitions', async () => {
    const gate = pending()
    openFamily()
    submit()
    await act(async () => {
      saveTokens(tokens('user-b', 'session-b'))
      saveTokens(tokens())
      gate.resolve(success)
    })
    expectBlank()
    expect(refreshed).not.toHaveBeenCalled()
  })
  it('accepts a pending result after renewal of the same subject and session', async () => {
    const gate = pending()
    openFamily()
    submit()
    await act(async () => {
      saveTokens(tokens('user-a', 'session-a', 2000000300))
      gate.resolve(success)
    })
    expect(screen.getByText('Создано персон: 2')).toBeTruthy()
    expect(refreshed).toHaveBeenCalledOnce()
  })
  it('does not let an old finally block unlock a new wedding import', async () => {
    const first = pending()
    const view = openFamily()
    submit()
    view.rerender(<GuestImportPanel {...props} weddingId="w2" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Список гостей' }), { target: { value: 'Вера' } })
    fireEvent.click(screen.getByRole('button', { name: 'Проверить и дополнить' }))
    const second = pending()
    submit()
    await act(async () => first.resolve(success))
    expect(refreshed).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Импортировать приглашения' }).matches(':disabled')).toBe(true)
    submit()
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve({ created: [{ partySize: 1 }], skipped: [] }))
    expect(screen.getByText('Создано персон: 1')).toBeTruthy()
    expect(refreshed).toHaveBeenCalledOnce()
  })
  it.each(['success', 'failure'] as const)('ignores a pending %s after actual unmount', async outcome => {
    const gate = pending()
    const view = openFamily()
    submit()
    view.unmount()
    await act(async () => {
      if (outcome === 'success') gate.resolve(success)
      else gate.reject(new Error('late error'))
    })
    expect(refreshed).not.toHaveBeenCalled()
  })
  it('clears the previous server result and rejected names when the account changes', async () => {
    request.mockResolvedValueOnce({ created: [], skipped: [{ index: 0, name: 'Анна', reason: 'invalid' }] })
    openFamily()
    submit()
    await waitFor(() => expect(refreshed).toHaveBeenCalledOnce())
    expect(screen.getByText(/Строка не принята сервером/)).toBeTruthy()
    act(() => saveTokens(tokens('user-b', 'session-b')))
    expectBlank()
    expect(document.body.textContent).not.toContain('Анна')
    expect(screen.queryByText(/Строка не принята сервером/)).toBeNull()
  })
})
