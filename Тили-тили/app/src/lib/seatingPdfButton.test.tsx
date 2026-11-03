import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SeatingPdfButton } from '@/components/SeatingPdfButton'
import { seatingPdfBody } from './seatingPdf'
import type { SeatingRead } from './useSeating'
import { setI18nLang } from './i18n'

const state = vi.hoisted(() => ({ generation: 1, token: 'A', calls: [] as Array<{ isCurrent: () => boolean; body: string }>, downloads: 0,
  finish: null as (() => void) | null, fail: false }))
vi.mock('./api/client', () => ({ accessTokenForWs: () => state.token }))
vi.mock('./api/weddingData', () => ({ getGuests: async () => [] }))
vi.mock('./useLegacyActionScope', () => ({
  useLegacySessionKey: () => state.token,
  useLegacyActionScope: () => () => { const token = state.token, generation = state.generation
    return { isCurrent: () => token === state.token && generation === state.generation, assertCurrent: () => undefined }
  },
}))
vi.mock('./offlineAccess', () => ({ offlineGeneration: () => state.generation, offlineScope: (token: string) => token,
  sameOfflineScope: (a: string, b: string) => !!a && a === b }))
vi.mock('./localPdf', () => ({ downloadTextPdf: async (options: { isCurrent: () => boolean; body: string }) => {
  state.calls.push(options)
  if (state.fail) throw new Error('Synthetic renderer failure')
  await new Promise<void>(resolve => { state.finish = resolve })
  if (options.isCurrent()) { state.downloads++; return true }
  return false
} }))

const data = () => ({ generation: 1, guests: [
  { id: 'g1', name: 'Әлиә <script>alert(1)</script>', status: 'yes', tableId: 't1', phone: 'PRIVATE_PHONE', diet: 'PRIVATE_DIET', token: 'PRIVATE_TOKEN' },
  { id: 'g2', name: 'Иван', status: 'pending', tableId: null },
  { id: 'g3', name: 'Отказался', status: 'no', tableId: 't1' },
], tables: [{ id: 't1', name: 'Семья', capacity: 8 }] } as unknown as SeatingRead)

beforeEach(() => { state.generation = 1; state.token = 'A'; state.calls = []; state.downloads = 0; state.finish = null; state.fail = false; setI18nLang('ru') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('local seating PDF', () => {
  it('exports each attending person once and excludes declined/contact/diet/token fields', () => {
    const text = seatingPdfBody(data())
    expect(text).toContain('Семья · 1/8')
    expect(text).toContain('Әлиә <script>alert(1)</script>')
    expect(text).toContain('Иван')
    for (const secret of ['Отказался', 'PRIVATE_PHONE', 'PRIVATE_DIET', 'PRIVATE_TOKEN']) expect(text).not.toContain(secret)
  })
  it('counts all attending family members, including an orphaned table assignment', () => {
    const value = data(); value.guests[1].tableId = 'missing'
    expect(seatingPdfBody(value)).toContain('Иван')
  })
  it.each(['logout', 'generation', 'wedding', 'refresh', 'editing', 'unmount'])('blocks a late download after %s', async reason => {
    const value = data()
    const view = render(<SeatingPdfButton weddingId="w1" data={value} disabled={false} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    if (reason === 'logout') state.token = 'B'
    if (reason === 'generation') state.generation = 2
    if (reason === 'wedding') view.rerender(<SeatingPdfButton weddingId="w2" data={value} disabled={false} />)
    if (reason === 'refresh') view.rerender(<SeatingPdfButton weddingId="w1" data={data()} disabled={false} />)
    if (reason === 'editing') view.rerender(<SeatingPdfButton weddingId="w1" data={value} disabled />)
    if (reason === 'unmount') view.unmount()
    state.finish?.()
    await waitFor(() => expect(state.calls[0].isCurrent()).toBe(false))
    expect(state.downloads).toBe(0)
  })
  it('ignores repeated clicks and completes one export', async () => {
    render(<SeatingPdfButton weddingId="w1" data={data()} disabled={false} />)
    fireEvent.click(screen.getByRole('button')); fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    state.finish?.()
    await waitFor(() => expect(state.downloads).toBe(1))
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
  })
  it('remains canceled after editing is opened and closed during generation', async () => {
    const value = data()
    const view = render(<SeatingPdfButton weddingId="w1" data={value} disabled={false} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    view.rerender(<SeatingPdfButton weddingId="w1" data={value} disabled />)
    view.rerender(<SeatingPdfButton weddingId="w1" data={value} disabled={false} />)
    expect(state.calls[0].isCurrent()).toBe(false)
    state.finish?.()
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    expect(state.downloads).toBe(0)
  })
  it('uses English headings for unnamed tables and unseated guests', () => {
    setI18nLang('en')
    const value = data(); value.tables[0].name = ''
    const body = seatingPdfBody(value)
    expect(body).toContain('Table 1')
    expect(body).toContain('Unseated')
    expect(body).not.toContain('Без места')
  })
  it('shows a translated error and allows retry', async () => {
    setI18nLang('en'); state.fail = true
    render(<SeatingPdfButton weddingId="w1" data={data()} disabled={false} />)
    fireEvent.click(screen.getByRole('button'))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save the PDF')
    state.fail = false; fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(state.calls).toHaveLength(2))
    state.finish?.()
    await waitFor(() => expect(state.downloads).toBe(1))
  })
})
