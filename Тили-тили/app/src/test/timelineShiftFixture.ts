import type { TimelineShiftPreview } from '@/lib/api/weddingWrite'

export const shiftPreviewFixture = (overrides: Partial<TimelineShiftPreview> = {}): TimelineShiftPreview => {
  const guestCount = overrides.guestsAffected ?? 15
  const guests = Array.from({ length: guestCount }, (_, i) => ({ id: `guest-${i + 1}`, name: `Гость ${i + 1}` }))
  return {
  scope: { kind: 'day', date: '2027-06-14', timeZone: 'Asia/Yekaterinburg' },
  minutes: 15, sourceVersion: '1', canConfirm: true,
  expiresAt: '2027-06-14T10:10:00.000Z', previewToken: 'signed-preview-fixture',
  blocks: [{ id: 'e1', before: { startsAt: '2027-06-14T11:00:00.000Z', endsAt: '2027-06-14T11:30:00.000Z' }, after: { startsAt: '2027-06-14T11:15:00.000Z', endsAt: '2027-06-14T11:45:00.000Z' } }],
  excluded: [], conflicts: [], affectedBlockIds: ['e1'], affectedReferences: [], movements: [],
  blockDetails: [{ id: 'e1', name: 'Церемония', eventId: 'main', eventName: 'Основная программа', eventDate: '2027-06-14', timeZone: 'Asia/Yekaterinburg', location: null, startsAt: '2027-06-14T11:00:00Z', endsAt: '2027-06-14T11:30:00Z' },
    { id: 'e2', name: 'Фиксированный блок', eventId: 'main', eventName: 'Основная программа', eventDate: '2027-06-14', timeZone: 'Asia/Yekaterinburg', location: null, startsAt: null, endsAt: null }],
  referenceDetails: [], affectedGuests: guests,
  guestsAffected: guestCount, affectedGuestIds: guests.map(g => g.id), affectedVendorIds: [], affectedMemberIds: [],
  ...overrides,
  }
}
