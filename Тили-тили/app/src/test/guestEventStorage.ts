import { GUEST_EVENT_OFFLINE_KEY, guestEventCopyKeys } from '../lib/guestDayOffline'

/** Inspect raw storage, including copies left by an older app. */
export function guestEventStorageText(): string | null {
  const records = [GUEST_EVENT_OFFLINE_KEY, ...guestEventCopyKeys()]
    .map(key => localStorage.getItem(key))
    .filter(value => value !== null)
  return records.length ? records.join('\n') : null
}
