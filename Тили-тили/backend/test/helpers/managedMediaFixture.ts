import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mediaFixture } from './mediaTransportFixture.js'
import { PHOTO_MAX_BYTES } from '../../src/media/storage.js'

/** Synthetic provider, not an antivirus engine or qualification of a real bucket. */
export async function managedMediaFixture(allowedOrigin?: string) {
  if (allowedOrigin) {
    const origin = new URL(allowedOrigin)
    if (origin.origin !== allowedOrigin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Only an exact owned loopback browser origin is allowed')
  }
  const owner = process.env.MEDIA_FIXTURE_OWNER ?? 'backend/managed-media-tests', objects = new Map<string, Buffer>()
  const events: { method: string; key: string }[] = []
  const controls = { infected: false, deleteFailure: false, putResponseLoss: false,
    beforeRead: null as null | ((key: string) => Promise<void>),
    beforePut: null as null | ((key: string) => Promise<void>),
    afterPut: null as null | ((key: string) => Promise<void>),
    beforeDelete: null as null | ((key: string) => Promise<void>),
    afterDelete: null as null | ((key: string) => Promise<void>),
    beforePostCommit: null as null | (() => Promise<void>),
    beforeScan: null as null | (() => Promise<void>) }
  const region = 'test-1', bucket = 'private-media-' + randomUUID(), accessKey = 'synthetic-access', secretKey = 'synthetic-secret'
  const server = httpServer((request, response) => { response.on('error', () => undefined)
    if (allowedOrigin && request.headers.origin === allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', allowedOrigin); response.setHeader('Vary', 'Origin')
    }
    void (async () => {
    const path = decodeURIComponent(new URL(request.url!, 'http://fixture.test').pathname)
    if (request.method === 'POST' && path === '/' + bucket) {
      const boundary = /boundary=([^;]+)/.exec(request.headers['content-type'] ?? '')?.[1]?.replace(/^"|"$/g, '')
      if (!boundary || boundary.length > 100) { response.writeHead(400).end(); return }
      const chunks: Buffer[] = []; let received = 0
      for await (const chunk of request) {
        received += chunk.length
        if (received > PHOTO_MAX_BYTES + 64 * 1024) { response.writeHead(413).end(); return }
        chunks.push(Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks), delimiter = Buffer.from('--' + boundary), fields: Record<string, string> = Object.create(null)
      let file: Buffer | null = null, offset = body.indexOf(delimiter) + delimiter.length
      while (offset >= delimiter.length && offset < body.length - 4) {
        if (body.subarray(offset, offset + 2).toString() === '--') break
        const headerEnd = body.indexOf('\r\n\r\n', offset), next = body.indexOf(delimiter, headerEnd + 4)
        if (headerEnd < offset || next < 0) break
        const header = body.toString('utf8', offset, headerEnd), name = /name="([^"]+)"/.exec(header)?.[1]
        const data = body.subarray(headerEnd + 4, next - 2)
        if (name === 'file') file = data
        else if (name && data.length < 32 * 1024) fields[name] = data.toString('utf8')
        offset = next + delimiter.length
      }
      try {
        const policy = JSON.parse(Buffer.from(fields.Policy!, 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] }
        const date = fields['X-Amz-Date']!.slice(0, 8)
        const hmac = (key: Buffer | string, text: string) => createHmac('sha256', key).update(text).digest()
        const signing = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), 's3'), 'aws4_request')
        const signature = hmac(signing, fields.Policy!), supplied = Buffer.from(fields['X-Amz-Signature']!, 'hex')
        const exact = (wanted: unknown) => policy.conditions.some(c => JSON.stringify(c) === JSON.stringify(wanted))
        if (!file || supplied.length !== signature.length || !timingSafeEqual(signature, supplied)
          || fields['X-Amz-Credential'] !== `${accessKey}/${date}/${region}/s3/aws4_request` || Date.parse(policy.expiration) <= Date.now()
          || !exact({ bucket }) || !exact({ key: fields.key })
          || !exact(['eq', '$Content-Type', fields['Content-Type']]) || !exact(['content-length-range', file.length, file.length])) {
          response.writeHead(403).end(); return
        }
        await controls.beforePostCommit?.()
        if (Date.parse(policy.expiration) <= Date.now()) { response.writeHead(403).end(); return }
        objects.set(fields.key!, Buffer.from(file)); events.push({ method: 'POST', key: fields.key! }); response.writeHead(204).end()
      } catch { response.writeHead(403).end() }
      return
    }
    if (!path.startsWith(`/${bucket}/`)) { response.writeHead(404).end(); return }
    const key = path.slice(bucket.length + 2)
    events.push({ method: request.method!, key })
    if (request.method === 'GET') {
      await controls.beforeRead?.(key)
      const bytes = objects.get(key)
      if (!bytes) { response.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>'); return }
      response.writeHead(200, { 'content-type': key.startsWith('clean/') ? 'image/webp' : 'application/octet-stream', 'content-length': bytes.length }).end(bytes)
    } else if (request.method === 'PUT') {
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of request) { length += chunk.length; if (length > PHOTO_MAX_BYTES) throw new Error('Unexpected upload size'); chunks.push(Buffer.from(chunk)) }
      await controls.beforePut?.(key)
      if (request.headers['if-none-match'] !== '*' || objects.has(key)) { response.writeHead(412).end(); return }
      objects.set(key, Buffer.concat(chunks)); await controls.afterPut?.(key)
      if (controls.putResponseLoss) { request.socket.destroy(); return }
      response.writeHead(200).end()
    } else if (request.method === 'DELETE') {
      await controls.beforeDelete?.(key)
      if (controls.deleteFailure) { response.writeHead(503).end(); return }
      objects.delete(key); await controls.afterDelete?.(key); response.writeHead(204).end()
    } else response.writeHead(405).end()
  })().catch(() => { if (!response.destroyed) response.writeHead(500).end() }) })
  const http = await mediaFixture(server, owner)
  let scanner: Awaited<ReturnType<typeof mediaFixture>>
  try {
    scanner = await mediaFixture(tcpServer(socket => {
      let bytes = Buffer.alloc(0), offset = 10, finished = false, length = 0
      socket.on('data', chunk => {
        if (finished) return
        bytes = Buffer.concat([bytes, chunk])
        if (bytes.length > PHOTO_MAX_BYTES + 4096 || !bytes.subarray(0, Math.min(10, bytes.length)).equals(Buffer.from('zINSTREAM\0').subarray(0, Math.min(10, bytes.length)))) { socket.destroy(); return }
        if (bytes.length < 10) return
        while (offset + 4 <= bytes.length) {
          const size = bytes.readUInt32BE(offset)
          if (size > PHOTO_MAX_BYTES || length + size > PHOTO_MAX_BYTES) { socket.destroy(); return }
          if (offset + 4 + size > bytes.length) return
          offset += 4 + size; length += size
          if (size === 0) {
            finished = true
            void Promise.resolve(controls.beforeScan?.()).then(() => socket.end(controls.infected ? 'stream: Synthetic.Test FOUND\0' : 'stream: OK\0')).catch(() => socket.destroy())
            return
          }
        }
      })
    }), owner)
  } catch (error) { await http.close(); throw error }
  return { owner, config: { endpoint: http.url, region, bucket, accessKey, secretKey,
    deliveryBaseUrl: 'https://app.example.test/api', scannerHost: '127.0.0.1', scannerPort: scanner.port, postMaxSeconds: 60 },
  objects, events, controls, async close() { await scanner.close(); await http.close() } }
}
