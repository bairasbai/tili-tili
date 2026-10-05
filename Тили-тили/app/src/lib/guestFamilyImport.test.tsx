// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GuestImportPanel } from '@/components/GuestImportPanel'
import { importGuests } from './api/weddingWrite'
import { setI18nLang } from './i18n'

vi.mock('./api/weddingWrite', () => ({ importGuests: vi.fn() }))
const request = vi.mocked(importGuests)
const imported = vi.fn()
const close = vi.fn()
const props = { weddingId: 'w1', existing: [], open: true, onImported: imported, onClose: close }
function open(text = 'Анна') {
  const view = render(<GuestImportPanel key="w1" {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Список гостей' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Проверить и дополнить' }))
  return view
}
function submit() { fireEvent.click(screen.getByRole('button', { name: 'Импортировать приглашения' })) }

beforeEach(() => { vi.clearAllMocks(); setI18nLang('ru') })
afterEach(() => { cleanup(); setI18nLang('ru') })

describe('WP02 named-family import UI', () => {
  it('sends named companions through the existing import API and displays server totals', async () => {
    request.mockResolvedValue({ created: [{ partySize: 2 }], skipped: [] })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить человека в семью' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Человек семьи 2' }), { target: { value: 'Борис' } })
    submit()
    await waitFor(() => expect(request).toHaveBeenCalledWith('w1', [{ name: 'Анна', members: [{ name: 'Борис' }] }]))
    expect(await screen.findByText('Создано приглашений: 1')).toBeTruthy()
    expect(screen.getByText('Создано персон: 2')).toBeTruthy()
    expect(imported).toHaveBeenCalledOnce()
  })
  it('does not POST while a newly added member has no name', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить человека в семью' }))
    expect((screen.getByRole('button', { name: 'Импортировать приглашения' }) as HTMLButtonElement).disabled).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })
  it('replaces +1 with a named companion explicitly', async () => {
    request.mockResolvedValue({ created: [{ partySize: 2 }], skipped: [] })
    open('Анна,+1')
    fireEvent.click(screen.getByRole('button', { name: 'Указать имя вместо +1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Человек семьи 2' }), { target: { value: 'Борис' } })
    submit()
    await waitFor(() => expect(request).toHaveBeenCalledWith('w1', [{ name: 'Анна', members: [{ name: 'Борис' }] }]))
  })
  it('retains edited family composition across closing and reopening in the same wedding', () => {
    const view = open()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить человека в семью' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Человек семьи 2' }), { target: { value: 'Борис' } })
    view.rerender(<GuestImportPanel key="w1" {...props} open={false} />)
    view.rerender(<GuestImportPanel key="w1" {...props} />)
    expect((screen.getByRole('textbox', { name: 'Человек семьи 2' }) as HTMLInputElement).value).toBe('Борис')
  })
  it('does not carry the draft into another wedding', () => {
    const view = open()
    view.rerender(<GuestImportPanel key="w2" {...props} weddingId="w2" />)
    expect((screen.getByRole('textbox', { name: 'Список гостей' }) as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByRole('textbox', { name: 'Основной человек' })).toBeNull()
  })
  it('keeps locally invalid and server-skipped rows after partial success', async () => {
    request.mockResolvedValue({ created: [{ partySize: 1 }], skipped: [{ index: 1, name: 'Борис', reason: 'invalid' }] })
    open('А\nАнна\nБорис')
    submit()
    await screen.findByText('Создано приглашений: 1')
    expect(screen.getAllByRole('textbox', { name: 'Основной человек' }).map(node => (node as HTMLInputElement).value)).toEqual(['А', 'Борис'])
    expect(screen.getByText(/Строка не принята сервером: проверьте поля/)).toBeTruthy()
  })
  it('keeps the draft after network failure and requests a refresh for uncertain commit outcome', async () => {
    request.mockRejectedValue(new Error('network'))
    open()
    submit()
    await waitFor(() => expect(imported).toHaveBeenCalledOnce())
    expect((screen.getByRole('textbox', { name: 'Основной человек' }) as HTMLInputElement).value).toBe('Анна')
    expect(screen.queryByText(/Создано приглашений:/)).toBeNull()
  })
  it('preserves rows and does not invent success after an incomplete response', async () => {
    request.mockResolvedValue({ created: [], skipped: [] })
    open()
    submit()
    expect(await screen.findByText(/Не удалось подтвердить итог импорта/)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Основной человек' }) as HTMLInputElement).value).toBe('Анна')
  })
  it('requires explicit confirmation before discarding preview edits', () => {
    open()
    fireEvent.change(screen.getByRole('textbox', { name: 'Основной человек' }), { target: { value: 'Анастасия' } })
    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к вставке' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect((screen.getByRole('textbox', { name: 'Основной человек' }) as HTMLInputElement).value).toBe('Анастасия')
  })
  it('renders the new paste workflow in English', () => {
    setI18nLang('en')
    render(<GuestImportPanel {...props} />)
    expect(screen.getByRole('button', { name: 'Review and complete' })).toBeTruthy()
    expect(screen.getByText('One line is one invitation. Add family members in the preview.')).toBeTruthy()
  })
})
