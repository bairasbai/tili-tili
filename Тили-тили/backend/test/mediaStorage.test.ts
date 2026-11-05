import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type RequestListener } from 'node:http'
import { createHash } from 'node:crypto'
import { S3MediaStore, PHOTO_MAX_BYTES } from '../src/media/storage.js'
import { mediaFixture } from './helpers/mediaTransportFixture.js'

const id = '019a5154-1212-7123-8123-121212121212'
const raw = `quarantine/${id}/original`, clean = `clean/${id}/${id}.webp`
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function store(endpoint: string, timeoutMs = 2000) {
  const storage = new S3MediaStore({ endpoint, region: 'test-1', bucket: 'private-media', accessKey: 'synthetic-access',
    secretKey: 'synthetic-secret', deliveryBaseUrl: 'https://app.example.test/api', scannerHost: '127.0.0.1', scannerPort: 19310 }, timeoutMs)
  cleanups.push(() => storage.close())
  return storage
}
async function fixture(handler: RequestListener) {
  const server = createServer(handler)
  const running = await mediaFixture(server)
  cleanups.push(() => running.close())
  return running
}

describe('private S3 transport over real HTTP with synthetic credentials', () => {
  it('signs an exact quarantine POST policy with bounded expiry; no request is sent', async () => {
    const grant = await store('http://127.0.0.1:1').grant(raw, 'image/png', 1234, 120)
    expect(grant.url).toBe('http://127.0.0.1:1/private-media')
    const policy = JSON.parse(Buffer.from(grant.fields.Policy!, 'base64').toString('utf8'))
    expect(policy.conditions).toContainEqual(['content-length-range', 1234, 1234])
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/png'])
    expect(policy.conditions).toContainEqual({ key: raw })
    expect(policy.conditions).toContainEqual({ bucket: 'private-media' })
    expect(grant.fields.key).toBe(raw)
    expect(grant.fields['X-Amz-Signature']).toMatch(/^[a-f0-9]{64}$/)
    expect(Date.parse(policy.expiration) - Date.now()).toBeGreaterThan(115_000)
    expect(Date.parse(policy.expiration) - Date.now()).toBeLessThanOrEqual(120_000)
  })
  it.each([0, -1, 1.2, PHOTO_MAX_BYTES + 1, NaN])('refuses an invalid claimed size %s before signing', async size => {
    await expect(store('http://127.0.0.1:1').grant(raw, 'image/png', size, 60)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('refuses public/unknown keys, clean POSTs, non-raster types and excessive expiry', async () => {
    const s3 = store('http://127.0.0.1:1')
    await expect(s3.grant('../../bucket', 'image/png', 1, 60)).rejects.toMatchObject({ statusCode: 500 })
    await expect(s3.grant(clean, 'image/png', 1, 60)).rejects.toMatchObject({ statusCode: 422 })
    await expect(s3.grant(raw, 'image/svg+xml', 1, 60)).rejects.toMatchObject({ statusCode: 422 })
    await expect(s3.grant(raw, 'image/png', 1, 301)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('fetches only the configured bucket/key with a bounded snapshot', async () => {
    const seen: string[] = []
    const f = await fixture((req, res) => { seen.push(req.url!); res.end('snapshot') })
    expect(await store(f.url).read(raw, 8)).toEqual(Buffer.from('snapshot'))
    expect(seen).toEqual([`/private-media/${raw}?x-id=GetObject`])
  })
  it('rejects an oversized declared object and an oversized chunked body', async () => {
    let chunked = false
    const f = await fixture((_req, res) => {
      if (!chunked) { res.setHeader('Content-Length', '99999999'); res.flushHeaders() }
      else { res.write('1234'); res.end('56789') }
    })
    const s3 = store(f.url)
    await expect(s3.read(raw, 8)).rejects.toMatchObject({ statusCode: 422 })
    chunked = true
    await expect(s3.read(raw, 8)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('refuses empty objects and does not follow a redirect outside storage', async () => {
    let redirectedRequests = 0
    const other = await fixture((_req, res) => { redirectedRequests++; res.end('unexpected') })
    let redirect = false
    const f = await fixture((_req, res) => { if (redirect) res.writeHead(302, { location: other.url }); res.end() })
    const s3 = store(f.url)
    await expect(s3.read(raw, 8)).rejects.toMatchObject({ statusCode: 422 })
    redirect = true
    await expect(s3.read(raw, 8)).rejects.toMatchObject({ statusCode: 503 })
    expect(redirectedRequests).toBe(0)
  })
  it('aborts a drip-fed response at an absolute deadline after headers', async () => {
    const f = await fixture((_req, res) => {
      res.write('x')
      const timer = setInterval(() => res.write('x'), 15)
      res.on('close', () => clearInterval(timer))
    })
    const started = Date.now()
    await expect(store(f.url, 130).read(raw, 4096)).rejects.toMatchObject({ statusCode: 503 })
    expect(Date.now() - started).toBeLessThan(1500)
  })
  it('writes immutable clean WebP with exact length/checksum and deletes its exact key', async () => {
    const requests: { method: string; url: string; headers: Record<string, string | string[] | undefined>; bytes: Buffer }[] = []
    const f = await fixture((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', data => chunks.push(data))
      req.on('end', () => { requests.push({ method: req.method!, url: req.url!, headers: req.headers, bytes: Buffer.concat(chunks) }); res.end() })
    })
    const s3 = store(f.url), bytes = Buffer.from('synthetic-clean')
    await s3.put(clean, bytes); await s3.remove(clean)
    expect(requests.map(r => r.method)).toEqual(['PUT', 'DELETE'])
    expect(requests[0]!.bytes).toEqual(bytes)
    expect(requests[0]!.headers).toMatchObject({ 'content-type': 'image/webp', 'content-length': String(bytes.length),
      'cache-control': 'private, no-store', 'if-none-match': '*', 'content-md5': createHash('md5').update(bytes).digest('base64') })
    expect(requests.every(r => r.url.startsWith(`/private-media/${clean}`))).toBe(true)
    await expect(s3.put(raw, bytes)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('returns a generic failure without upstream error details or credentials', async () => {
    const f = await fixture((_req, res) => { res.writeHead(403, { 'Content-Type': 'application/xml' }); res.end('<Error><Code>Denied</Code><Message>synthetic-secret storage-internal</Message></Error>') })
    const s3 = store(f.url)
    for (const operation of [() => s3.read(raw, 8), () => s3.put(clean, Buffer.from('x')), () => s3.remove(clean)]) {
      const error = await operation().catch(value => value)
      expect(error).toMatchObject({ statusCode: 503, code: 'media_storage_unavailable' })
      expect(String(error)).not.toMatch(/synthetic-secret|storage-internal/)
    }
  })
  it.each([
    ['GET', 403, true], ['GET', 403, false], ['GET', 500, true], ['GET', 500, false],
    ['PUT', 403, true], ['PUT', 403, false], ['PUT', 500, true], ['PUT', 500, false],
    ['DELETE', 403, true], ['DELETE', 403, false], ['DELETE', 500, true], ['DELETE', 500, false],
    ['PUT', 200, true], ['PUT', 200, false], ['DELETE', 200, true], ['DELETE', 200, false],
  ] as const)('caps SDK control/error bodies before deserialization: %s %s length=%s', async (method, status, declared) => {
    const payload = Buffer.from('<Error><Code>AccessDenied</Code><Message>' + 'x'.repeat(2 * 1024 * 1024) + '</Message></Error>')
    const attempts: { sent: number; closed: Promise<void> }[] = []
    const f = await fixture((_req, res) => {
      res.statusCode = status; res.setHeader('Content-Type', 'application/xml')
      if (declared) res.setHeader('Content-Length', String(payload.length))
      let closed!: () => void
      const attempt = { sent: 0, closed: new Promise<void>(resolve => { closed = resolve }) }
      attempts.push(attempt)
      const timer = setInterval(() => {
        const chunk = payload.subarray(attempt.sent, attempt.sent + 16 * 1024)
        attempt.sent += chunk.length; res.write(chunk)
        if (attempt.sent === payload.length) { clearInterval(timer); res.end() }
      }, 2)
      res.on('close', () => { clearInterval(timer); closed() })
    })
    const s3 = store(f.url, 10_000)
    const action = method === 'GET' ? s3.read(raw, PHOTO_MAX_BYTES) : method === 'PUT' ? s3.put(clean, Buffer.from('x')) : s3.remove(clean)
    await expect(action).rejects.toMatchObject({ statusCode: 503, code: 'media_storage_unavailable' })
    expect(attempts.length).toBeGreaterThan(0)
    for (const attempt of attempts) {
      await attempt.closed
      expect(attempt.sent).toBeLessThan(payload.length)
    }
  })
})
