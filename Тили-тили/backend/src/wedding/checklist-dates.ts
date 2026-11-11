import { validationFailed } from '../errors.js'

const MONTHS = '^0*([0-9]{1,2}|1[01][0-9]|120)$'
const VALID_MONTH_PERIOD = new RegExp(MONTHS)

export function validateTaskPeriod(period: string) {
  if (/^\d+$/.test(period) && !VALID_MONTH_PERIOD.test(period)) {
    throw validationFailed({ period: 'числовой период должен быть от 0 до 120 месяцев' })
  }
}

/** Arguments are fixed SQL expressions chosen by callers. Named offsets belong to templates. */
export function taskDueSql(date: string, period: string, system: string) {
  return `(case
    when (${period}) ~ '${MONTHS}' then (${date} - make_interval(months => (${period})::int))::date
    when ${system} then ${date} + case (${period}) when 'last_week' then -7 when 'wedding_day' then 0 when 'after_wedding' then 7 end
    end)`
}
