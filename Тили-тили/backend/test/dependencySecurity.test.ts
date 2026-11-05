import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Upstream GHSA regression scenarios. These exercise the installed dependency,
// not a claim that every optional configuration is enabled in this application.
const apps: FastifyInstance[] = []
function server() {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: true } } })
  apps.push(app)
  return app
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close() })

describe('Fastify security boundaries', () => {
  // GHSA-hwr6-493r-vm6h: boolean false must compile, including the query alias.
  for (const part of ['body', 'querystring', 'query', 'params', 'headers']) {
    it(`enforces a deny-all ${part} schema`, async () => {
      const app = server()
      let reached = false
      app.post('/deny/:id', { schema: { [part]: false } }, () => { reached = true; return 'unreachable' })
      const res = await app.inject({ method: 'POST', url: '/deny/one?q=1', payload: { value: 'one' } })
      expect(res.statusCode).toBe(400)
      expect(reached).toBe(false)
    })
    it(`accepts a true ${part} schema as a positive control`, async () => {
      const app = server()
      app.post('/allow/:id', { schema: { [part]: true } }, () => 'allowed')
      const res = await app.inject({ method: 'POST', url: '/allow/one?q=1', payload: { value: 'one' } })
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('allowed')
    })
  }

  // GHSA-667r-xxjv-c9mm: an async validator returns the data, not a Joi wrapper.
  it.each([
    { action: 'read', value: { action: 'write' } },
    { action: 'read', error: 'untrusted error property' },
  ])('preserves validated async data with reserved-looking properties: %j', async payload => {
    const app = server()
    app.post('/async', { schema: { body: {
      $async: true, type: 'object', required: ['action'],
      properties: { action: { const: 'read' }, value: { type: 'object' }, error: { type: 'string' } },
    } } }, request => request.body)
    const res = await app.inject({ method: 'POST', url: '/async', payload })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(payload)
  })

  // GHSA-9q9j-q6p8-xq58 and GHSA-389g-gv7q-r4x8.
  it.each([
    { dependencies: { 'X-Admin': ['X-Admin-Token'] } },
    { allOf: [{ if: { required: ['X-Admin'] }, then: { required: ['X-Admin-Token'] } }] },
  ])('enforces mixed-case cross-header constraints: %j', async constraint => {
    const app = server()
    app.get('/headers', { schema: { headers: {
      type: 'object', properties: { 'X-Admin': { type: 'string' }, 'X-Admin-Token': { const: 'valid' } }, ...constraint,
    } } }, () => 'allowed')
    expect((await app.inject({ url: '/headers', headers: { 'x-admin': '1' } })).statusCode).toBe(400)
    expect((await app.inject({ url: '/headers', headers: { 'x-admin': '1', 'x-admin-token': 'valid' } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/headers', headers: { 'x-admin': '1', 'x-admin-token': 'wrong' } })).statusCode).toBe(400)
  })
  it.each([{ enum: ['X-Debug-Override'] }, { const: 'X-Debug-Override' }])('enforces propertyNames denial: %j', async name => {
    const app = server()
    app.get('/names', { schema: { headers: { type: 'object', propertyNames: { not: name } } } }, () => 'allowed')
    expect((await app.inject({ url: '/names', headers: { 'x-debug-override': '1' } })).statusCode).toBe(400)
    expect((await app.inject({ url: '/names', headers: { 'x-ordinary': '1' } })).statusCode).toBe(200)
  })

  // GHSA-p68q-wchp-6fh7: malformed URLs must not reach another prefix's fallback.
  it.each(['POST', 'DELETE'] as const)('rejects malformed %s targets before a private fallback', async method => {
    const app = server()
    let disclosed = 0
    app.register(async publicApp => { publicApp.get('/known', () => 'public') }, { prefix: '/public' })
    app.register(async privateApp => {
      privateApp.get('/known', () => 'private route')
      privateApp.setNotFoundHandler({ preHandler: async (_req: FastifyRequest, reply: FastifyReply) => { await reply.code(401).send('denied') } }, () => {
        disclosed++; return 'synthetic protected fallback'
      })
    }, { prefix: '/private' })
    const bad = await app.inject({ method, url: '/public/%zz' })
    expect(bad.statusCode).toBe(400)
    expect(bad.body).not.toContain('synthetic protected fallback')
    expect(disclosed).toBe(0)
    expect((await app.inject({ url: '/private/missing' })).statusCode).toBe(401)
    expect((await app.inject({ url: '/public/known' })).body).toBe('public')
  })

  // Crash-prone optional transports run in an isolated, bounded child, never the
  // Vitest process. The child closes/rebinds its own loopback port before exit.
  it.each(['timeout', 'http2'] as const)('survives %s streaming and still serves a control request', async scenario => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/dependencyStreamingFixture.mjs', import.meta.url)), scenario], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stdout = '', stderr = ''
    child.stdout!.on('data', chunk => { stdout += String(chunk) })
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    let expired = false, force: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (force !== undefined || child.exitCode !== null || child.signalCode !== null) return
      if (child.connected) child.send('shutdown', () => undefined)
      force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }, 2_000)
    }
    const deadline = setTimeout(() => { expired = true; stop() }, 15_000)
    try {
      const code = await closed
      expect(expired, 'Owned fixture exceeded its parent deadline').toBe(false)
      expect(code, stderr).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.uncaught).toEqual([])
      expect(result.control).toEqual({ status: 200, body: 'healthy' })
      expect(result.portReleased).toBe(true)
      if (scenario === 'http2') {
        expect(result.response.body).toBe('hello')
        expect(result.response.trailers['x-checksum']).toBe('checked')
        expect(result.response.headers).not.toHaveProperty('transfer-encoding')
      } else expect(result.headersObserved).toBe(true)
    } finally {
      clearTimeout(deadline)
      try { stop(); await closed } finally { clearTimeout(force) }
    }
  }, 25_000)
})

interface Uri {
  parse(input: string): { scheme?: string; host?: string; path?: string; error?: string; to?: string[]; subject?: string; body?: string }
  serialize(input: ReturnType<Uri['parse']>, options?: { reference: string }): string
  normalize(input: string, options?: { reference: string; scheme?: string }): string
  resolve(base: string, ref: string): string
  equal(left: string, right: string): boolean
}
const require = createRequire(import.meta.url)
const compiler = createRequire(require.resolve('@fastify/ajv-compiler'))
const ajv = createRequire(compiler.resolve('ajv'))
const parsers: [string, Uri][] = [['schema compiler', compiler('fast-uri')], ['Ajv', ajv('fast-uri')]]
for (const [name, uri] of parsers) describe(`fast-uri used by ${name}`, () => {
  it('keeps ordinary hosts and references working', () => {
    expect(uri.parse('https://EXAMPLE.com/a').host).toBe('example.com')
    expect(uri.resolve('https://example.com/docs/a', '../b')).toBe('https://example.com/b')
  })
  it('canonicalizes encoded uppercase host octets consistently', () => {
    expect(uri.parse('//%41.com').host).toBe('a.com')
    expect(uri.equal('//%41.com', '//a.com')).toBe(true)
  })
  it.each(['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)', '%64ata:text/plain,hello'])('does not activate an encoded scheme: %s', input => {
    expect(uri.normalize(input)).not.toMatch(/^(javascript|data|vbscript):/i)
    let resolved: string | undefined, failure: unknown
    try { resolved = uri.resolve('https://example.com/', input) } catch (error) { failure = error }
    if (failure !== undefined) {
      expect(uri.parse(input).error).toBe('URI scheme is malformed.')
      expect(failure).toMatchObject({ message: 'URI scheme is malformed.' })
    } else expect(resolved).not.toMatch(/^(javascript|data|vbscript):/i)
  })
  it.each(['http://a@b@evil.example/', 'http://exa\tmple.com/', 'http://exa\nmple.com/', 'http://exa\rmple.com/'])('rejects ambiguous authorities: %j', input => {
    expect(uri.parse(input).error).toBeTruthy()
  })
  it.each(['a/../b', '../x'])('preserves relative reference meaning across normalization: %s', ref => {
    const base = 'https://example.com/docs/page'
    expect(uri.resolve(base, uri.normalize(ref))).toBe(uri.resolve(base, ref))
  })
  it('does not create a live scheme from a relative path in suffix serialization', () => {
    const normalized = uri.serialize({ path: 'javascript:alert(1)' }, { reference: 'suffix' })
    expect(normalized).not.toMatch(/^javascript:/i)
    expect(uri.parse(normalized).scheme).not.toBe('javascript')
  })
  it('does not create a live scheme during suffix normalization with an explicit scheme option', () => {
    expect(uri.normalize('javascript:alert(1)', { reference: 'suffix', scheme: 'x' })).toBe('javascript%3Aalert(1)')
  })
})
describe('fast-uri mailto field-name roundtrip (compiler branch)', () => {
  const uri = parsers[0]![1]
  it.each(['%74o=second%40example.com', '%73ubject=changed', '%62ody=changed'])('keeps reserved fields consistent: %s', query => {
    const parsed = uri.parse(`mailto:first@example.com?${query}`)
    const reparsed = uri.parse(uri.serialize(parsed))
    expect(reparsed.to).toEqual(parsed.to)
    expect(reparsed.subject).toBe(parsed.subject)
    expect(reparsed.body).toBe(parsed.body)
  })
})
