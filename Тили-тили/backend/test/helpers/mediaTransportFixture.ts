import { appendFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'

/** Real loopback transports, owned by this test worker. Never connect to shared services. */
export async function mediaFixture<T extends Server>(server: T, owner = process.env.MEDIA_FIXTURE_OWNER ?? 'backend/media-transport-tests') {
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address')
  const port = address.port
  const record = (state: string) => {
    if (process.env.MEDIA_FIXTURE_EVIDENCE) appendFileSync(process.env.MEDIA_FIXTURE_EVIDENCE, JSON.stringify({
      owner, pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      command: process.argv, cwd: process.cwd(), port, time: new Date().toISOString(), state,
    }) + '\n')
  }
  record('listening')
  let closed = false
  return { port, url: `http://127.0.0.1:${port}`, async close() {
    if (closed) return
    closed = true
    const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    for (const socket of sockets) socket.destroy()
    await stopped
    // A successful fresh bind proves that our listener released its port.
    const probe = createServer()
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
    record('closed-port-rebound-and-released')
  } }
}
