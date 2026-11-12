import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTokens } from '@/lib/api/client'
import { AffectedDecisions, OwnerAppeal, StaffAppeals } from '@/pages/ComplaintAppeals'

const complaintId = '780e02b7-217d-4d2f-9fbd-9debb760f611'
const id = 'ae4d0409-149e-44e6-b602-9d82158af009'
const ownerPath = `/support/complaints/${complaintId}/appeal`
const when = '2026-11-11T10:30:00Z'
const message = 'Материалы заявителя'
const reason = 'Причина пересмотра'
const original = { complaintId, targetKind: 'vendor', category: 'fraud', action: 'warn', decisionAt: when, reason: null }
const appeal = { id, role: 'affected', message, submittedAt: when, decision: null }
const final = { ...appeal, decision: { outcome: 'changed', newAction: 'dismiss', decidedAt: when, reason } }
const tokens = (sub: string) => ({ accessToken: `e30.${btoa(JSON.stringify({ sub, sid: sub + '-session' }))}.test`, refreshToken: 'test' })
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})

function mount(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/support/moderation" element={<AffectedDecisions />} />
    <Route path="/support/complaints/:complaintId/appeal" element={<OwnerAppeal />} />
    <Route path="/admin/appeals" element={<StaffAppeals />} />
    <Route path="/admin/appeals/:appealId" element={<StaffAppeals />} />
  </Routes></MemoryRouter>)
}

describe('апелляции в интерфейсе', () => {
  beforeEach(() => { localStorage.clear(); saveTokens(tokens('one')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); saveTokens(null); localStorage.clear() })

  it('открывает решение из списка адресата, сохраняет черновик после сбоя и показывает результат', async () => {
    let submitted = false, reviewed = false
    const attempts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/moderation/decisions')) return reply({ items: [{ original, outcome: null }], nextCursor: null })
      if (init?.method === 'POST') {
        expect(path).toContain(`/complaints/${complaintId}/appeal`)
        attempts.push(JSON.parse(init.body as string))
        if (attempts.length === 1) throw new TypeError('network')
        submitted = true
        return reply({ id }, 201)
      }
      return reply({ role: 'affected', original, appeal: reviewed ? final : submitted ? appeal : null })
    }))
    mount('/support/moderation')
    fireEvent.click(await screen.findByRole('link', { name: /Открыть апелляцию/ }))
    const input = await screen.findByLabelText<HTMLTextAreaElement>('Почему решение стоит пересмотреть')
    fireEvent.change(input, { target: { value: '  ' + message + '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Подать апелляцию' }))
    await screen.findByRole('alert')
    expect(input.value).toContain(message)
    fireEvent.click(screen.getByRole('button', { name: 'Подать апелляцию' }))
    expect(await screen.findByText('Апелляция на рассмотрении')).toBeTruthy()
    expect(attempts).toEqual([{ message }, { message }])
    reviewed = true
    act(() => window.dispatchEvent(new Event('focus')))
    expect(await screen.findByText(reason)).toBeTruthy()
    expect(screen.getByText('Решение изменено')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Подать апелляцию' })).toBeNull()
  })

  it('назначает сотрудника, показывает допустимые меры из API и сохраняет обоснованное решение', async () => {
    const commands: unknown[] = []
    let decided = false
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/admin/complaint-appeals')) return reply({ items: [{
        id, targetKind: 'vendor', role: 'affected', assignedToMe: false, outcome: null, submittedAt: when,
      }], nextCursor: null })
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string)
        commands.push(body)
        if (body.action === 'decide') decided = true
        return reply({ id })
      }
      return reply({ original, appeal: decided ? final : appeal, allowedActions: decided ? [] : ['dismiss'],
        complaintText: 'Материалы исходной жалобы' })
    }))
    mount('/admin/appeals')
    const claim = await screen.findByRole('button', { name: /Взять апелляцию/ })
    expect(screen.queryByText(message)).toBeNull()
    fireEvent.click(claim)
    const select = await screen.findByLabelText('Решение по апелляции')
    expect(within(select).queryByRole('option', { name: 'Блокировка' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Сохранить решение' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'dismiss' } })
    fireEvent.change(screen.getByLabelText('Пояснение для заявителя'), { target: { value: reason } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить решение' }))
    expect(await screen.findByText(reason)).toBeTruthy()
    expect(commands).toEqual([{ action: 'claim' }, { action: 'decide', outcome: 'changed', newAction: 'dismiss', reason }])
    expect(screen.queryByLabelText('Решение по апелляции')).toBeNull()
  })

  it('после смены аккаунта игнорирует поздние материалы прежнего сеанса', async () => {
    let resolve!: (value: Response) => void
    const late = new Promise<Response>(done => { resolve = done })
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) =>
      new Headers(init?.headers).get('Authorization')?.includes(tokens('one').accessToken)
        ? late : reply({ error: { code: 'not_found', message: 'Апелляция или решение не найдены' } }, 404))
    vi.stubGlobal('fetch', fetcher)
    mount(ownerPath)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    act(() => saveTokens(tokens('two')))
    expect(await screen.findByText('Апелляция или решение не найдены')).toBeTruthy()
    await act(async () => { resolve(reply({ role: 'affected', original, appeal: final })) })
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByText(reason)).toBeNull()
  })

  it('скрывает материалы при повторной проверке и отзыве роли сотрудника', async () => {
    const complaintText = 'Закрытые материалы жалобы'
    const denied = 'Раздел для сотрудников платформы'
    let finishRecheck!: (response: Response) => void
    const recheck = new Promise<Response>(done => { finishRecheck = done })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply({ original, appeal, allowedActions: ['dismiss'], complaintText }))
      .mockReturnValueOnce(recheck)
    vi.stubGlobal('fetch', fetcher)

    mount(`/admin/appeals/${id}`)
    expect(await screen.findByText(complaintText)).toBeTruthy()
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Сохранить решение' })).toBeTruthy()

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(complaintText)).toBeNull()
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Сохранить решение' })).toBeNull()

    await act(async () => { finishRecheck(reply({ error: { code: 'forbidden', message: denied } }, 403)) })
    expect(await screen.findByText(denied)).toBeTruthy()
    expect(screen.queryByText(complaintText)).toBeNull()
    expect(screen.queryByText(message)).toBeNull()
  })
})
