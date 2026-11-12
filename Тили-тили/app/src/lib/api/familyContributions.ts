import { api, url } from './client'
import type { components } from './schema'

export type FamilyContribution = components['schemas']['FamilyContribution']
export type FamilyContributionWrite = components['schemas']['FamilyContributionWrite']
export const listFamilyContributions = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/budget/family-contributions', { weddingId }))
export const getFamilyContributionHistory = (weddingId: string, contributionId: string) =>
  api.get(url('/weddings/{weddingId}/budget/family-contributions/{contributionId}/history', { weddingId, contributionId }))
export const saveFamilyContribution = (weddingId: string, contributionId: string, body: FamilyContributionWrite, assertCurrent: () => void) =>
  api.put(url('/weddings/{weddingId}/budget/family-contributions/{contributionId}', { weddingId, contributionId }), body, { assertCurrent })
