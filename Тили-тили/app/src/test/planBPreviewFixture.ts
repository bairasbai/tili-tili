import type { PlanBPreview } from '@/lib/api/weddingWrite'

export const planBPreviewFixture = (overrides: Partial<PlanBPreview> = {}): PlanBPreview => ({
  previewToken: 'test-planb-preview', expiresAt: '2027-06-14T08:10:00Z',
  scenario: 'rain', currentScenario: null, reserveAddress: null,
  inAppRecipients: [{ name: 'Аня', kind: 'team' }], manualGuests: ['Денис'],
  ...overrides,
})
