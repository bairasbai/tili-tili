import { api, ApiError, url } from './client'
import { parseInvitationDesign } from '../invitationDesign'

function checked<T extends { data: { draft: unknown; published: unknown; version: string }; etag: string | null }>(snapshot: T): T {
  parseInvitationDesign(snapshot.data.draft)
  if (snapshot.data.published !== null) parseInvitationDesign(snapshot.data.published)
  if (snapshot.etag !== `"invitation-${snapshot.data.version}"`) throw new ApiError('http', 200, 'invalid_response', 'Версия приглашения не подтверждена сервером')
  return snapshot
}
export const getInvitationDesign = async (weddingId: string) => checked(await api.getSnapshot(url('/weddings/{weddingId}/invitation-design', { weddingId })))
export const saveInvitationDesign = async (weddingId: string, data: unknown, version: string, assertCurrent: () => void) => checked(await api.putSnapshot(url('/weddings/{weddingId}/invitation-design', { weddingId }), parseInvitationDesign(data), { ifMatch: version, assertCurrent }))
export const publishInvitationDesign = async (weddingId: string, version: string, assertCurrent: () => void) => checked(await api.postSnapshot(url('/weddings/{weddingId}/invitation-design/publish', { weddingId }), {}, { ifMatch: version, assertCurrent }))
