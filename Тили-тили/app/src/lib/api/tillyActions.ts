import { api, ApiError, url } from './client'
export const acceptTillyAction = async (weddingId: string, actionId: string, assertCurrent: () => void) => {
  const result = await api.post(url('/weddings/{weddingId}/tilly/actions/{actionId}/accept', { weddingId, actionId }), {}, { assertCurrent })
  if (result.id !== actionId || result.state !== 'applied' || result.canApply || !result.result?.taskId) throw new ApiError('http', 200, 'invalid_response', 'Результат изменения не подтверждён сервером')
  return result
}
