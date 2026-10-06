/**
 * Future midday for the notification fixtures whose wedding zone is Europe/Moscow.
 * UTC calendar setters make the fixture independent of the runner's local zone.
 * Two calendar days ahead keeps it future at every hour; 09:00 UTC leaves room
 * for both the single 15-minute shift and all five consecutive 5-minute shifts.
 * This is test data, not a change to the application's calendar/shift rules.
 */
export function futureShiftStart(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid fixture clock')
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() + 2)
  start.setUTCHours(9, 0, 0, 0)
  return start.toISOString()
}
