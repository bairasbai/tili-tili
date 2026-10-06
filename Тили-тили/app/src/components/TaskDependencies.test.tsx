// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { TaskDependencies, type DependencyTask } from './TaskDependencies'
import { setI18nLang } from '@/lib/i18n'

const A = '10000000-0000-4000-8000-000000000001', B = '10000000-0000-4000-8000-000000000002', C = '10000000-0000-4000-8000-000000000003'
const W = '20000000-0000-4000-8000-000000000001'
const task = (): DependencyTask => ({ id: B, title: 'Final menu', done: false, dependencyVersion: '2',
  dependencies: [{ id: A, title: 'Guest replies', done: false }, { id: C, title: 'Venue choice', done: true }], dependencyOverride: null })
const tasks = (): DependencyTask[] => [task(), { id: A, title: 'Guest replies', done: false }, { id: C, title: 'Venue choice', done: true }]
const save = vi.fn(async () => true), refresh = vi.fn()
function props(extra: Partial<React.ComponentProps<typeof TaskDependencies>> = {}) {
  return { task: task(), tasks: tasks(), weddingId: W, canManage: true, disabled: false, onSave: save, onRefresh: refresh, ...extra }
}
const open = (extra: Partial<React.ComponentProps<typeof TaskDependencies>> = {}) => render(<MemoryRouter><TaskDependencies {...props(extra)} /></MemoryRouter>)
beforeEach(() => { setI18nLang('ru'); save.mockReset().mockResolvedValue(true); refresh.mockReset() })
afterEach(() => { cleanup(); setI18nLang('ru') })

describe('FR005 prerequisite editor', () => {
  it('shows the actual prerequisite states and a link to the exact task and wedding', () => {
    open()
    expect(screen.getByText('Сначала завершите:')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Guest replies' }).getAttribute('href')).toBe(`/wedding/checklist?wedding=${W}&task=${A}`)
    expect(screen.getByText('Выполнено:')).toBeTruthy(); expect(save).not.toHaveBeenCalled()
  })
  it('does not interpret missing server metadata as an empty graph', () => {
    open({ task: { id: B, title: 'Legacy', done: false } })
    expect(screen.queryByRole('region')).toBeNull(); expect(screen.queryByText('Предпосылки не заданы')).toBeNull()
  })
  it('distinguishes an actually empty prerequisite set', () => {
    open({ task: { ...task(), dependencies: [] } }); expect(screen.getByText('Предпосылки не заданы')).toBeTruthy()
  })
  it('offers read-only explanations to a helper without a manual-decision form', () => {
    open({ canManage: false }); expect(screen.queryByText('Изменить зависимости')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.getByText('Ручное завершение при незакрытых предпосылках подтверждает пара.')).toBeTruthy()
  })
  it('saves only the explicitly selected prerequisite IDs with the displayed version', async () => {
    open(); fireEvent.click(screen.getByText('Изменить зависимости'))
    const group = screen.getByRole('group', { name: 'Что нужно закончить раньше' })
    expect(within(group).queryByLabelText('Final menu')).toBeNull()
    fireEvent.click(within(group).getByLabelText('Venue choice'))
    fireEvent.click(screen.getByText('Сохранить зависимости'))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ dependsOn: [A], dependencyVersion: '2' }))
  })
  it('sends an empty list to explicitly remove the links', async () => {
    open(); fireEvent.click(screen.getByText('Изменить зависимости'))
    fireEvent.click(screen.getByLabelText('Guest replies')); fireEvent.click(screen.getByLabelText('Venue choice'))
    fireEvent.click(screen.getByText('Сохранить зависимости'))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ dependsOn: [], dependencyVersion: '2' }))
  })
  it('requires a non-blank manual reason and binds it to the unfinished subset', async () => {
    open(); const submit = screen.getByText('Завершить с указанной причиной') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: '  ' } }); expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: '  Menu decided in person  ' } })
    fireEvent.click(submit)
    await waitFor(() => expect(save).toHaveBeenCalledWith({ done: true, dependencyVersion: '2', dependencyOverride: { reason: 'Menu decided in person', prerequisiteIds: [A] } }))
  })
  it('preserves the reason and selected links after the parent reports a failed save', async () => {
    save.mockResolvedValue(false); open()
    fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByText('Завершить с указанной причиной'))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect((screen.getByLabelText('Причина ручного решения') as HTMLTextAreaElement).value).toBe('Keep this draft')
    fireEvent.click(screen.getByText('Изменить зависимости')); fireEvent.click(screen.getByLabelText('Venue choice'))
    fireEvent.click(screen.getByText('Сохранить зависимости'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect((screen.getByLabelText('Venue choice') as HTMLInputElement).checked).toBe(false)
  })
  it('does not submit duplicate rapid clicks while a decision is pending', async () => {
    let release!: (value: boolean) => void
    save.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve }))
    open(); fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: 'Reviewed' } })
    const submit = screen.getByText('Завершить с указанной причиной'); fireEvent.click(submit); fireEvent.click(submit)
    expect(save).toHaveBeenCalledOnce(); release(true)
    await waitFor(() => expect((screen.getByLabelText('Причина ручного решения') as HTMLTextAreaElement).value).toBe(''))
  })
  it('allows removing old links but not adding new links to a completed task', () => {
    const done = { ...task(), done: true, dependencies: [{ id: A, title: 'Guest replies', done: true }] }
    open({ task: done }); fireEvent.click(screen.getByText('Изменить зависимости'))
    expect((screen.getByLabelText('Guest replies') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('Venue choice') as HTMLInputElement).disabled).toBe(true)
  })
  it('displays a recorded reason and does not pretend the remaining prerequisites are done', () => {
    open({ task: { ...task(), done: true, dependencyOverride: { reason: 'Real decision', at: '2026-10-06T10:00:00Z' } } })
    expect(screen.getByText(/Real decision/)).toBeTruthy()
    expect(screen.getByText('У выполненной задачи есть незавершённые предпосылки. Отметка не снимается автоматически.')).toBeTruthy()
    expect(screen.queryByText('Завершить с указанной причиной')).toBeNull()
  })
  it('does not expose a completion override when all prerequisites are complete', () => {
    open({ task: { ...task(), dependencies: [{ id: A, title: 'Guest replies', done: true }] } })
    expect(screen.queryByLabelText('Причина ручного решения')).toBeNull()
  })
  it('provides explicit refresh without writing domain data', () => {
    open(); fireEvent.click(screen.getByText('Обновить задачи и зависимости'))
    expect(refresh).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled()
  })
  it('disables all write/refresh controls while the parent is refreshing', () => {
    open({ disabled: true }); fireEvent.click(screen.getByText('Изменить зависимости')); fireEvent.click(screen.getByText('Обновить задачи и зависимости'))
    expect(refresh).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
  })
  it('drops old decision drafts when a newer prerequisite version is displayed', () => {
    const v = open(); fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: 'Old scope' } })
    v.rerender(<MemoryRouter><TaskDependencies {...props({ task: { ...task(), dependencyVersion: '3' } })} /></MemoryRouter>)
    expect((screen.getByLabelText('Причина ручного решения') as HTMLTextAreaElement).value).toBe('')
  })
  it('drops decision controls and draft contents after a role change', () => {
    const v = open(); fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: 'Private decision' } })
    v.rerender(<MemoryRouter><TaskDependencies {...props({ canManage: false })} /></MemoryRouter>)
    expect(screen.queryByDisplayValue('Private decision')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull()
  })
  it('renders the action, explanation and reason label in English', () => {
    setI18nLang('en'); open()
    expect(screen.getByRole('region', { name: 'Task dependencies' })).toBeTruthy()
    expect(screen.getByLabelText('Reason for the manual decision')).toBeTruthy()
    expect(screen.getByText('Complete with this reason')).toBeTruthy()
  })
})
