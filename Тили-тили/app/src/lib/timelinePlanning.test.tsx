// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimelinePlanningEditor } from '@/components/TimelinePlanning'
import { toTimelineDraft, type TimelineDraft } from './api/weddingWrite'
import { setI18nLang } from './i18n'

const event: TimelineDraft = { id: 'a', eventId: '019a00e1-3210-7000-8000-000000000001', name: 'Сборы', startsAt: '2027-06-14T06:00:12.125Z', endsAt: '2027-06-14T07:00:12.125Z', forGuests: true,
  durationMinutes: 60, fixed: false, travelMinutes: 10, bufferMinutes: 5, responsible: { kind: 'member', id: 'u1' }, participants: [{ kind: 'member', id: 'u1' }] }
afterEach(() => { cleanup(); setI18nLang('ru') })
function editor(over: Partial<Parameters<typeof TimelinePlanningEditor>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(true), onCancel = vi.fn()
  render(<TimelinePlanningEditor event={event} events={[event]} choices={[{ reference: { kind: 'member', id: 'u1' }, name: 'Аня' }]}
    referencesReady timeZone="Asia/Yekaterinburg" disabled={false} onSave={onSave} onCancel={onCancel} {...over} />)
  return { onSave, onCancel }
}
describe('timeline planning fields', () => {
  it('preserves the server event identity when preparing a full-list write', () => {
    const draft = toTimelineDraft({ id: 'block-id', name: 'Ceremony block', forGuests: true,
      eventId: '019a00e1-3210-7000-8000-000000000001' })
    expect(draft).toMatchObject({ id: 'block-id', eventId: '019a00e1-3210-7000-8000-000000000001', startsAt: '' })
  })
  it('does not invent an event identity for a compatible response without one', () => {
    expect(toTimelineDraft({ id: 'block-id', name: 'Legacy block', forGuests: true })).not.toHaveProperty('eventId')
  })
  it('keeps seconds, milliseconds and known end when only location changes', async () => {
    const { onSave } = editor()
    fireEvent.change(screen.getByLabelText('Место блока'), { target: { value: 'Новый адрес' } })
    fireEvent.click(screen.getByText('Сохранить блок'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ eventId: event.eventId, startsAt: event.startsAt, endsAt: event.endsAt, durationMinutes: 60, location: 'Новый адрес' })
  })
  it('uses the wedding time zone when changing start, not the browser time zone', async () => {
    const { onSave } = editor()
    fireEvent.change(screen.getByLabelText('Начало блока'), { target: { value: '2027-06-15T15:30:12.125' } })
    fireEvent.click(screen.getByText('Сохранить блок'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ startsAt: '2027-06-15T10:30:12.125Z', endsAt: undefined, durationMinutes: 60 })
  })
  it('refuses negative/oversized numbers and a fixed start without a start time', () => {
    const { onSave } = editor()
    const save = screen.getByText('Сохранить блок').closest('button')!
    for (const [label, value] of [['Длительность, мин', '-1'], ['Переезд, мин', '10081'], ['Запас, мин', '-1']]) {
      const input = screen.getByLabelText(label!)
      fireEvent.change(input, { target: { value } })
      expect(save.disabled).toBe(true)
      fireEvent.click(save)
      fireEvent.change(input, { target: { value: '10' } })
    }
    fireEvent.change(screen.getByLabelText('Начало блока'), { target: { value: '' } })
    fireEvent.click(screen.getByLabelText('Фиксированное начало'))
    expect(save.disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })
  it('can plan duration without a start and preserves references during a reference-loading failure', async () => {
    const { onSave } = editor({ referencesReady: false, referencesError: 'Сервер недоступен', event: { ...event, startsAt: '', endsAt: undefined } })
    expect((screen.getByLabelText('Ответственный') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe('Сервер недоступен')
    fireEvent.change(screen.getByLabelText('Длительность, мин'), { target: { value: '90' } })
    fireEvent.click(screen.getByText('Сохранить блок'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ startsAt: '', durationMinutes: 90, responsible: event.responsible, participants: event.participants })
  })
  it('a rejected save keeps input and allows a deliberate retry rather than closing the editor', async () => {
    const onSave = vi.fn().mockResolvedValue(false)
    const { onCancel } = editor({ onSave })
    fireEvent.change(screen.getByLabelText('Название блока'), { target: { value: 'Новый блок' } })
    fireEvent.click(screen.getByText('Сохранить блок'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onCancel).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Название блока') as HTMLInputElement).value).toBe('Новый блок')
  })
  it('empty reference/dependency states and commands render in English', () => {
    setI18nLang('en')
    editor({ choices: [], event: { ...event, responsible: null, participants: [] } })
    expect(screen.getByText('No participants')).toBeTruthy()
    expect(screen.getByText('No other blocks')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save block' })).toBeTruthy()
    expect(screen.getByLabelText('Duration, min')).toBeTruthy()
  })
})
