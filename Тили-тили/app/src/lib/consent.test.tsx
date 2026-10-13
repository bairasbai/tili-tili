// @vitest-environment jsdom
/*
 * Согласие на обработку персональных данных (152-ФЗ, план §18.1).
 *
 * Требование закона: согласие даётся явным действием. Предустановленная
 * галочка согласием не считается, а без согласия регистрацию продолжать
 * нельзя. Здесь это и проверяется — вместе с наличием самих документов.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { projectFile } from '@/test/projectFiles'

/*
 * Действующая редакция приходит с сервера. Здесь она подменяется, потому что
 * проверяется не запрос, а то, что экран с ней делает: показывает человеку и
 * сверяет с текстом, который лежит в сборке.
 */
const { serverPolicy, transport } = vi.hoisted(() => ({
  serverPolicy: { version: '', calls: 0, replies: [] as Promise<{ policyVersion: string } | undefined>[], checks: [] as Array<(() => void) | undefined> },
  transport: { consentFails: false, tokens: null as unknown, calls: [] as string[], consentBody: null as unknown },
}))
vi.mock('@/lib/api/legal', () => ({
  getPolicy: async (options?: { assertCurrent?: () => void }) => {
    serverPolicy.calls++
    serverPolicy.checks.push(options?.assertCurrent)
    return serverPolicy.replies.shift() ?? { policyVersion: serverPolicy.version }
  },
}))

/*
 * Вход отвечает токенами, фиксация согласия может отказать. Проверяется не
 * запрос, а состояние, в котором остаётся человек: вошедший без согласия
 * упирается в 403 на каждом экране и починить это не может.
 */
vi.mock('@/lib/api/client', async (orig) => ({
  ...await orig<object>(),
  saveTokens: (v: unknown) => { transport.tokens = v },
  api: {
    get: async () => undefined,
    post: async (path: string, body?: unknown) => {
      transport.calls.push(path)
      if (path === '/users/me/consent') transport.consentBody = body
      if (path === '/auth/otp') return { resendAfter: 60 }
      if (path === '/auth/otp/verify') return { accessToken: 'a', refreshToken: 'r' }
      if (path === '/users/me/consent') {
        if (transport.consentFails) throw new Error('редакция разошлась')
        return undefined
      }
      return undefined
    },
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  },
}))

const { Auth } = await import('@/pages/Account')
const { Offer, Privacy } = await import('@/pages/Legal')
const { LEGAL_TEXT_VERSION } = await import('./legal')
const { ApiError } = await import('./api/client')

const wrap = (node: React.ReactNode) =>
  render(<MemoryRouter><StoreProvider>{node}</StoreProvider></MemoryRouter>)

/* Две галочки (152-ФЗ, план бэкенда §7): согласие на обработку и «мне есть 18 лет».
   Ищутся по имени — `getByRole('checkbox')` без имени с двумя элементами падает. */
const consentBox = () => screen.getByRole('checkbox', { name: /обработку персональных данных/ })
const adultBox = () => screen.getByRole('checkbox', { name: 'Мне есть 18 лет' })

/** Экран входа с загруженной редакцией: до неё галочка недоступна. */
const authReady = async () => {
  wrap(<Auth />)
  await waitFor(() => expect(consentBox().hasAttribute('disabled')).toBe(false))
}

beforeEach(() => {
  localStorage.clear()
  serverPolicy.version = LEGAL_TEXT_VERSION
  serverPolicy.calls = 0
  serverPolicy.replies.length = 0
  serverPolicy.checks.length = 0
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  transport.consentFails = false
  transport.tokens = null
  transport.calls.length = 0
  transport.consentBody = null
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('согласие на обработку данных', () => {
  it('галочка не стоит заранее', async () => {
    await authReady()
    expect(consentBox().getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem('tt_consent')).toBeNull()
  })

  it('без согласия вход недоступен', async () => {
    await authReady()
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('согласие даётся нажатием и живёт только на экране', async () => {
    await authReady()
    fireEvent.click(consentBox())
    expect(consentBox().getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    /* Возраст — отдельная галочка (план бэкенда §7): без неё код не запросить. */
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
    fireEvent.click(adultBox())
    /* Кнопка ждёт ещё и телефон: код запрашивается у сервера, и запрос без
       номера отправлять некуда. Согласие — необходимое условие, не достаточное. */
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(false)
    /* Галочка — состояние экрана, не устройства: в хранилище она переживала
       брошенный вход и стояла заранее для следующего человека на этом
       телефоне (ERR-0226, D1-12). Дата согласия фиксируется сервером. */
    expect(localStorage.getItem('tt_consent')).toBeNull()
  })

  it('одного согласия мало — без телефона код не запросить', async () => {
    await authReady()
    fireEvent.click(consentBox())
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('неполный номер кнопку не открывает', async () => {
    await authReady()
    fireEvent.click(consentBox())
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '91712345' } })
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('согласие можно снять', async () => {
    await authReady()
    fireEvent.click(consentBox())
    fireEvent.click(consentBox())
    expect(consentBox().getAttribute('aria-checked')).toBe('false')
    expect(JSON.parse(localStorage.getItem('tt_consent')!)).toBeNull()
  })
})

/*
 * Подпись ставится под КОНКРЕТНЫМ текстом (152-ФЗ).
 *
 * Текст живёт в сборке, номер редакции — на сервере, и раньше их не связывало
 * ничто: человек читал экран без номера, а в базу ложилась редакция, о которой
 * он не знал. Разойдись они — восстановить, что именно он видел, было бы нечем.
 */
describe('редакция документов: подпись под тем, что человек видел', () => {
  it('редакция названа на экране входа', async () => {
    await authReady()
    expect(screen.getByText(/редакция от/)).toBeTruthy()
  })

  it('до ответа сервера согласие дать нельзя', () => {
    wrap(<Auth />)
    /* Не «пока грузится, разрешим»: редакция неизвестна, подписывать нечего. */
    expect(consentBox().hasAttribute('disabled')).toBe(true)
  })

  it('редакция сервера разошлась с текстом сборки — галочка закрыта', async () => {
    serverPolicy.version = '2027-01-01'
    wrap(<Auth />)
    await waitFor(() => expect(screen.getByText(/Документы обновились/)).toBeTruthy())
    expect(consentBox().hasAttribute('disabled')).toBe(true)

    fireEvent.click(consentBox())
    /* Даже нажатием: подписаться под текстом, которого не видел, нельзя. */
    expect(consentBox().getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem('tt_consent')).toBeNull()
  })
})

/*
 * Расхождение редакций ловится в браузере, но ловить его там — уже поздно:
 * человек упирается в «обновите приложение» вместо регистрации.
 *
 * Здесь та же сверка на сборке: редакция текстов приложения и умолчание
 * `POLICY_VERSION` на сервере — одно число. Разъедутся при правке — тест
 * покраснеет до выката, а не у пользователя.
 */
/*
 * Вошёл, но согласия нет — состояние, из которого человек не выберется сам.
 *
 * `requireConsent` стоит на каждом защищённом маршруте: все экраны ответят 403,
 * а приложение покажет «у вашей роли нет доступа» — про роль, которая ни при
 * чём. Токены при этом лежат в браузере, и при следующем открытии он снова
 * «вошедший». Поэтому отказ фиксации согласия обязан снять токены.
 */
describe('согласие не зафиксировано — значит и вход не состоялся', () => {
  const signIn = async () => {
    await authReady()
    fireEvent.click(consentBox())
    fireEvent.click(adultBox())
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    fireEvent.click(screen.getByText('Получить код').closest('button')!)
    await waitFor(() => expect(transport.calls).toContain('/auth/otp'))
    for (let k = 0; k < 4; k++) {
      fireEvent.change(document.getElementById(`otp-${k}`)!, { target: { value: String(k + 1) } })
    }
    fireEvent.click(screen.getByText('Войти').closest('button')!)
  }

  it('отказ фиксации согласия снимает токены', async () => {
    transport.consentFails = true
    await signIn()
    await waitFor(() => expect(transport.calls).toContain('/users/me/consent'))
    /* Токены выданы входом и отозваны здесь же: половинчатого состояния нет. */
    await waitFor(() => expect(transport.tokens).toBeNull())
  })

  it('согласие принято — токены остаются, «мне есть 18» уходит в теле как adult: true', async () => {
    await signIn()
    await waitFor(() => expect(transport.calls).toContain('/users/me/consent'))
    expect(transport.tokens).toEqual({ accessToken: 'a', refreshToken: 'r' })
    expect(transport.consentBody).toMatchObject({ adult: true })
  })

  it('«мне есть 18» не стоит заранее и снимается вместе с согласием при смене номера', async () => {
    await authReady()
    expect(adultBox().getAttribute('aria-checked')).toBe('false')
    fireEvent.click(consentBox())
    fireEvent.click(adultBox())
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234560' } })
    expect(consentBox().getAttribute('aria-checked')).toBe('false')
    expect(adultBox().getAttribute('aria-checked')).toBe('false')
  })
})

describe('редакция текста и редакция сервера — одно число', () => {
  it('LEGAL_TEXT_VERSION совпадает с POLICY_VERSION бэкенда', () => {
    const config = projectFile('../backend/src/config.ts')
    /* `envText(source.POLICY_VERSION)`: пустая строка из шаблона `.env` — не версия (ревью 015). */
    const fallback = /policyVersion:\s*(?:envText\()?source\.POLICY_VERSION\)?\s*\?\?\s*'([^']+)'/.exec(config)
    /* Если умолчание перепишут иначе, тест обязан сломаться, а не тихо
       пропустить проверку: молчаливый пропуск здесь хуже отсутствия теста. */
    expect(fallback, 'умолчание POLICY_VERSION в backend/src/config.ts не найдено').toBeTruthy()
    expect(LEGAL_TEXT_VERSION).toBe(fallback![1])
  })
})

describe('юридические экраны', () => {
  it('оферта открывается, помечена черновиком и называет свою редакцию', () => {
    wrap(<Offer />)
    expect(screen.getByText('Черновик.')).toBeTruthy()
    expect(screen.getByText(/Площадка не является стороной сделки/)).toBeTruthy()
    /* Номер редакции на самом документе: по нему фиксируется согласие. */
    expect(screen.getByText(/Редакция от/)).toBeTruthy()
  })

  it('политика открывается, называет место хранения данных и свою редакцию', () => {
    wrap(<Privacy />)
    expect(screen.getByText('Черновик.')).toBeTruthy()
    expect(screen.getByText(/Российской Федерации/)).toBeTruthy()
    expect(screen.getByText(/Редакция от/)).toBeTruthy()
  })
})


describe('Auth: редакция документов требует текущую сеть', () => {
  it('offline mount не dispatch getPolicy и сохраняет номер при неизвестной редакции', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    wrap(<Auth />)
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    await act(async () => { await Promise.resolve() })
    expect(serverPolicy.calls).toBe(0)
    expect(consentBox().hasAttribute('disabled')).toBe(true)
    expect(adultBox().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
    expect((screen.getByPlaceholderText('917 123-45-67') as HTMLInputElement).value).toBe('9171234567')
    expect(transport.calls).toEqual([])
  })
})


const policyReply = () => {
  let resolve!: (value: { policyVersion: string }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ policyVersion: string }>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve: (version = LEGAL_TEXT_VERSION) => resolve({ policyVersion: version }), reject }
}
const network = (online: boolean) => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
  fireEvent(window, new Event(online ? 'online' : 'offline'))
}
const checkedPhone = async () => {
  await authReady()
  fireEvent.click(consentBox()); fireEvent.click(adultBox())
  fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
}

describe('Auth: свежая policy после reconnect', () => {
  it('пустой успешный policy ответ остаётся UNKNOWN и не открывает действия', async () => {
    serverPolicy.replies.push(Promise.resolve(undefined))
    wrap(<Auth />)
    await act(async () => { await Promise.resolve() })
    expect(serverPolicy.calls).toBe(1)
    expect(consentBox().hasAttribute('disabled')).toBe(true)
    expect(adultBox().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(/редакция от/)).toBeNull()
    expect(transport.calls).toEqual([])
  })

  it('reconnect перечитывает policy, сохраняя номер и явные галочки до свежего ответа', async () => {
    await checkedPhone()
    const fresh = policyReply(); serverPolicy.replies.push(fresh.promise)
    network(false)
    await act(async () => { await Promise.resolve() })
    expect(serverPolicy.calls).toBe(1)
    expect(consentBox().getAttribute('aria-checked')).toBe('true')
    expect(adultBox().getAttribute('aria-checked')).toBe('true')
    expect(consentBox().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
    expect(serverPolicy.checks[0]).toBeTypeOf('function')
    expect(serverPolicy.checks[0]).toThrow()
    network(true)
    await waitFor(() => expect(serverPolicy.calls).toBe(2))
    expect(consentBox().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
    expect((screen.getByPlaceholderText('917 123-45-67') as HTMLInputElement).value).toBe('9171234567')
    await act(async () => { fresh.resolve(); await fresh.promise })
    await waitFor(() => expect(consentBox().hasAttribute('disabled')).toBe(false))
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(false)
    expect(transport.calls).toEqual([])
  })

  it('offline→online ABA не принимает запоздалую matching policy вместо новой несовпавшей редакции', async () => {
    const old = policyReply(), fresh = policyReply()
    serverPolicy.replies.push(old.promise, fresh.promise)
    wrap(<Auth />)
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    await waitFor(() => expect(serverPolicy.calls).toBe(1))
    act(() => { network(false); network(true) })
    await waitFor(() => expect(serverPolicy.calls).toBe(2))
    expect(serverPolicy.checks[0]).toThrow()
    await act(async () => { fresh.resolve('2027-01-01'); await fresh.promise })
    await waitFor(() => expect(screen.getByText(/Документы обновились/)).toBeTruthy())
    await act(async () => { old.resolve(); await old.promise })
    expect(screen.getByText(/Документы обновились/)).toBeTruthy()
    expect(consentBox().hasAttribute('disabled')).toBe(true)
    expect((screen.getByPlaceholderText('917 123-45-67') as HTMLInputElement).value).toBe('9171234567')
    expect(transport.calls).toEqual([])
  })

  it('policy, начатая online, не открывает согласие после disconnect', async () => {
    const old = policyReply(); serverPolicy.replies.push(old.promise)
    wrap(<Auth />)
    await waitFor(() => expect(serverPolicy.calls).toBe(1))
    network(false)
    await act(async () => { old.resolve(); await old.promise })
    expect(serverPolicy.checks[0]).toThrow()
    expect(consentBox().hasAttribute('disabled')).toBe(true)
    expect(adultBox().hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(/редакция от/)).toBeNull()
    expect(serverPolicy.calls).toBe(1)
    expect(transport.calls).toEqual([])
  })

  it('unmount закрывает original policy read и не запускает поздние действия', async () => {
    const old = policyReply(); serverPolicy.replies.push(old.promise)
    const view = wrap(<Auth />)
    await waitFor(() => expect(serverPolicy.calls).toBe(1))
    view.unmount()
    expect(serverPolicy.checks[0]).toThrow()
    await act(async () => { old.resolve(); await old.promise })
    expect(serverPolicy.calls).toBe(1)
    expect(transport.calls).toEqual([])
    expect(screen.queryByText('С возвращением')).toBeNull()
  })

  it('шаг OTP и четыре цифры сохраняются, но verify ждёт свежую policy', async () => {
    await checkedPhone()
    fireEvent.click(screen.getByText('Получить код').closest('button')!)
    await waitFor(() => expect(screen.getByText('Код из SMS')).toBeTruthy())
    for (let k = 0; k < 4; k++) fireEvent.change(document.getElementById(`otp-${k}`)!, { target: { value: String(k + 1) } })
    const fresh = policyReply(); serverPolicy.replies.push(fresh.promise)
    network(false)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Войти').closest('button')!.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText('Войти').closest('button')!)
    expect(transport.calls).toEqual(['/auth/otp'])
    network(true)
    await waitFor(() => expect(serverPolicy.calls).toBe(2))
    expect(screen.getByText('Войти').closest('button')!.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Код из SMS')).toBeTruthy()
    expect([0, 1, 2, 3].map(k => (document.getElementById(`otp-${k}`) as HTMLInputElement).value)).toEqual(['1', '2', '3', '4'])
    await act(async () => { fresh.resolve(); await fresh.promise })
    await waitFor(() => expect(screen.getByText('Войти').closest('button')!.hasAttribute('disabled')).toBe(false))
    expect([0, 1, 2, 3].map(k => (document.getElementById(`otp-${k}`) as HTMLInputElement).value)).toEqual(['1', '2', '3', '4'])
    expect(transport.calls).toEqual(['/auth/otp'])
  })

  it('обычный отказ policy сохраняет прежний retry, а offline retry не отправляет запрос', async () => {
    const failed = policyReply(); serverPolicy.replies.push(failed.promise)
    wrap(<Auth />)
    await waitFor(() => expect(serverPolicy.calls).toBe(1))
    await act(async () => { failed.reject(new ApiError('http', 503, 'internal', 'Сервер недоступен')); await failed.promise.catch(() => undefined) })
    await waitFor(() => expect(screen.getByText(/Не удалось проверить редакцию документов/)).toBeTruthy())
    expect(consentBox().hasAttribute('disabled')).toBe(true)
    const retry = screen.getByText('Повторить')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    fireEvent.click(retry)
    network(false)
    await act(async () => { await Promise.resolve() })
    expect(serverPolicy.calls).toBe(1)
    network(true)
    await waitFor(() => expect(serverPolicy.calls).toBe(2))
    await waitFor(() => expect(consentBox().hasAttribute('disabled')).toBe(false))
    expect(consentBox().getAttribute('aria-checked')).toBe('false')
    expect(transport.calls).toEqual([])
  })
})
