import { api, url } from './client'
import type { components } from './schema'

type Origin = { assertCurrent: () => void }
type Schemas = components['schemas']
export type TaskDelegationInvitation = Schemas['TaskDelegationInvitation']
export type DelegatedTask = Schemas['DelegatedTask']

export const getWeddingTaskDelegations = (weddingId: string, origin: Origin) =>
  api.get(url('/weddings/{weddingId}/task-delegations', { weddingId }), origin)
export const issueTaskDelegation = (weddingId: string, taskId: string, origin: Origin) =>
  api.post(url('/weddings/{weddingId}/task-delegations', { weddingId }), { taskId }, origin)
export const revokeTaskDelegation = (weddingId: string, delegationId: string, origin: Origin) =>
  api.delete(url('/weddings/{weddingId}/task-delegations/{delegationId}', { weddingId, delegationId }), origin)
export const getDelegatedTasks = (origin: Origin) => api.get('/users/me/task-delegations', origin)
export const acceptTaskDelegation = (code: string, origin: Origin) =>
  api.post('/users/me/task-delegations/accept', { code }, origin)
export const setDelegatedTaskDone = (task: DelegatedTask, origin: Origin) =>
  api.put(url('/users/me/task-delegations/{delegationId}/completion', { delegationId: task.id }),
    { done: !task.done, expectedRevision: task.revision }, origin)
