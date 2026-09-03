import { AppError, conflict } from '../errors.js'
import { isUniqueViolation, type Queryable } from '../plugins/db.js'
import { COMMITTED } from '../deals/state.js'

/**
 * Перенос свадьбы на другую дату — со всем, что от даты зависит.
 *
 * От даты свадьбы живут четыре вещи: занятость в календарях подрядчиков,
 * сроки задач чек-листа, время блоков тайминга и час открытия чата дня X
 * (последнее двигает триггер базы). Поменять только колонку `weddings.date`
 * значит развести их: подрядчик остаётся занят на дне, которого больше нет,
 * а на настоящий день свадьбы у него в календаре пусто — и эту дату успевает
 * занять другая пара.
 *
 * Поэтому перенос — один код, а не два похожих: и `POST /reschedule`,
 * и `PATCH /weddings` с новой датой проходят здесь.
 */
export interface RescheduleReport {
  free: string[]
  busy: string[]
}

export async function rescheduleWedding(
  client: Queryable,
  weddingId: string,
  date: string,
): Promise<RescheduleReport> {
  const { rows: w } = await client.query<{ date: string | null }>(
    'select date::text as date from weddings where id = $1',
    [weddingId],
  )
  const oldDate = w[0]?.date ?? null
  if (oldDate === date) return { free: [], busy: [] }

  /* Кто из забронированной команды свободен на новую дату, а кто нет.
   * Ответ нужен целиком: пара решает, отменять ли занятого, а не получает
   * «не получилось» без объяснения (План §9.4). */
  const { rows: team } = await client.query<{
    deal_id: string
    vendor_id: string | null
    name: string
    busy: boolean
  }>(
    `select d.id as deal_id, d.vendor_id,
            coalesce(ven.name, d.external_name) as name,
            exists (
              select 1 from vendor_busy_dates b
               where b.vendor_id = d.vendor_id and b.date = $2::date
                 and (b.deal_id is null or b.deal_id <> d.id)
            ) as busy
       from deals d
       left join vendors ven on ven.id = d.vendor_id
      where d.wedding_id = $1 and d.state = any($3)`,
    [weddingId, date, COMMITTED],
  )

  const busy = team.filter((t) => t.busy).map((t) => t.name)
  const free = team.filter((t) => !t.busy).map((t) => t.name)
  if (busy.length > 0) {
    // Частичный перенос хуже отказа: половина команды осталась на старой
    // дате, и это выясняется в день свадьбы.
    throw new AppError(409, 'team_busy', `Заняты на новую дату: ${busy.join(', ')}`, {
      busy: busy.join(', '),
    })
  }

  await client.query('update weddings set date = $2::date where id = $1', [weddingId, date])
  // Старые даты освобождаются, новые захватываются в той же транзакции.
  await client.query(
    `delete from vendor_busy_dates
      where source = 'deal' and deal_id in (select id from deals where wedding_id = $1)`,
    [weddingId],
  )
  for (const member of team) {
    if (!member.vendor_id) continue
    try {
      await client.query(
        `insert into vendor_busy_dates (vendor_id, date, source, deal_id)
         values ($1, $2::date, 'deal', $3)`,
        [member.vendor_id, date, member.deal_id],
      )
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('date_taken', `Дата у «${member.name}» занята`)
      }
      throw error
    }
  }

  /* Сроки задач и блоки тайминга считались от старой даты — сдвигаем
   * на ту же разницу. Свадьба без прежней даты сдвигать нечего: задачи
   * и тайминг завелись с пустыми сроками и пустыми останутся до правки. */
  if (oldDate) {
    await client.query(
      `update tasks set due = due + ($2::date - $3::date) where wedding_id = $1 and due is not null`,
      [weddingId, date, oldDate],
    )
    // `date - date` даёт целое число дней, а к timestamptz целое прибавить
    // нельзя — нужен интервал.
    await client.query(
      `update timeline_events
          set starts_at = starts_at + make_interval(days => ($2::date - $3::date)),
              ends_at = ends_at + make_interval(days => ($2::date - $3::date))
        where wedding_id = $1`,
      [weddingId, date, oldDate],
    )
  }
  return { free, busy }
}
