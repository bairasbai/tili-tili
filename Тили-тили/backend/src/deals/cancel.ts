import { conflict } from '../errors.js'
import { uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { detachBusRoutes, releaseVendorDate } from './repo.js'
import { assertTransition, type DealState } from './state.js'
import { releaseLead } from '../vendor/leads.js'
import { setTimelineActor } from '../timeline/version.js'

/**
 * Единственная дверь, переводящая сделку в `cancelled` (F1, F-RL-2-02/SA-06).
 *
 * До этой функции сделку отменяли три независимые реализации — слот
 * (`slots.ts`), `PATCH /deals` и отмена свадьбы (`weddingLifecycle.ts`) —
 * и они расходились: дверь свадьбы не звала `releaseLead`/`detachBusRoutes`,
 * не гасила `external_invites`, снимала занятость голым `delete` мимо
 * `releaseVendorDate` (и забирала день у `done`-сделки того же подрядчика,
 * RF-BE-02); дверь слота не сбрасывала `negotiating_until`; дверь
 * `PATCH /deals` отвечала `bad_transition`, а не `already_cancelled`, на
 * повторную отмену (ARB-1 = A). Теперь все четыре HTTP-двери зовут только
 * эту функцию, внутри транзакции вызывающего — порядок замков прежний
 * («свадьба → сделка»).
 */
export async function cancelDeal(
  client: Queryable,
  dealId: string,
  opts: { actorId: string; note?: string | null; reason?: string | null },
): Promise<{ from: DealState }> {
  await client.query('select id from weddings where id=(select wedding_id from deals where id=$1) for update', [dealId])
  await setTimelineActor(client, opts.actorId)
  const { rows } = await client.query<{ state: DealState; slot_id: string }>(
    'select state, slot_id from deals where id = $1 for update',
    [dealId],
  )
  const from = rows[0]!.state
  if (from === 'cancelled') throw conflict('already_cancelled', 'Сделка уже отменена')
  assertTransition(from, 'cancelled')

  await client.query(
    `update deals set state = 'cancelled', cancelled_at = now(), negotiating_until = null,
        cancel_reason = coalesce($2, cancel_reason)
      where id = $1`,
    [dealId, opts.reason ?? null],
  )
  await client.query(
    `insert into deal_events (id, deal_id, from_state, to_state, actor_id, note)
     values ($1, $2, $3, 'cancelled', $4, $5)`,
    [uuidv7(), dealId, from, opts.actorId, opts.note ?? null],
  )
  await client.query('update slots set deal_id = null where deal_id = $1', [dealId])
  await releaseVendorDate(client, dealId)
  // Ссылка своего подрядчика гаснет любой дверью отмены (ERR-0242) — слот,
  // а не сделка: `external_invites.slot_id` живёт отдельно от `deal_id`.
  await client.query('update external_invites set revoked_at = now() where slot_id = $1 and revoked_at is null', [
    rows[0]!.slot_id,
  ])
  await detachBusRoutes(client, dealId)
  // Лид подрядчика из `won` — обратно в работу (ревью 015).
  await releaseLead(client, dealId)

  return { from }
}
