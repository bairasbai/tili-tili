import assert from 'node:assert/strict'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { disposablePgPort } from './disposablePgPort.js'
import sharp from 'sharp'
import pg from 'pg'
import { vi } from 'vitest'
import { managedMediaFixture } from './helpers/managedMediaFixture.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'
import { eraseUser, purgeArchivedWeddings } from '../src/jobs/index.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import { S3MediaStore } from '../src/media/storage.js'
import { mediaStorageIdentity, type MediaStorageConfig } from '../src/media/config.js'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { mediaFixture } from './helpers/mediaTransportFixture.js'
import { seedUntrackedSlotDeal } from './helpers/dayFixture.js'
import type { OrderDto } from '../src/orders/model.js'
import type { TermsView } from '../src/orders/terms.js'
import { retireLocalMediaObjects } from '../../../deploy/local-media/retire-objects.mjs'

const DB = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'synthetic-managed-media-access'.repeat(3)

function syntheticPdf(version: '1.4' | '1.5' = '1.4') {
  const header = `%PDF-${version}\n`, object = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const pages = '2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n'
  const prefix = header + object + pages
  return Buffer.from(`${prefix}xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n${String(header.length + object.length).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${prefix.length}\n%%EOF\n`)
}

describe.skipIf(!DB)('managed portfolio through registered authenticated APIs', () => {
  let app: FastifyInstance
  let provider: Awaited<ReturnType<typeof managedMediaFixture>>
  let png: Buffer
  let cityId: number | undefined
  const users: string[] = []
  beforeAll(async () => {
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, disposablePgPort())
    assert.equal(target.username, 'codex_test'); assert.equal(target.search, ''); assert.equal(target.hash, '')
    assert(['/tili_ecosystem_media_20261105_test', '/tili_ecosystem_media2_20261105_test', '/tili_ecosystem_media3_20261105_test', '/tili_ecosystem_media4_20261105_test', '/tili_ecosystem_media7_20261105_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    provider = await managedMediaFixture()
    png = await sharp({ create: { width: 12, height: 9, channels: 3, background: '#edb5ac' } }).png().toBuffer()
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'synthetic-managed-media-refresh'.repeat(3), policyVersion: POLICY, mediaStorage: provider.config, albumMaxPerGuest: 2 })
    await app.ready()
    for (let i = 0; i < 8 && cityId === undefined; i++) cityId = (await app.db!.query<{ id: number }>(
      'insert into cities(id,name,region) values($1,$2,$3) on conflict(id) do nothing returning id',
      [randomInt(1_500_000_000, 1_600_000_000), 'Synthetic media city', randomUUID()])).rows[0]?.id
    assert(cityId !== undefined)
    const actual = (await app.db!.query<{ name: string; port: number }>('select current_database() name,inet_server_port() port')).rows[0]!
    expect(actual.name).toBe(target.pathname.slice(1)); expect(actual.port).toBe(Number(disposablePgPort()))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    if (!app || !provider) return
    provider.controls.beforeRead = provider.controls.beforePut = provider.controls.afterPut = provider.controls.beforeDelete = null
    provider.controls.beforeScan = null
    provider.controls.afterDelete = provider.controls.beforePostCommit = null
    provider.controls.infected = provider.controls.deleteFailure = provider.controls.putResponseLoss = false
    for (const id of users.splice(0)) await app.db!.query('delete from users where id=$1', [id])
  })
  afterAll(async () => {
    let recorded = !process.env.MEDIA_STATE_EVIDENCE
    try {
      if (app && provider) {
        const storageId = mediaStorageIdentity(provider.config)
        const objects = (await app.db!.query('select * from media_objects where storage_id=$1 order by key', [storageId])).rows
        const assets = (await app.db!.query('select * from media_uploads where storage_id=$1 order by id', [storageId])).rows
        if (process.env.MEDIA_STATE_EVIDENCE) {
          writeFileSync(process.env.MEDIA_STATE_EVIDENCE, JSON.stringify({ owner: provider.owner, at: new Date().toISOString(),
            scope: 'Synthetic provider only; all application fixtures removed before namespace retirement', storageId, objects, assets,
            providerEvents: provider.events, finalSyntheticObjects: [...provider.objects].map(([key, bytes]) => ({ key, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) }, null, 2), { encoding: 'utf8', flag: 'wx' })
          recorded = true
        }
      }
    } finally {
      try {
        // Only this random per-run bucket exists in this in-memory fixture.
        // Stop every producer before retiring its synthetic deletion ledger.
        // Other namespaces and historical FAILED records are never selected.
        await provider?.close()
        if (app && provider && recorded) {
          const storageId = mediaStorageIdentity(provider.config)
          const remaining = await app.db!.query('select id from media_uploads where storage_id=$1', [storageId])
          if (remaining.rowCount === 0) {
            await app.db!.query('delete from media_objects where storage_id=$1', [storageId])
            expect((await app.db!.query('select key from media_objects where storage_id=$1', [storageId])).rowCount).toBe(0)
          }
        }
      } finally {
        if (app) { try { if (cityId !== undefined) await app.db!.query('delete from cities where id=$1', [cityId]) } finally { await app.close() } }
      }
    }
  })
  async function owner(rights = true, createVendor = true) {
    let id: string | undefined
    for (let i = 0; i < 8 && !id; i++) id = (await app.db!.query<{ id: string }>(
      'insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id',
      [randomUUID(), '+79' + randomInt(100_000_000, 999_999_999), 'Synthetic media owner'])).rows[0]?.id
    assert(id); users.push(id)
    const session = randomUUID(), vendor = randomUUID()
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    if (createVendor) await app.db!.query("insert into vendors(id,user_id,category_id,name,media_rights_at) values($1,$2,'photo','Synthetic media portfolio',$3)", [vendor, id, rights ? new Date() : null])
    return { id, session, vendor, authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: id, sid: session }) }
  }
  type Actor = Awaited<ReturnType<typeof owner>>
  const command = (actor: Actor, method: 'GET' | 'POST' | 'DELETE', url: string) => ({ method, url, headers: { authorization: actor.authorization } })
  async function issue(actor: Actor, bytes = png, key = randomUUID()) {
    const response = await app.inject({ ...command(actor, 'POST', '/media/upload-url'),
      headers: { authorization: actor.authorization, 'idempotency-key': key },
      payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: bytes.length } })
    expect(response.statusCode, response.body).toBe(201)
    return response.json() as { uploadId: string; uploadUrl: string; fields: Record<string, string>; expiresAt: string }
  }
  async function post(grant: Awaited<ReturnType<typeof issue>>, bytes = png, fields = grant.fields) {
    const data = new FormData()
    for (const [key, value] of Object.entries(fields)) data.append(key, value)
    data.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'synthetic.png')
    const response = await fetch(grant.uploadUrl, { method: 'POST', body: data, redirect: 'error', credentials: 'omit' })
    await response.arrayBuffer()
    return response.status
  }
  const complete = (actor: Actor, id: string) => app.inject(command(actor, 'POST', `/media/uploads/${id}/complete`))
  async function unboundedApp() {
    const config: MediaStorageConfig = { ...provider.config, localUnboundedPost: true, deliveryBaseUrl: 'http://127.0.0.1:43010/api' }
    delete config.postMaxSeconds
    const local = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'synthetic-managed-media-refresh'.repeat(3), policyVersion: POLICY, mediaStorage: config, albumMaxPerGuest: 2 })
    await local.ready()
    return local
  }
  async function photo(actor: Actor) {
    const grant = await issue(actor); expect(await post(grant)).toBe(204)
    const response = await complete(actor, grant.uploadId); expect(response.statusCode, response.body).toBe(200)
    return { grant, ready: response.json() }
  }
  async function waitFor(check: () => Promise<boolean>, timeout = 6000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    throw new Error('Expected actual barrier did not appear')
  }
  async function guestAlbumFor(couple: Actor, weddingId: string) {
    const base = `/weddings/${weddingId}/guests`
    const guest = await app.inject({ ...command(couple, 'POST', base), payload: { name: 'Гость итогового альбома' } })
    expect(guest.statusCode, guest.body).toBe(201)
    const link = await app.inject(command(couple, 'POST', `${base}/${guest.json().id}/invite-link`))
    expect(link.statusCode, link.body).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const invite = await app.inject({ url: `/invite/${code}` })
    expect(invite.statusCode, invite.body).toBe(200)
    const token = encodeURIComponent(invite.json().guestToken as string)
    return { token, path: `/join/${token}/album` }
  }
  it('SC-012: changed order terms preserve prior approvals and their PDF through archive and account erasure', async () => {
    const couple = await owner(false, false), vendor = await owner(), helper = await owner(false, false), outsider = await owner(false, false)
    const wedding = await app.inject({ ...command(couple, 'POST', '/weddings'),
      payload: { partnerName: 'Synthetic contract couple', city: { name: 'Уфа', region: 'Башкортостан' }, date: '2027-06-14' } })
    expect(wedding.statusCode, wedding.body).toBe(201)
    const weddingId = wedding.json().id as string
    try {
      const slotId = (await app.db!.query<{ id: string }>("select id from slots where wedding_id=$1 and category_id='photo' order by sort limit 1", [weddingId])).rows[0]!.id
      const { dealId } = await seedUntrackedSlotDeal(app, { weddingId, slotId, vendorId: vendor.vendor, state: 'booked', price: 17000 })
      await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [weddingId, helper.id])
      const versions = `/deals/${dealId}/documents`
      const newVersion = async () => {
        const made = await app.inject({ ...command(couple, 'POST', `/deals/${dealId}/contract`),
          payload: { templateCode: 'photographer', fields: { customerFullName: 'Synthetic private fields', performerFullName: 'Synthetic vendor' } } })
        expect(made.statusCode, made.body).toBe(201)
        return made.json().id as string
      }
      const first = await newVersion(), second = await newVersion()
      const path = `${versions}/${first}/attachments`
      const bytes = syntheticPdf()
      const requestGrant = (actor: Actor, key: string, url = path, sizeBytes = bytes.length) => app.inject({
        ...command(actor, 'POST', url), headers: { authorization: actor.authorization, 'idempotency-key': key }, payload: { sizeBytes },
      })
      const replayKey = randomUUID()
      expect((await requestGrant(outsider, replayKey)).statusCode).toBe(404)
      expect((await requestGrant(helper, replayKey)).statusCode).toBe(403)
      const replies = await Promise.all([requestGrant(couple, replayKey), requestGrant(vendor, replayKey)])
      expect(replies.map(r => r.statusCode).sort()).toEqual([201, 409])
      const author = replies[0]!.statusCode === 201 ? couple : vendor
      const other = author === couple ? vendor : couple
      const receipt = replies.find(r => r.statusCode === 201)!.json() as Awaited<ReturnType<typeof issue>>
      expect((await requestGrant(author, replayKey)).json().uploadId).toBe(receipt.uploadId)
      const upload = `${path}/${receipt.uploadId}`
      const content = `${upload}/content`
      expect((await app.inject(command(other, 'GET', upload))).statusCode).toBe(404)
      expect((await app.inject(command(other, 'GET', versions))).json().versions[1]).toMatchObject({ uploadInProgress: true, pendingUploadId: null, attachment: null })
      expect((await app.inject(command(author, 'GET', versions))).json().versions[1]).toMatchObject({ uploadInProgress: true, pendingUploadId: receipt.uploadId, attachment: null })
      expect((await app.inject(command(author, 'GET', content))).statusCode).toBe(404)
      expect(receipt.fields['Content-Type']).toBe('application/pdf')
      const submitPdf = async (grant: typeof receipt, input: Buffer) => {
        const body = new FormData()
        for (const [key, value] of Object.entries(grant.fields)) body.append(key, value)
        body.append('file', new Blob([new Uint8Array(input)], { type: 'application/pdf' }), 'synthetic-contract.pdf')
        const posted = await fetch(grant.uploadUrl, { method: 'POST', body, redirect: 'error', credentials: 'omit' })
        await posted.arrayBuffer()
        expect(posted.status).toBe(204)
      }
      await submitPdf(receipt, bytes)
      const checked = await app.inject(command(author, 'POST', `${upload}/complete`))
      expect(checked.statusCode, checked.body).toBe(200)
      expect(checked.json()).toMatchObject({ state: 'ready', contentType: 'application/pdf', width: null, height: null, outputBytes: bytes.length })
      const list = await app.inject(command(other, 'GET', versions))
      expect(list.statusCode, list.body).toBe(200)
      expect(list.body).not.toContain('Synthetic private fields')
      expect(list.json().versions).toMatchObject([
        { id: second, version: 2, pendingUploadId: null, attachment: null },
        { id: first, version: 1, pendingUploadId: null, attachment: { uploadId: receipt.uploadId, attachedAt: checked.json().readyAt,
          authorSide: author === couple ? 'couple' : 'vendor', authorName: 'Synthetic media owner', canRemove: false } },
      ])
      const reply = await app.inject(command(other, 'GET', content))
      expect(reply.statusCode, reply.body).toBe(200)
      expect(reply.rawPayload).toEqual(bytes)
      expect(reply.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store',
        'content-disposition': 'attachment; filename="contract.pdf"' })
      const guest = await guestAlbumFor(couple, weddingId)
      const album = await app.inject({ url: guest.path })
      expect(album.statusCode, album.body).toBe(200)
      expect(album.json().photos).toEqual([])
      expect(album.body).not.toContain(receipt.uploadId)
      expect((await app.inject({ url: `${content}?guestToken=${guest.token}` })).statusCode).toBe(401)
      expect((await app.inject(command(other, 'GET', content.replace(first, second)))).statusCode).toBe(404)
      expect((await app.inject(command(other, 'DELETE', upload))).statusCode).toBe(404)
      expect((await app.inject(command(outsider, 'GET', content))).statusCode).toBe(404)
      const formerVendor = await owner(false, false)
      provider.controls.beforeRead = async key => {
        if (key.endsWith('.pdf')) await app.db!.query('update vendors set user_id=$2 where id=$1', [vendor.vendor, formerVendor.id])
      }
      expect((await app.inject(command(vendor, 'GET', content))).statusCode).toBe(404)
      provider.controls.beforeRead = null
      await app.db!.query('update vendors set user_id=$2 where id=$1', [vendor.vendor, vendor.id])
      const state = (await app.db!.query('select status,file_url from documents where id=$1', [first])).rows[0]
      expect(state).toEqual({ status: 'draft', file_url: null })
      expect((await app.inject(command(author, 'DELETE', upload))).json()).toMatchObject({ state: 'deleted', deletion: 'queued' })
      expect((await app.inject(command(other, 'GET', content))).statusCode).toBe(404)
      expect((await app.db!.query('select state from media_objects where key like $1', [`clean/${receipt.uploadId}/%`])).rows).toEqual([{ state: 'pending' }])

      const coAuthor = await owner(false, false)
      await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, coAuthor.id])
      const retainedGrant = await requestGrant(coAuthor, randomUUID())
      expect(retainedGrant.statusCode, retainedGrant.body).toBe(201)
      const retained = retainedGrant.json() as typeof receipt
      await submitPdf(retained, bytes)
      expect((await app.inject(command(coAuthor, 'POST', `${path}/${retained.uploadId}/complete`))).statusCode).toBe(200)
      const secondPath = `${versions}/${second}/attachments`
      const text = Buffer.from('Synthetic ordinary text file')
      const wrongGrant = await requestGrant(coAuthor, randomUUID(), secondPath, text.length)
      expect(wrongGrant.statusCode, wrongGrant.body).toBe(201)
      const wrong = wrongGrant.json() as typeof receipt
      await submitPdf(wrong, text)
      const invalid = await app.inject(command(coAuthor, 'POST', `${secondPath}/${wrong.uploadId}/complete`))
      expect(invalid.statusCode, invalid.body).toBe(422)
      expect(invalid.json().error.code).toBe('media_invalid_pdf')
      await app.db!.tx(client => eraseUser(client, coAuthor.id))
      const remaining = (await app.inject(command(vendor, 'GET', versions))).json().versions
      expect(remaining).toMatchObject([
        { id: second, uploadInProgress: false, pendingUploadId: null, attachment: null },
        { id: first, attachment: { uploadId: retained.uploadId, authorName: null, authorSide: 'couple', canRemove: false } },
      ])
      expect((await app.inject(command(vendor, 'GET', `${path}/${retained.uploadId}/content`))).rawPayload).toEqual(bytes)
      expect((await app.db!.query('select state,document_author_id from media_uploads where id=$1', [wrong.uploadId])).rows)
        .toEqual([{ state: 'deleted', document_author_id: null }])

      const third = await newVersion()
      const thirdPath = `${versions}/${third}/attachments`
      const proposedFile = await requestGrant(couple, randomUUID(), thirdPath)
      expect(proposedFile.statusCode, proposedFile.body).toBe(201)
      const thirdFile = proposedFile.json() as typeof receipt
      const change = (actor: Actor, documentId: string, action: 'propose' | 'agree', attachmentId: string | null) =>
        app.inject({ ...command(actor, 'POST', `${versions}/${documentId}/agreement`), payload: { action, attachmentId } })
      expect((await change(outsider, third, 'agree', null)).statusCode).toBe(404)
      expect((await change(helper, third, 'agree', null)).statusCode).toBe(403)
      expect((await change(vendor, third, 'propose', null)).statusCode).toBe(403)
      expect((await change(vendor, third, 'agree', null)).json().error.code).toBe('contract_not_proposed')
      expect((await change(couple, second, 'propose', null)).json().error.code).toBe('contract_version_changed')
      expect((await change(couple, third, 'propose', thirdFile.uploadId)).json().error.code).toBe('contract_attachment_changed')
      const agreedBytes = syntheticPdf('1.5')
      await submitPdf(thirdFile, agreedBytes)
      const thirdUpload = `${thirdPath}/${thirdFile.uploadId}`
      const checkedAgreementFile = await app.inject(command(couple, 'POST', `${thirdUpload}/complete`))
      expect(checkedAgreementFile.statusCode, checkedAgreementFile.body).toBe(200)
      const agreedAttachment = { uploadId: thirdFile.uploadId, attachedAt: checkedAgreementFile.json().readyAt,
        authorSide: 'couple', authorName: 'Synthetic media owner', canRemove: false }
      expect((await change(couple, third, 'propose', null)).json().error.code).toBe('contract_attachment_changed')
      const proposals = await Promise.all([change(couple, third, 'propose', thirdFile.uploadId), change(couple, third, 'propose', thirdFile.uploadId)])
      expect(proposals.map(r => r.statusCode)).toEqual([200, 200])
      expect(proposals[0]!.json()).toEqual(proposals[1]!.json())
      expect(proposals[0]!.json()).toMatchObject({ proposedSide: 'couple', coupleAt: null, vendorAt: null })
      expect((await app.inject(command(couple, 'DELETE', thirdUpload))).json().error.code).toBe('contract_attachment_locked')
      expect((await requestGrant(couple, randomUUID(), thirdPath)).json().error.code).toBe('contract_attachment_locked')
      await expect(app.db!.query("update documents set fields='{}' where id=$1", [third])).rejects.toMatchObject({ code: '23514' })
      const approvals = await Promise.all([change(couple, third, 'agree', thirdFile.uploadId), change(vendor, third, 'agree', thirdFile.uploadId)])
      expect(approvals.map(r => r.statusCode)).toEqual([200, 200])
      const readApproved = async (actor: Actor) => (await app.inject(command(actor, 'GET', versions))).json().versions
      const agreed = (await readApproved(vendor))[0].agreement
      expect(agreed).toMatchObject({ canAgree: false, canPropose: false, coupleAt: expect.any(String), vendorAt: expect.any(String),
        terms: { customerName: 'Synthetic private fields', performerName: 'Synthetic vendor' } })

      const orderPath = `/deals/${dealId}/order`
      const readTerms = async (actor: Actor, termsId?: string) => {
        const response = await app.inject(command(actor, 'GET', `${orderPath}/terms${termsId ? `?termsId=${termsId}` : ''}`))
        expect(response.statusCode, response.body).toBe(200)
        return response.json<TermsView>()
      }
      const orderWrite = async <T>(actor: Actor, path: string, payload: object) => {
        const response = await app.inject({ ...command(actor, 'POST', orderPath + path),
          headers: { authorization: actor.authorization, 'idempotency-key': randomUUID() }, payload })
        expect(response.statusCode, response.body).toBe(200)
        return response.json<T>()
      }
      const publishTerms = (actor: Actor, expectedOrderVersion: string, expectedTermsRevision: string) =>
        orderWrite<TermsView>(actor, '/terms/proposals', { expectedOrderVersion, expectedTermsRevision })
      const acceptTerms = async (actor: Actor) => {
        const { selected, readToken } = await readTerms(actor)
        return orderWrite<TermsView>(actor, `/terms/${selected!.id}/accept`,
          { expectedTermsVersion: selected!.version, digest: selected!.digest, readToken })
      }
      await publishTerms(couple, '1', '0')
      await acceptTerms(couple)
      const originalTerms = (await acceptTerms(vendor)).selected!
      expect(originalTerms.receipts.map(receipt => receipt.party)).toEqual(['customer', 'performer'])
      expect(originalTerms.snapshot.parts).toEqual([])

      const addedWork = { kind: 'deliverable', title: 'Дополнительное слайд-шоу',
        details: { items: ['Слайд-шоу'], dueAt: '2027-07-15T12:00:00Z' } }
      const draftOrder = await orderWrite<OrderDto>(vendor, '/parts', { expectedVersion: '1', ...addedWork })
      const offeredTerms = await publishTerms(vendor, draftOrder.version, '1')
      const changedTerms = offeredTerms.selected!
      expect(changedTerms.receipts).toEqual([])
      expect(changedTerms.snapshot.parts).toMatchObject([addedWork])
      expect(changedTerms.snapshot.economics).toEqual(originalTerms.snapshot.economics)
      expect(offeredTerms.agreedTermsId).toBe(originalTerms.id)
      expect((await acceptTerms(vendor)).agreedTermsId).toBe(originalTerms.id)
      expect((await acceptTerms(couple)).agreedTermsId).toBe(changedTerms.id)

      const contractActions = async (actor: Actor) => {
        const exported = await app.inject(command(actor, 'GET', '/users/me/export'))
        expect(exported.statusCode, exported.body).toBe(200)
        return exported.json().contractActions
      }
      const exportedRevision = { documentId: third, dealId, version: 3 }
      const coupleActions = [
        { ...exportedRevision, action: 'proposed', side: 'couple', recordedAt: agreed.proposedAt },
        { ...exportedRevision, action: 'agreed', side: 'couple', recordedAt: agreed.coupleAt },
      ]
      const vendorActions = [{ ...exportedRevision, action: 'agreed', side: 'vendor', recordedAt: agreed.vendorAt }]
      expect(await contractActions(couple)).toEqual(coupleActions)
      expect(await contractActions(vendor)).toEqual(vendorActions)
      expect(await contractActions(helper)).toEqual([])
      expect(await contractActions(outsider)).toEqual([])
      await app.db!.query('update vendors set user_id=$2 where id=$1', [vendor.vendor, formerVendor.id])
      try {
        expect(await contractActions(vendor)).toEqual([])
        expect(await contractActions(formerVendor)).toEqual([])
      } finally {
        await app.db!.query('update vendors set user_id=$2 where id=$1', [vendor.vendor, vendor.id])
      }
      const fourth = await newVersion()
      const next = await readApproved(couple)
      expect(next[0]).toMatchObject({ id: fourth, attachment: null,
        agreement: { canPropose: true, canAgree: false, proposedAt: null, coupleAt: null, vendorAt: null } })
      expect(next[1]).toMatchObject({ id: third, agreement: agreed, attachment: agreedAttachment })
      expect((await change(vendor, third, 'agree', thirdFile.uploadId)).json().vendorAt).toBe(agreed.vendorAt)
      const audit = await app.db!.query("select action,count(*)::int n from audit_log where entity='document' and entity_id=$1 group by action order by action", [third])
      expect(audit.rows).toEqual([{ action: 'contract.agreed', n: 2 }, { action: 'contract.proposed', n: 1 }])

      const cancelled = await app.inject({ method: 'PATCH', url: `/deals/${dealId}`,
        headers: { authorization: couple.authorization, 'idempotency-key': randomUUID() }, payload: { state: 'cancelled' } })
      expect(cancelled.statusCode, cancelled.body).toBe(200)
      expect(cancelled.json().state).toBe('cancelled')
      for (const actor of [couple, vendor]) {
        const history = await app.inject(command(actor, 'GET', `/deals/${dealId}/events`))
        expect(history.statusCode, history.body).toBe(200)
        expect(history.json()).toEqual(expect.arrayContaining([expect.objectContaining({
          fromState: 'booked', toState: 'cancelled', by: 'couple',
        })]))
        expect((await readTerms(actor, originalTerms.id)).selected).toMatchObject({
          digest: originalTerms.digest, snapshot: originalTerms.snapshot, receipts: originalTerms.receipts,
        })
        const currentTerms = await readTerms(actor)
        expect(currentTerms.agreedTermsId).toBe(changedTerms.id)
        expect(currentTerms.selected?.receipts.map(receipt => receipt.party)).toEqual(['performer', 'customer'])
        expect(await readApproved(actor)).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: fourth, attachment: null,
            agreement: expect.objectContaining({ canPropose: false, canAgree: false, coupleAt: null, vendorAt: null }) }),
          expect.objectContaining({ id: third, agreement: agreed,
            attachment: agreedAttachment }),
        ]))
        const pdf = await app.inject(command(actor, 'GET', `${thirdUpload}/content`))
        expect(pdf.statusCode).toBe(200)
        expect(pdf.rawPayload).toEqual(agreedBytes)
      }
      expect((await app.inject(command(helper, 'GET', `/deals/${dealId}/events`))).statusCode).toBe(403)
      expect((await app.inject(command(outsider, 'GET', `/deals/${dealId}/events`))).statusCode).toBe(404)
      expect((await app.inject(command(outsider, 'GET', `${thirdUpload}/content`))).statusCode).toBe(404)
      expect((await change(couple, fourth, 'propose', null)).statusCode).toBe(409)

      const draftPath = `${versions}/${fourth}/attachments`
      const unfinished = await requestGrant(couple, randomUUID(), draftPath)
      expect(unfinished.statusCode, unfinished.body).toBe(201)
      const draftUpload = `${draftPath}/${unfinished.json().uploadId}`
      const archivePath = '/users/me/archived-contracts'
      const listArchive = (actor: Actor, side: 'couple' | 'vendor', before?: string) => app.inject(command(actor, 'GET',
        `${archivePath}?${new URLSearchParams({ side, ...(before ? { before } : {}) })}`))
      const archiveRetentionDays = app.appConfig.weddingArchiveDays
      const emptyArchive = { items: [], nextCursor: null, archiveRetentionDays }
      expect((await listArchive(couple, 'couple')).json()).toEqual(emptyArchive)
      const partner = await owner(false, false)
      await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, partner.id])
      const cancelPath = `/weddings/${weddingId}/cancel`
      const requested = await app.inject(command(couple, 'POST', cancelPath))
      expect(requested.statusCode, requested.body).toBe(200)
      expect(requested.json()).toMatchObject({ state: 'confirmation_required', requestedBy: couple.id })
      expect((await listArchive(partner, 'couple')).json()).toEqual(emptyArchive)
      const archived = await app.inject(command(partner, 'POST', cancelPath))
      expect(archived.statusCode, archived.body).toBe(200)
      expect(archived.json().state).toBe('cancelled')
      for (const [actor, side, performerName] of [[couple, 'couple', 'Synthetic media portfolio'], [vendor, 'vendor', null]] as const) {
        const list = await listArchive(actor, side)
        expect(list.statusCode, list.body).toBe(200)
        expect(list.headers['cache-control']).toBe('no-store')
        expect(list.json()).toEqual({ items: [{ dealId, weddingTitle: expect.any(String), performerName, archivedAt: expect.any(String),
          cleanupEligible: false }], nextCursor: null, archiveRetentionDays })
        expect((await listArchive(actor, side, dealId)).json()).toEqual(emptyArchive)
      }
      for (const [actor, side] of [[helper, 'couple'], [outsider, 'vendor'], [vendor, 'couple'], [couple, 'vendor']] as const) {
        const list = await listArchive(actor, side)
        expect(list.statusCode, list.body).toBe(200)
        expect(list.json()).toEqual(emptyArchive)
      }
      expect((await listArchive(couple, 'couple', 'invalid')).statusCode).toBe(422)
      expect((await app.inject({ url: `${archivePath}?side=couple` })).statusCode).toBe(401)
      const blocked = await Promise.all([
        requestGrant(couple, randomUUID(), draftPath),
        app.inject(command(couple, 'DELETE', draftUpload)),
        app.inject(command(couple, 'POST', `${draftUpload}/complete`)),
        app.inject({ ...command(couple, 'POST', `/deals/${dealId}/contract`),
          payload: { templateCode: 'photographer', fields: { customerFullName: 'Synthetic customer', performerFullName: 'Synthetic vendor' } } }),
      ])
      for (const response of blocked) {
        expect(response.statusCode).toBe(409)
        expect(response.json().error.code).toBe('contract_archived')
      }
      expect((await app.inject(command(helper, 'GET', versions))).statusCode).toBe(403)
      expect((await app.inject(command(outsider, 'GET', `${thirdUpload}/content`))).statusCode).toBe(404)
      const draftStatus = await app.inject(command(couple, 'GET', draftUpload))
      expect(draftStatus.statusCode, draftStatus.body).toBe(200)

      const readRetained = async (member = couple) => {
        for (const actor of [member, vendor]) {
          const listed = await app.inject(command(actor, 'GET', versions))
          expect(listed.statusCode, listed.body).toBe(200)
          expect(listed.json()).toMatchObject({ archived: true, uploadEnabled: false })
          expect(listed.json().versions).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: first, attachment: expect.objectContaining({ canRemove: false }) }),
            expect.objectContaining({ id: third, agreement: agreed, attachment: { ...agreedAttachment,
              authorName: member === couple ? agreedAttachment.authorName : null } }),
            expect.objectContaining({ id: fourth, pendingUploadId: null, uploadInProgress: false }),
          ]))
          const download = await app.inject(command(actor, 'GET', `${thirdUpload}/content`))
          expect(download.statusCode).toBe(200)
          expect(download.rawPayload).toEqual(agreedBytes)
        }
      }
      await readRetained()
      expect(await contractActions(couple)).toEqual(coupleActions)
      expect(await contractActions(vendor)).toEqual(vendorActions)
      const { clean_key: cleanKey } = (await app.db!.query<{ clean_key: string }>(
        'select clean_key from media_uploads where id=$1', [thirdFile.uploadId])).rows[0]!
      expect(provider.objects.get(cleanKey)).toEqual(agreedBytes)
      await purgeArchivedWeddings(app)
      await readRetained()

      const removed = await app.inject(command(couple, 'DELETE', '/users/me'))
      expect(removed.statusCode, removed.body).toBe(204)
      expect((await app.inject(command(couple, 'GET', versions))).statusCode).toBe(401)
      expect((await app.inject(command(couple, 'GET', '/users/me/export'))).statusCode).toBe(401)
      await app.db!.tx(client => eraseUser(client, couple.id))
      expect((await app.db!.query('select id from users where id=$1', [couple.id])).rowCount).toBe(0)
      expect((await app.db!.query('select owner_id from weddings where id=$1', [weddingId])).rows).toEqual([{ owner_id: partner.id }])
      expect((await app.db!.query(`select proposed_by,couple_by,vendor_by,attachment_id
        from contract_agreements where document_id=$1`, [third])).rows).toEqual([{
        proposed_by: null, couple_by: null, vendor_by: vendor.id, attachment_id: thirdFile.uploadId,
      }])
      expect((await app.db!.query('select document_author_id,state from media_uploads where id=$1', [thirdFile.uploadId])).rows)
        .toEqual([{ document_author_id: null, state: 'ready' }])
      await readRetained(partner)
      expect(await contractActions(partner)).toEqual([])
      expect(await contractActions(vendor)).toEqual(vendorActions)

      // Advance only this synthetic archive past the actual configured retention.
      await app.db!.tx(async client => {
        await prepareLegacyCalendarScope(client, { weddingIds: [weddingId], mode: 'erase' })
        await client.query('update weddings set archived_at=clock_timestamp()-make_interval(days=>$2) where id=$1 and cancelled_at is not null',
          [weddingId, app.appConfig.weddingArchiveDays + 1])
      })
      for (const [actor, side] of [[partner, 'couple'], [vendor, 'vendor']] as const) {
        const due = await listArchive(actor, side)
        expect(due.statusCode, due.body).toBe(200)
        expect(due.json()).toMatchObject({ archiveRetentionDays, items: [{ dealId, cleanupEligible: true }] })
      }
      expect(await purgeArchivedWeddings(app)).toBe(1)
      expect(await contractActions(partner)).toEqual([])
      expect(await contractActions(vendor)).toEqual([])
      expect((await listArchive(partner, 'couple')).json()).toEqual(emptyArchive)
      expect((await listArchive(vendor, 'vendor')).json()).toEqual(emptyArchive)
      expect((await app.inject(command(partner, 'GET', versions))).statusCode).toBe(404)
      expect((await app.inject(command(vendor, 'GET', `${thirdUpload}/content`))).statusCode).toBe(404)
      expect((await app.db!.query('select document_id from contract_agreements where document_id=$1', [third])).rowCount).toBe(0)
      expect((await app.db!.query('select id from media_uploads where id=$1', [thirdFile.uploadId])).rowCount).toBe(0)
      expect((await app.db!.query('select state from media_objects where key=$1', [cleanKey])).rows).toEqual([{ state: 'pending' }])
      await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second' where key=$1", [cleanKey])
      await app.managedMedia!.collect(50)
      expect(provider.objects.has(cleanKey)).toBe(false)
      expect((await app.db!.query("select action from audit_log where (entity_id=$1 and action='wedding.purged') or (entity_id=$2 and action='contract.agreed') order by action", [weddingId, third])).rows)
        .toEqual([{ action: 'contract.agreed' }, { action: 'contract.agreed' }, { action: 'wedding.purged' }])
    } finally { await app.db!.query('delete from weddings where id=$1', [weddingId]) }
  })
  it.each([false, true])('T005: a guest submits a verified photo, the couple approves and removes it (local unbounded: %s)', async useLocal => {
    const runtime = useLocal ? await unboundedApp() : app
    const couple = await owner(false, false)
    const headers = { authorization: couple.authorization }
    let weddingId: string | undefined
    try {
      const created = await runtime.inject({ method: 'POST', url: '/weddings', headers,
        payload: { partnerName: 'Album fixture', city: { name: 'Уфа', region: 'Башкортостан' }, date: '2027-06-14' } })
      expect(created.statusCode, created.body).toBe(201)
      weddingId = created.json().id as string
      const album = `/weddings/${weddingId}/album`
      const guest = await runtime.inject({ method: 'POST', url: `/weddings/${weddingId}/guests`, headers, payload: { name: 'Album guest' } })
      expect(guest.statusCode, guest.body).toBe(201)
      const guestId = guest.json().id as string
      const invitation = await runtime.inject({ method: 'POST', url: `/weddings/${weddingId}/guests/${guestId}/invite-link`, headers })
      expect(invitation.statusCode, invitation.body).toBe(200)
      const invite = await runtime.inject({ method: 'GET', url: `/invite/${(invitation.json().url as string).split('/').pop()!}` })
      expect(invite.statusCode, invite.body).toBe(200)
      const token = invite.json().guestToken as string
      const guestAlbum = `/join/${token}/album`
      const list = () => runtime.inject({ method: 'GET', url: guestAlbum })
      const requestUpload = (consent: boolean, key = randomUUID()) => runtime.inject({ method: 'POST', url: `${guestAlbum}/uploads`,
        headers: { 'idempotency-key': key }, payload: { contentType: 'image/png', sizeBytes: png.length, consent } })
      expect((await list()).json()).toEqual({ uploadEnabled: true, photos: [] })
      expect((await requestUpload(false)).json().error.code).toBe('consent_required')
      const oldWrite = await runtime.inject({ method: 'POST', url: `${album}?guestToken=${token}`,
        payload: { fileUrl: 'https://example.com/old.jpg', consent: true } })
      expect(oldWrite.statusCode, oldWrite.body).toBe(410)
      const key = randomUUID()
      const attempts = await Promise.all([requestUpload(true, key), requestUpload(true, key)])
      expect(attempts.map(result => result.statusCode)).toEqual([201, 201])
      const grant = attempts[0]!.json() as Awaited<ReturnType<typeof issue>>
      expect(attempts[1]!.json().uploadId).toBe(grant.uploadId)
      const debt = await app.db!.query<{ deadline: string }>('select external_until::text deadline from media_objects where key=$1',
        [`quarantine/${grant.uploadId}/original`])
      expect(debt.rows[0]?.deadline === 'infinity').toBe(useLocal)
      const concurrent = await Promise.all([requestUpload(true), requestUpload(true)])
      expect(concurrent.map(result => result.statusCode).sort()).toEqual([201, 429])
      const quota = concurrent.find(result => result.statusCode === 429)!
      expect(quota.json().error.code).toBe('album_limit')
      expect(quota.headers['retry-after']).toBeUndefined()
      const unfinished = concurrent.find(result => result.statusCode === 201)!.json().uploadId as string
      await app.db!.query(`update media_uploads set created_at=now()-interval '8 minutes',expires_at=now()-interval '3 minutes',
        album_consent_at=now()-interval '8 minutes' where id=$1`, [unfinished])
      const stillOccupied = await requestUpload(true)
      expect(stillOccupied.json().error.code).toBe('album_limit')
      expect(await post(grant)).toBe(204)
      const finished = await runtime.inject({ method: 'POST', url: `${guestAlbum}/uploads/${grant.uploadId}/complete` })
      expect(finished.statusCode, finished.body).toBe(200)
      expect(finished.json().state).toBe('ready')
      expect((await list()).json().photos).toEqual([])
      const guestContent = `${guestAlbum}/${grant.uploadId}/content`
      expect((await runtime.inject({ method: 'GET', url: guestContent })).statusCode).toBe(404)
      const team = await runtime.inject({ method: 'GET', url: `${album}/${grant.uploadId}/content`, headers })
      expect(team.statusCode, team.body).toBe(200)
      expect(team.headers['content-type']).toBe('image/webp')
      const approved = await runtime.inject({ method: 'PATCH', url: `${album}/${grant.uploadId}`, headers, payload: { approved: true } })
      expect(approved.statusCode, approved.body).toBe(200)
      expect((await list()).json().photos).toMatchObject([{ id: grant.uploadId, approved: true, managed: true }])
      const image = await runtime.inject({ method: 'GET', url: guestContent })
      expect(image.statusCode, image.body).toBe(200)
      expect(image.headers['cache-control']).toBe('private, no-store')
      expect(image.rawPayload).toEqual(team.rawPayload)
      if (useLocal) {
        const { clean_key: cleanKey, storage_id: storageId } = (await app.db!.query<{ clean_key: string; storage_id: string }>(
          'select clean_key,storage_id from media_uploads where id=$1', [grant.uploadId])).rows[0]!
        const original = grant.fields.key!
        expect(provider.objects.has(original)).toBe(true)
        expect(provider.objects.get(cleanKey)).toEqual(image.rawPayload)
        const store = new S3MediaStore(provider.config)
        try {
          // Synthetic transport has no live old writers. Exercise the same
          // SQL retirement step used after the real launcher drains them.
          await retireLocalMediaObjects(app.db!, storageId, async (objectKey: string) => {
            await store.remove(objectKey)
            expect(provider.objects.has(objectKey)).toBe(false)
          })
        } finally { store.close() }
        expect((await app.db!.query('select state from media_objects where key=$1', [original])).rows[0]?.state).toBe('done')
        expect((await app.db!.query('select state from media_objects where key=$1', [cleanKey])).rows[0]?.state).toBe('pending')
        const replay = await requestUpload(true, key)
        expect(replay.statusCode, replay.body).toBe(409)
        expect(replay.json().error.code).toBe('media_upload_expired')
        const afterRestart = await runtime.inject({ method: 'GET', url: guestContent })
        expect(afterRestart.statusCode, afterRestart.body).toBe(200)
        expect(afterRestart.rawPayload).toEqual(image.rawPayload)
      }
      const hidden = await runtime.inject({ method: 'PATCH', url: `${album}/${grant.uploadId}`, headers, payload: { approved: false } })
      expect(hidden.statusCode, hidden.body).toBe(200)
      expect((await list()).json().photos).toEqual([])
      expect((await runtime.inject({ method: 'GET', url: guestContent })).statusCode).toBe(404)
      const restored = await runtime.inject({ method: 'PATCH', url: `${album}/${grant.uploadId}`, headers, payload: { approved: true } })
      expect(restored.statusCode, restored.body).toBe(200)

      const helper = await owner(false, false)
      await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [weddingId, helper.id])
      const removedGuest = await runtime.inject({ method: 'DELETE', url: `/weddings/${weddingId}/guests/${guestId}`,
        headers: { authorization: helper.authorization } })
      expect(removedGuest.statusCode, removedGuest.body).toBe(204)
      expect((await list()).statusCode).toBe(401)
      const remainingPhoto = await runtime.inject({ method: 'GET', url: `${album}/${grant.uploadId}/content`, headers })
      expect(remainingPhoto.rawPayload).toEqual(image.rawPayload)
      const detached = await app.db!.query('select state,album_party_id,album_guest_id from media_uploads where id=any($1::uuid[]) order by state',
        [[grant.uploadId, unfinished]])
      expect(detached.rows).toEqual([
        { state: useLocal ? 'expired' : 'deleted', album_party_id: null, album_guest_id: null },
        { state: 'ready', album_party_id: null, album_guest_id: null },
      ])
      expect((await runtime.inject({ method: 'DELETE', url: `${album}/${grant.uploadId}`, headers })).statusCode).toBe(204)
      expect((await runtime.inject({ method: 'GET', url: `${album}/${grant.uploadId}/content`, headers })).statusCode).toBe(404)
      const state = await app.db!.query('select state from media_uploads where id=$1', [grant.uploadId])
      expect(state.rows[0]?.state).toBe('deleted')
    } finally {
      try { if (weddingId) await app.db!.query('delete from weddings where id=$1', [weddingId]) }
      finally { if (useLocal) await runtime.close() }
    }
  })
  it('local unbounded mode advertises uploads and retains SQL infinity through delete, cascade and a bounded-mode GC', async () => {
    const actor = await owner(), local = await unboundedApp()
    try {
      const list = await local.inject(command(actor, 'GET', '/media/uploads'))
      expect(list.statusCode).toBe(200); expect(list.json().enabled).toBe(true)
      const issued = await local.inject({ ...command(actor, 'POST', '/media/upload-url'),
        headers: { authorization: actor.authorization, 'idempotency-key': randomUUID() },
        payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: png.length } })
      expect(issued.statusCode, issued.body).toBe(201)
      const grant = issued.json() as Awaited<ReturnType<typeof issue>>
      expect(Number.isFinite(Date.parse(grant.expiresAt))).toBe(true)
      const key = `quarantine/${grant.uploadId}/original`
      const debt = () => app.db!.query("select not_before::text deadline,external_until::text external,state,write_phase from media_objects where key=$1", [key])
      expect((await debt()).rows[0]).toMatchObject({ deadline: 'infinity', external: 'infinity', state: 'pending', write_phase: 'external' })
      expect(await post(grant)).toBe(204)
      expect((await local.inject(command(actor, 'POST', `/media/uploads/${grant.uploadId}/complete`))).statusCode).toBe(200)
      expect((await local.inject(command(actor, 'DELETE', `/media/uploads/${grant.uploadId}`))).json().deletion).toBe('queued')
      await local.managedMedia!.collect()
      await app.db!.query('delete from users where id=$1', [actor.id])
      await app.managedMedia!.collect() // finite configuration does not rewrite existing infinity debt
      expect((await debt()).rows[0]).toMatchObject({ deadline: 'infinity', external: 'infinity', state: 'pending', write_phase: 'external' })
      expect(provider.events.filter(event => event.key === key && event.method === 'DELETE')).toHaveLength(0)
    } finally { await local.close() }
  })
  it('local unbounded grants keep the five-slot quota after an expired/deleted test-clock frame', async () => {
    const actor = await owner(), local = await unboundedApp()
    const attempt = () => local.inject({ ...command(actor, 'POST', '/media/upload-url'),
      headers: { authorization: actor.authorization, 'idempotency-key': randomUUID() },
      payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: png.length } })
    try {
      const responses = await Promise.all(Array.from({ length: 6 }, attempt))
      expect(responses.map(response => response.statusCode).sort()).toEqual([201, 201, 201, 201, 201, 409])
      // Only these newly created synthetic fixtures use a past SQL clock frame;
      // the deployed maintenance code never changes original intent timestamps.
      await app.db!.query("update media_uploads set state='deleted',deleted_at=clock_timestamp(),created_at=created_at-interval '1 day',expires_at=expires_at-interval '1 day' where vendor_id=$1", [actor.vendor])
      await local.managedMedia!.collect()
      expect((await attempt()).statusCode).toBe(409)
      expect((await app.db!.query("select count(*)::int n from media_objects where key like 'quarantine/%' and external_until='infinity'::timestamptz and key in (select quarantine_key from media_uploads where vendor_id=$1)", [actor.vendor])).rows[0]?.n).toBe(5)
    } finally { await local.close() }
  })
  it('issues a bounded exact POST policy once per intent; no file URL before verification', async () => {
    const actor = await owner(), key = randomUUID()
    const command = { method: 'POST' as const, url: '/media/upload-url', headers: { authorization: actor.authorization, 'idempotency-key': key },
      payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: 1234 } }
    const first = await app.inject(command)
    expect(first.statusCode).toBe(201)
    const grant = first.json()
    expect(grant.uploadId).toMatch(/^[0-9a-f-]{36}$/); expect(grant.method).toBe('POST'); expect(grant.fileUrl).toBeUndefined()
    const policy = JSON.parse(Buffer.from(grant.fields.Policy, 'base64').toString('utf8'))
    expect(policy.conditions).toContainEqual(['content-length-range', 1234, 1234])
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/png'])
    expect(Date.parse(policy.expiration)).toBeLessThanOrEqual(Date.parse(grant.expiresAt))
    const again = await app.inject(command)
    expect(again.statusCode).toBe(201); expect(again.json().uploadId).toBe(grant.uploadId)
    const changed = await app.inject({ ...command, payload: { ...command.payload, sizeBytes: 1235 } })
    expect(changed.statusCode).toBe(409)
  })
  it('keeps non-photo purposes explicitly disabled', async () => {
    const actor = await owner()
    const response = await app.inject({ method: 'POST', url: '/media/upload-url', headers: { authorization: actor.authorization, 'idempotency-key': randomUUID() },
      payload: { kind: 'document_scan', contentType: 'image/png', sizeBytes: 1234 } })
    expect(response.statusCode).toBe(501)
  })
  it('rejects absent, overlong and non-ASCII intent keys before issuing a provider capability', async () => {
    const actor = await owner(), previousPosts = provider.events.filter(event => event.method === 'POST').length
    for (const [key, status] of [[undefined, 400], ['x'.repeat(129), 422], ['x'.repeat(201), 400], ['has space', 422], ['café', 422]] as const) {
      const response = await app.inject({ ...command(actor, 'POST', '/media/upload-url'),
        headers: { authorization: actor.authorization, ...(key ? { 'idempotency-key': key } : {}) },
        payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: png.length } })
      expect(response.statusCode, response.body).toBe(status)
    }
    expect((await app.db!.query('select id from media_uploads where vendor_id=$1', [actor.vendor])).rowCount).toBe(0)
    expect(provider.events.filter(event => event.method === 'POST')).toHaveLength(previousPosts)
  })
  it('FR-050: verified PDF and WebP stay private until submitted, then belong to that revision', async () => {
    const couple = await owner(false, false), vendor = await owner(), outsider = await owner(false, false)
    const wedding = await app.inject({ ...command(couple, 'POST', '/weddings'),
      payload: { partnerName: 'Synthetic order delivery', city: { name: 'Уфа', region: 'Башкортостан' }, date: '2027-06-14' } })
    expect(wedding.statusCode, wedding.body).toBe(201)
    const weddingId = wedding.json().id as string
    try {
      const slotId = (await app.db!.query<{ id: string }>("select id from slots where wedding_id=$1 and category_id='photo' order by sort limit 1", [weddingId])).rows[0]!.id
      const { dealId } = await seedUntrackedSlotDeal(app, { weddingId, slotId, vendorId: vendor.vendor, state: 'booked', price: 17000 })
      const path = `/deals/${dealId}/order/delivery`
      const mutate = (actor: Actor, url: string, payload: object) => app.inject({ ...command(actor, 'POST', url),
        headers: { authorization: actor.authorization, 'idempotency-key': randomUUID() }, payload })
      const upload = async (contentType: string, bytes: Buffer) => {
        const issued = await mutate(vendor, `${path}/files`, { revision: 1, contentType, sizeBytes: bytes.length })
        expect(issued.statusCode, issued.body).toBe(201)
        const grant = issued.json() as Awaited<ReturnType<typeof issue>>
        expect(grant.fields['Content-Type']).toBe(contentType)
        const body = new FormData()
        for (const [key, value] of Object.entries(grant.fields)) body.append(key, value)
        body.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), 'synthetic-delivery')
        const posted = await fetch(grant.uploadUrl, { method: 'POST', body, redirect: 'error', credentials: 'omit' })
        await posted.arrayBuffer()
        expect(posted.status).toBe(204)
        const checked = await app.inject(command(vendor, 'POST', `${path}/files/${grant.uploadId}/complete`))
        expect(checked.statusCode, checked.body).toBe(200)
        expect(checked.json()).toMatchObject({ state: 'ready', contentType })
        return grant.uploadId
      }
      const bytes = syntheticPdf()
      const grantInput = { revision: 1, contentType: 'application/pdf', sizeBytes: bytes.length }
      expect((await mutate(couple, `${path}/files`, grantInput)).statusCode).toBe(403)
      expect((await mutate(outsider, `${path}/files`, grantInput)).statusCode).toBe(404)
      const pdf = await upload('application/pdf', bytes), image = await upload('image/png', png), abandoned = await upload('image/png', png)
      const content = `${path}/files/${pdf}/content`
      expect((await app.inject(command(vendor, 'GET', content))).statusCode).toBe(404)
      expect((await app.inject(command(couple, 'GET', content))).statusCode).toBe(404)
      expect((await app.inject(command(couple, 'GET', path))).json()).toMatchObject({ drafts: [], revision: 0 })
      expect((await app.inject(command(vendor, 'GET', path))).json().drafts.map((row: { uploadId: string }) => row.uploadId)).toEqual([pdf,image,abandoned])
      const step = { kind: 'submitted', expectedRevision: 0, summary: 'Synthetic materials', dueOn: '2027-06-15' }
      expect((await mutate(vendor, path, step)).statusCode).toBe(422)
      expect((await mutate(vendor, path, { ...step, fileIds: [randomUUID()] })).statusCode).toBe(409)
      await expect(app.db!.tx(async client => {
        await client.query(`insert into order_delivery_steps(wedding_id,deal_id,revision,kind,actor_id,summary,due_on)
          values($1,$2,1,'submitted',$3,'Synthetic attachmentless fixture','2027-06-15')`, [weddingId,dealId,vendor.id])
      })).rejects.toMatchObject({ code: '23514', constraint: 'order_delivery_material_required' })
      const sent = await mutate(vendor, path, { ...step, fileIds: [pdf,image] })
      expect(sent.statusCode, sent.body).toBe(200)
      const list = await app.inject(command(couple, 'GET', path))
      expect(list.json()).toMatchObject({ revision: 1, drafts: [], steps: [{ kind: 'submitted', materialUrl: null,
        files: [{ uploadId: pdf, contentType: 'application/pdf' }, { uploadId: image, contentType: 'image/png' }] }] })
      const downloaded = await app.inject(command(couple, 'GET', content))
      expect(downloaded.statusCode, downloaded.body).toBe(200)
      expect(downloaded.rawPayload).toEqual(bytes)
      expect(downloaded.headers).toMatchObject({ 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="material.pdf"' })
      const imageReply = await app.inject(command(vendor, 'GET', `${path}/files/${image}/content`))
      expect(imageReply.statusCode).toBe(200)
      expect((await sharp(imageReply.rawPayload).metadata()).format).toBe('webp')
      const guest = await guestAlbumFor(couple, weddingId)
      const approved = randomUUID(), pending = randomUUID()
      await app.db!.query(`insert into album_photos(id,wedding_id,url,approved)
        values($1,$3,'https://example.invalid/sc015-approved.jpg',true),($2,$3,'https://example.invalid/sc015-pending.jpg',false)`,
      [approved, pending, weddingId])
      const album = await app.inject({ url: guest.path })
      expect(album.statusCode, album.body).toBe(200)
      expect(album.json().photos.map((item: { id: string }) => item.id)).toEqual([approved])
      for (const privateId of [pending, pdf, image]) expect(album.body).not.toContain(privateId)
      expect((await app.inject({ url: `${path}/files/${image}/content?guestToken=${guest.token}` })).statusCode).toBe(401)
      expect((await app.inject(command(outsider, 'GET', content))).statusCode).toBe(404)
      expect((await app.inject(command(vendor, 'DELETE', `${path}/files/${pdf}`))).statusCode).toBe(409)
      expect((await mutate(vendor, `${path}/files`, grantInput)).statusCode).toBe(409)
      await app.db!.query("update media_uploads set ready_at=clock_timestamp()-interval '2 days' where id=any($1::uuid[])", [[pdf,abandoned]])
      const keys = (await app.db!.query<{ id: string; clean_key: string }>('select id,clean_key from media_uploads where id=any($1::uuid[])', [[pdf,abandoned]])).rows
      await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second' where key=any($1::text[])", [keys.map(row => row.clean_key)])
      await app.managedMedia!.collect()
      expect(provider.objects.has(keys.find(row => row.id === pdf)!.clean_key)).toBe(true)
      expect(provider.objects.has(keys.find(row => row.id === abandoned)!.clean_key)).toBe(false)
      expect((await app.db!.query('select state from media_uploads where id=$1', [abandoned])).rows[0]!.state).toBe('deleted')
      expect((await mutate(couple, path, { kind: 'accepted', expectedRevision: 1 })).statusCode).toBe(200)
      expect((await app.inject(command(couple, 'GET', content))).statusCode).toBe(200)
    } finally { await app.db!.query('delete from weddings where id=$1', [weddingId]) }
  })

  it('uses actual signed HTTP POST and scanner then immutable WebP; retry after ready is the same asset', async () => {
    const actor = await owner(), { grant, ready } = await photo(actor)
    expect(ready.state).toBe('ready'); expect(ready.width).toBe(12); expect(ready.height).toBe(9)
    const row = (await app.db!.query<{ clean_key: string }>('select clean_key from media_uploads where id=$1', [grant.uploadId])).rows[0]!
    const clean = provider.objects.get(row.clean_key)!
    expect((await sharp(clean).metadata()).format).toBe('webp')
    expect(await post(grant, Buffer.alloc(png.length, 1))).toBe(204)
    expect(provider.objects.get(row.clean_key)).toEqual(clean)
    const again = await complete(actor, grant.uploadId)
    expect(again.statusCode).toBe(200); expect(again.json()).toEqual(ready)
    expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(1)
  })
  it('the synthetic provider enforces exact bytes, MIME, key, signature and actual expiry of the SDK policy', async () => {
    const actor = await owner(), grant = await issue(actor)
    expect(await post(grant, Buffer.concat([png, Buffer.from([1])]))).toBe(403)
    expect(await post(grant, png, { ...grant.fields, key: `quarantine/${randomUUID()}/original` })).toBe(403)
    expect(await post(grant, png, { ...grant.fields, 'Content-Type': 'image/jpeg' })).toBe(403)
    expect(await post(grant, png, { ...grant.fields, 'X-Amz-Signature': '0'.repeat(64) })).toBe(403)
    expect(await post(grant)).toBe(204)
    const store = new S3MediaStore(provider.config)
    try {
      // This isolated short capability has no DB intent; no early DB clock rewrites.
      const short = await store.grant(`quarantine/${randomUUID()}/original`, 'image/png', png.length, 1)
      const expiration = Date.parse(JSON.parse(Buffer.from(short.fields.Policy!, 'base64').toString()).expiration)
      await waitFor(async () => Date.now() > expiration + 30)
      expect(await post({ ...grant, uploadUrl: short.url, fields: short.fields })).toBe(403)
    } finally { store.close() }
  })
  it('serializes the last quota slot against simultaneous intents and counts legacy photos', async () => {
    const actor = await owner()
    for (let i = 0; i < 4; i++) await app.db!.query("insert into vendor_media(id,vendor_id,kind,url,sort) values($1,$2,'photo',$3,$4)", [randomUUID(), actor.vendor, `https://external.example/${i}.jpg`, i])
    const attempt = () => app.inject({ ...command(actor, 'POST', '/media/upload-url'), headers: { authorization: actor.authorization, 'idempotency-key': randomUUID() }, payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: png.length } })
    const results = await Promise.all([attempt(), attempt()])
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409])
    expect((await app.db!.query('select id from media_uploads where vendor_id=$1', [actor.vendor])).rowCount).toBe(1)
  })
  it('does not release live grants when deleted or failed and retains the original deadline on retry', async () => {
    const actor = await owner(), first = await issue(actor), key = randomUUID(), same = await issue(actor, png, key)
    const before = (await app.db!.query('select expires_at from media_uploads where id=$1', [same.uploadId])).rows[0]!
    const retry = await issue(actor, png, key)
    expect(retry.uploadId).toBe(same.uploadId)
    expect((await app.db!.query('select expires_at from media_uploads where id=$1', [same.uploadId])).rows[0]).toEqual(before)
    await issue(actor); await issue(actor); await issue(actor)
    expect((await app.inject(command(actor, 'DELETE', `/media/uploads/${first.uploadId}`))).json().deletion).toBe('queued')
    await app.db!.query("update media_uploads set state='failed',error_code='media_invalid_photo' where id=$1", [same.uploadId])
    const sixth = await app.inject({ ...command(actor, 'POST', '/media/upload-url'), headers: { authorization: actor.authorization, 'idempotency-key': randomUUID() }, payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: png.length } })
    expect(sixth.statusCode).toBe(409); expect(sixth.json().error.code).toBe('media_photo_limit')
  })
  it('rejects current owner without media rights and actual resource-manager access to another company', async () => {
    const noRights = await owner(false)
    expect((await app.inject({ ...command(noRights, 'POST', '/media/upload-url'), headers: { authorization: noRights.authorization, 'idempotency-key': randomUUID() }, payload: { kind: 'vendor_photo', contentType: 'image/png', sizeBytes: png.length } })).statusCode).toBe(403)
    const actor = await owner(), manager = await owner(true, false), grant = await issue(actor)
    const principal = { userId: actor.id, sessionId: actor.session, policyVersion: POLICY }
    const invite = await app.db!.tx(q => inviteStaff(q, { vendorId: actor.vendor, actor: principal, role: 'resource_manager', targetUserId: manager.id }))
    await app.db!.tx(q => acceptStaffInvite(q, { token: invite.token, actor: { userId: manager.id, sessionId: manager.session, policyVersion: POLICY } }))
    expect((await app.inject(command(manager, 'GET', `/media/uploads/${grant.uploadId}`))).statusCode).toBe(403)
    expect((await complete(manager, grant.uploadId)).statusCode).toBe(403)
  })
  it.each(['rights', 'consent', 'session', 'blocked', 'deleted'] as const)('rechecks %s after actual scanner wait before publishing', async change => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    provider.controls.beforeScan = async () => {
      if (change === 'rights') await app.db!.query('update vendors set media_rights_at=null where id=$1', [actor.vendor])
      if (change === 'consent') await app.db!.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1', [actor.id])
      if (change === 'session') await app.db!.query('update sessions set revoked_at=clock_timestamp() where id=$1', [actor.session])
      if (change === 'blocked') await app.db!.query('update vendors set blocked_at=clock_timestamp() where id=$1', [actor.vendor])
      if (change === 'deleted') await app.db!.query('update users set deleted_at=clock_timestamp() where id=$1', [actor.id])
    }
    const response = await complete(actor, grant.uploadId)
    expect([401, 403]).toContain(response.statusCode)
    expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(0)
    expect(provider.events.filter(e => e.method === 'PUT' && e.key.startsWith(`clean/${grant.uploadId}/`))).toHaveLength(0)
  })
  it.each(['malware', 'signature', 'truncated'] as const)('never publishes %s input and keeps cleanup obligations', async kind => {
    const actor = await owner(), grant = await issue(actor)
    expect(await post(grant)).toBe(204)
    if (kind === 'malware') provider.controls.infected = true
    if (kind === 'signature') provider.objects.set(grant.fields.key!, Buffer.alloc(png.length, 1))
    if (kind === 'truncated') provider.objects.set(grant.fields.key!, png.subarray(0, png.length - 1))
    const result = await complete(actor, grant.uploadId)
    expect(result.statusCode).toBe(422)
    expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(0)
    expect((await app.db!.query('select key from media_objects where key=$1', [grant.fields.key])).rowCount).toBe(1)
  })
  it('keeps managed IDs through profile PUT and preserves external URLs with the same pathname', async () => {
    const actor = await owner(), { grant, ready } = await photo(actor)
    const before = (await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rows[0]!.id
    const city = (await app.db!.query<{ name: string; region: string }>('select name,region from cities where id=$1', [cityId])).rows[0]!
    const request = { method: 'PUT' as const, url: '/vendor/profile', headers: { authorization: actor.authorization }, payload: {
      name: 'Synthetic media profile', categoryId: 'photo', city, media: [{ kind: 'photo', url: ready.fileUrl }, { kind: 'photo', url: 'https://external.example/media/photos/abc' }] } }
    const saved = await app.inject(request)
    expect(saved.statusCode, saved.body).toBe(200)
    expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rows[0]!.id).toBe(before)
    expect((await app.db!.query('select photo_url from vendors where id=$1', [actor.vendor])).rows[0]!.photo_url).toBe(ready.fileUrl)
    const foreign = await owner(), other = await photo(foreign)
    const bad = await app.inject({ ...request, payload: { ...request.payload, media: [{ kind: 'photo', url: other.ready.fileUrl }] } })
    expect(bad.statusCode).toBe(422)
    expect((await app.inject(command(actor, 'DELETE', `/media/uploads/${grant.uploadId}`))).json().deletion).toBe('queued')
    expect((await app.inject(request)).statusCode).toBe(422)
    expect((await app.db!.query('select photo_url from vendors where id=$1', [actor.vendor])).rows[0]!.photo_url).toBe('https://external.example/media/photos/abc')
  })
  it('DB rejects cross-company links and cross-asset keys even through raw SQL', async () => {
    const actor = await owner(), other = await owner(), { grant } = await photo(actor)
    await expect(app.db!.query('update vendor_media set vendor_id=$2 where media_upload_id=$1', [grant.uploadId, other.vendor])).rejects.toMatchObject({ code: '23514', constraint: 'vendor_media_managed_link_032' })
    const unknown = `quarantine/${randomUUID()}/original`
    const deadline = new Date(Date.now() + 3_600_000)
    await app.db!.query("insert into media_objects(key,storage_id,not_before,write_phase,external_until) values($1,$2,$3,'external',$3)", [unknown, mediaStorageIdentity(provider.config), deadline])
    await expect(app.db!.query('update media_uploads set quarantine_key=$2 where id=$1', [grant.uploadId, unknown])).rejects.toMatchObject({ code: '23514', constraint: 'media_upload_key_identity' })
    const fk = (await app.db!.query<{ definition: string }>("select pg_get_constraintdef(oid) definition from pg_constraint where conname='vendor_media_managed_company'")).rows[0]!
    expect(fk.definition).toContain('FOREIGN KEY (media_upload_id, vendor_id)')
  })
  it('an old delete-all/reinsert writer cannot turn a managed URL into an unlinked legacy row', async () => {
    const actor = await owner(), { grant, ready } = await photo(actor)
    const original = (await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rows[0]!.id
    await expect(app.db!.tx(async q => {
      await q.query('delete from vendor_media where vendor_id=$1', [actor.vendor])
      await q.query("insert into vendor_media(id,vendor_id,kind,url,sort) values($1,$2,'photo',$3,0)", [randomUUID(), actor.vendor, ready.fileUrl])
    })).rejects.toMatchObject({ code: '23514', constraint: 'vendor_media_managed_link_032' })
    expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rows[0]!.id).toBe(original)
    expect((await app.db!.query('select state from media_uploads where id=$1', [grant.uploadId])).rows[0]!.state).toBe('ready')
  })
  it('checks owner/public visibility again after actual clean-object delivery wait; never sends raw bytes', async () => {
    const actor = await owner(), { grant, ready } = await photo(actor), path = `/media/photos/${grant.uploadId}`
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404)
    const preview = await app.inject(command(actor, 'GET', path))
    expect(preview.statusCode).toBe(200); expect(preview.headers['content-type']).toContain('image/webp')
    expect(preview.headers['cache-control']).toBe('private, no-store'); expect(preview.headers['x-content-type-options']).toBe('nosniff')
    await app.db!.query('update vendors set published_at=clock_timestamp() where id=$1', [actor.vendor])
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(200)
    provider.controls.beforeRead = async key => { if (key.startsWith('clean/')) await app.db!.query('update vendors set published_at=null where id=$1', [actor.vendor]) }
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404)
    const status = await app.inject(command(actor, 'GET', `/media/uploads/${grant.uploadId}`))
    expect(status.json().fileUrl).toBe(ready.fileUrl)
    expect(status.body).not.toContain('quarantine/'); expect(status.body).not.toContain('clean/'); expect(status.body).not.toContain('X-Amz-')
  })
  it('a lost COMMIT acknowledgement leaves the already-ready object intact and retry replays it', async () => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    const original = app.db!.tx.bind(app.db!)
    let lost = false
    const mock = vi.spyOn(app.db!, 'tx').mockImplementation(async work => {
      const result = await original(work)
      if (!lost && typeof result === 'object' && result !== null && 'state' in result && result.state === 'ready') {
        lost = true; throw new Error('Synthetic COMMIT acknowledgement loss AFTER real commit')
      }
      return result
    })
    const first = await complete(actor, grant.uploadId)
    expect(first.statusCode).toBe(500); expect(lost).toBe(true); mock.mockRestore()
    expect((await app.db!.query('select state from media_uploads where id=$1', [grant.uploadId])).rows[0]!.state).toBe('ready')
    const retry = await complete(actor, grant.uploadId)
    expect(retry.statusCode).toBe(200); expect(retry.json().state).toBe('ready')
    expect(provider.events.filter(e => e.method === 'DELETE' && e.key.includes(grant.uploadId))).toHaveLength(0)
  })
  it('bounds clean candidates to three even when PUT replies and DELETE are unavailable', async () => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    provider.controls.putResponseLoss = provider.controls.deleteFailure = true
    const orphan = `clean/${randomUUID()}/${randomUUID()}.webp`
    await app.db!.query("insert into media_objects(key,storage_id,not_before) values($1,$2,clock_timestamp()-interval '1 second')", [orphan, mediaStorageIdentity(provider.config)])
    provider.objects.set(orphan, Buffer.from('Synthetic orphan, no upload grant ever issued'))
    expect((await app.managedMedia!.collect()).failed).toBeGreaterThan(0)
    expect(provider.events.some(e => e.method === 'DELETE' && e.key === orphan)).toBe(true)
    for (let i = 0; i < 3; i++) expect((await complete(actor, grant.uploadId)).statusCode).toBe(503)
    expect((await complete(actor, grant.uploadId)).statusCode).toBe(409)
    const keys = (await app.db!.query<{ key: string }>("select key from media_objects where key like $1", [`clean/${grant.uploadId}/%`])).rows
    expect(keys).toHaveLength(3); expect(new Set(keys.map(r => r.key)).size).toBe(3)
  })
  it('real export excludes storage grants/keys and actual eraseUser cascade preserves deletion obligations', async () => {
    const actor = await owner(), { grant } = await photo(actor)
    const result = await app.inject(command(actor, 'GET', '/users/me/export'))
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().managedMedia.some((m: { uploadId: string }) => m.uploadId === grant.uploadId)).toBe(true)
    expect(result.body).not.toContain('quarantine/'); expect(result.body).not.toContain('clean/'); expect(result.body).not.toContain('X-Amz-')
    const before = (await app.db!.query('select key from media_objects where key=$1 or key like $2 order by key', [grant.fields.key, `clean/${grant.uploadId}/%`])).rows
    await app.db!.tx(q => eraseUser(q, actor.id))
    expect((await app.db!.query('select id from media_uploads where id=$1', [grant.uploadId])).rowCount).toBe(0)
    expect((await app.db!.query('select key from media_objects where key=$1 or key like $2 order by key', [grant.fields.key, `clean/${grant.uploadId}/%`])).rows).toEqual(before)
    expect((await app.inject(command(actor, 'GET', `/media/photos/${grant.uploadId}`))).statusCode).toBe(401)
  })
  it('concurrent complete reports an actual processing state then replays one ready photo', async () => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    let entered = false, release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    provider.controls.beforeScan = () => { entered = true; return barrier }
    const first = complete(actor, grant.uploadId)
    try {
      await waitFor(async () => entered)
      const concurrent = await complete(actor, grant.uploadId)
      expect(concurrent.statusCode).toBe(202); expect(concurrent.json().state).toBe('processing')
    } finally { release() }
    expect((await first).statusCode).toBe(200)
    expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(1)
  })
  it('delete during scanner wait fences the older worker and keeps capability debt queued', async () => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    provider.controls.beforeScan = async () => {
      const deleted = await app.inject(command(actor, 'DELETE', `/media/uploads/${grant.uploadId}`))
      expect(deleted.statusCode).toBe(200); expect(deleted.json().deletion).toBe('queued')
    }
    const old = await complete(actor, grant.uploadId)
    expect(old.statusCode).toBe(409)
    expect((await app.db!.query('select state from media_uploads where id=$1', [grant.uploadId])).rows[0]!.state).toBe('deleted')
    expect(provider.events.filter(e => e.method === 'PUT' && e.key.includes(grant.uploadId))).toHaveLength(0)
  })
  it('current JWT expiry after scanner await denies publication even with pinned DB identity', async () => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    const token = await signAccessToken(SECRET, { sub: actor.id, sid: actor.session }, Date.now() - 897_000)
    const expires = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp * 1000
    provider.controls.beforeScan = () => waitFor(async () => Date.now() >= expires + 30)
    const response = await complete({ ...actor, authorization: 'Bearer ' + token }, grant.uploadId)
    expect(response.statusCode).toBe(401)
    expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(0)
  })
  it.each(['beforePut', 'finalize'] as const)('fresh lease check after actual object-lock wait: %s', async phase => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    const holder = new pg.Client({ connectionString: DB! }); await holder.connect()
    let entered = false, held = false
    const hook = async () => {
      await app.db!.query("update media_uploads set lease_until=clock_timestamp()+interval '1 second' where id=$1", [grant.uploadId])
      const key = (await app.db!.query<{ clean_key: string }>('select clean_key from media_uploads where id=$1', [grant.uploadId])).rows[0]!.clean_key
      await holder.query('begin'); held = true
      await holder.query('select key from media_objects where key=$1 for update', [key]); entered = true
    }
    if (phase === 'beforePut') provider.controls.beforeScan = hook
    else {
      const original = app.db!.query.bind(app.db!)
      vi.spyOn(app.db!, 'query').mockImplementation(async <T extends pg.QueryResultRow>(text: string, values?: readonly unknown[]) => {
        const result = await original<T>(text, values)
        if (text.includes('update media_objects') && text.includes('where key=$1 and writer_nonce=$2') && values?.[2] === 'settled') await hook()
        return result
      })
    }
    const pending = complete(actor, grant.uploadId)
    try {
      await waitFor(async () => entered)
      const pid = (await holder.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await waitFor(async () => (await app.db!.query('select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount! > 0)
      await waitFor(async () => (await app.db!.query<{ expired: boolean }>('select lease_until<clock_timestamp() expired from media_uploads where id=$1', [grant.uploadId])).rows[0]!.expired)
      await holder.query('commit'); held = false
      const result = await pending
      expect(result.statusCode).toBe(409)
      expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(0)
      expect((await app.db!.query('select state from media_uploads where id=$1', [grant.uploadId])).rows[0]!.state).toBe('failed')
      const writes = provider.events.filter(e => e.method === 'PUT' && e.key.startsWith(`clean/${grant.uploadId}/`))
      expect(writes).toHaveLength(phase === 'beforePut' ? 0 : 1)
      process.stdout.write(`MEDIA_LEASE_BARRIER ${JSON.stringify({ phase, holder: pid, actualWaitObserved: true, response: result.statusCode })}\n`)
    } finally {
      if (held) await holder.query('rollback')
      await holder.end(); await pending
    }
  })
  it('GC keeps active ready/current-lease objects and actually deletes an unreferenced synthetic orphan', async () => {
    const actor = await owner(), { grant } = await photo(actor)
    const active = (await app.db!.query<{ clean_key: string }>('select clean_key from media_uploads where id=$1', [grant.uploadId])).rows[0]!.clean_key
    await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second' where key=$1", [active])
    const orphan = `clean/${randomUUID()}/${randomUUID()}.webp`
    provider.objects.set(orphan, Buffer.from('Synthetic orphan without any issued capability'))
    await app.db!.query("insert into media_objects(key,storage_id,not_before) values($1,$2,clock_timestamp()-interval '1 second')", [orphan, mediaStorageIdentity(provider.config)])
    await app.managedMedia!.collect()
    expect(provider.objects.has(active)).toBe(true); expect(provider.objects.has(orphan)).toBe(false)
    expect((await app.db!.query('select state from media_objects where key=$1', [orphan])).rows[0]!.state).toBe('done')
    const next = await issue(actor); expect(await post(next)).toBe(204)
    provider.controls.beforePut = async key => {
      await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second' where key=$1", [key])
      await app.managedMedia!.collect()
      expect(provider.events.some(e => e.method === 'DELETE' && e.key === key)).toBe(false)
    }
    expect((await complete(actor, next.uploadId)).statusCode).toBe(200)
  })
  it('a slow POST body started before expiry is refused after expiry without creating an object', async () => {
    const store = new S3MediaStore(provider.config), key = `quarantine/${randomUUID()}/original`
    try {
      const grant = await store.grant(key, 'image/png', png.length, 1)
      const expires = Date.parse(JSON.parse(Buffer.from(grant.fields.Policy!, 'base64').toString()).expiration)
      const boundary = 'synthetic-' + randomUUID(), chunks: Buffer[] = []
      for (const [name, value] of Object.entries(grant.fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`))
      const body = Buffer.concat(chunks)
      let request!: ReturnType<typeof httpRequest>
      const reply = new Promise<number>((resolve, reject) => {
        request = httpRequest(grant.url, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length } }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode!)); response.once('error', reject)
        })
        request.once('error', reject)
        request.setTimeout(5000, () => request.destroy(new Error('Synthetic POST absolute test deadline')))
      })
      try {
        request.write(body.subarray(0, body.length - 1))
        await waitFor(async () => Date.now() > expires + 30)
        request.end(body.subarray(body.length - 1))
        expect(await reply).toBe(403); expect(provider.objects.has(key)).toBe(false)
      } finally { request.destroy() }
    } finally { store.close() }
  })
  it('a full POST held before commit rechecks expiry and cannot leave a late quarantine write', async () => {
    const actor = await owner(), template = await issue(actor), store = new S3MediaStore(provider.config)
    let release!: () => void, entered = false
    const barrier = new Promise<void>(resolve => { release = resolve })
    provider.controls.beforePostCommit = () => { entered = true; return barrier }
    try {
      const key = `quarantine/${randomUUID()}/original`, grant = await store.grant(key, 'image/png', png.length, 1)
      const expires = Date.parse(JSON.parse(Buffer.from(grant.fields.Policy!, 'base64').toString()).expiration)
      const pending = post({ ...template, uploadUrl: grant.url, fields: grant.fields })
      try { await waitFor(async () => entered); await waitFor(async () => Date.now() > expires + 30) }
      finally { release() }
      expect(await pending).toBe(403); expect(provider.objects.has(key)).toBe(false)
    } finally { release(); store.close() }
  })
  it.each(['ack-before-write', 'ack-after-write'] as const)('GC never loses a paused inflight writer: %s', async order => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    let releasePut!: () => void, releaseDelete!: () => void, key = '', deleted = false
    const putBarrier = new Promise<void>(resolve => { releasePut = resolve })
    const deleteBarrier = new Promise<void>(resolve => { releaseDelete = resolve })
    provider.controls.beforePut = async candidate => { key = candidate; await putBarrier }
    if (order === 'ack-after-write') provider.controls.afterDelete = async candidate => { if (candidate === key) { deleted = true; await deleteBarrier } }
    const pending = complete(actor, grant.uploadId)
    try {
      await waitFor(async () => !!key)
      expect((await app.db!.query('select write_phase from media_objects where key=$1', [key])).rows[0]!.write_phase).toBe('inflight')
      // Only the clean candidate's synthetic deadlines are advanced. No live
      // external POST deadline is shortened or treated as expired here.
      await app.db!.query("update media_uploads set lease_until=clock_timestamp()-interval '1 second' where id=$1", [grant.uploadId])
      await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second',obligation_version=obligation_version+1 where key=$1", [key])
      const collection = app.managedMedia!.collect()
      if (order === 'ack-after-write') await waitFor(async () => deleted)
      else {
        await collection
        expect((await app.db!.query('select state from media_objects where key=$1', [key])).rows[0]!.state).not.toBe('done')
      }
      releasePut()
      expect((await pending).statusCode).toBe(409)
      releaseDelete(); await collection
      const row = (await app.db!.query('select state,write_phase from media_objects where key=$1', [key])).rows[0]!
      expect(row).toMatchObject({ state: 'pending', write_phase: 'settled' })
      expect(provider.objects.has(key)).toBe(true)
      expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(0)
      provider.controls.afterDelete = null
      await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second' where key=$1", [key])
      await app.managedMedia!.collect()
      expect(provider.objects.has(key)).toBe(false)
      expect((await app.db!.query('select state from media_objects where key=$1', [key])).rows[0]!.state).toBe('done')
    } finally { releasePut(); releaseDelete(); await pending }
  })
  it('unknown remote PUT stays tracked after eight DELETE ACKs and an actual late provider commit', async () => {
    const actor = await owner(), grant = await issue(actor); expect(await post(grant)).toBe(204)
    let release!: () => void, key = ''
    const barrier = new Promise<void>(resolve => { release = resolve })
    provider.controls.beforePut = async candidate => { key = candidate; await barrier }
    const pending = complete(actor, grant.uploadId)
    try {
      await waitFor(async () => !!key)
      // Exercise the real 15-second SDK deadline, not a mocked rejected store.
      expect((await pending).statusCode).toBe(503)
      expect((await app.db!.query('select write_phase from media_objects where key=$1', [key])).rows[0]!.write_phase).toBe('uncertain')
      for (let attempt = 0; attempt < 8; attempt++) {
        await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second' where key=$1", [key])
        await app.managedMedia!.collect()
      }
      const beforeLate = (await app.db!.query('select state,attempts from media_objects where key=$1', [key])).rows[0]!
      expect(beforeLate).toMatchObject({ state: 'failed', attempts: 8 })
      release(); await waitFor(async () => provider.objects.has(key))
      expect((await app.db!.query('select state,write_phase from media_objects where key=$1', [key])).rows[0]).toMatchObject({ state: 'failed', write_phase: 'uncertain' })
      expect((await app.db!.query('select id from vendor_media where media_upload_id=$1', [grant.uploadId])).rowCount).toBe(0)
      expect(provider.events.filter(e => e.method === 'PUT' && e.key === key)).toHaveLength(1)
      expect(provider.events.filter(e => e.method === 'DELETE' && e.key === key)).toHaveLength(8)
    } finally { release(); await pending }
  }, 35_000)
  it('a different storage namespace neither serves nor cleans old bucket obligations', async () => {
    const actor = await owner(), { grant } = await photo(actor)
    const key = (await app.db!.query('select clean_key from media_uploads where id=$1', [grant.uploadId])).rows[0]!.clean_key
    await app.db!.query("update media_objects set not_before=clock_timestamp()-interval '1 second' where key=$1", [key])
    const other = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'synthetic-managed-media-refresh'.repeat(3), policyVersion: POLICY,
      mediaStorage: { ...provider.config, bucket: 'another-private-bucket' } })
    try {
      await other.ready()
      expect((await other.inject(command(actor, 'GET', `/media/photos/${grant.uploadId}`))).statusCode).toBe(503)
      await other.managedMedia!.collect()
      expect(provider.objects.has(key)).toBe(true)
      expect(provider.events.some(e => e.method === 'DELETE' && e.key === key)).toBe(false)
    } finally { await other.close() }
  })
  it('same-length corrupted stored bytes never leave the verified-photo endpoint', async () => {
    const actor = await owner(), { grant } = await photo(actor)
    const key = (await app.db!.query('select clean_key from media_uploads where id=$1', [grant.uploadId])).rows[0]!.clean_key
    const original = provider.objects.get(key)!
    provider.objects.set(key, Buffer.alloc(original.length, 1))
    expect((await app.inject(command(actor, 'GET', `/media/photos/${grant.uploadId}`))).statusCode).toBe(503)
  })
  it('DB refuses missing processing candidates, partial nonce/lease pairs and a writer of another key', async () => {
    const actor = await owner(), pending = await issue(actor)
    await expect(app.db!.query("update media_uploads set state='processing',nonce=$2,lease_until=clock_timestamp()+interval '1 minute',clean_key=null where id=$1", [pending.uploadId, randomUUID()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'media_upload_candidate_identity' })
    await expect(app.db!.query('update media_uploads set nonce=$2 where id=$1', [pending.uploadId, randomUUID()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'media_upload_claim' })
    await expect(app.db!.query("update media_uploads set lease_until=clock_timestamp()+interval '1 minute' where id=$1", [pending.uploadId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'media_upload_claim' })
    await expect(app.db!.query('update media_objects set nonce=$2 where key=$1', [pending.fields.key, randomUUID()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'media_object_claim' })
    await expect(app.db!.query("update media_objects set lease_until=clock_timestamp()+interval '1 minute' where key=$1", [pending.fields.key]))
      .rejects.toMatchObject({ code: '23514', constraint: 'media_object_claim' })
    const { grant } = await photo(actor)
    const key = (await app.db!.query('select clean_key from media_uploads where id=$1', [grant.uploadId])).rows[0]!.clean_key
    await expect(app.db!.query('update media_objects set writer_nonce=$2 where key=$1', [key, randomUUID()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'media_object_writer_key' })
    expect((await app.db!.query('select state from media_uploads where id=$1', [grant.uploadId])).rows[0]!.state).toBe('ready')
  })
  it('bounds buffered deliveries and releases capacity after all actual reads finish', async () => {
    const actor = await owner(), { grant } = await photo(actor)
    let reads = 0, release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    provider.controls.beforeRead = async key => { if (key.startsWith('clean/')) { reads++; await barrier } }
    const ongoing = Array.from({ length: 8 }, () => app.inject(command(actor, 'GET', `/media/photos/${grant.uploadId}`)))
    try {
      await waitFor(async () => reads === 8)
      const ninth = await app.inject(command(actor, 'GET', `/media/photos/${grant.uploadId}`))
      expect(ninth.statusCode).toBe(503); expect(reads).toBe(8)
    } finally { release() }
    expect((await Promise.all(ongoing)).every(r => r.statusCode === 200)).toBe(true)
    provider.controls.beforeRead = null
    expect((await app.inject(command(actor, 'GET', `/media/photos/${grant.uploadId}`))).statusCode).toBe(200)
  })
  it('holds eight real HTTP payloads until finish or disconnect and measures Linux native socket backpressure', async () => {
    const actor = await owner(), { grant } = await photo(actor), path = `/media/photos/${grant.uploadId}`
    const key = (await app.db!.query('select clean_key from media_uploads where id=$1', [grant.uploadId])).rows[0]!.clean_key
    const large = await sharp(randomBytes(1536 * 1536 * 3), { raw: { width: 1536, height: 1536, channels: 3 } }).webp({ lossless: true }).toBuffer()
    expect(large.length).toBeGreaterThan(6 * 1024 * 1024)
    provider.objects.set(key, large)
    await app.db!.query('update media_uploads set output_bytes=$2,sha256=$3 where id=$1', [grant.uploadId, large.length, createHash('sha256').update(large).digest('hex')])
    const wireApp = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'synthetic-managed-media-refresh'.repeat(3), policyVersion: POLICY, mediaStorage: provider.config })
    const waiting = new Map<ServerResponse, () => void>(), clients: Socket[] = [], responses: ServerResponse[] = []
    let hold = true, closed = 0
    const probeHeaders = { authorization: actor.authorization, 'x-media-lifetime-probe': '1' }
    wireApp.addHook('onSend', async (request, reply, payload) => {
      if (hold && request.url === path && reply.statusCode === 200
        && (!request.headers['x-media-lifetime-probe'] || request.headers['x-media-lifetime-probe'] === 'hold-one')) {
        expect(Buffer.isBuffer(payload)).toBe(true); expect((payload as Buffer).equals(large)).toBe(true)
        let retire!: () => void
        const barrier = new Promise<void>(resolve => { retire = resolve })
        waiting.set(reply.raw, retire); reply.raw.once('close', retire)
        try { await barrier } finally { waiting.delete(reply.raw); reply.raw.off('close', retire) }
      }
      return payload
    })
    await wireApp.ready()
    const observe = (request: IncomingMessage, response: ServerResponse) => {
      if (request.url !== path || request.headers['x-media-lifetime-probe']) return
      responses.push(response); response.once('close', () => { closed++ })
    }
    wireApp.server.on('request', observe)
    const wire = await mediaFixture(wireApp.server)
    const probe = () => wireApp.inject({ method: 'GET', url: path, headers: probeHeaders })
    let replacement: Promise<{ statusCode: number }> | undefined
    async function connect() {
      const socket = createConnection({ host: '127.0.0.1', port: wire.port })
      clients.push(socket); socket.on('error', () => undefined); socket.pause()
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${actor.authorization}\r\nConnection: close\r\n\r\n`)
    }
    try {
      const positive = await fetch(wire.url + path, { headers: probeHeaders })
      expect(positive.status).toBe(200); expect(positive.headers.get('content-type')).toContain('image/webp')
      expect(Buffer.from(await positive.arrayBuffer()).equals(large)).toBe(true)
      for (let i = 0; i < 8; i++) await connect()
      await waitFor(async () => waiting.size === 8)
      expect(responses).toHaveLength(8); expect(responses.every(r => !r.writableFinished)).toBe(true)
      expect((await probe()).statusCode).toBe(503)
      clients[0]!.destroy()
      await waitFor(async () => closed === 1 && waiting.size === 7)
      // Hold the replacement response explicitly: scheduler overlap between
      // two quick probes would not prove that exactly one slot was released.
      replacement = wireApp.inject({ method: 'GET', url: path,
        headers: { ...probeHeaders, 'x-media-lifetime-probe': 'hold-one' } }).then(result => result)
      void replacement.catch(() => undefined)
      await waitFor(async () => waiting.size === 8)
      expect((await probe()).statusCode).toBe(503)
      const replacementResponse = [...waiting.keys()].filter(response => !responses.includes(response))
      expect(replacementResponse).toHaveLength(1)
      waiting.get(replacementResponse[0]!)!()
      expect((await replacement).statusCode).toBe(200)
      expect((await probe()).statusCode).toBe(200)
      hold = false
      for (const retire of waiting.values()) retire()
      for (const socket of clients.slice(1)) { socket.on('data', () => undefined); socket.resume() }
      await waitFor(async () => closed === 8 && responses.slice(1).every(r => r.writableFinished))
      expect((await probe()).statusCode).toBe(200)
      process.stdout.write('MEDIA_DELIVERY_HTTP_LIFETIME ' + JSON.stringify({ heldRealPayloads: 8,
        bytesPerResponse: large.length, ninthStatus: 503, afterOneDisconnect: [200, 503], afterFinish: 200 }) + '\n')
      if (process.platform === 'linux') {
        // Linux CI also requires genuine socket backpressure. Windows loopback
        // can finish all WSASend writes despite a paused reader; that measured
        // behavior is not evidence of a queued-response barrier.
        for (const socket of clients) socket.destroy()
        clients.length = 0; responses.length = 0; closed = 0
        for (let i = 0; i < 8; i++) await connect()
        await waitFor(async () => responses.length === 8 && responses.every(r => r.writableLength > 0 && !r.writableFinished), 10_000)
        expect((await probe()).statusCode).toBe(503)
        process.stdout.write('MEDIA_DELIVERY_LINUX_BACKPRESSURE ' + JSON.stringify({ clients: 8,
          queuedBytes: responses.map(r => r.writableLength), ninthStatus: 503 }) + '\n')
        for (const socket of clients) socket.destroy()
        await waitFor(async () => closed === 8)
        expect((await probe()).statusCode).toBe(200)
      }
      const failed = await wireApp.inject({ method: 'GET', url: path, headers: { ...probeHeaders, authorization: 'Bearer invalid' } })
      expect(failed.statusCode).toBe(401); expect((await probe()).statusCode).toBe(200)
    } finally {
      hold = false
      for (const retire of waiting.values()) retire()
      await replacement?.catch(() => undefined)
      for (const socket of clients) socket.destroy()
      wireApp.server.off('request', observe)
      try { await wire.close() } finally { await wireApp.close() }
      expect(waiting.size).toBe(0)
    }
  }, 30_000)

})
