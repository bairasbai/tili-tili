// @vitest-environment jsdom
/*
 * Согласие на обработку персональных данных (152-ФЗ, план §18.1).
 *
 * Требование закона: согласие даётся явным действием. Предустановленная
 * галочка согласием не считается, а без согласия регистрацию продолжать
 * нельзя. Здесь это и проверяется — вместе с наличием самих документов.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { projectFile } from '@/test/projectFiles'

/*
 * Действующая редакция приходит с сервера. Здесь она подменяется, потому что
 * проверяется не запрос, а то, что экран с ней делает: показывает человеку и
 * сверяет с текстом, который лежит в сборке.
 */
const { serverPolicy, transport } = vi.hoisted(() => ({
  serverPolicy: { version: '' },
  transport: { consentFails: false, tokens: null as unknown, calls: [] as string[] },
}))
vi.mock('@/lib/api/legal', () => ({
  getPolicy: async () => ({ policyVersion: serverPolicy.version }),
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
    post: async (path: string) => {
      transport.calls.push(path)
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

const wrap = (node: React.ReactNode) =>
  render(<MemoryRouter><StoreProvider>{node}</StoreProvider></MemoryRouter>)

/** Экран входа с загруженной редакцией: до неё галочка недоступна. */
const authReady = async () => {
  wrap(<Auth />)
  await waitFor(() => expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(false))
}

beforeEach(() => {
  localStorage.clear()
  serverPolicy.version = LEGAL_TEXT_VERSION
  transport.consentFails = false
  transport.tokens = null
  transport.calls.length = 0
})
afterEach(cleanup)

describe('согласие на обработку данных', () => {
  it('галочка не стоит заранее', async () => {
    await authReady()
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem('tt_consent')).toBeNull()
  })

  it('без согласия вход недоступен', async () => {
    await authReady()
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('согласие даётся нажатием и живёт только на экране', async () => {
    await authReady()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true')
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
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('неполный номер кнопку не открывает', async () => {
    await authReady()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '91712345' } })
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('согласие можно снять', async () => {
    await authReady()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
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
    expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true)
  })

  it('редакция сервера разошлась с текстом сборки — галочка закрыта', async () => {
    serverPolicy.version = '2027-01-01'
    wrap(<Auth />)
    await waitFor(() => expect(screen.getByText(/Документы обновились/)).toBeTruthy())
    expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    /* Даже нажатием: подписаться под текстом, которого не видел, нельзя. */
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
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
    fireEvent.click(screen.getByRole('checkbox'))
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

  it('согласие принято — токены остаются', async () => {
    await signIn()
    await waitFor(() => expect(transport.calls).toContain('/users/me/consent'))
    expect(transport.tokens).toEqual({ accessToken: 'a', refreshToken: 'r' })
  })
})

describe('редакция текста и редакция сервера — одно число', () => {
  it('LEGAL_TEXT_VERSION совпадает с POLICY_VERSION бэкенда', () => {
    const config = projectFile('../backend/src/config.ts')
    const fallback = /policyVersion:\s*source\.POLICY_VERSION\s*\?\?\s*'([^']+)'/.exec(config)
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
