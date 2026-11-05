import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Socket } from 'node:net'
import { ClamMediaScanner } from '../src/media/scanner.js'
import { PHOTO_MAX_BYTES } from '../src/media/storage.js'
import { mediaFixture } from './helpers/mediaTransportFixture.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(handler: (socket: Socket) => void, timeout = 1000) {
  const running = await mediaFixture(createServer(handler))
  cleanups.push(() => running.close())
  return new ClamMediaScanner('127.0.0.1', running.port, timeout)
}
function receiveStream(socket: Socket, complete: (data: Buffer) => void) {
  let input = Buffer.alloc(0), header = false, completed = false
  const chunks: Buffer[] = []
  socket.on('data', data => {
    input = Buffer.concat([input, data])
    if (!header) {
      if (input.length < 10) return
      expect(input.subarray(0, 10)).toEqual(Buffer.from('zINSTREAM\0'))
      input = input.subarray(10); header = true
    }
    while (input.length >= 4 && !completed) {
      const size = input.readUInt32BE(0)
      expect(size).toBeLessThanOrEqual(64 * 1024)
      if (input.length < size + 4) return
      if (!size) { completed = true; complete(Buffer.concat(chunks)); return }
      chunks.push(input.subarray(4, 4 + size)); input = input.subarray(4 + size)
    }
  })
}

describe('ClamD INSTREAM real loopback protocol', () => {
  it('sends the exact bounded snapshot with network-byte-order chunk framing', async () => {
    const bytes = Buffer.alloc(160_000, 13)
    let received: Buffer | undefined
    const scanner = await fixture(socket => receiveStream(socket, data => { received = data; socket.end('stream: OK\0') }))
    await scanner.scan(bytes)
    expect(received).toEqual(bytes)
  })
  it('accepts a clean reply fragmented over multiple packets', async () => {
    const scanner = await fixture(socket => receiveStream(socket, () => { socket.write('stream: '); setImmediate(() => socket.end('OK\0')) }))
    await expect(scanner.scan(Buffer.from('sample'))).resolves.toBeUndefined()
  })
  it.each(['stream: Eicar-Test-Signature FOUND\0', 'stream: Heuristics.Limits.Exceeded FOUND\0'])('fails a detection: %s', async reply => {
    const scanner = await fixture(socket => receiveStream(socket, () => socket.end(reply)))
    await expect(scanner.scan(Buffer.from('synthetic test bytes'))).rejects.toMatchObject({ statusCode: 422, code: 'media_malware_detected' })
  })
  it.each(['stream: OK', 'stream: OK\0stream: Virus FOUND\0', 'stream: skipped ERROR\0', 'OK\0', 'x'.repeat(2049)])('refuses incomplete, extra or unrecognized results', async reply => {
    const scanner = await fixture(socket => receiveStream(socket, () => socket.end(reply)))
    await expect(scanner.scan(Buffer.from('sample'))).rejects.toMatchObject({ statusCode: 503 })
  })
  it('rejects peer close while a maximum-sized stream is backpressured', async () => {
    const scanner = await fixture(socket => { socket.pause(); setTimeout(() => socket.destroy(), 30) }, 250)
    const started = Date.now()
    await expect(scanner.scan(Buffer.alloc(PHOTO_MAX_BYTES, 7))).rejects.toMatchObject({ statusCode: 503 })
    expect(Date.now() - started).toBeLessThan(1500)
  })
  it('expires a peer that never reads even when writes cannot drain', async () => {
    const scanner = await fixture(socket => socket.pause(), 120)
    const started = Date.now()
    await expect(scanner.scan(Buffer.alloc(PHOTO_MAX_BYTES, 7))).rejects.toMatchObject({ statusCode: 503 })
    expect(Date.now() - started).toBeLessThan(1500)
  })
  it('expires an incomplete drip-fed reply at the absolute deadline', async () => {
    const scanner = await fixture(socket => receiveStream(socket, () => {
      const timer = setInterval(() => socket.write('x'), 10)
      socket.on('close', () => clearInterval(timer))
    }), 120)
    const started = Date.now()
    await expect(scanner.scan(Buffer.from('sample'))).rejects.toMatchObject({ statusCode: 503 })
    expect(Date.now() - started).toBeLessThan(1500)
  })
  it('rejects empty and oversized input before sending a command', async () => {
    let requests = 0
    const scanner = await fixture(socket => { requests++; socket.end() })
    await expect(scanner.scan(Buffer.alloc(0))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scanner.scan(Buffer.alloc(PHOTO_MAX_BYTES + 1))).rejects.toMatchObject({ statusCode: 422 })
    expect(requests).toBe(0)
  })
  it('treats a clean-looking reply followed by a held-open connection as unavailable', async () => {
    const scanner = await fixture(socket => receiveStream(socket, () => socket.write('stream: OK\0')), 120)
    await expect(scanner.scan(Buffer.from('sample'))).rejects.toMatchObject({ statusCode: 503 })
  })
})
