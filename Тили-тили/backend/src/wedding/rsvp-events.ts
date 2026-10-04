import type { EnrolledEmission } from '../notify/enrolled.js'
import type { Queryable } from '../plugins/db.js'
import { conflict, notFound, unauthorized, validationFailed } from '../errors.js'
import { guestByToken } from '../guests/access.js'
import { lockOrderWedding } from '../orders/context.js'
import { checkEntityId } from '../orders/model.js'
import { fromLocal, localDayBounds } from '../notify/quiet.js'
import { notifyWedding } from '../notify/notify.js'
import type { ParticipationSource, ParticipationStatus } from './participation.js'

/**
 * T012 — срок ответа на ДОПОЛНИТЕЛЬНОЕ мероприятие, личные ответы по
 * персонам (`event_guest_participation`, решение D1 — вторую таблицу
 * ответов не завели), поздняя просьба гостю к организатору
 * (`event_rsvp_requests`) и правка ответа парой («внесено организатором»,
 * `source='organizer_correction'`, D3).
 *
 * Основной RSVP (`POST /rsvp/{token}`, автобус/гостиница/стол/меню) этим
 * модулем не затрагивается — у него срока нет (D2).
 *
 * Каждая запись — одна транзакция: замок свадьбы первым (та же строка
 * `weddings`, что держат `lockOrderWedding`/`lockTimeline`/`lockGuestTeamAccess` —
 * общий мьютекс свадьбы), затем повторная проверка токена/семьи и ростера
 * ПОСЛЕ ожидания замка, срок — по строке мероприятия, прочитанной под этим
 * же замком, и только потом версия и запись.
 */

/* ───────────────────────── срок ответа ───────────────────────── */

export type RsvpWindowState = 'none' | 'open' | 'closed'
export interface RsvpWindow {
  state: RsvpWindowState
  date: string | null
  timeZone: string | null
  closesAt: string | null
}

/** Срок D в зоне Z закрывается в начале суток D+1 по Z (DST-безопасно). */
function closesAtForDeadline(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  // Местный полдень даты D — безопасный якорь: не съезжает на соседние
  // сутки ни при одном реальном смещении (включая получасовые/Kathmandu).
  const noon = fromLocal({ year, month, day, minutes: 720 }, timeZone)
  return localDayBounds(noon, timeZone).to
}

/**
 * Состояние срока в момент `at`. `at` — `clock_timestamp()`/`Date.now()`,
 * взятый ПОСЛЕ захвата замков (R-364): время до ожидания замка не считается.
 */
export function rsvpWindow(deadlineDate: string | null, eventTimeZone: string | null, at: Date): RsvpWindow {
  if (deadlineDate === null) return { state: 'none', date: null, timeZone: null, closesAt: null }
  // CHECK на wedding_events гарантирует time_zone not null всегда, когда задан
  // срок; запасной UTC здесь — только защита типов, в хранимых данных недостижим.
  const timeZone = eventTimeZone ?? 'UTC'
  const closesAt = closesAtForDeadline(deadlineDate, timeZone)
  return { state: at.getTime() < closesAt.getTime() ? 'open' : 'closed', date: deadlineDate, timeZone, closesAt: closesAt.toISOString() }
}

/**
 * Версия участия/просьбы T012 — отдельный код конфликта от `orders`
 * (контракт требует `version_conflict`, а общий `checkVersion` из
 * `orders/model.ts` всегда бросает `order_version_conflict`: тот код
 * общий для заказов и его нельзя переопределить ради одного модуля).
 */
function checkRsvpVersion(actual: string, expected: string, allowZero = false): void {
  if (typeof expected !== 'string' || !(allowZero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(expected)) {
    throw validationFailed({ expectedVersion: 'Нужна точная версия' })
  }
  if (actual !== expected) throw conflict('version_conflict', 'Данные изменились — обновите ответ')
}

/* ───────────────────────── проекции ───────────────────────── */

export interface RequestDto {
  id: string
  guestId: string
  requestedStatus: 'attending' | 'declined'
  state: 'pending' | 'accepted' | 'rejected'
  comment: string | null
  decisionNote: string | null
  createdAt: string
  decidedAt: string | null
  version: string
}
export interface PersonAnswer {
  guestId: string
  name: string
  status: ParticipationStatus
  source: ParticipationSource | null
  version: string
  request: RequestDto | null
}
export interface CouplePersonAnswer extends PersonAnswer {
  partyId: string
  partyLabel: string | null
}
export interface EventSummary {
  id: string
  name: string
  kind: string
  date: string | null
  timeZone: string | null
  location: string | null
  isMain: boolean
  rsvpDeadline: string | null
}
export interface GuestRsvpEvent {
  event: EventSummary
  deadline: RsvpWindow
  people: PersonAnswer[]
}
export interface CoupleRoster {
  deadline: RsvpWindow
  people: CouplePersonAnswer[]
  requests: RequestDto[]
}

interface RequestRow {
  id: string
  guest_id: string
  requested_status: 'attending' | 'declined'
  state: 'pending' | 'accepted' | 'rejected'
  comment: string | null
  decision_note: string | null
  created_at: Date
  decided_at: Date | null
  version: string
}
const REQUEST_COLUMNS = 'id,guest_id,requested_status,state,comment,decision_note,created_at,decided_at,version::text'
function projectRequest(r: RequestRow): RequestDto {
  return { id: r.id, guestId: r.guest_id, requestedStatus: r.requested_status, state: r.state, comment: r.comment,
    decisionNote: r.decision_note, createdAt: r.created_at.toISOString(), decidedAt: r.decided_at?.toISOString() ?? null, version: r.version }
}

interface ParticipationRow { status: ParticipationStatus; version: string; source: ParticipationSource | null; actor_user_id: string | null }
/** Последняя просьба персоны на это мероприятие — любого состояния (гость видит и решённую). */
async function latestRequestsByGuest(client: Queryable, weddingId: string, eventId: string, guestIds: string[]): Promise<Map<string, RequestDto>> {
  if (guestIds.length === 0) return new Map()
  const { rows } = await client.query<RequestRow>(
    `select distinct on (guest_id) ${REQUEST_COLUMNS} from event_rsvp_requests
      where wedding_id=$1 and program_event_id=$2 and guest_id=any($3::uuid[])
      order by guest_id, created_at desc`,
    [weddingId, eventId, guestIds],
  )
  return new Map(rows.map((r) => [r.guest_id, projectRequest(r)]))
}
async function participationByGuest(client: Queryable, weddingId: string, eventId: string, guestIds: string[]): Promise<Map<string, ParticipationRow>> {
  if (guestIds.length === 0) return new Map()
  const { rows } = await client.query<{ guest_id: string } & ParticipationRow>(
    'select guest_id,status,version::text,source,actor_user_id from event_guest_participation where wedding_id=$1 and program_event_id=$2 and guest_id=any($3::uuid[])',
    [weddingId, eventId, guestIds],
  )
  return new Map(rows.map((r) => [r.guest_id, r]))
}
function projectPerson(person: { id: string; name: string }, participation: ParticipationRow | undefined, request: RequestDto | null): PersonAnswer {
  return { guestId: person.id, name: person.name, status: participation?.status ?? 'unknown', source: participation?.source ?? null,
    version: participation?.version ?? '0', request }
}

/* ───────────────────────── гость: доступ по токену ───────────────────────── */

interface GuestScope { weddingId: string; partyId: string; token: string }
/**
 * Повторная проверка токена/семьи ПОСЛЕ ожидания замка свадьбы (ERR-0424, R-339).
 *
 * `write=false` — `for share` (чтение не мешает другому чтению); `true` —
 * `for update`, как и раньше. Раньше тут всегда было `for update` по
 * умолчанию, включая чтение (P3-6): `GET /rsvp/{token}/events` брал тот же
 * эксклюзивный замок, что и запись, и держал его до конца своей транзакции —
 * двум гостям одной свадьбы нельзя было открыть список мероприятий
 * одновременно. Легаси `GET` по гостю берёт `for share`; здесь — тот же приём.
 */
async function lockAndRecheckGuestParty(client: Queryable, scope: GuestScope, write = true): Promise<void> {
  await lockOrderWedding(client, scope.weddingId, write)
  const guest = await guestByToken(client, scope.token)
  if (guest.weddingId !== scope.weddingId.toLowerCase() || guest.partyId !== scope.partyId.toLowerCase()) {
    throw unauthorized('Ссылка недействительна')
  }
  // `for share`: держим строку приглашения до конца транзакции — конкурентная
  // ротация токена того же приглашения теперь ждёт нашего commit, а не
  // проскальзывает между этой проверкой и записью.
  const party = await client.query('select id from guest_parties where id=$1 and wedding_id=$2 and invite_token=$3 for share',
    [scope.partyId, scope.weddingId, scope.token])
  if (!party.rows[0]) throw unauthorized('Ссылка недействительна')
}

interface AdditionalEventRow { is_main: boolean; rsvp_deadline: string | null; time_zone: string | null }
/** Мероприятие существует, принадлежит свадьбе и не основное — иначе 404 (T012 сюда основную программу не допускает). */
async function lockAdditionalEvent(client: Queryable, weddingId: string, eventId: string, write: boolean): Promise<AdditionalEventRow> {
  checkEntityId(eventId, 'eventId')
  const { rows } = await client.query<AdditionalEventRow>(
    `select is_main,rsvp_deadline::text,time_zone from wedding_events where wedding_id=$1 and id=$2 for ${write ? 'update' : 'share'}`,
    [weddingId, eventId],
  )
  if (!rows[0] || rows[0].is_main) throw notFound('Мероприятие не найдено')
  return rows[0]
}

/** Персоны СВОЕЙ семьи, приглашённые именно на это мероприятие. */
async function invitedFamilyMembers(client: Queryable, weddingId: string, eventId: string, partyId: string, write: boolean): Promise<{ id: string; name: string }[]> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `select g.id,g.name from guests g join guest_event_invitations i on i.wedding_id=g.wedding_id and i.guest_id=g.id
      where i.wedding_id=$1 and i.event_id=$2 and g.party_id=$3 order by g.party_position,g.id for ${write ? 'update' : 'share'} of g`,
    [weddingId, eventId, partyId],
  )
  return rows
}

/** `GET /rsvp/{guestToken}/events` — только доп. мероприятия с приглашённой персоной семьи, только эти персоны. */
export async function guestRsvpEvents(client: Queryable, scope: GuestScope): Promise<GuestRsvpEvent[]> {
  await lockAndRecheckGuestParty(client, scope, false)
  const events = await client.query<{ id: string; name: string; kind: string; date: string | null; time_zone: string | null; location: string | null; rsvp_deadline: string | null }>(
    `select distinct e.id,e.name,e.kind,e.date::text,e.time_zone,e.location,e.rsvp_deadline::text
       from wedding_events e join guest_event_invitations i on i.wedding_id=e.wedding_id and i.event_id=e.id
       join guests g on g.wedding_id=i.wedding_id and g.id=i.guest_id
      where e.wedding_id=$1 and not e.is_main and g.party_id=$2
      order by e.date::text nulls last, e.id`,
    [scope.weddingId, scope.partyId],
  )
  const at = new Date()
  const result: GuestRsvpEvent[] = []
  for (const e of events.rows) {
    const people = await invitedFamilyMembers(client, scope.weddingId, e.id, scope.partyId, false)
    const ids = people.map((p) => p.id)
    // Последовательно — см. комментарий в answerGuestRsvp.
    const participation = await participationByGuest(client, scope.weddingId, e.id, ids)
    const requests = await latestRequestsByGuest(client, scope.weddingId, e.id, ids)
    result.push({
      event: { id: e.id, name: e.name, kind: e.kind, date: e.date, timeZone: e.time_zone, location: e.location, isMain: false, rsvpDeadline: e.rsvp_deadline },
      deadline: rsvpWindow(e.rsvp_deadline, e.time_zone, at),
      people: people.map((p) => projectPerson(p, participation.get(p.id), requests.get(p.id) ?? null)),
    })
  }
  return result
}

export interface AnswerItem { guestId: string; status: 'attending' | 'declined'; expectedVersion: string }
export interface AnswerInput extends GuestScope { eventId: string; answers: AnswerItem[] }
/** `PUT /rsvp/{guestToken}/events/{eventId}/answers` — атомарная пачка, no-op не меняет версию. */
export async function answerGuestRsvp(client: Queryable, input: AnswerInput): Promise<PersonAnswer[]> {
  checkEntityId(input.eventId, 'eventId')
  await lockAndRecheckGuestParty(client, input)
  // Чужой (другой свадьбы) guestId в теле отличать от «не из моей семьи» на
  // этом шаге не нужно (P2-3, было 401 — контракт обещает 404): он просто не
  // попадёт в invitedIds ниже и получит тот же notFound, что и настоящий,
  // но неприглашённый человек своей свадьбы.
  const event = await lockAdditionalEvent(client, input.weddingId, input.eventId, false)
  const invited = await invitedFamilyMembers(client, input.weddingId, input.eventId, input.partyId, true)
  const invitedIds = new Set(invited.map((p) => p.id))

  const seen = new Set<string>()
  for (const a of input.answers) {
    checkEntityId(a.guestId, 'guestId')
    const id = a.guestId.toLowerCase()
    if (seen.has(id)) throw validationFailed({ guestId: 'Один человек указан дважды' })
    seen.add(id)
    if (!invitedIds.has(id)) throw notFound('Персона не найдена')
  }
  // Срок — по строке мероприятия, прочитанной ПОД замком этой транзакции, уже
  // после ожидания замка свадьбы (R-364): никакого снимка «до».
  const window = rsvpWindow(event.rsvp_deadline, event.time_zone, new Date())
  if (window.state === 'closed') throw conflict('rsvp_deadline_passed', 'Срок ответа на мероприятие уже прошёл — попросите организатора изменить ответ')

  for (const a of input.answers) {
    const existing = await client.query<{ status: ParticipationStatus; version: string; source: ParticipationSource | null; actor_user_id: string | null }>(
      'select status,version::text,source,actor_user_id from event_guest_participation where wedding_id=$1 and program_event_id=$2 and guest_id=$3 for update',
      [input.weddingId, input.eventId, a.guestId],
    )
    const row = existing.rows[0]
    checkRsvpVersion(row?.version ?? '0', a.expectedVersion, true)
    if (row && row.status === a.status && row.source === 'guest_response') continue // no-op: версию не меняем
    await client.query(
      `insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source,actor_user_id)
       values($1,$2,$3,$4,'guest_response',null)
       on conflict(program_event_id,guest_id) do update set status=excluded.status,source=excluded.source,
         actor_user_id=null,version=event_guest_participation.version+1,recorded_at=now()`,
      [input.weddingId, input.eventId, a.guestId, a.status],
    )
    await client.query(
      "insert into audit_log(actor_id,action,entity,entity_id,diff) values(null,'wedding.participation_changed','guest',$1,$2::jsonb)",
      [a.guestId, JSON.stringify({ weddingId: input.weddingId, programEventId: input.eventId, status: a.status, source: 'guest_response', beforeVersion: row?.version ?? '0' })],
    )
  }
  // Последовательно, не Promise.all: один pg-клиент не держит два запроса
  // параллельно (ERR — предупреждение драйвера «query already executing»
  // внутри транзакции оборачивалось в 500).
  const participation = await participationByGuest(client, input.weddingId, input.eventId, invited.map((p) => p.id))
  const requests = await latestRequestsByGuest(client, input.weddingId, input.eventId, invited.map((p) => p.id))
  return invited.map((p) => projectPerson(p, participation.get(p.id), requests.get(p.id) ?? null))
}

export interface LateRequestInput extends GuestScope { eventId: string; guestId: string; requestedStatus: 'attending' | 'declined'; comment: string | null; idempotencyKey: string }
/** `POST /rsvp/{guestToken}/events/{eventId}/requests` — только после срока; Idempotency-Key — тот же 201 на повтор. */
export async function createLateRequest(client: Queryable, input: LateRequestInput, emissions?: EnrolledEmission): Promise<RequestDto> {
  checkEntityId(input.eventId, 'eventId'); checkEntityId(input.guestId, 'guestId')
  await lockAndRecheckGuestParty(client, input)
  // P2-3: чужой guestId не отличаем здесь — ниже notFound ловит его тем же
  // 404, что и неприглашённого человека своей свадьбы (invited-запрос по
  // party_id=input.partyId молча его не находит).
  const event = await lockAdditionalEvent(client, input.weddingId, input.eventId, false)
  const invited = await client.query<{ id: string }>(
    `select g.id from guests g join guest_event_invitations i on i.wedding_id=g.wedding_id and i.guest_id=g.id
      where i.wedding_id=$1 and i.event_id=$2 and g.id=$3 and g.party_id=$4 for update of g`,
    [input.weddingId, input.eventId, input.guestId, input.partyId],
  )
  if (!invited.rows[0]) throw notFound('Персона не найдена')

  // Повтор того же Idempotency-Key — тот же 201, без повторной проверки срока
  // или занятости: наш собственный предыдущий успех не должен стать отказом.
  const sameKey = await client.query<RequestRow & { program_event_id: string }>(
    `select ${REQUEST_COLUMNS},program_event_id from event_rsvp_requests where guest_id=$1 and idempotency_key=$2`,
    [input.guestId, input.idempotencyKey],
  )
  const replay = sameKey.rows[0]
  if (replay) {
    if (replay.program_event_id !== input.eventId.toLowerCase() || replay.requested_status !== input.requestedStatus || (replay.comment ?? null) !== input.comment) {
      throw conflict('idempotency_key_reused', 'Этот Idempotency-Key уже использован для другой просьбы')
    }
    return projectRequest(replay)
  }

  const window = rsvpWindow(event.rsvp_deadline, event.time_zone, new Date())
  if (window.state !== 'closed') throw conflict('rsvp_deadline_open', 'Срок ответа не прошёл — ответьте напрямую')
  const pending = await client.query('select 1 from event_rsvp_requests where program_event_id=$1 and guest_id=$2 and state=\'pending\' for update',
    [input.eventId, input.guestId])
  if (pending.rowCount) throw conflict('rsvp_request_pending', 'У вас уже есть необработанная просьба по этому мероприятию')

  const inserted = await client.query<RequestRow>(
    `insert into event_rsvp_requests(wedding_id,program_event_id,guest_id,party_id,requested_status,comment,idempotency_key)
     values($1,$2,$3,$4,$5,$6,$7) returning ${REQUEST_COLUMNS}`,
    [input.weddingId, input.eventId, input.guestId, input.partyId, input.requestedStatus, input.comment, input.idempotencyKey],
  )
  const row = inserted.rows[0]!
  await client.query(
    "insert into audit_log(actor_id,action,entity,entity_id,diff) values(null,'wedding.rsvp_request_created','event_rsvp_request',$1,$2::jsonb)",
    [row.id, JSON.stringify({ weddingId: input.weddingId, programEventId: input.eventId, guestId: input.guestId, requestedStatus: input.requestedStatus })],
  )
  const name = (await client.query<{ name: string }>('select name from guests where id=$1', [input.guestId])).rows[0]!.name
  await (emissions ? emissions.emitWedding : notifyWedding)(client, input.weddingId, null,
    { kind: 'guest', title: 'Просьба изменить ответ', body: `${name} просит организатора изменить ответ на дополнительное мероприятие` },
    new Date(), false, ['couple'])
  return projectRequest(row)
}

/* ───────────────────────── пара: роль couple, запись; команда — чтение ───────────────────────── */

/** `GET /weddings/{weddingId}/events/{eventId}/rsvp` — вызывается ПОСЛЕ `lockGuestReadAccess`. */
export async function loadCoupleRoster(client: Queryable, weddingId: string, eventId: string): Promise<CoupleRoster> {
  checkEntityId(weddingId, 'weddingId')
  const event = await lockAdditionalEvent(client, weddingId, eventId, false)
  const people = await client.query<{ id: string; name: string; party_id: string; party_label: string | null }>(
    `select g.id,g.name,g.party_id,p.label as party_label from guests g
       join guest_event_invitations i on i.wedding_id=g.wedding_id and i.guest_id=g.id
       join guest_parties p on p.id=g.party_id
      where i.wedding_id=$1 and i.event_id=$2 order by g.party_position,g.id`,
    [weddingId, eventId],
  )
  const ids = people.rows.map((p) => p.id)
  // Последовательно — один pg-клиент не обслуживает параллельные запросы
  // (см. комментарий в answerGuestRsvp).
  const participation = await participationByGuest(client, weddingId, eventId, ids)
  const requestsByGuest = await latestRequestsByGuest(client, weddingId, eventId, ids)
  const pending = await client.query<RequestRow>(`select ${REQUEST_COLUMNS} from event_rsvp_requests where wedding_id=$1 and program_event_id=$2 and state='pending' order by created_at`, [weddingId, eventId])
  // «Несколько последних решений», не вся история: предел — тот же порядок
  // величины, что у maxItems других T012-списков контракта.
  const decided = await client.query<RequestRow>(`select ${REQUEST_COLUMNS} from event_rsvp_requests where wedding_id=$1 and program_event_id=$2 and state<>'pending' order by decided_at desc limit 20`, [weddingId, eventId])
  return {
    deadline: rsvpWindow(event.rsvp_deadline, event.time_zone, new Date()),
    people: people.rows.map((p) => ({ ...projectPerson(p, participation.get(p.id), requestsByGuest.get(p.id) ?? null), partyId: p.party_id, partyLabel: p.party_label })),
    requests: [...pending.rows, ...decided.rows].map(projectRequest),
  }
}

/**
 * БЕЗ join по `guest_event_invitations` (P1-2): отвечающего могли вывести из
 * ростера мероприятия МЕЖДУ просьбой/правкой и этим вызовом —
 * `decideRequest` строит ответ уже ПОСЛЕ решения (приглашение проверяет
 * только для записи organizer_correction, не для самого решения — reject
 * всегда возможен, accept пишет ответ только если человек всё ещё
 * приглашён, см. комментарий там), `applyOrganizerCorrection` же сама
 * проверяет приглашение ДО вызова. Раньше join по инвайту делал
 * singleCouplePerson 404 для decideRequest ровно тогда, когда приглашение
 * сняли, — решение целиком откатывалось (вся функция в одной транзакции),
 * и просьба навсегда оставалась pending, блокируя новую после повторного
 * приглашения. Профиль персоны строим по тому, что она гость ЭТОЙ свадьбы,
 * а не по текущему ростеру конкретного мероприятия.
 */
async function singleCouplePerson(client: Queryable, weddingId: string, eventId: string, guestId: string): Promise<CouplePersonAnswer> {
  const person = await client.query<{ id: string; name: string; party_id: string; party_label: string | null }>(
    `select g.id,g.name,g.party_id,p.label as party_label from guests g join guest_parties p on p.id=g.party_id
      where g.id=$2 and g.wedding_id=$1`,
    [weddingId, guestId],
  )
  const row = person.rows[0]
  if (!row) throw notFound('Персона не найдена')
  // Последовательно — см. комментарий в answerGuestRsvp.
  const participation = await participationByGuest(client, weddingId, eventId, [guestId])
  const requests = await latestRequestsByGuest(client, weddingId, eventId, [guestId])
  return { ...projectPerson(row, participation.get(guestId), requests.get(guestId) ?? null), partyId: row.party_id, partyLabel: row.party_label }
}

/**
 * Пишет `source='organizer_correction'`. Без проверки версии (`expectedVersion`
 * не передан) используется из `decideRequest`, где версия участия не при чём —
 * версионируется сама просьба; с проверкой — из прямой правки парой.
 */
async function upsertOrganizerCorrection(client: Queryable, weddingId: string, eventId: string, guestId: string, status: ParticipationStatus,
  actorUserId: string, expectedVersion?: string): Promise<void> {
  const existing = await client.query<{ status: ParticipationStatus; source: ParticipationSource | null; actor_user_id: string | null; version: string }>(
    'select status,source,actor_user_id,version::text from event_guest_participation where wedding_id=$1 and program_event_id=$2 and guest_id=$3 for update',
    [weddingId, eventId, guestId],
  )
  const row = existing.rows[0]
  if (expectedVersion !== undefined) checkRsvpVersion(row?.version ?? '0', expectedVersion, true)
  if (row && row.status === status && row.source === 'organizer_correction' && row.actor_user_id === actorUserId) return // no-op: версию не меняем
  await client.query(
    `insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source,actor_user_id)
     values($1,$2,$3,$4,'organizer_correction',$5)
     on conflict(program_event_id,guest_id) do update set status=excluded.status,source=excluded.source,
       actor_user_id=excluded.actor_user_id,version=event_guest_participation.version+1,recorded_at=now()`,
    [weddingId, eventId, guestId, status, actorUserId],
  )
  await client.query(
    "insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'wedding.participation_changed','guest',$2,$3::jsonb)",
    [actorUserId, guestId, JSON.stringify({ weddingId, programEventId: eventId, status, source: 'organizer_correction', beforeVersion: row?.version ?? '0' })],
  )
}

export interface CorrectionInput { weddingId: string; eventId: string; guestId: string; status: ParticipationStatus; expectedVersion: string; actorUserId: string }
/** `PUT /weddings/{weddingId}/events/{eventId}/rsvp/{guestId}` — только couple; разрешено в любое время. */
export async function applyOrganizerCorrection(client: Queryable, input: CorrectionInput): Promise<CouplePersonAnswer> {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.guestId, 'guestId')
  await lockAdditionalEvent(client, input.weddingId, input.eventId, true)
  const invited = await client.query('select 1 from guest_event_invitations where wedding_id=$1 and event_id=$2 and guest_id=$3', [input.weddingId, input.eventId, input.guestId])
  if (!invited.rowCount) throw notFound('Персона не найдена')
  await upsertOrganizerCorrection(client, input.weddingId, input.eventId, input.guestId, input.status, input.actorUserId, input.expectedVersion)
  return singleCouplePerson(client, input.weddingId, input.eventId, input.guestId)
}

export interface DecisionInput { weddingId: string; eventId: string; requestId: string; decision: 'accept' | 'reject'; note: string | null; expectedVersion: string; actorUserId: string }
export interface DecisionResult { request: RequestDto; person: CouplePersonAnswer }
/** `POST /weddings/{weddingId}/events/{eventId}/rsvp-requests/{requestId}/decision` — только couple. */
export async function decideRequest(client: Queryable, input: DecisionInput): Promise<DecisionResult> {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.requestId, 'requestId')
  await lockAdditionalEvent(client, input.weddingId, input.eventId, true)
  const existing = await client.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from event_rsvp_requests where wedding_id=$1 and program_event_id=$2 and id=$3 for update`,
    [input.weddingId, input.eventId, input.requestId],
  )
  const row = existing.rows[0]
  if (!row) throw notFound('Просьба не найдена')
  checkRsvpVersion(row.version, input.expectedVersion)
  if (row.state !== 'pending') throw conflict('rsvp_request_decided', 'Просьба уже принята или отклонена')

  const newState = input.decision === 'accept' ? 'accepted' : 'rejected'
  const updated = await client.query<RequestRow>(
    `update event_rsvp_requests set state=$4,decision_note=$5,decided_by=$6,decided_at=clock_timestamp(),version=version+1
      where id=$1 and wedding_id=$2 and program_event_id=$3 returning ${REQUEST_COLUMNS}`,
    [input.requestId, input.weddingId, input.eventId, newState, input.note, input.actorUserId],
  )
  const decided = updated.rows[0]!
  await client.query(
    "insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'wedding.rsvp_request_decided','event_rsvp_request',$2,$3::jsonb)",
    [input.actorUserId, input.requestId, JSON.stringify({ weddingId: input.weddingId, programEventId: input.eventId, decision: input.decision, beforeVersion: input.expectedVersion })],
  )
  if (input.decision === 'accept') {
    // Принятие — в ТОЙ ЖЕ транзакции меняет ответ персоны на requestedStatus,
    // источник organizer_correction (контракт). Приглашение могли снять между
    // просьбой и решением — тогда просьба всё равно решается, но ответ не
    // переписывается за того, кого уже вывели из ростера.
    const stillInvited = await client.query('select 1 from guest_event_invitations where wedding_id=$1 and event_id=$2 and guest_id=$3',
      [input.weddingId, input.eventId, row.guest_id])
    if (stillInvited.rowCount) await upsertOrganizerCorrection(client, input.weddingId, input.eventId, row.guest_id, row.requested_status, input.actorUserId)
  }
  const person = await singleCouplePerson(client, input.weddingId, input.eventId, row.guest_id)
  return { request: projectRequest(decided), person }
}
