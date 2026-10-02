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

/**
 * Местные дата и время суток → момент по UTC.
 *
 * Два прохода (P3-7): смещение зоны само зависит от искомого момента, а
 * не только от даты/времени на входе — вблизи перехода на/с летнего
 * времени `offsetMinutes(guess, tz)` берёт смещение ДО перехода (`guess`
 * ещё наивно трактует местные поля как UTC), и однопроходная поправка
 * иногда приземляется уже ПОСЛЕ перехода, где настоящее смещение другое —
 * результат уезжал на величину скачка (например, Америка/Сантьяго, где
 * переход ровно в местную полночь, съезжал на час). Второй проход берёт
 * смещение уже в ТОЧКЕ первой поправки и перепроверяет: если оно другое —
 * значит, первая поправка перепрыгнула через переход, и считаем от
 * исходного `guess` ещё раз, уже верным смещением.
 */
export function fromLocal(local: Local, tz: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, 0, 0) + local.minutes * 60_000
  const firstOffset = offsetMinutes(new Date(guess), tz)
  const corrected = guess - firstOffset * 60_000
  const secondOffset = offsetMinutes(new Date(corrected), tz)
  return new Date(guess - secondOffset * 60_000)
}

/**
 * Границы МЕСТНЫХ суток, в которые попадает момент `at`.
 *
 * Нужны дневному лимиту push. Раньше он резал сутки через `date_trunc('day')`
 * по таймзоне сессии PostgreSQL — она нигде не задаётся, то есть UTC. У
 * человека на Камчатке (+12) местные сутки лежат на границе двух суток UTC,
 * и лимит «три в сутки» разрешал шесть: три в хвосте одних и три в начале
 * следующих. Тихие часы в этом же файле давно считаются по зоне пользователя —
 * лимит из общего правила выпал.
 *
 * Считаем здесь, а не в SQL: `at time zone` в запросе зависел бы от того,
 * знает ли база это имя зоны, а `knownTimeZone` проверяет её по ICU. Разойтись
 * они могут, и тогда падал бы весь путь уведомления.
 */
export function localDayBounds(at: Date, tz: string): { from: Date; to: Date } {
  const local = toLocal(at, tz)
  const from = fromLocal({ ...local, minutes: 0 }, tz)
  // Следующие сутки считаем календарём, а не прибавлением 86 400 000 мс:
  // при переходе на летнее время сутки бывают короче и длиннее.
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day) + 86_400_000)
  const to = fromLocal(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), minutes: 0 },
    tz,
  )
  return { from, to }
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
