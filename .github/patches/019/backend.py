from pathlib import Path
import hashlib

def apply(name, before, after, edits):
    p = Path(name)
    data = p.read_bytes() if p.exists() else b''
    assert hashlib.sha256(data).hexdigest() == before, f'Base mismatch: {name}'
    lines = data.decode().splitlines(keepends=True)
    for start, end, text in reversed(edits):
        lines[start:end] = [text]
    result = ''.join(lines).encode()
    assert hashlib.sha256(result).hexdigest() == after, f'Result mismatch: {name}'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(result)

apply('Тили-тили/backend/src/deals/book.ts', '2c261d8d964b85c26ab3539ec2dde5bf42986107209b53a4fd31ab08b38f0abf', '1e766db16f0b538adadd865f929e37f11f700048e06f568c9576ca5651128f9d', [
    (38, 40, "  const { rows: weddings } = await client.query<{ date: string | null; tz: string | null; archived_at: Date | null; cancelled_at: Date | null }>(\n    'select date::text as date, tz, archived_at, cancelled_at from weddings where id = $1 for share',\n"),
    (42, 43, "  if (!weddings[0] || weddings[0].archived_at) throw notFound('Свадьба не найдена')\n  if (weddings[0].cancelled_at) throw conflict('wedding_cancelled', 'Свадьба отменена')\n"),
    (70, 71, 'async function lockLiveVendor(client: Queryable, vendorId: string, offer = false): Promise<void> {\n'),
    (76, 77, '      for share of u, v`,\n'),
    (79, 80, "  if (!vendors[0]) {\n    if (offer) throw conflict('vendor_unavailable', 'Анкета подрядчика недоступна')\n    throw notFound('Подрядчик не найден')\n  }\n"),
    (162, 163, "  let packageId = input.performer.kind === 'external' ? null : input.performer.packageId ?? null\n  if (input.performer.kind === 'offer') {\n    await lockLiveVendor(client, input.performer.vendorId, true)\n    // The offer may have been read before a concurrent package deletion.\n    // Stabilize the optional FK, but NEVER replace the immutable offer terms.\n    if (packageId) {\n      const { rows } = await client.query<{ id: string }>(\n        'select id from vendor_packages where id = $1 and vendor_id = $2 for key share',\n        [packageId, input.performer.vendorId],\n      )\n      packageId = rows[0]?.id ?? null\n    }\n  }\n"),
    (177, 178, '        packageId,\n'),
])

apply('Тили-тили/backend/src/deals/repo.ts', '7cc477df5af374857f675831902fc444b10f63fcf80bf6c09697e2018aeeb22d', '054e94a801b23ba7c0fb6ad0bda43dd0b8c0c395b73461660021c5f5c9ff0951', [
    (15, 15, '  package_includes: string[] | null\n'),
    (46, 47, '  coalesce(d.package_title_snapshot, pkg.name) as package_name,\n  coalesce(d.package_includes_snapshot, pkg.items) as package_includes`\n'),
    (71, 72, '    // Accepted offer text may contain monetary/private conditions.\n    packageName: seesMoney ? r.package_name : null,\n    ...(seesMoney ? { packageIncludes: r.package_includes ?? null } : {}),\n'),
])

apply('Тили-тили/backend/src/offers/accept.ts', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '9f9b0f75079e417cbba8e438c3d0fc717cc0efdf53277ccd67242c2f466f3c6c', [
    (0, 0, "import { bookVendor, lockBookingContext } from '../deals/book.js'\nimport { loadSlot } from '../deals/repo.js'\nimport { conflict, forbidden, notFound } from '../errors.js'\nimport { isUuid } from '../ids.js'\nimport type { Queryable } from '../plugins/db.js'\n\n/** R-317: wedding → actor → slot → requests → vendor → package → offer.\n * The request is the response/accept mutex. Never lock an offer before its\n * package: ON DELETE SET NULL takes the opposite order on package removal. */\nexport async function acceptOffer(\n  client: Queryable,\n  input: { weddingId: string; actorId: string; offerId: string },\n) {\n  if (!isUuid(input.offerId)) throw notFound('Предложение не найдено')\n  const { rows: found } = await client.query<{ slot_id: string; request_id: string }>(\n    `select r.slot_id, r.id as request_id from offers o\n       join offer_requests r on r.id = o.request_id\n       join slots s on s.id = r.slot_id\n      where o.id = $1 and s.wedding_id = $2`,\n    [input.offerId, input.weddingId],\n  )\n  if (!found[0]) throw notFound('Предложение не найдено')\n  const context = await lockBookingContext(client, { ...input, slotId: found[0].slot_id })\n  // Recheck membership under the wedding lock, not only in the HTTP hook.\n  const { rows: members } = await client.query<{ role: string }>(\n    'select role from wedding_members where wedding_id = $1 and user_id = $2',\n    [input.weddingId, input.actorId],\n  )\n  if (members[0]?.role !== 'couple') throw forbidden('Принять предложение может только пара')\n\n  // Lock ALL requests in id order, just like bookVendor. Taking only the\n  // selected one first would reverse the order for two different offers.\n  await client.query('select id from offer_requests where slot_id = $1 order by id for update', [context.slotId])\n  const { rows } = await client.query<{\n    status: string; close_reason: string | null; vendor_id: string | null\n    wedding_date: string | null; kind: string; package_id: string | null\n    title: string | null; price: string | null; includes: string[]\n    superseded_at: Date | null; accepted_at: Date | null; expired: boolean\n  }>(\n    `select r.status, r.close_reason, r.vendor_id, r.wedding_date::text,\n            o.kind, o.package_id, o.title, o.price::text, o.includes,\n            o.superseded_at, o.accepted_at,\n            (o.valid_until < (now() at time zone $3)::date) as expired\n       from offers o join offer_requests r on r.id = o.request_id\n      where o.id = $1 and r.id = $2`,\n    [input.offerId, found[0].request_id, context.weddingTz ?? 'Europe/Moscow'],\n  )\n  const offer = rows[0]\n  if (!offer) throw notFound('Предложение не найдено')\n  if (offer.wedding_date !== context.date || offer.close_reason === 'date_changed') {\n    throw conflict('offer_stale_date', 'Предложение на прежнюю дату — запросите новое')\n  }\n  if (offer.status !== 'open') throw conflict('request_closed', 'Запрос предложения закрыт')\n  if (offer.superseded_at) throw conflict('offer_superseded', 'Подрядчик обновил предложение')\n  if (offer.accepted_at) throw conflict('offer_accepted', 'Предложение уже принято')\n  if (offer.kind !== 'offer') throw conflict('offer_declined', 'Подрядчик отказался от запроса')\n  if (offer.expired) throw conflict('offer_expired', 'Срок предложения истёк')\n  if (!offer.vendor_id) throw conflict('vendor_unavailable', 'Анкета подрядчика недоступна')\n  // Database constraints guarantee title/price for kind=offer; do not accept\n  // a caller-supplied amount or read mutable catalog terms here.\n  const dealId = await bookVendor(client, context, {\n    performer: { kind: 'offer', vendorId: offer.vendor_id, packageId: offer.package_id,\n      packageTitle: offer.title!, packageIncludes: offer.includes },\n    price: Number(offer.price),\n  })\n  await client.query('update offers set accepted_at = now(), deal_id = $2 where id = $1', [input.offerId, dealId])\n  return loadSlot(client, context.slotId, true)\n}\n"),
])

apply('Тили-тили/backend/src/offers/close.ts', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'c3a07825c58e2d61bdbf2bd3ae09bc3facbe68d10d3b5e1279ac84067cb4f98f', [
    (0, 0, "import type { Queryable } from '../plugins/db.js'\nimport { notifyVendorOfferEvent } from './notify.js'\n\n/** Caller holds the wedding lock. Close requests BEFORE deals/vendors. All\n * notifications share its transaction, so a failed reschedule sends none. */\nexport async function closeWeddingOfferRequests(\n  client: Queryable,\n  weddingId: string,\n  weddingTz: string | null,\n  reason: 'date_changed' | 'wedding_cancelled',\n): Promise<void> {\n  const { rows } = await client.query<{ user_id: string | null }>(\n    `with targets as (\n       select r.id from offer_requests r join slots s on s.id = r.slot_id\n        where s.wedding_id = $1 and r.status = 'open'\n        order by r.id for update of r\n     ), closed as (\n       update offer_requests r set status = 'closed', close_reason = $2, closed_at = now()\n         from targets t where r.id = t.id returning r.vendor_id\n     ) select v.user_id from closed c left join vendors v on v.id = c.vendor_id`,\n    [weddingId, reason],\n  )\n  for (const row of rows) {\n    if (row.user_id) await notifyVendorOfferEvent(client, row.user_id, weddingTz, reason)\n  }\n}\n"),
])

apply('Тили-тили/backend/src/routes/offers.ts', '781da5ad288c7ab9967d4a422565f0962f87e2ad0626bcf5a35cbf55adee5174', 'a2852a140f10413ad437a7b3f0f65568baeffaf66725adb55036f02c033b1cff', [
    (1, 1, "import { acceptOffer } from '../offers/accept.js'\n"),
    (108, 108, "\n  app.post('/weddings/:weddingId/offers/:offerId/accept', async (request, reply) => {\n    // This command has no editable terms. Reject bodies rather than silently\n    // discarding a price that a caller may think they have negotiated.\n    if (request.body !== undefined && request.body !== null) {\n      throw validationFailed({ body: 'Принятие предложения не принимает тело запроса' })\n    }\n    const { offerId } = request.params as { offerId: string }\n    return withIdempotency(db(), request, reply, 'offers.accept', (tx) => tx(async (client) => ({\n      status: 200,\n      body: await acceptOffer(client, {\n        weddingId: request.member!.weddingId, actorId: request.caller!.userId, offerId,\n      }),\n    })))\n  })\n"),
])

apply('Тили-тили/backend/src/routes/vendorCabinet.ts', '8ebcc50a952be33b9c3a58e5b4579c2eadb1101320cc6e6b86a71d0f4801ceb3', '522b6e4c6476e43e0f0ab9e4c3b88f9d9a3ee927723325b4f1d3be571faf1b4b', [
    (556, 556, '      package_includes: string[] | null\n'),
    (565, 565, '              coalesce(d.package_includes_snapshot, pkg.items) as package_includes,\n'),
    (609, 609, '        packageIncludes: r.package_includes,\n'),
])

apply('Тили-тили/backend/src/routes/weddingLifecycle.ts', '916094dd0176eeb5a1bd57fb80f73632e57379f85e04c3c9d3e5bc37ffffcf0e', '4c6ecc4903f08106bccef5f239b59fa91cb3e94446068a6ab7d385a7207cfdac', [
    (3, 3, "import { closeWeddingOfferRequests } from '../offers/close.js'\n"),
    (87, 87, '        tz: string | null\n'),
    (100, 101, '        `select w.cancel_requested_by, w.cancel_requested_at, w.cancelled_at, w.tz,\n'),
    (147, 147, "      await closeWeddingOfferRequests(client, weddingId, w.tz, 'wedding_cancelled')\n\n"),
])

apply('Тили-тили/backend/src/wedding/access.ts', '99bb9e9edecfbf31e0cc11026c230834fc7d23c8fdf3bb44a13c5c614a7a967c', '6d0a44b2f06f3ad9f9e8f57429f182c09f95150bef89378c917ad7a73a04559c', [
    (39, 39, '  { url: /^\\/weddings\\/:weddingId\\/offers\\/[^/]+\\/accept$/, by: { POST: ONLY_COUPLE } },\n'),
])

apply('Тили-тили/backend/src/wedding/reschedule.ts', '5a451b6fd7afb582820c2cdbb59a857f7406f4e4aa07bceaf1881331d4eba8e5', 'df9ce31d206058c153d4d98e8c343ddc443cbb819a3855d67aa3c56c3dbfedde', [
    (0, 0, "import { closeWeddingOfferRequests } from '../offers/close.js'\n"),
    (47, 47, "  await closeWeddingOfferRequests(client, weddingId, tz, 'date_changed')\n"),
])

apply('Тили-тили/backend/vitest.serial.json', '1d0aee10fc2ed517e4eab11326df4dbb31f67420682781f242774b45a00e5da4', '11a178be78fbc13dd6fe2ab132f75ab1e4d57f297507f80ebd5221d55b79a0ae', [
    (1, 1, '  "test/accept019.test.ts",\n'),
    (21, 21, '  "test/offers019.test.ts",\n'),
])

apply('Тили-тили/Тили-тили_API_openapi.yaml', '7506160a3cb4be24bbbb5c7f2508a0185329832c1af0b394a7cdf908e7f4ebc4', '49dfa5137bd83cacc93148ff7f14c67a212e973504e44f21dfd016de2cb95694', [
    (1036, 1036, "          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/Error' }\n  /weddings/{weddingId}/offers/{offerId}/accept:\n    post:\n      tags: [bookings]\n      summary: Принять предложение и забронировать исполнителя\n      description: |\n        Только пара. Без тела: цена, название и состав берутся из неизменяемого\n        предложения. Одна транзакция создаёт бронь, занимает дату, сохраняет\n        условия в сделке, отмечает принятие и закрывает запросы этого места.\n        Срок включителен по календарному дню свадьбы (tz, иначе Europe/Moscow).\n        Повтор успешной попытки с тем же ключом возвращает прежний Slot без\n        второй брони. Неопределённый сетевой исход повторяется с тем же ключом.\n      security: [{ bearerAuth: [] }]\n      parameters:\n        - { $ref: '#/components/parameters/WeddingId' }\n        - name: offerId\n          in: path\n          required: true\n          schema: { type: string, format: uuid }\n        - name: Idempotency-Key\n          in: header\n          required: true\n          schema: { type: string, minLength: 1, maxLength: 200 }\n      responses:\n        '200':\n          description: Забронированное место с принятыми условиями\n          headers:\n            Idempotent-Replay:\n              schema: { type: string, enum: ['true'] }\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/Slot' }\n        '400':\n          description: Требуется Idempotency-Key, ключ слишком длинный или передано тело\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/Error' }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n        '403': { $ref: '#/components/responses/Forbidden' }\n        '404': { $ref: '#/components/responses/NotFound' }\n        '409':\n          description: |\n            offer_expired, offer_stale_date, offer_superseded, offer_declined,\n            offer_accepted, request_closed, slot_taken, date_taken,\n            vendor_unavailable, wedding_cancelled, idempotency_key_reused,\n            idempotency_in_progress. При отказе изменений и уведомлений нет.\n"),
    (2680, 2681, "                          description: 'Неизменяемое название принятого пакета/предложения; null — без сохранённых условий'\n                        packageIncludes:\n                          type: array\n                          nullable: true\n                          items: { type: string }\n                          description: Неизменяемый состав услуг в момент брони\n"),
    (7179, 7180, '            `POST …/book` или принятие предложения). Не меняется при правке\n            или удалении пакета. null — нет снимка или роль не видит условия.\n        packageIncludes:\n          type: array\n          nullable: true\n          items: { type: string }\n          description: Неизменяемый состав услуг; только паре. null — снимок отсутствует.\n'),
])

