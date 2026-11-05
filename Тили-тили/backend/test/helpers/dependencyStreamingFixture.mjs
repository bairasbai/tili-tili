// Synthetic, bounded loopback fixture for GHSA-3qgw-9275-xf8w / GHSA-4mh8-r7rc-xpvc.
import Fastify from 'fastify'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { appendFileSync } from 'node:fs'

const scenario = process.argv[2]
if (!['timeout', 'http2'].includes(scenario)) throw new Error('Unknown synthetic scenario')
const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
const report = { owner: 'root/wp01-dependency-security-20261105', pid: process.pid, startedAt, command: process.argv, cwd: process.cwd(), scenario, port: null, uncaught: [], control: null, response: null, headersObserved: false, portReleased: false }
function record(state) {
  if (process.env.DEPENDENCY_FIXTURE_EVIDENCE) appendFileSync(process.env.DEPENDENCY_FIXTURE_EVIDENCE, JSON.stringify({ ...report, state, at: new Date().toISOString() }) + '\n')
}
process.on('uncaughtException', error => { report.uncaught.push(error.code ?? error.name) })
const watchdog = setTimeout(() => { process.stderr.write('Synthetic fixture deadline exceeded\n'); process.exit(2) }, 10_000)
const sockets = new Set()
let stream, streamTimer, session
const app = scenario === 'http2' ? Fastify({ http2: true }) : Fastify({ handlerTimeout: 150 })
process.on('message', message => {
  if (message !== 'shutdown') return
  record('parent-requested-shutdown')
  stream?.destroy(); session?.destroy()
  for (const socket of sockets) socket.destroy()
})
app.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
app.get('/health', () => 'healthy')
app.get('/stream', (_request, reply) => {
  if (scenario === 'http2') {
    reply.trailer('x-checksum', async () => 'checked')
    return reply.send('hello')
  }
  stream = new PassThrough()
  reply.type('text/plain').send(stream)
  stream.write('hello')
  streamTimer = setTimeout(() => stream.end(' finished'), 450)
  return reply
})
async function getHttp(path) {
  return await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: report.port, path, agent: false }, response => {
      if (path === '/stream') report.headersObserved = true
      let body = ''
      response.on('data', chunk => { body += String(chunk) })
      response.on('end', () => resolve({ status: response.statusCode, body }))
      response.on('aborted', () => resolve({ status: response.statusCode, body }))
      response.on('error', reject)
    })
    request.setTimeout(2_000, () => request.destroy(new Error('Synthetic request timeout')))
    request.on('error', reject)
  })
}
async function getHttp2(path) {
  return await new Promise((resolve, reject) => {
    const request = session.request({ ':path': path })
    const result = { status: null, body: '', headers: {}, trailers: {} }
    request.on('response', headers => { result.headers = headers; result.status = headers[':status'] })
    request.on('trailers', trailers => { result.trailers = trailers })
    request.on('data', chunk => { result.body += String(chunk) })
    request.on('end', () => resolve(result))
    request.on('error', reject)
    request.setTimeout(2_000, () => { request.close(); reject(new Error('Synthetic HTTP2 timeout')) })
    request.end()
  })
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 })
  report.port = app.server.address().port
  record('listening')
  if (scenario === 'http2') {
    session = http2.connect(`http://127.0.0.1:${report.port}`)
    session.on('error', () => undefined)
    try { report.response = await getHttp2('/stream') } catch (error) { report.response = { error: error.code ?? error.message } }
    const health = await getHttp2('/health')
    report.control = { status: health.status, body: health.body }
  } else {
    try { report.response = await getHttp('/stream') } catch (error) { report.response = { error: error.code ?? error.message } }
    report.control = await getHttp('/health')
  }
} finally {
  clearTimeout(streamTimer)
  stream?.destroy()
  session?.destroy()
  for (const socket of sockets) socket.destroy()
  await app.close()
  if (report.port !== null) {
    const probe = net.createServer()
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(report.port, '127.0.0.1', resolve) })
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
    report.portReleased = true
  }
  clearTimeout(watchdog)
  record('closed-port-rebound-and-released')
}
process.stdout.write(JSON.stringify(report) + '\n')
if (process.connected) process.disconnect()
