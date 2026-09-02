// @vitest-environment jsdom
/*
 * Регрессии на «пропажу данных при перезагрузке».
 * Каждый блок проверяет две стороны: запись в localStorage и чтение обратно
 * при повторном монтировании (эмуляция F5).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider, useStore } from './store'
import { Settings, Notifications } from '@/pages/Account'
import { DayX } from '@/pages/Smart'
import Invite from '@/pages/Invite'

const wrap = (node: React.ReactNode, route = '/') =>
  render(<MemoryRouter initialEntries={[route]}><StoreProvider>{node}</StoreProvider></MemoryRouter>)

/** Перезагрузка страницы: размонтировать всё и собрать заново из localStorage. */
const reload = (node: React.ReactNode, route = '/') => { cleanup(); return wrap(node, route) }

beforeEach(() => localStorage.clear())
afterEach(cleanup)

function SlotProbe() {
  const { slots, bookVendor, cancelBooking, paySlot } = useStore()
  const s = (id: string) => slots.find(x => x.id === id)!
  return (
    <div>
      <span data-testid="s8-state">{s('s8').state}</span>
      <span data-testid="s8-vendor">{s('s8').vendor ?? '—'}</span>
      <span data-testid="s1-state">{s('s1').state}</span>
      <span data-testid="s1-vendor">{s('s1').vendor ?? '—'}</span>
      <span data-testid="s2-status">{s('s2').status ?? '—'}</span>
      <button onClick={() => bookVendor('s8', 'DJ Иван', 40000)}>book</button>
      <button onClick={() => cancelBooking('s1')}>cancel</button>
      <button onClick={() => paySlot('s2')}>pay</button>
    </div>
  )
}

describe('слоты команды переживают перезагрузку', () => {
  it('бронь сохраняется и читается обратно', () => {
    wrap(<SlotProbe />)
    expect(screen.getByTestId('s8-state').textContent).toBe('empty')
    fireEvent.click(screen.getByText('book'))
    expect(screen.getByTestId('s8-state').textContent).toBe('booked')

    reload(<SlotProbe />)
    expect(screen.getByTestId('s8-state').textContent).toBe('booked')
    expect(screen.getByTestId('s8-vendor').textContent).toBe('DJ Иван')
  })

  it('отмена брони не «воскресает» после перезагрузки (undefined теряется в JSON)', () => {
    wrap(<SlotProbe />)
    expect(screen.getByTestId('s1-state').textContent).toBe('booked')
    fireEvent.click(screen.getByText('cancel'))
    expect(screen.getByTestId('s1-state').textContent).toBe('empty')

    reload(<SlotProbe />)
    expect(screen.getByTestId('s1-state').textContent).toBe('empty')
    expect(screen.getByTestId('s1-vendor').textContent).toBe('—')
  })

  it('оплата сохраняется', () => {
    wrap(<SlotProbe />)
    fireEvent.click(screen.getByText('pay'))
    reload(<SlotProbe />)
    expect(screen.getByTestId('s2-status').textContent).toBe('Оплачено полностью')
  })

  it('статус хранится русским ключом i18n даже при EN-интерфейсе', () => {
    localStorage.setItem('tt_lang', 'en')
    wrap(<SlotProbe />)
    fireEvent.click(screen.getByText('book'))
    const saved = JSON.parse(localStorage.getItem('tt_slots')!)
    expect(saved.s8.status).toBe('Забронировано')
  })
})

describe('настройки переживают перезагрузку', () => {
  it('выключенный push сохраняется', () => {
    wrap(<Settings />)
    fireEvent.click(screen.getByLabelText('Push: дедлайны задач'))
    expect(JSON.parse(localStorage.getItem('tt_settings')!).push.tasks).toBe(false)
  })

  it('выключенный push читается обратно и тумблер остаётся выключенным', () => {
    localStorage.setItem('tt_settings', JSON.stringify({
      quiet: false,
      push: { tasks: false, chats: true, deals: true, tips: false },
      name: 'Алина Петрова',
    }))
    wrap(<Settings />)
    expect(screen.getByLabelText('Push: дедлайны задач').className).not.toContain('grad')
    expect(screen.getByLabelText('Push: сообщения').className).toContain('grad')
    expect(screen.getByLabelText('Тихие часы').className).not.toContain('grad')
    expect(screen.getByText('Алина Петрова')).toBeTruthy()
  })
})

describe('уведомления: «прочитано» переживает перезагрузку', () => {
  it('«Прочитать все» сохраняется и точки не возвращаются', () => {
    const { container } = wrap(<Notifications />)
    expect(container.innerHTML).toContain('top-4 right-4')
    fireEvent.click(screen.getByText('Прочитать все'))
    expect(JSON.parse(localStorage.getItem('tt_notif_read')!).length).toBeGreaterThan(0)

    const after = reload(<Notifications />)
    expect(after.container.innerHTML).not.toContain('top-4 right-4')
  })
})

describe('день X: задержка и план Б переживают перезагрузку', () => {
  it('накопленная задержка сохраняется', () => {
    wrap(<DayX />)
    fireEvent.click(screen.getByText('+15 мин задержка'))
    expect(screen.getByText(/МИН К ПЛАНУ/).textContent).toContain('+15')
    expect(JSON.parse(localStorage.getItem('tt_dayx')!).delay).toBe(15)

    reload(<DayX />)
    expect(screen.getByText(/МИН К ПЛАНУ/).textContent).toContain('+15')
  })
})

describe('гость: ответ RSVP переживает перезагрузку', () => {
  const open = () => {
    const btn = screen.queryByText('Открыть приглашение')
    if (btn) fireEvent.click(btn)
  }

  it('отправленный ответ не сбрасывается в пустую форму', () => {
    wrap(<Invite />)
    open()
    fireEvent.click(screen.getByText('Приду с радостью'))
    fireEvent.click(screen.getByText('Отправить ответ'))
    expect(screen.getByText('Ждём вас!')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('tt_guest_rsvp')!).sent).toBe(true)

    reload(<Invite />)
    open()
    expect(screen.getByText('Ждём вас!')).toBeTruthy()
  })
})
