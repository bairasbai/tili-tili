import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffSupport, SupportCases, SupportCaseScreen } from '@/pages/SupportCases'
import { saveTokens } from '@/lib/api/client'

const id = 'b4ca72e0-1708-4f7a-ab10-fcf3299e1558'
const subject = 'Личная тема', message = 'Личный текст автора'
const createdAt = '2026-11-10T10:30:00Z'
const detail = { id, subject, createdAt, assigned: true, status: 'in_progress',
  history: [{ id, kind: 'opened', message, createdAt }] }

const tokens = (sub: string) => ({ accessToken: `e30.${btoa(JSON.stringify({ sub, sid: sub + '-session' }))}.test`, refreshToken: 'local-test' })
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const error = (status: number, code: string, message: string) => reply({ error: { code, message } }, status)

describe('интерфейс поддержки', () => {
  beforeEach(() => { localStorage.clear(); saveTokens(tokens('owner')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); saveTokens(null); localStorage.clear() })

  it('сохраняет черновик и ключ после ошибки связи, после квитанции открывает историю', async () => {
    const keys: (string | null)[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith(`/support/cases/${id}`)) return reply(detail)
      if (init?.method !== 'POST') return reply({ items: [], nextCursor: null })
      keys.push(new Headers(init.headers).get('Idempotency-Key'))
      if (keys.length === 1) throw new TypeError('temporary network failure')
      return reply({ id }, 201)
    }))
    render(<MemoryRouter initialEntries={['/support']}><Routes>
      <Route path="/support" element={<SupportCases />} />
      <Route path="/support/cases/:caseId" element={<SupportCaseScreen />} />
    </Routes></MemoryRouter>)
    const topic = await screen.findByLabelText('Тема обращения'), body = screen.getByLabelText('Опишите вопрос')
    fireEvent.change(topic, { target: { value: subject } })
    fireEvent.change(body, { target: { value: message } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить обращение' }))
    await screen.findByRole('alert')
    expect((topic as HTMLInputElement).value).toBe(subject)
    expect((body as HTMLTextAreaElement).value).toBe(message)
    fireEvent.click(screen.getByRole('button', { name: 'Отправить обращение' }))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(keys).toEqual([expect.any(String), keys[0]])
  })

  it('при проверке после возвращения в окно скрывает частный текст, отказ по роли не раскрывает его', async () => {
    let reads = 0, resolve!: (value: Response) => void
    const blocked = new Promise<Response>(done => { resolve = done })
    vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1 ? reply(detail) : blocked))
    render(<MemoryRouter initialEntries={[`/admin/support/${id}`]}><Routes>
      <Route path="/admin/support/:caseId" element={<StaffSupport />} />
    </Routes></MemoryRouter>)
    expect(await screen.findByText(message)).toBeTruthy()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Закрыть с ответом' })).toBeNull()
    await act(async () => { resolve(error(403, 'forbidden', 'Раздел для сотрудников платформы')) })
    expect(await screen.findByText('Раздел для сотрудников платформы')).toBeTruthy()
    expect(screen.queryByText(message)).toBeNull()
    expect(reads).toBe(2)
  })

  it('отбрасывает поздний ответ предыдущего аккаунта при смене сеанса', async () => {
    let resolve!: (value: Response) => void
    const late = new Promise<Response>(done => { resolve = done })
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => new Headers(init?.headers).get('Authorization')?.includes(tokens('owner').accessToken)
      ? late : error(404, 'not_found', 'Обращение не найдено'))
    vi.stubGlobal('fetch', fetcher)
    render(<MemoryRouter initialEntries={[`/support/cases/${id}`]}><Routes>
      <Route path="/support/cases/:caseId" element={<SupportCaseScreen />} />
    </Routes></MemoryRouter>)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    act(() => saveTokens(tokens('another')))
    expect(await screen.findByText('Обращение не найдено')).toBeTruthy()
    await act(async () => { resolve(reply(detail)) })
    expect(screen.queryByText(subject)).toBeNull()
    expect(screen.queryByText(message)).toBeNull()
  })
})
