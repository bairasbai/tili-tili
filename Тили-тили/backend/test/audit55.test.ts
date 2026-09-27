import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * F5 · контракт v0.41.0 — единственный сторож всех 14 расхождений ревью 016
 * (F5-01…F5-14). Красный до правки контракта, зелёный после (ROADMAP.md, F5).
 *
 * Блок без базы — механические сторожа (G-a…G-g): разбирают
 * `Тили-тили_API_openapi.yaml` (`js-yaml`, как `gen-contract.mjs`) и текст
 * `src/**\/*.ts` (кроме `*.generated.ts`) напрямую, без поднятия сервера —
 * контракт и код сверяются как тексты, а не через HTTP.
 *
 * G-h и G-i — после общего ревью (F5-R7-02…05, F5-R7-08): откат F5-06/07/08
 * и неполные списки 409 и тексты отказов больше не остаются зелёными.
 *
 * Блок `describe.skipIf(!live)` — поведение живьём (L-1, L-2): PQ-2 (стол до
 * 100) и PQ-3 (гостевой токен: 410/401), под `TEST_DATABASE_URL`.
 *
 * `F5_AUDIT55_CONTRACT` — только для ремонта: даёт прогнать те же сторожа на
 * черновике контракта до применения (`cp` в реальный путь, ROADMAP F5 шаг 4).
 * По умолчанию — настоящий путь контракта, как у `gen-contract.mjs`.
 */

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (s: string) => unknown }

const here = path.dirname(fileURLToPath(import.meta.url))
const CONTRACT_FILE =
  process.env.F5_AUDIT55_CONTRACT ?? path.resolve(here, '..', '..', 'Тили-тили_API_openapi.yaml')
const SRC_DIR = path.resolve(here, '..', 'src')

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

// ───────────────────────── контракт: разбор ─────────────────────────

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
type Method = (typeof METHODS)[number]

interface YamlSchema {
  type?: string | string[]
  format?: string
  description?: string
  required?: string[]
  additionalProperties?: boolean | YamlSchema
  properties?: Record<string, YamlSchema>
  oneOf?: YamlSchema[]
  allOf?: YamlSchema[]
  items?: YamlSchema
  $ref?: string
  enum?: unknown[]
  nullable?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}

interface YamlParam {
  name?: string
  in?: string
  required?: boolean
  $ref?: string
  schema?: YamlSchema
}
interface YamlOperation {
  description?: string
  parameters?: YamlParam[]
  requestBody?: { content?: Record<string, { schema?: YamlSchema }> }
  responses?: Record<
    string,
    {
      description?: string
      $ref?: string
      headers?: Record<string, { description?: string; schema?: YamlSchema }>
      content?: Record<string, { schema?: YamlSchema }>
    }
  >
}
interface Op {
  method: Method
  openapiPath: string
  fastifyPath: string
  item: YamlOperation
}

function loadDoc(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(CONTRACT_FILE, 'utf8')) as Record<string, unknown>
}

function listOperations(doc: Record<string, unknown>): Op[] {
  const out: Op[] = []
  const paths = (doc.paths ?? {}) as Record<string, Record<string, YamlOperation | YamlParam[]>>
  for (const [p, pathItem] of Object.entries(paths)) {
    const pathLevelParams = (pathItem.parameters as YamlParam[] | undefined) ?? []
    for (const m of METHODS) {
      const op = pathItem[m] as YamlOperation | undefined
      if (!op) continue
      out.push({
        method: m,
        openapiPath: p,
        fastifyPath: p.replace(/\{([^}]+)\}/g, ':$1'),
        item: { ...op, parameters: [...pathLevelParams, ...(op.parameters ?? [])] },
      })
    }
  }
  return out
}

/** Ссылки `$ref` в `parameters`/`responses` — разрешаются напрямую по документу (JSON pointer урезанный до нужд теста). */
function resolveRef<T>(doc: Record<string, unknown>, ref: string): T {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], doc) as T
}

function resolveParam(doc: Record<string, unknown>, p: YamlParam): YamlParam {
  return p.$ref ? resolveRef<YamlParam>(doc, p.$ref) : p
}

function findParam(doc: Record<string, unknown>, op: Op, name: string, where?: string): YamlParam | undefined {
  return (op.item.parameters ?? [])
    .map((p) => resolveParam(doc, p))
    .find((p) => p.name === name && (!where || p.in === where))
}

function hasStatus(op: Op, status: string): boolean {
  return Boolean(op.item.responses && Object.prototype.hasOwnProperty.call(op.item.responses, status))
}

/** Текст, где ищутся имена кодов у операции: её `description` + `description` каждого ответа. */
function opText(doc: Record<string, unknown>, op: Op): string {
  const parts: string[] = [op.item.description ?? '']
  for (const r of Object.values(op.item.responses ?? {})) {
    if (r?.$ref) {
      const resolved = resolveRef<{ description?: string }>(doc, r.$ref)
      parts.push(resolved.description ?? '')
    } else if (r?.description) {
      parts.push(r.description)
    }
  }
  return parts.join('\n')
}

function namesCode(text: string, code: string): boolean {
  return new RegExp(`\\b${code}\\b`).test(text)
}

const opKey = (method: string, openapiPath: string) => `${method.toUpperCase()} ${openapiPath}`
function findOp(ops: Op[], method: string, openapiPath: string): Op | undefined {
  return ops.find((o) => o.method === method.toLowerCase() && o.openapiPath === openapiPath)
}

function exactObject(schema: YamlSchema, required: string[], properties = required): void {
  expect(schema.type).toBe('object')
  expect(schema.additionalProperties).toBe(false)
  expect([...(schema.required ?? [])].sort()).toEqual([...required].sort())
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...properties].sort())
}

// ───────────────────────── исходники: сканирование ─────────────────────────

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts')) out.push(full)
  }
  return out
}

const SOURCE_FILES = listSourceFiles(SRC_DIR)
const SOURCES = SOURCE_FILES.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
const ALL_SOURCE = SOURCES.map((s) => s.text).join('\n')

/** Индекс парной закрывающей скобки от `openIdx` (символ `(`) — вне строк/шаблонов/комментариев. */
function matchParen(text: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    } else if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(text, i, c)
    } else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? text.length : close + 1
    }
  }
  return -1
}

function skipQuoted(text: string, start: number, quote: string): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === quote) return i
    i++
  }
  return i
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Текст регистрации обработчика (`app.<метод>('<путь>', …)`) — от вызова до его собственной парной скобки. */
function findHandlerSlice(fastifyPath: string, method: Method): string | null {
  const anchor = new RegExp(`app\\.${method}\\(\\s*['"]${escapeRe(fastifyPath)}['"]`)
  for (const { text } of SOURCES) {
    const m = anchor.exec(text)
    if (!m) continue
    const openIdx = text.indexOf('(', m.index)
    const closeIdx = matchParen(text, openIdx)
    if (closeIdx === -1) continue
    return text.slice(openIdx, closeIdx + 1)
  }
  return null
}

/** `required`, с которым вызван `withIdempotency(…)` — берётся из последнего аргумента ЕГО СОБСТВЕННОЙ пары скобок. */
function withIdempotencyRequired(slice: string): boolean {
  const m = /withIdempotency\(/.exec(slice)
  if (!m) return true
  const openIdx = m.index + 'withIdempotency'.length
  const closeIdx = matchParen(slice, openIdx)
  if (closeIdx === -1) return true
  const args = slice.slice(openIdx + 1, closeIdx)
  return !/,\s*false\s*,?\s*$/.test(args.trimEnd())
}

/** Механически из кода: обработчик читает `Idempotency-Key`? Если да — с каким `required`. */
function idempotencyUsage(slice: string): { reads: boolean; required: boolean } {
  if (/\bguestKey\(/.test(slice)) return { reads: true, required: true }
  if (/\bwithIdempotency\(/.test(slice)) return { reads: true, required: withIdempotencyRequired(slice) }
  if (/\breadKeyHeader\(\s*request\s*,/.test(slice)) return { reads: true, required: true }
  return { reads: false, required: false }
}

// ───────────────────────── F5-13: код → операции, называющие его в тексте ─────────────────────────

const OPERATION_CODES: [code: string, ops: [string, string][]][] = [
  ['active_deals', [['DELETE', '/users/me']]],
  ['album_limit', [['POST', '/weddings/{weddingId}/album']]],
  [
    'already_cancelled',
    [
      ['POST', '/weddings/{weddingId}/slots/{slotId}/cancel'],
      ['DELETE', '/weddings/{weddingId}/slots/{slotId}/external'],
      ['PATCH', '/deals/{dealId}'], // F5-14: делёта F1 — единая дверь cancelDeal()
    ],
  ],
  ['already_member', [['POST', '/invites/{code}/accept']]],
  [
    'bad_limit',
    [
      ['GET', '/admin/moderation/vendors'],
      ['GET', '/admin/verifications'],
      ['GET', '/admin/complaints'],
      ['GET', '/admin/concierge'],
      ['GET', '/catalog/vendors'],
      ['GET', '/chats/{chatId}/messages'],
      ['GET', '/join/{guestToken}/day-chat/messages'],
      ['GET', '/catalog/vendors/{vendorId}/reviews'],
      ['GET', '/guest-vendor/{token}/messages'],
    ],
  ],
  ['bad_phone', [['POST', '/auth/otp'], ['POST', '/auth/otp/verify']]],
  [
    'chat_not_open_yet',
    [
      ['GET', '/chats/{chatId}/messages'],
      ['POST', '/chats/{chatId}/messages'],
      ['POST', '/chats/{chatId}/typing'],
      ['GET', '/chats/{chatId}/ws'],
    ],
  ],
  ['city_ambiguous', [['PUT', '/vendor/profile']]],
  ['concierge_pending', [['POST', '/catalog/concierge']]],
  ['contribution_limit', [['POST', '/gifts/{guestToken}/{giftId}/fund'], ['POST', '/gifts/{guestToken}/funds/{fundId}']]],
  [
    'date_taken',
    [
      ['PATCH', '/deals/{dealId}'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/book'],
      ['POST', '/weddings/{weddingId}/reschedule'],
      ['PATCH', '/weddings/{weddingId}'],
    ],
  ],
  ['deadline_passed', [['POST', '/join/{guestToken}/hotels']]],
  ['empty_shift', [['POST', '/weddings/{weddingId}/timeline/shift']]],
  ['fields_missing', [['POST', '/deals/{dealId}/contract']]],
  ['fund_has_contributions', [['DELETE', '/weddings/{weddingId}/funds/{fundId}']]],
  ['gift_closed', [['POST', '/gifts/{guestToken}/{giftId}/fund']]],
  [
    'gift_has_contributions',
    [['DELETE', '/weddings/{weddingId}/wishlist/{giftId}'], ['POST', '/gifts/{guestToken}/{giftId}/reserve']],
  ],
  ['gift_not_group', [['POST', '/gifts/{guestToken}/{giftId}/fund']]],
  ['gift_overfunded', [['POST', '/gifts/{guestToken}/{giftId}/fund']]],
  ['gift_price_below_funded', [['PATCH', '/weddings/{weddingId}/wishlist/{giftId}']]],
  ['gift_reserved', [['POST', '/gifts/{guestToken}/{giftId}/reserve'], ['POST', '/gifts/{guestToken}/{giftId}/fund']]],
  [
    'gone',
    [
      ['GET', '/join/{guestToken}/day'],
      ['GET', '/join/{guestToken}/day-chat/messages'],
      ['POST', '/join/{guestToken}/day-chat/messages'],
      ['GET', '/invite/{shareCode}'],
      ['GET', '/invites/{code}'],
      ['POST', '/invites/{code}/accept'],
      ['GET', '/guest-vendor/{token}'],
      ['GET', '/guest-vendor/{token}/messages'],
      ['POST', '/guest-vendor/{token}/messages'],
    ],
  ],
  ['hotel_full', [['POST', '/join/{guestToken}/hotels']]],
  [
    'idempotency_in_progress',
    [
      ['POST', '/weddings/{weddingId}/logistics/notify-pickup'],
      ['POST', '/weddings/{weddingId}/menu-poll/remind'],
      ['POST', '/weddings/{weddingId}/timeline/shift'],
      ['POST', '/weddings/{weddingId}/planb/activate'],
      ['PATCH', '/deals/{dealId}'],
      ['POST', '/deals/{dealId}/contract'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/book'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/cancel'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/pay'],
      ['POST', '/weddings/{weddingId}/reschedule'],
    ],
  ],
  [
    'idempotency_key_required',
    [
      ['POST', '/weddings/{weddingId}/logistics/notify-pickup'],
      ['POST', '/weddings/{weddingId}/menu-poll/remind'],
      ['POST', '/weddings/{weddingId}/timeline/shift'],
      ['POST', '/weddings/{weddingId}/planb/activate'],
      ['PATCH', '/deals/{dealId}'],
      ['POST', '/gifts/{guestToken}/{giftId}/reserve'],
      ['POST', '/gifts/{guestToken}/{giftId}/fund'],
      ['POST', '/gifts/{guestToken}/funds/{fundId}'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/book'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/cancel'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/pay'],
      ['POST', '/weddings/{weddingId}/reschedule'],
    ],
  ],
  [
    'idempotency_key_reused',
    [
      ['POST', '/weddings/{weddingId}/logistics/notify-pickup'],
      ['POST', '/weddings/{weddingId}/menu-poll/remind'],
      ['POST', '/weddings/{weddingId}/timeline/shift'],
      ['POST', '/weddings/{weddingId}/planb/activate'],
      ['PATCH', '/deals/{dealId}'],
      ['POST', '/deals/{dealId}/contract'],
      ['POST', '/gifts/{guestToken}/{giftId}/fund'],
      ['POST', '/gifts/{guestToken}/funds/{fundId}'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/book'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/cancel'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/pay'],
      ['POST', '/weddings/{weddingId}/reschedule'],
    ],
  ],
  [
    'idempotency_key_too_long',
    [
      ['POST', '/weddings/{weddingId}/logistics/notify-pickup'],
      ['POST', '/weddings/{weddingId}/menu-poll/remind'],
      ['POST', '/weddings/{weddingId}/timeline/shift'],
      ['POST', '/weddings/{weddingId}/planb/activate'],
      ['PATCH', '/deals/{dealId}'],
      ['POST', '/deals/{dealId}/contract'],
      ['POST', '/gifts/{guestToken}/{giftId}/reserve'],
      ['POST', '/gifts/{guestToken}/{giftId}/fund'],
      ['POST', '/gifts/{guestToken}/funds/{fundId}'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/book'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/cancel'],
      ['POST', '/weddings/{weddingId}/slots/{slotId}/pay'],
      ['POST', '/weddings/{weddingId}/reschedule'],
    ],
  ],
  ['last_couple', [['PATCH', '/weddings/{weddingId}/members/{userId}'], ['DELETE', '/weddings/{weddingId}/members/{userId}']]],
  ['lead_won', [['POST', '/vendor/leads/{leadId}']]],
  ['likes_limit', [['PUT', '/inspiration/likes/{storyId}']]],
  ['not_booked', [['POST', '/deals/{dealId}/contract'], ['POST', '/weddings/{weddingId}/slots/{slotId}/pay']]],
  ['own_code', [['POST', '/referral/{code}/apply']]],
  ['policy_version_stale', [['POST', '/users/me/consent']]],
  ['referral_used', [['POST', '/referral/{code}/apply']]],
  ['refresh_superseded', [['POST', '/auth/refresh']]],
  ['reservation_limit', [['POST', '/gifts/{guestToken}/{giftId}/reserve']]],
  ['request_open', [['DELETE', '/weddings/{weddingId}/slots/{slotId}/shortlist/{entryId}']]],
  ['shortlist_full', [['PUT', '/weddings/{weddingId}/shortlist/{vendorId}']]],
  ['slot_missing', [['PUT', '/weddings/{weddingId}/shortlist/{vendorId}']]],
  ['slot_empty', [['POST', '/weddings/{weddingId}/slots/{slotId}/cancel'], ['POST', '/weddings/{weddingId}/slots/{slotId}/pay']]],
  ['slot_taken', [['POST', '/weddings/{weddingId}/slots/{slotId}/book'], ['POST', '/weddings/{weddingId}/slots/{slotId}/external']]],
  ['system_task', [['DELETE', '/weddings/{weddingId}/tasks/{taskId}']]],
  ['text_not_allowed', [['POST', '/vendor/leads/{leadId}']]],
  ['text_required', [['POST', '/vendor/leads/{leadId}']]],
  ['too_many_requests', [['POST', '/auth/otp'], ['POST', '/auth/otp/verify']]],
  ['too_often', [['POST', '/weddings/{weddingId}/guests/remind']]],
  ['unknown_package', [['POST', '/weddings/{weddingId}/slots/{slotId}/book'], ['PUT', '/vendor/profile']]],
  ['unknown_timezone', [['PATCH', '/users/me'], ['PATCH', '/weddings/{weddingId}']]],
  ['upgrade_required', [['GET', '/chats/{chatId}/ws']]],
  ['vendor_unavailable', [['PUT', '/weddings/{weddingId}/shortlist/{vendorId}']]],
  ['video_duration_required', [['PUT', '/vendor/profile']]],
  ['video_too_long', [['PUT', '/vendor/profile']]],
  [
    'wedding_date_unknown',
    [
      ['GET', '/chats/{chatId}/messages'],
      ['POST', '/chats/{chatId}/messages'],
      ['POST', '/chats/{chatId}/typing'],
      ['GET', '/chats/{chatId}/ws'],
    ],
  ],
  [
    'wedding_cancelled',
    [
      ['PUT', '/weddings/{weddingId}/shortlist/{vendorId}'],
      ['DELETE', '/weddings/{weddingId}/slots/{slotId}/shortlist/{entryId}'],
    ],
  ],
]

// ───────────────────────── F5-03/F5-04/F5-13: 43 HTTP-пары «операция × статус», сейчас не объявленные ─────────────────────────

const STATUS_PAIRS: [method: string, openapiPath: string, status: string][] = [
  // F5-03 — восемь списков без 400 вовсе (пагинация: bad_limit/bad_cursor)
  ['GET', '/chats/{chatId}/messages', '400'],
  ['GET', '/catalog/vendors/{vendorId}/reviews', '400'],
  ['GET', '/guest-vendor/{token}/messages', '400'],
  ['GET', '/join/{guestToken}/day-chat/messages', '400'],
  ['GET', '/admin/moderation/vendors', '400'],
  ['GET', '/admin/verifications', '400'],
  ['GET', '/admin/complaints', '400'],
  ['GET', '/admin/concierge', '400'],
  // F5-04 — тринадцать операций идемпотентности: 400 всем, 409 четырём без него
  ['POST', '/weddings/{weddingId}/slots/{slotId}/book', '400'],
  ['POST', '/weddings/{weddingId}/slots/{slotId}/cancel', '400'],
  ['POST', '/weddings/{weddingId}/slots/{slotId}/pay', '400'],
  ['POST', '/gifts/{guestToken}/{giftId}/reserve', '400'],
  ['POST', '/gifts/{guestToken}/{giftId}/fund', '400'],
  ['POST', '/gifts/{guestToken}/funds/{fundId}', '400'],
  ['POST', '/weddings/{weddingId}/logistics/notify-pickup', '400'],
  ['POST', '/weddings/{weddingId}/menu-poll/remind', '400'],
  ['PATCH', '/deals/{dealId}', '400'],
  ['POST', '/deals/{dealId}/contract', '400'],
  ['POST', '/weddings/{weddingId}/timeline/shift', '400'],
  ['POST', '/weddings/{weddingId}/planb/activate', '400'],
  ['POST', '/weddings/{weddingId}/reschedule', '400'],
  ['POST', '/weddings/{weddingId}/logistics/notify-pickup', '409'],
  ['POST', '/weddings/{weddingId}/menu-poll/remind', '409'],
  ['POST', '/weddings/{weddingId}/timeline/shift', '409'],
  ['POST', '/weddings/{weddingId}/planb/activate', '409'],
  // F5-13 — остальные двадцать минус два WS-текстовых (43 = 8 + 13 + 4 + 18)
  ['POST', '/chats/{chatId}/typing', '423'],
  ['PUT', '/vendor/profile', '422'],
  ['POST', '/deals/{dealId}/contract', '422'],
  ['GET', '/catalog/vendors', '422'],
  ['GET', '/chats/{chatId}/messages', '403'],
  ['PATCH', '/users/me', '422'],
  ['PATCH', '/weddings/{weddingId}', '422'],
  ['POST', '/chats/{chatId}/messages', '403'],
  ['POST', '/chats/{chatId}/typing', '403'],
  ['POST', '/rsvp/{guestToken}', '409'],
  ['POST', '/vendor/calendar/busy', '422'],
  ['POST', '/vendor/leads/{leadId}', '403'],
  ['POST', '/vendor/leads/{leadId}', '429'],
  ['POST', '/weddings', '422'],
  ['POST', '/weddings/{weddingId}/album', '422'],
  ['POST', '/weddings/{weddingId}/logistics/hotels', '422'],
  ['POST', '/weddings/{weddingId}/reschedule', '422'],
  ['POST', '/weddings/{weddingId}/timeline/shift', '422'],
]

// ───────────────────────── тесты ─────────────────────────

describe('audit55 — контракт v0.41.0, единственный владелец (F5)', () => {
  const doc = loadDoc()
  const ops = listOperations(doc)
  const schemas = (doc as { components: { schemas: Record<string, YamlSchema> } }).components.schemas

  it('контракт разобран, операций много', () => {
    expect(ops.length).toBeGreaterThan(100)
  })

  it('версия контракта — 0.49.0 (019: принятие предложения и снимок брони; F5-14 сохранён)', () => {
    expect((doc.info as { version: string }).version).toBe('0.49.0')
  })

  it('019: PUT принимает атомарную замену, shortlist_full — три записи, DELETE — entryId', () => {
    const put = findOp(ops, 'put', '/weddings/{weddingId}/shortlist/{vendorId}')!
    const body = put.item.requestBody?.content?.['application/json']?.schema as {
      required?: string[]
      additionalProperties: boolean
      properties: { replaceEntryId: { type: string; format: string } }
    }
    expect(body.required).toBeUndefined()
    expect(body.additionalProperties).toBe(false)
    expect(body.properties.replaceEntryId).toEqual({ type: 'string', format: 'uuid' })
    expect(hasStatus(put, '422')).toBe(true)
    const conflictSchema = put.item.responses?.['409']?.content?.['application/json']?.schema as {
      properties: {
        error: {
          properties: {
            details: {
              properties: {
                shortlist: { minItems: number; maxItems: number; items: { $ref: string } }
              }
            }
          }
        }
      }
    }
    const shortlist = conflictSchema.properties.error.properties.details.properties.shortlist
    expect(shortlist.minItems).toBe(3)
    expect(shortlist.maxItems).toBe(3)
    expect(shortlist.items.$ref).toBe('#/components/schemas/ShortlistEntry')

    const del = findOp(ops, 'delete', '/weddings/{weddingId}/slots/{slotId}/shortlist/{entryId}')!
    expect(findParam(doc, del, 'entryId', 'path')?.required).toBe(true)
    expect(findParam(doc, del, 'vendorId', 'path')).toBeUndefined()
  })

  describe('T023: строгий контракт запросов и предложений', () => {
    const offerKeys = ['id', 'requestId', 'kind', 'packageId', 'title', 'price', 'includes', 'message', 'validUntil']
    const requestRequired = ['id', 'status', 'weddingDate', 'guests', 'city', 'wishes', 'createdAt']
    const requestKeys = [...requestRequired, 'closeReason', 'budgetHint', 'offer']

    it('Offer — strict oneOf: оба варианта имеют девять ключей, а отказ не маскируется предложением', () => {
      const variants = schemas.Offer!.oneOf ?? []
      expect(variants).toHaveLength(2)
      const offered = variants.find((variant) => variant.properties?.kind?.enum?.[0] === 'offer')!
      const declined = variants.find((variant) => variant.properties?.kind?.enum?.[0] === 'decline')!

      exactObject(offered, offerKeys)
      expect(offered.properties!.kind!.enum).toEqual(['offer'])
      expect(offered.properties!.packageId).toMatchObject({ type: 'string', format: 'uuid', nullable: true })
      expect(offered.properties!.packageId!.enum).toBeUndefined()
      expect(offered.properties!.title).toMatchObject({ type: 'string', minLength: 1, maxLength: 200 })
      expect(offered.properties!.title!.nullable).not.toBe(true)
      expect(offered.properties!.price).toEqual({ $ref: '#/components/schemas/PositiveMoney' })
      expect(offered.properties!.message).toMatchObject({ type: 'string', maxLength: 2000, nullable: true })
      expect(offered.properties!.validUntil).toMatchObject({ type: 'string', format: 'date' })
      expect(offered.properties!.validUntil!.nullable).not.toBe(true)

      exactObject(declined, offerKeys)
      expect(declined.properties!.kind!.enum).toEqual(['decline'])
      for (const key of ['packageId', 'title', 'price', 'validUntil']) {
        expect(declined.properties![key]!.nullable, key).toBe(true)
        expect(declined.properties![key]!.enum, key).toEqual([null])
      }
      expect(declined.properties!.includes).toMatchObject({ type: 'array', minItems: 0, maxItems: 0 })
      expect(declined.properties!.message).toMatchObject({ type: 'string', minLength: 1, maxLength: 2000 })
      expect(declined.properties!.message!.nullable).not.toBe(true)
    })

    it('OfferRequest и безопасный OfferPublic не раскрывают лишнего', () => {

      const request = schemas.OfferRequest!
      exactObject(request, requestRequired, requestKeys)
      expect(request.properties!.status!.enum).toEqual(['open', 'closed'])
      expect(request.properties!.weddingDate!.nullable).toBe(true)
      expect(request.properties!.guests!.nullable).toBe(true)
      expect(request.properties!.city!.nullable).toBe(true)
      expect(request.properties!.wishes!.nullable).toBe(true)
      expect(request.properties!.budgetHint!.$ref).toBe('#/components/schemas/PositiveMoney')
      expect(request.properties!.offer!.$ref).toBe('#/components/schemas/Offer')

      const publicRequest = schemas.OfferPublic!
      exactObject(publicRequest, ['status'])
      expect(publicRequest.properties!.status!.enum).toEqual(['pending', 'responded'])

      const shortlist = schemas.ShortlistEntry!
      expect(shortlist.required).not.toContain('request')
      expect(shortlist.properties!.request!.oneOf).toEqual([
        { $ref: '#/components/schemas/OfferRequest' },
        { $ref: '#/components/schemas/OfferPublic' },
      ])
    })

    it('OfferInput — три непересекающиеся строгие формы: пакет, custom с includes и отказ с текстом', () => {
      const variants = schemas.OfferInput!.oneOf ?? []
      expect(variants).toHaveLength(3)
      const byPackage = variants.find((variant) => Boolean(variant.properties?.packageId))!
      const custom = variants.find((variant) => Boolean(variant.properties?.title))!
      const decline = variants.find((variant) => variant.properties?.kind?.enum?.[0] === 'decline')!

      exactObject(byPackage, ['kind', 'packageId', 'price'], ['kind', 'packageId', 'price', 'message', 'validUntil'])
      exactObject(custom, ['kind', 'title', 'price', 'includes'], ['kind', 'title', 'price', 'includes', 'message', 'validUntil'])
      exactObject(decline, ['kind', 'message'])
      expect(byPackage.properties!.title).toBeUndefined()
      expect(byPackage.properties!.includes).toBeUndefined()
      expect(custom.properties!.packageId).toBeUndefined()
      expect(custom.required).toContain('includes')
      expect(decline.properties!.message!.minLength).toBe(1)
      expect(decline.properties!.packageId).toBeUndefined()
      expect(decline.properties!.price).toBeUndefined()
    })

    it('batch пары возвращает строгий union в порядке entryIds и атомарно отказывает по квоте без Retry-After', () => {
      const op = findOp(ops, 'post', '/weddings/{weddingId}/slots/{slotId}/offer-requests')!
      expect(op).toBeDefined()
      const idem = findParam(doc, op, 'Idempotency-Key', 'header')!
      expect(idem.required).toBe(true)
      expect(idem.schema?.maxLength).toBe(200)

      const input = op.item.requestBody!.content!['application/json']!.schema!
      exactObject(input, ['entryIds'], ['entryIds', 'wishes', 'budgetHint'])
      const entryIds = input.properties!.entryIds!
      expect(entryIds).toMatchObject({ type: 'array', minItems: 1, maxItems: 3, uniqueItems: true })
      expect(entryIds.items).toMatchObject({ type: 'string', format: 'uuid' })
      expect(input.properties!.budgetHint!.$ref).toBe('#/components/schemas/PositiveMoney')

      const created = op.item.responses!['201']!
      expect(created.headers!['Idempotent-Replay']!.schema).toEqual({ type: 'string', enum: ['true'] })
      const success = created.content!['application/json']!.schema!
      exactObject(success, ['results'])
      const results = success.properties!.results!
      expect(results.description).toMatch(/порядке.*entryIds/i)
      expect(results).toMatchObject({ type: 'array', minItems: 1, maxItems: 3 })
      const resultVariants = results.items!.oneOf ?? []
      expect(resultVariants).toHaveLength(2)
      const sent = resultVariants.find((variant) => variant.properties?.status?.enum?.[0] === 'sent')!
      const skipped = resultVariants.find((variant) => variant.properties?.status?.enum?.[0] !== 'sent')!
      exactObject(sent, ['entryId', 'status', 'requestId'])
      exactObject(skipped, ['entryId', 'status'])
      expect(skipped.properties!.status!.enum).toEqual([
        'not_shortlisted', 'busy', 'already_open', 'unavailable', 'category_changed',
      ])

      const conflict = op.item.responses!['409']!.content!['application/json']!.schema!
      const noSent = conflict.oneOf![0]!
      exactObject(noSent, ['error'])
      const error = noSent.properties!.error!
      exactObject(error, ['code', 'message', 'details'])
      expect(error.properties!.code!.enum).toEqual(['no_request_sent'])
      const details = error.properties!.details!
      exactObject(details, ['results'])
      expect(details.properties!.results!.description).toMatch(/порядке.*entryIds/i)
      expect(details.properties!.results!.items).toEqual(results.items)

      const quota = op.item.responses!['429']!
      expect(quota.headers).toBeUndefined()
      expect(`${op.item.description}\n${quota.description}`).toMatch(/остатка квоты не хватает|квоты не хватает всем/i)
      expect(`${op.item.description}\n${quota.description}`).toMatch(/целиком|ни одна строка/i)
      const quotaError = quota.content!['application/json']!.schema!.properties!.error!
      expect(quotaError.properties!.code!.enum).toEqual(['offer_requests_limit'])
    })

    it('кабинет получает bare array, а ответ объявляет replay и ограниченный Retry-After только у квоты версий', () => {
      const list = findOp(ops, 'get', '/vendor/offer-requests')!
      expect(list).toBeDefined()
      const listSchema = list.item.responses!['200']!.content!['application/json']!.schema!
      expect(listSchema.type).toBe('array')
      expect(listSchema.items).toEqual({ $ref: '#/components/schemas/OfferRequest' })

      const answer = findOp(ops, 'post', '/vendor/offer-requests/{requestId}/offers')!
      expect(answer).toBeDefined()
      expect(findParam(doc, answer, 'Idempotency-Key', 'header')).toMatchObject({ required: true })
      expect(answer.item.requestBody!.content!['application/json']!.schema).toEqual({
        $ref: '#/components/schemas/OfferInput',
      })
      const created = answer.item.responses!['201']!
      expect(created.content!['application/json']!.schema).toEqual({ $ref: '#/components/schemas/Offer' })
      expect(created.headers!['Idempotent-Replay']!.schema).toEqual({ type: 'string', enum: ['true'] })

      const limited = answer.item.responses!['429']!
      expect(limited.description).toMatch(/offer_revisions_limit/)
      expect(limited.headers!['Retry-After']!.schema).toEqual({ type: 'integer', minimum: 1, maximum: 86400 })
      const limitError = limited.content!['application/json']!.schema!.properties!.error!
      expect(limitError.properties!.code!.enum).toEqual(['offer_revisions_limit'])
    })
  })

  describe('G-a: идемпотентность — 400 и правильный Idempotency-Key у операций, чей обработчик её читает', () => {
    it('заголовок и 400 совпадают с тем, что реально делает обработчик', () => {
      const violations: string[] = []
      for (const op of ops) {
        const slice = findHandlerSlice(op.fastifyPath, op.method)
        if (!slice) continue
        const usage = idempotencyUsage(slice)
        if (!usage.reads) continue
        if (!hasStatus(op, '400')) violations.push(`${opKey(op.method, op.openapiPath)}: нет 400`)
        const param = findParam(doc, op, 'Idempotency-Key', 'header')
        if (!param) violations.push(`${opKey(op.method, op.openapiPath)}: нет заголовка Idempotency-Key`)
        else if (Boolean(param.required) !== usage.required) {
          violations.push(
            `${opKey(op.method, op.openapiPath)}: required=${String(param.required)}, ожидалось ${usage.required}`,
          )
        }
      }
      expect(violations).toEqual([])
    })

    it('ни одна операция не объявляет Idempotency-Key, которого обработчик не читает', () => {
      const violations: string[] = []
      for (const op of ops) {
        const param = findParam(doc, op, 'Idempotency-Key', 'header')
        if (!param) continue
        const slice = findHandlerSlice(op.fastifyPath, op.method)
        const reads = slice ? idempotencyUsage(slice).reads : false
        if (!reads) violations.push(`${opKey(op.method, op.openapiPath)}: заголовок объявлен, обработчик не читает`)
      }
      expect(violations).toEqual([])
    })
  })

  describe('G-b: пагинация — 400 у операций с parsePageQuery', () => {
    it('каждая операция с parsePageQuery( объявляет 400', () => {
      const violations: string[] = []
      for (const op of ops) {
        const slice = findHandlerSlice(op.fastifyPath, op.method)
        if (!slice || !/\bparsePageQuery\(/.test(slice)) continue
        if (!hasStatus(op, '400')) violations.push(opKey(op.method, op.openapiPath))
      }
      expect(violations).toEqual([])
    })
  })

  describe('G-c1: каждый код, который умеет выдать код, назван в контракте хотя бы раз', () => {
    function scanCodes(): Set<string> {
      const codes = new Set<string>()
      const patterns = [
        /\bnew\s+AppError\(\s*\d+\s*,\s*'([a-z][a-z0-9_]*)'/g,
        /\bconflict\(\s*'([a-z][a-z0-9_]*)'/g,
        /\bquotaExceeded\(\s*'([a-z][a-z0-9_]*)'/g,
        /\bcode:\s*'([a-z][a-z0-9_]*)'/g,
        /\btoErrorBody\(\s*'([a-z][a-z0-9_]*)'/g,
        // `overfunded(constraint, code, message)` в routes/gifts.ts — код вторым аргументом
        // локального помощника, а не одного из общих конструкторов errors.ts.
        /\boverfunded\(\s*'[^']*'\s*,\s*'([a-z][a-z0-9_]*)'/g,
      ]
      for (const re of patterns) for (const m of ALL_SOURCE.matchAll(re)) codes.add(m[1]!)
      // TooManyRequests: явный код — третий аргумент вызова; без него — дефолт класса.
      for (const m of ALL_SOURCE.matchAll(/new\s+TooManyRequests\(/g)) {
        const openIdx = m.index! + 'new TooManyRequests'.length
        const closeIdx = matchParen(ALL_SOURCE, openIdx)
        const args = closeIdx === -1 ? '' : ALL_SOURCE.slice(openIdx + 1, closeIdx)
        const codeMatch = /'([a-z][a-z0-9_]*)'\s*$/.exec(args.trimEnd())
        codes.add(codeMatch ? codeMatch[1]! : 'too_many_requests')
      }
      return codes
    }

    it('ни один найденный код не остаётся безымянным в YAML', () => {
      const codes = scanCodes()
      const yamlText = fs.readFileSync(CONTRACT_FILE, 'utf8')
      const missing = [...codes].filter((c) => !namesCode(yamlText, c)).sort()
      expect(missing).toEqual([])
    })
  })

  describe('G-c2: 128(+1) операционных пар «код × операция» названы в тексте операции', () => {
    it('каждая пара названа в описании операции или её ответов', () => {
      const violations: string[] = []
      for (const [code, pairs] of OPERATION_CODES) {
        for (const [method, p] of pairs) {
          const op = findOp(ops, method, p)
          if (!op) {
            violations.push(`${method} ${p}: операция не найдена в контракте`)
            continue
          }
          if (!namesCode(opText(doc, op), code)) violations.push(`${opKey(method, p)}: не назван код ${code}`)
        }
      }
      expect(violations).toEqual([])
    })
  })

  describe('G-d: пример ссылки своего подрядчика без ТИЛИ-СВОЙ', () => {
    it('строка ТИЛИ-СВОЙ не встречается в контракте', () => {
      expect(fs.readFileSync(CONTRACT_FILE, 'utf8')).not.toContain('ТИЛИ-СВОЙ')
    })
  })

  describe('G-e: 43 HTTP-пары «операция × статус», которые код выдаёт, а контракт не объявляет', () => {
    it('каждый статус объявлен', () => {
      const violations: string[] = []
      for (const [method, p, status] of STATUS_PAIRS) {
        const op = findOp(ops, method, p)
        if (!op) {
          violations.push(`${method} ${p}: операция не найдена`)
          continue
        }
        if (!hasStatus(op, status)) violations.push(`${opKey(method, p)}: нет ${status}`)
      }
      expect(violations).toEqual([])
    })
  })

  describe('G-f: PQ-3 — гостевой токен: 410 gone у трёх путей дня X, 401 у остальных семнадцати', () => {
    const DAY_X: [string, string][] = [
      ['GET', '/join/{guestToken}/day'],
      ['GET', '/join/{guestToken}/day-chat/messages'],
      ['POST', '/join/{guestToken}/day-chat/messages'],
    ]
    const guestOps = ops.filter((op) => Boolean(findParam(doc, op, 'guestToken')))

    it('найдены все двадцать гостевых операций', () => {
      expect(guestOps.length).toBe(20)
    })

    it('дни X отвечают 410 с кодом gone и без 401; остальные — 401 и без 410', () => {
      const violations: string[] = []
      for (const op of guestOps) {
        const isDayX = DAY_X.some(([m, p]) => m === op.method.toUpperCase() && p === op.openapiPath)
        if (isDayX) {
          if (!hasStatus(op, '410')) violations.push(`${opKey(op.method, op.openapiPath)}: нет 410`)
          else if (!namesCode(opText(doc, op), 'gone')) {
            violations.push(`${opKey(op.method, op.openapiPath)}: 410 не называет gone`)
          }
          if (hasStatus(op, '401')) violations.push(`${opKey(op.method, op.openapiPath)}: лишний 401`)
        } else {
          if (!hasStatus(op, '401')) violations.push(`${opKey(op.method, op.openapiPath)}: нет 401`)
          if (hasStatus(op, '410')) violations.push(`${opKey(op.method, op.openapiPath)}: лишний 410`)
        }
      }
      expect(violations).toEqual([])
    })

    it('GuestToken и GuestTokenQuery несут формулировку PQ-3 (410, 401, три пути дня X)', () => {
      const params = doc as { components: { parameters: Record<string, { description: string }> } }
      for (const name of ['GuestToken', 'GuestTokenQuery']) {
        const text = params.components.parameters[name]!.description
        expect(text, name).toContain('410')
        expect(text, name).toContain('401')
        for (const [, p] of DAY_X) expect(text, `${name} ${p}`).toContain(p)
      }
    })
  })

  describe('G-g: PQ-2 — вместимость стола до 100', () => {
    it('POST и PATCH .../tables несут capacity 1..100, POST объявляет 422', () => {
      const post = findOp(ops, 'post', '/weddings/{weddingId}/tables')!
      const patch = findOp(ops, 'patch', '/weddings/{weddingId}/tables/{tableId}')!
      const postCapacity = post.item.requestBody!.content!['application/json']!.schema!.properties as {
        capacity: { minimum?: number; maximum?: number }
      }
      const patchCapacity = patch.item.requestBody!.content!['application/json']!.schema!.properties as {
        capacity: { minimum?: number; maximum?: number }
      }
      expect(postCapacity.capacity.minimum).toBe(1)
      expect(postCapacity.capacity.maximum).toBe(100)
      expect(patchCapacity.capacity.maximum).toBe(100)
      expect(hasStatus(post, '422')).toBe(true)
    })
  })

  /*
   * G-h (F5-R7-08): три правки F5, откат которых G-a…G-g не замечали. Каждая
   * проверка сверяет контракт с кодом обработчика — код источник правды, — и
   * краснеет, если вернуть в контракт прежнюю форму.
   */
  describe('G-h: F5-06, F5-07, F5-08 — форма ответа совпадает с кодом', () => {
    it('F5-06: потолок лайков — 429 квоты (QuotaExceeded), без обещания Retry-After: код бросает quotaExceeded, заголовок ставится только TooManyRequests', () => {
      const op = findOp(ops, 'put', '/inspiration/likes/{storyId}')!
      const slice = findHandlerSlice(op.fastifyPath, op.method)
      expect(slice, 'обработчик PUT /inspiration/likes/:storyId не найден').toBeTruthy()
      expect(slice).toMatch(/\bquotaExceeded\(\s*'likes_limit'/)
      expect(slice).not.toMatch(/\bTooManyRequests\b/)
      const r429 = op.item.responses?.['429']
      expect(r429, '429 не объявлен').toBeTruthy()
      expect(r429!.$ref).toBe('#/components/responses/QuotaExceeded')
    })

    const ADMIN_QUEUES = ['/admin/moderation/vendors', '/admin/verifications', '/admin/complaints', '/admin/concierge']

    it('F5-07: четыре очереди панели — 400 BadRequest и ни одного 422: строку запроса разбирает parsePageQuery, схемы у неё нет', () => {
      const violations: string[] = []
      for (const p of ADMIN_QUEUES) {
        const op = findOp(ops, 'get', p)
        if (!op) {
          violations.push(`GET ${p}: операция не найдена`)
          continue
        }
        const slice = findHandlerSlice(op.fastifyPath, op.method) ?? ''
        if (!/\bparsePageQuery\(/.test(slice)) violations.push(`GET ${p}: обработчик без parsePageQuery`)
        if (/\bquerystring\s*:/.test(slice)) violations.push(`GET ${p}: у обработчика появилась схема строки запроса`)
        if (hasStatus(op, '422')) violations.push(`GET ${p}: объявлен 422, которого код не выдаёт`)
        if (op.item.responses?.['400']?.$ref !== '#/components/responses/BadRequest') {
          violations.push(`GET ${p}: 400 не BadRequest`)
        }
      }
      expect(violations).toEqual([])
    })

    const DICTIONARY_MISS: [method: string, openapiPath: string][] = [
      ['POST', '/catalog/concierge'],
      ['PUT', '/vendor/profile'],
      ['POST', '/weddings'],
      ['PATCH', '/weddings/{weddingId}'],
    ]

    it('F5-08: промах словаря (категория, город) — 404 объявлен у всех четырёх операций, чей обработчик бросает notFound', () => {
      const violations: string[] = []
      for (const [method, p] of DICTIONARY_MISS) {
        const op = findOp(ops, method, p)
        if (!op) {
          violations.push(`${method} ${p}: операция не найдена`)
          continue
        }
        const slice = findHandlerSlice(op.fastifyPath, op.method) ?? ''
        if (!/\bnotFound\(/.test(slice)) violations.push(`${method} ${p}: обработчик не бросает notFound — сторож устарел`)
        const r404 = op.item.responses?.['404']
        if (!r404) {
          violations.push(`${method} ${p}: нет 404`)
          continue
        }
        const text = r404.$ref ? (resolveRef<{ description?: string }>(doc, r404.$ref).description ?? '') : (r404.description ?? '')
        if (!/справочник/.test(text)) violations.push(`${method} ${p}: 404 не говорит о справочнике`)
      }
      expect(violations).toEqual([])
    })
  })

  /*
   * G-i (F5-R7-02…05): списки 409 и тексты отказов, которые общее ревью нашло
   * расходящимися с кодом уже после F5. Каждая проверка сначала убеждается,
   * что код по-прежнему делает то, о чём речь (иначе сторож устарел), и только
   * потом читает контракт.
   */
  describe('G-i: F5-R7-02…05 — списки 409 и тексты отказов совпадают с кодом', () => {
    const src = (rel: string) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
    const r409 = (op: Op) => op.item.responses?.['409']?.description ?? ''

    it('F5-R7-02: 409 переноса даты называет team_busy — главный отказ rescheduleWedding()', () => {
      const op = findOp(ops, 'post', '/weddings/{weddingId}/reschedule')!
      expect(findHandlerSlice(op.fastifyPath, op.method)).toMatch(/\brescheduleWedding\(/)
      expect(src('wedding/reschedule.ts')).toMatch(/new AppError\(409, 'team_busy'/)
      expect(namesCode(op.item.description ?? '', 'team_busy'), 'описание операции').toBe(true)
      expect(namesCode(r409(op), 'team_busy'), 'список 409').toBe(true)
    })

    it('F5-R7-02: 409 отмены брони слота называет bad_transition — cancelDeal() не снимает выполненную работу', () => {
      const op = findOp(ops, 'post', '/weddings/{weddingId}/slots/{slotId}/cancel')!
      expect(findHandlerSlice(op.fastifyPath, op.method)).toMatch(/\bcancelDeal\(/)
      expect(src('deals/cancel.ts')).toMatch(/\bassertTransition\(from, 'cancelled'\)/)
      expect(src('deals/state.ts')).toMatch(/new AppError\(409, 'bad_transition'/)
      expect(namesCode(r409(op), 'bad_transition'), 'список 409').toBe(true)
    })

    it('F5-R7-03: policy_version_stale — любое расхождение редакции («не совпадает»), как сравнивает обработчик, а не «старше»', () => {
      const op = findOp(ops, 'post', '/users/me/consent')!
      expect(findHandlerSlice(op.fastifyPath, op.method)).toMatch(/policyVersion !== /)
      expect(r409(op)).toMatch(/не совпадает/)
      expect(r409(op)).not.toMatch(/старше/)
    })

    it('F5-R7-04/05: forbidden — «согласия нет вовсе», consent_outdated — отдельный код и в общей таблице, и в ответе Forbidden', () => {
      expect(src('auth/consent.ts')).toMatch(/if \(row\.any\) return 'outdated'/)
      expect(src('plugins/auth.ts')).toMatch(/state === 'none'[\s\S]{0,300}throw forbidden\(/)
      const table = (doc.info as { description: string }).description
      const forbiddenRow = table.split('\n').find((l) => l.trimStart().startsWith('- `forbidden` (403)'))
      expect(forbiddenRow, 'строки forbidden в общей таблице нет').toBeTruthy()
      expect(forbiddenRow).not.toMatch(/нет согласия под действующей редакцией/)
      expect(namesCode(forbiddenRow!, 'consent_outdated')).toBe(true)
      const forbidden = resolveRef<{ description?: string }>(doc, '#/components/responses/Forbidden').description ?? ''
      expect(namesCode(forbidden, 'consent_outdated'), 'ответ Forbidden').toBe(true)
    })
  })
})

// ───────────────────────── L-1 / L-2: поведение живьём ─────────────────────────

describe.skipIf(!live)('audit55 — L-1/L-2, поведение живьём (PQ-2, PQ-3)', () => {
  let app: FastifyInstance
  let counter = 0
  // Префикс телефонов прогона — перебор свободного (R-259), как в audit33/audit51/…
  let RUN = String(randomInt(100_000, 1_000_000))
  const SECRET_A = 'a'.repeat(48)
  const SECRET_R = 'b'.repeat(48)
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
    for (let i = 0; i < 20; i++) {
      const { rows } = await app.db!.query('select 1 from users where phone like $1 limit 1', [`+79${RUN}%`])
      if (rows.length === 0) break
      RUN = String(randomInt(100_000, 1_000_000))
    }
  })

  afterAll(async () => {
    await app?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  async function newUser() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: body.accessToken, userId: body.user.id }
  }

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }
  type Wedding = Awaited<ReturnType<typeof newWedding>>

  /** Гость с личным токеном — так, как его получает живой человек. */
  async function newGuest(w: Wedding) {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Ольга' },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id as string}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode, link.body.slice(0, 200)).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode, exchanged.body.slice(0, 200)).toBe(200)
    return exchanged.json().guestToken as string
  }

  async function newTable(w: Wedding, capacity: number) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name: `Стол ${RUN}-${++counter}`, capacity },
    })
    return res
  }

  const patchTable = (w: Wedding, tableId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/tables/${tableId}`, headers: auth(w.token), payload })

  describe('L-1: PQ-2 живьём — стол до 100', () => {
    it('создание: 100 — 201, 101 — 422 validation_failed с fields.capacity', async () => {
      const w = await newWedding()
      const ok = await newTable(w, 100)
      expect(ok.statusCode, ok.body.slice(0, 200)).toBe(201)
      expect(ok.json().capacity).toBe(100)

      const bad = await newTable(w, 101)
      expect(bad.statusCode).toBe(422)
      expect(bad.json().error.code).toBe('validation_failed')
      expect(Object.keys(bad.json().error.fields)).toContain('capacity')
    })

    it('изменение: 51 и 100 — 200 (красные на c24d211, где потолок был 50); 101 и 0 — 422', async () => {
      const w = await newWedding()
      const tableId = (await newTable(w, 8)).json().id as string

      const to51 = await patchTable(w, tableId, { capacity: 51 })
      expect(to51.statusCode, to51.body.slice(0, 200)).toBe(200)
      const to100 = await patchTable(w, tableId, { capacity: 100 })
      expect(to100.statusCode, to100.body.slice(0, 200)).toBe(200)

      const to101 = await patchTable(w, tableId, { capacity: 101 })
      expect(to101.statusCode).toBe(422)
      expect(to101.json().error.code).toBe('validation_failed')
      expect(Object.keys(to101.json().error.fields)).toContain('capacity')

      const to0 = await patchTable(w, tableId, { capacity: 0 })
      expect(to0.statusCode).toBe(422)
    })
  })

  describe('L-2: PQ-3 живьём — мёртвый гостевой токен', () => {
    it('три пути дня X — 410 gone; остальные — 401, поведение не меняется', async () => {
      const dead = randomUUID()

      const day = await app.inject({ method: 'GET', url: `/join/${dead}/day` })
      expect(day.statusCode).toBe(410)
      const dayChat = await app.inject({ method: 'GET', url: `/join/${dead}/day-chat/messages` })
      expect(dayChat.statusCode).toBe(410)

      const rsvp = await app.inject({ method: 'GET', url: `/rsvp/${dead}` })
      expect(rsvp.statusCode).toBe(401)
      const gifts = await app.inject({ method: 'GET', url: `/gifts/${dead}` })
      expect(gifts.statusCode).toBe(401)
      const shuttle = await app.inject({ method: 'GET', url: `/join/${dead}/shuttle` })
      expect(shuttle.statusCode).toBe(401)
      const hotels = await app.inject({ method: 'GET', url: `/join/${dead}/hotels` })
      expect(hotels.statusCode).toBe(401)
      const menuVote = await app.inject({ method: 'GET', url: `/join/${dead}/menu-vote` })
      expect(menuVote.statusCode).toBe(401)
      const team = await app.inject({ method: 'GET', url: `/join/${dead}/team` })
      expect(team.statusCode).toBe(401)

      const w = await newWedding()
      const liveToken = await newGuest(w)
      const reserve = await app.inject({
        method: 'DELETE',
        url: `/gifts/${dead}/${randomUUID()}/reserve`,
      })
      expect(reserve.statusCode).toBe(401)

      const album = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/album?guestToken=${dead}` })
      expect(album.statusCode).toBe(401)
      // Свой токен продолжает работать теми же путями — поведение не меняется.
      const albumMine = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/album?guestToken=${liveToken}` })
      expect(albumMine.statusCode).toBe(200)
    })
  })
})
