// @vitest-environment jsdom
/*
 * Регрессии на «пропажу данных при перезагрузке».
 * Каждый блок проверяет две стороны: запись в localStorage и чтение обратно
 * при повторном монтировании (эмуляция F5).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/*
 * Гость ходит по своему токену, а не по аккаунту. Мок держит его ответ в
 * памяти: без этого проверка «ответ сохранился» смотрела бы на состояние
 * экрана, а не на то, что дошло до сервера.
 */
const { guestState } = vi.hoisted(() => ({ guestState: { status: 'pending' as string } }))
vi.mock('@/lib/api/guest', async (orig) => ({
  ...await orig<object>(),
  getRsvp: async () => ({
    guestName: 'Ольга',
    status: guestState.status,
    wedding: { title: 'Алина & Тимур', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 },
  }),
  sendRsvp: async (_t: string, status: string) => { guestState.status = status },
  getGuestMenu: async () => ({ question: '', options: [], chosenOptionId: null }),
  getGuestShuttle: async () => ({ myBusId: null, routes: [] }),
  getGuestHotels: async () => [],
}))

/* Мозаика приходит с сервера — общий набор ответов: src/test/slotsMock.ts. */
vi.mock('@/lib/api/weddingData', async (orig) => ({ ...await orig<object>(), ...(await import('@/test/slotsMock')).slotsRead }))
vi.mock('@/lib/api/slots', async (orig) => ({ ...await orig<object>(), ...(await import('@/test/slotsMock')).slotsWrite }))
import { authorize, invitesRevoked, resetSlots } from '@/test/slotsMock'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
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
  const { slots, bookVendor, cancelBooking, paySlot, bookExternal, removeExternalVendor } = useStore()
  const s = (id: string) => slots.find(x => x.id === id)
  return (
    <div>
      <span data-testid="count">{slots.length}</span>
      <span data-testid="s8-state">{s('s8')?.state ?? '—'}</span>
      <span data-testid="s8-vendor">{s('s8')?.vendor ?? '—'}</span>
      <span data-testid="s1-state">{s('s1')?.state ?? '—'}</span>
      <span data-testid="s1-vendor">{s('s1')?.vendor ?? '—'}</span>
      <span data-testid="s2-status">{s('s2')?.status ?? '—'}</span>
      <span data-testid="s9-state">{s('s9')?.state ?? '—'}</span>
      <button onClick={() => void bookVendor('s8', 'v9', 4_000_000)}>book</button>
      <button onClick={() => void cancelBooking('s1')}>cancel</button>
      <button onClick={() => void paySlot('s2')}>pay</button>
      <button onClick={() => void bookExternal('s9', 'Фотограф Ирек', 3_000_000, '+79170000000')}>own</button>
      <button onClick={() => void removeExternalVendor('s9')}>drop-own</button>
    </div>
  )
}

describe('мозаика команды живёт на сервере, а не в браузере', () => {
  beforeEach(() => { resetSlots(); authorize() })

  it('гость без свадьбы видит пустую мозаику, а не выдуманную', async () => {
    /* Раньше двенадцать слотов лежали в `initialSlots`, и три из них были
       «забронированы» у каждого, кто открыл приложение. */
    localStorage.clear()
    wrap(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0'))
  })

  it('бронь показывается после ответа сервера и переживает перезагрузку', async () => {
    wrap(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('s8-state').textContent).toBe('empty'))
    fireEvent.click(screen.getByText('book'))
    await waitFor(() => expect(screen.getByTestId('s8-state').textContent).toBe('booked'))

    /* F5 — данные приходят заново с сервера, локальной копии нет. */
    reload(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('s8-vendor').textContent).toBe('Подрядчик v9'))
  })

  it('отмена брони не «воскресает» после перезагрузки', async () => {
    wrap(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('s1-state').textContent).toBe('booked'))
    fireEvent.click(screen.getByText('cancel'))
    await waitFor(() => expect(screen.getByTestId('s1-state').textContent).toBe('empty'))

    reload(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('s1-state').textContent).toBe('empty'))
    expect(screen.getByTestId('s1-vendor').textContent).toBe('—')
  })

  it('аванс виден подписью, а плитка остаётся забронированной', async () => {
    /* Аванс вносят по существующей сделке — на пустом слоте платить нечего. */
    resetSlots({ s1: 'Усадьба Белый Сад', s2: 'Фотостудия «Кадр»' })
    wrap(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('12'))
    fireEvent.click(screen.getByText('pay'))
    /* На экране четыре состояния плитки, на сервере пять: `paid` показываем
       как `booked` с подписью — прятать факт оплаты нельзя. */
    await waitFor(() => expect(screen.getByTestId('s2-status').textContent).toBe('Аванс внесён'))
  })

  it('свой подрядчик убирается удалением, а не отменой: ссылка гаснет', async () => {
    /*
     * Отмена только закрывает сделку. Удаление своего подрядчика ещё и гасит
     * выданную ему ссылку-приглашение — без этого человек, которого убрали из
     * свадьбы, продолжает видеть по живому токену дату, тайминг и чат.
     */
    wrap(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('12'))
    fireEvent.click(screen.getByText('own'))
    await waitFor(() => expect(screen.getByTestId('s9-state').textContent).toBe('booked'))

    fireEvent.click(screen.getByText('drop-own'))
    await waitFor(() => expect(screen.getByTestId('s9-state').textContent).toBe('empty'))
    expect(invitesRevoked).toContain('s9')
  })

  it('ничего из мозаики не оседает в localStorage', async () => {
    wrap(<SlotProbe />)
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('12'))
    fireEvent.click(screen.getByText('book'))
    await waitFor(() => expect(screen.getByTestId('s8-state').textContent).toBe('booked'))
    /* Вторая копия мозаики на устройстве разошлась бы с серверной на первом
       же действии из другого устройства или из кабинета подрядчика. */
    expect(localStorage.getItem('tt_slots')).toBeNull()
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

describe('гость: ответ RSVP уходит паре, а не в браузер гостя', () => {
  const open = () => {
    const btn = screen.queryByText('Открыть приглашение')
    if (btn) fireEvent.click(btn)
  }

  beforeEach(() => {
    guestState.status = 'pending'
    localStorage.setItem('tt_guest_token', 'g-token')
  })

  it('ответ сохраняется на сервере и виден после перезагрузки', async () => {
    /*
     * Раньше ответ жил в `tt_guest_rsvp` на телефоне гостя: страница честно
     * показывала «Ждём вас!», а пара в списке гостей не видела ничего. Теперь
     * проверяем ответ сервера, а не то, что экран нарисовал сам.
     */
    wrap(<Invite />)
    await waitFor(() => expect(screen.getByText('Открыть приглашение')).toBeTruthy())
    open()
    fireEvent.click(screen.getByText('Приду с радостью'))

    await waitFor(() => expect(guestState.status).toBe('yes'))
    await waitFor(() => expect(screen.getByText('Ждём вас!')).toBeTruthy())
    expect(localStorage.getItem('tt_guest_rsvp')).toBeNull()

    reload(<Invite />)
    await waitFor(() => expect(screen.getByText('Ждём вас!')).toBeTruthy())
  })

  it('без ссылки страница объясняет, что нужна ссылка, а не показывает чужое приглашение', async () => {
    localStorage.removeItem('tt_guest_token')
    wrap(<Invite />)
    await waitFor(() => expect(screen.getByText('Нужна ссылка из приглашения')).toBeTruthy())
  })
})
