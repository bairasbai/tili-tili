import { AppError, conflict } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { OPEN_BOOKINGS } from '../deals/state.js'
import { holdVendorDate } from '../deals/repo.js'
import { notifyWedding } from '../notify/notify.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import { TIMELINE_TEMPLATE } from './templates.generated.js'

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
  /** Кто перенёс: ему самому новость не шлём. */
  actorId: string | null = null,
): Promise<RescheduleReport> {
  /* `for update` на строке свадьбы: два переноса подряд с двух устройств
   * (календарь не блокирует дни, пока запрос идёт) иначе оба читали одну
   * старую дату, и второй сдвигал сроки задач и тайминг на свою разницу
   * ПОВЕРХ уже сделанного первого — итог не совпадал ни с одной из дат
   * (D2-08, R-187). Второй теперь ждёт первого и считает разницу от его даты. */
  const { rows: w } = await client.query<{ date: string | null; tz: string | null }>(
    'select date::text as date, tz from weddings where id = $1 for update',
    [weddingId],
  )
  const oldDate = w[0]?.date ?? null
  /* Пояс площадки: время тайминга местное, а не UTC. Без пояса «сборы в 08:00»
     превращаются в 13:00 у пары в Уфе. */
  const tz = w[0]?.tz ?? 'Europe/Moscow'
  if (oldDate === date) return { free: [], busy: [] }

  /* Кто из забронированной команды свободен на новую дату, а кто нет.
   * Ответ нужен целиком: пара решает, отменять ли занятого, а не получает
   * «не получилось» без объяснения (План §9.4).
   *
   * Только открытые брони: у `done` работа сделана, её день остаётся
   * отработанным и на новую дату не переезжает (D2-22, ERR-0205).
   *
   * Занятость проверяется по подрядчику, а не по сделке: у фотографа, который
   * снимает ещё и видео, две сделки и ОДНА строка занятости (ERR-0037) —
   * вторая сделка не должна видеть её как чужую. */
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
                 and (b.deal_id is null
                      or not exists (select 1 from deals own where own.id = b.deal_id and own.wedding_id = $1))
            ) as busy
       from deals d
       left join vendors ven on ven.id = d.vendor_id
      where d.wedding_id = $1 and d.state = any($3)`,
    [weddingId, date, OPEN_BOOKINGS],
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
  /* Старые даты освобождаются, новые захватываются в той же транзакции.
   * Снимаются только строки открытых броней: строка `done`-сделки остаётся
   * на отработанном дне (D2-22).
   *
   * Строка занятости у подрядчика одна на день и ссылается на первую из его
   * сделок этой свадьбы. Если та открыта, а вторая (второй слот) уже
   * выполнена, отработанный день держит именно вторая — ссылку переносим
   * на неё, иначе снятие открытой брони освободило бы и его. */
  /* Переписывать ссылку на выполненную сделку можно только у той, у которой
   * своей строки ещё нет: на втором переносе строка прежней даты уже
   * принадлежала `done`-сделке, и переписывание второй строки на неё же
   * оставляло день занятым призраком навсегда (ревью фиксов, RF-BE-02). */
  await client.query(
    `update vendor_busy_dates b
        set deal_id = (
          select d.id from deals d
           where d.vendor_id = b.vendor_id and d.wedding_id = $1 and d.state = 'done'
             and not exists (select 1 from vendor_busy_dates o where o.deal_id = d.id and o.source = 'deal')
           order by d.created_at limit 1
        )
      where b.source = 'deal'
        and b.deal_id in (select id from deals where wedding_id = $1 and state = any($2))
        and exists (
          select 1 from deals d
           where d.vendor_id = b.vendor_id and d.wedding_id = $1 and d.state = 'done'
             and not exists (select 1 from vendor_busy_dates o where o.deal_id = d.id and o.source = 'deal')
        )`,
    [weddingId, OPEN_BOOKINGS],
  )
  await client.query(
    `delete from vendor_busy_dates
      where source = 'deal'
        and deal_id in (select id from deals where wedding_id = $1 and state = any($2))`,
    [weddingId, OPEN_BOOKINGS],
  )
  /* Одна строка занятости на подрядчика, а не на сделку: у фотографа с двумя
   * слотами (фото + видео, ERR-0037) два `insert` упирались в первичный ключ
   * `(vendor_id, date)`, и перенос отвечал 409 «дата занята» — занята их же
   * свадьбой (D2-01). `holdVendorDate` различает «своя» и «чужая»: чужая —
   * 409, своя — уже наша. */
  const held = new Set<string>()
  for (const member of team) {
    if (!member.vendor_id || held.has(member.vendor_id)) continue
    held.add(member.vendor_id)
    try {
      await holdVendorDate(client, member.vendor_id, date, member.deal_id, weddingId)
    } catch (error) {
      if (error instanceof AppError && error.code === 'date_taken') {
        throw conflict('date_taken', `Дата у «${member.name}» занята`)
      }
      throw error
    }
  }

  /*
   * Сроки задач и блоки тайминга считались от старой даты — сдвигаем на ту же
   * разницу.
   *
   * Если прежней даты не было, сдвигать нечего: задачи и тайминг завелись с
   * пустыми сроками. Но и оставлять их пустыми нельзя — квиз разрешает ответ
   * «пока не знаем», и у такой пары чек-лист навсегда оставался бы без
   * дедлайнов, а день X — без часов. Поэтому первая дата не сдвигает, а
   * заводит: сроки считаются от неё так же, как при создании свадьбы.
   */
  if (!oldDate) {
    // «За 9 месяцев» лежит в `period` числом месяцев — тем же, что при создании.
    await client.query(
      `update tasks
          set due = ($2::date - make_interval(months => period::int))::date
        where wedding_id = $1 and due is null and period ~ '^[0-9]+$'`,
      [weddingId, date],
    )
    // Время шаблона местное для площадки: пояс берём у свадьбы.
    for (const e of TIMELINE_TEMPLATE) {
      await client.query(
        `update timeline_events
            set starts_at = ($2::date + $3::time) at time zone $5,
                ends_at = ($2::date + $4::time) at time zone $5
          where wedding_id = $1 and sort = $6 and starts_at is null`,
        [weddingId, date, e.startsAt, e.endsAt, tz, e.sort],
      )
    }
  }
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

  /* Перенос — новость для всех, кого он двигает, а не только запись в базе.
   *
   * До 2026-09-06 подрядчик узнавал о новой дате, только открыв календарь:
   * его занятость молча переезжала, а команда свадьбы не получала ничего.
   * Подрядчику — карточка обновления в кабинете, как у сдвига тайминга
   * (§13.2); команде и подрядчикам — уведомление мимо тихих часов: дата
   * свадьбы — из тех новостей, которые не ждут утра (§18.6). */
  const human = date.split('-').reverse().join('.')
  await noteVendorUpdate(client, weddingId, 'timeline', `Свадьба перенесена на ${human}: тайминг сдвинут на новый день`)
  await notifyWedding(
    client,
    weddingId,
    actorId,
    {
      kind: 'system',
      title: 'Дата свадьбы изменена',
      body: `Теперь свадьба ${human}. Сроки задач и тайминг сдвинуты.`,
      link: '/wedding',
      critical: true,
    },
    new Date(),
    true,
  )
  return { free, busy }
}
