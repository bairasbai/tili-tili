/**
 * Тихие часы: когда уведомление МОЖНО отправить push-ом.
 *
 * Тихие часы — про звук в 23:00, а не про право знать: в приложении
 * уведомление появляется сразу, откладывается только push. Поэтому решение
 * здесь — «когда», а не «слать ли»: выбросить push значит потерять новость,
 * а не поберечь сон.
 *
 * Функция чистая и не ходит в базу — её проверяет тест, а не живой ночной
 * прогон.
 */
export interface QuietHours {
  /** «22:00» — с этого времени по местному времени пользователя тихо. */
  from: string
  /** «09:00» — до этого времени тихо. */
  to: string
}

/**
 * Часовой пояс, который понимает система. Неизвестный — не повод уронить
 * уведомление: считаем по Москве, сервис работает в РФ.
 */
export function knownTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'Europe/Moscow'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'Europe/Moscow'
  }
}

/** Смещение зоны в минутах на конкретный момент (у РФ перехода на лето нет). */
function offsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  // `hour` в формате hour12:false даёт 24 вместо 0 — приводим к суткам.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000
}

interface Local {
  year: number
  month: number
  day: number
  minutes: number
}

function toLocal(at: Date, tz: string): Local {
  const shifted = new Date(at.getTime() + offsetMinutes(at, tz) * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/** Местные дата и время суток → момент по UTC. */
export function fromLocal(local: Local, tz: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, 0, 0) + local.minutes * 60_000
  return new Date(guess - offsetMinutes(new Date(guess), tz) * 60_000)
}

/** «22:00» → 1320 минут от полуночи. Мусор на входе — начало суток. */
export function parseTime(value: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(value)
  if (!m) return 0
  return (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60)
}

/**
 * Когда push станет можно отправить. Если можно прямо сейчас — вернётся `at`.
 *
 * Критичное (сделки, день X) тихих часов не знает: дата уплывает и слот
 * пропадает независимо от того, спит ли человек.
 */
export function deliverAfter(at: Date, rawTz: string, quiet: QuietHours, critical = false): Date {
  if (critical) return at
  const tz = knownTimeZone(rawTz)

  const from = parseTime(quiet.from)
  const to = parseTime(quiet.to)
  // Пустое окно (22:00–22:00) — тишины нет вовсе.
  if (from === to) return at

  const local = toLocal(at, tz)
  const overnight = from > to
  const quietNow = overnight ? local.minutes >= from || local.minutes < to : local.minutes >= from && local.minutes < to
  if (!quietNow) return at

  // Конец тишины — ближайшее наступление `to`. Ночью после полуночи это
  // сегодняшнее утро, вечером до полуночи — завтрашнее.
  const sameDay = local.minutes < to
  const end = { ...local, minutes: to }
  if (!sameDay) {
    const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day) + 86_400_000)
    end.year = tomorrow.getUTCFullYear()
    end.month = tomorrow.getUTCMonth() + 1
    end.day = tomorrow.getUTCDate()
  }
  return fromLocal(end, tz)
}
