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
const { guestState } = vi.hoisted(() => ({ guestState: { status: 'pending' as string, dead: false } }))
vi.mock('@/lib/api/guest', async (orig) => ({
  ...await orig<object>(),
  getRsvp: async () => {
    if (guestState.dead) {
      const { ApiError } = await import('@/lib/api/client')
      throw new ApiError('http', 401, 'unauthorized', 'Ссылка недействительна')
    }
    return {
      guestName: 'Ольга',
      status: guestState.status,
      wedding: { title: 'Алина & Тимур', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 },
    }
  },
  sendRsvp: async (_t: string, status: string) => { guestState.status = status },
  getGuestMenu: async () => ({ question: '', options: [], chosenOptionId: null }),
  getGuestShuttle: async () => ({ myBusId: null, routes: [] }),
  getGuestHotels: async () => [],
}))

/*
 * Профиль, сессии, уведомления и день X — всё это теперь серверное.
 * Мок держит ответы в памяти и записывает то, что ушло: тест проверяет не
 * «экран изменился», а «на сервер ушло именно это».
 */
const { profile, profilePatches, endedSessions, notifications, readNotifications, shifts, planbActivations } = vi.hoisted(() => ({
  profile: {
    id: 'u1',
    name: 'Тимур Волков',
    phone: '+79170009009',
    lang: 'ru',
    push: { tasks: true, chats: true, deals: true, tips: false },
    quietHours: { from: '22:00', to: '09:00' },
  } as Record<string, unknown>,
  profilePatches: [] as unknown[],
  endedSessions: [] as string[],
  notifications: [] as Record<string, unknown>[],
  readNotifications: [] as string[],
  shifts: [] as { weddingId: string; minutes: number }[],
  planbActivations: [] as string[],
}))

vi.mock('@/lib/api/auth', () => ({
  getMe: async () => ({ ...profile }),
  patchMe: async (patch: Record<string, unknown>) => {
    profilePatches.push(patch)
    Object.assign(profile, patch)
    return { ...profile }
  },
  getSessions: async () => [
    { id: 'this-one', device: 'Windows \u00b7 Chrome', current: true, createdAt: '2026-09-01T10:00:00Z' },
    { id: 'other-1', device: 'Android \u00b7 Chrome', current: false, createdAt: '2026-08-30T10:00:00Z' },
  ].filter(x => !endedSessions.includes(x.id)),
  endSession: async (id: string) => { endedSessions.push(id) },
}))

vi.mock('@/lib/api/notifications', async (orig) => ({
  ...await orig<object>(),
  getNotifications: async () => notifications.map(n => ({ ...n })),
  markNotificationRead: async (id: string) => {
    readNotifications.push(id)
    const n = notifications.find(x => x.id === id)
    if (n) n.read = true
  },
}))

vi.mock('@/lib/api/weddingWrite', async (orig) => ({
  ...await orig<object>(),
  shiftTimeline: async (weddingId: string, minutes: number) => { shifts.push({ weddingId, minutes }) },
  activatePlanB: async (_w: string, scenario = 'rain') => { planbActivations.push(scenario) },
}))

/* Мозаика приходит с сервера — общий набор ответов: src/test/slotsMock.ts. */
vi.mock('@/lib/api/weddingData', async (orig) => ({
  ...await orig<object>(),
  ...(await import('@/test/slotsMock')).slotsRead,
  getWedding: async () => ({ id: 'w1', title: 'Алина & Тимур', date: '2027-06-14', city: { name: 'Уфа' } }),
  getTimeline: async () => [
    { id: 'e1', name: 'Сбор гостей', startsAt: '2027-06-14T12:00:00Z', location: 'Усадьба' },
    { id: 'e2', name: 'Церемония', startsAt: '2027-06-14T15:00:00Z', location: 'Сад' },
  ],
}))
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

beforeEach(() => {
  localStorage.clear()
  profilePatches.length = 0
  endedSessions.length = 0
  readNotifications.length = 0
  shifts.length = 0
  planbActivations.length = 0
  Object.assign(profile, {
    name: 'Тимур Волков',
    push: { tasks: true, chats: true, deals: true, tips: false },
    quietHours: { from: '22:00', to: '09:00' },
  })
  notifications.length = 0
  notifications.push(
    { id: 'n1', kind: 'deal', title: 'Аванс подтверждён', body: 'Дата закрыта для других пар', link: '/wedding', read: false, createdAt: new Date().toISOString() },
    { id: 'n2', kind: 'guest', title: 'RSVP', body: 'Гость подтвердил приезд', link: null, read: true, createdAt: '2026-09-01T10:00:00Z' },
  )
})
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

/*
 * Настройки, уведомления и день X больше ничего не «переживают»: они не
 * хранятся на устройстве вовсе.
 *
 * Push рассылает сервер по СВОИМ настройкам, поэтому выключенный на телефоне
 * канал, лежащий в `tt_settings`, продолжал звонить. «Прочитано» из
 * `tt_notif_read` знал только этот браузер. Сдвиг дня X копился в `tt_dayx` и
 * не доходил ни до команды, ни до гостей.
 *
 * Проверяем ровно это: действие уходит на сервер и НИЧЕГО не оседает локально.
 */
describe('настройки: тумблеры уходят на сервер, а не в браузер', () => {
  it('выключенный push уходит запросом и не оседает локально', async () => {
    wrap(<Settings />)
    await waitFor(() => expect(screen.getByText('Тимур Волков')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Push: дедлайны задач'))
    await waitFor(() => expect(profilePatches).toContainEqual({ push: { tasks: false } }))
    expect(localStorage.getItem('tt_settings')).toBeNull()
  })

  it('состояние тумблеров читается из профиля, а не из устройства', async () => {
    profile.push = { tasks: false, chats: true, deals: true, tips: false }
    profile.quietHours = { from: '22:00', to: '22:00' }
    wrap(<Settings />)

    await waitFor(() => expect(screen.getByLabelText('Push: сообщения').className).toContain('grad'))
    expect(screen.getByLabelText('Push: дедлайны задач').className).not.toContain('grad')
    /* Пустое окно `22:00–22:00` сервер считает отсутствием тишины — тумблер
       обязан показывать выключенным именно его, а не отсутствие поля. */
    expect(screen.getByLabelText('Тихие часы').className).not.toContain('grad')
    expect(screen.getByText('Тимур Волков')).toBeTruthy()
  })

  it('устройства в списке — настоящие сессии, и «Завершить» гасит чужую', async () => {
    wrap(<Settings />)
    await waitFor(() => expect(screen.getByText('Android \u00b7 Chrome')).toBeTruthy())
    /* У текущей сессии кнопки «Завершить» нет: выход из неё — это выход из
       аккаунта, отдельная кнопка ниже. */
    expect(screen.getAllByText('Завершить')).toHaveLength(1)

    fireEvent.click(screen.getByText('Завершить'))
    await waitFor(() => expect(endedSessions).toContain('other-1'))
  })
})

describe('уведомления: «прочитано» уходит на сервер', () => {
  it('точка гаснет, отметка уходит запросом, в браузере ничего не остаётся', async () => {
    const { container } = wrap(<Notifications />)
    await waitFor(() => expect(container.innerHTML).toContain('top-4 right-4'))

    fireEvent.click(screen.getByText('Прочитать все'))
    await waitFor(() => expect(readNotifications).toEqual(['n1']))
    expect(localStorage.getItem('tt_notif_read')).toBeNull()

    /* Второе устройство увидит то же самое: сервер отдаёт `read: true`, и
       точка не возвращается. Раньше она возвращалась у всех, кроме того
       браузера, где нажали. */
    const after = reload(<Notifications />)
    await waitFor(() => expect(after.container.innerHTML).toContain('Аванс подтверждён'))
    expect(after.container.innerHTML).not.toContain('top-4 right-4')
  })
})

describe('день X: сдвиг программы уходит команде, а не в браузер пары', () => {
  const shiftButton = () => screen.getByText('+15 мин всей программе').closest('button')!

  it('«+15 мин всей программе» уходит запросом и не оседает локально', async () => {
    authorize()
    wrap(<DayX />)
    /* Кнопка выключена, пока тайминга нет: двигать нечего. Её включение и
       есть признак, что данные с сервера дошли. */
    await waitFor(() => expect(shiftButton().disabled).toBe(false))

    fireEvent.click(shiftButton())
    await waitFor(() => expect(shifts).toEqual([{ weddingId: 'w1', minutes: 15 }]))
    /* Ключа `tt_dayx` больше нет: пара видела в нём накопленную задержку,
       а команда и гости о ней не знали. */
    expect(localStorage.getItem('tt_dayx')).toBeNull()
  })

  it('план Б включается только после подтверждения', async () => {
    authorize()
    wrap(<DayX />)
    await waitFor(() => expect(shiftButton().disabled).toBe(false))

    /* Рассылка уходит всей команде и всем гостям — одного касания мало. */
    fireEvent.click(screen.getByText('Активировать'))
    expect(planbActivations).toEqual([])

    fireEvent.click(screen.getByText('Подтвердить'))
    await waitFor(() => expect(planbActivations).toEqual(['rain']))
  })
})

describe('гость: ответ RSVP уходит паре, а не в браузер гостя', () => {
  const open = () => {
    const btn = screen.queryByText('Открыть приглашение')
    if (btn) fireEvent.click(btn)
  }

  beforeEach(() => {
    guestState.status = 'pending'
    guestState.dead = false
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

  it('ответ можно изменить: планы меняются, и сервер это принимает', async () => {
    /*
     * Экран показывал «Ждём вас!» и не давал вернуться: гостю, который
     * передумал, оставалось звонить паре, чтобы та переписала ответ руками.
     * Сервер же принимает новый ответ поверх старого.
     */
    guestState.status = 'yes'
    wrap(<Invite />)
    await waitFor(() => expect(screen.getByText('Открыть приглашение')).toBeTruthy())
    open()
    fireEvent.click(screen.getByText('Не смогу прийти'))

    await waitFor(() => expect(guestState.status).toBe('no'))
    await waitFor(() => expect(screen.getByText('Спасибо за честный ответ')).toBeTruthy())
  })

  it('погашенная ссылка объясняет, что делать, и стирает мёртвый токен', async () => {
    /*
     * Пара перевыпустила приглашение — прежний токен умер. Экран показывал
     * голое «Ссылка недействительна» и оставлял гостя в тупике; мёртвый токен
     * при этом лежал в браузере и мешал открыть новую ссылку.
     */
    guestState.dead = true
    wrap(<Invite />)
    await waitFor(() => expect(screen.getByText('Ссылка больше не действует')).toBeTruthy())

    fireEvent.click(screen.getByText('Понятно'))
    await waitFor(() => expect(localStorage.getItem('tt_guest_token')).toBeFalsy())
  })
})
