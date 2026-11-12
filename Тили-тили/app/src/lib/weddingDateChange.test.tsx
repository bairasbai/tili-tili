import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WeddingDateChange } from '@/components/WeddingDateChange'
import { ApiError } from './api/client'
import { previewWeddingReschedule, type WeddingReschedulePreview } from './api/wedding'

vi.mock('./api/wedding', () => ({ previewWeddingReschedule: vi.fn() }))
vi.mock('./useLegacyActionScope', () => ({
  useLegacyActionScope: () => () => ({ isCurrent: () => true, assertCurrent: () => undefined }),
}))

const date = '2027-06-15'
const response: WeddingReschedulePreview = {
  previewToken: 'preview-one', currentDate: '2027-06-10', newDate: date, timeZone: 'Europe/Moscow',
  tasks: [{ id: 'task', title: 'Забрать декор', before: '2027-06-08', after: '2027-06-13' }],
  events: [], timeline: [], closingRequests: 0, canConfirm: true,
  bookings: [{ id: 'booking', name: 'Кондитер', eventId: null, moves: true, availability: 'unknown' }],
}

function open(onApply = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn()
  render(<WeddingDateChange weddingId="wedding" currentDate={response.currentDate} now={new Date(2027, 5, 10)}
    onApply={onApply} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: /15 июня/ }))
  return { onApply, onClose }
}

describe('предпросмотр даты на экране пары', () => {
  beforeEach(() => vi.mocked(previewWeddingReschedule).mockReset())

  it('сначала показывает последствия и предупреждает о неизвестной доступности', async () => {
    vi.mocked(previewWeddingReschedule).mockResolvedValue(response)
    const { onApply, onClose } = open()
    const confirm = await screen.findByRole('button', { name: 'Подтвердить перенос' })
    expect(screen.getByText('Доступность неизвестна, уточните у исполнителя')).not.toBeNull()
    expect(screen.getByText('08.06.2027 → 13.06.2027')).not.toBeNull()
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onApply).toHaveBeenCalledWith(date, expect.objectContaining({
      previewToken: 'preview-one', idempotencyKey: expect.any(String),
    }))
  })

  it('после изменения условий показывает новый снимок и блокирует подтверждение конфликта', async () => {
    vi.mocked(previewWeddingReschedule).mockResolvedValueOnce(response).mockResolvedValueOnce({
      ...response, previewToken: 'preview-two', canConfirm: false,
      bookings: [{ ...response.bookings[0]!, availability: 'busy' }],
    })
    const { onApply, onClose } = open(vi.fn().mockRejectedValueOnce(
      new ApiError('http', 409, 'reschedule_preview_changed', 'Изменились условия'),
    ))
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить перенос' }))
    expect(await screen.findByText('В календаре есть конфликт')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Условия изменились')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Подтвердить перенос' }).disabled).toBe(true)
    expect(onApply).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })
})
