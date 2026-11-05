import { createConnection } from 'node:net'
import { once } from 'node:events'
import { AppError } from '../errors.js'
import { PHOTO_MAX_BYTES, photoInvalid } from './storage.js'

export interface MediaScanner { scan(bytes: Buffer): Promise<void> }
const unavailable = () => new AppError(503, 'media_scanner_unavailable', 'Проверка файлов временно недоступна — попробуйте позже')

/** ClamD INSTREAM over an operator-owned private socket; paths are never sent. */
export class ClamMediaScanner implements MediaScanner {
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 15_000) {}
  async scan(bytes: Buffer): Promise<void> {
    if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) throw photoInvalid()
    const socket = createConnection({ host: this.host, port: this.port })
    let reply = Buffer.alloc(0), sent = false
    // Absolute deadline: a peer sending one byte periodically must not keep a scan alive.
    const timer = setTimeout(() => socket.destroy(unavailable()), this.timeoutMs)
    const response = new Promise<Buffer>((resolve, reject) => {
      socket.on('data', data => {
        if (reply.length + data.length > 2048) { reject(unavailable()); socket.destroy(unavailable()); return }
        reply = Buffer.concat([reply, data])
      })
      socket.once('error', () => reject(unavailable()))
      socket.once('end', () => {
        // One INSTREAM command has exactly one reply; reject early/truncated/multiple records.
        if (!sent || reply.length < 2 || reply.indexOf(0) !== reply.length - 1) {
          reject(unavailable()); socket.destroy(unavailable()); return
        }
        resolve(reply.subarray(0, -1))
      })
      socket.once('close', () => reject(unavailable()))
    })
    // Install the rejection handler before connect/write awaits can fail.
    void response.catch(() => undefined)
    const closedWhileWriting = response.then(() => { throw unavailable() })
    void closedWhileWriting.catch(() => undefined)
    try {
      await Promise.race([once(socket, 'connect'), closedWhileWriting])
      const write = async (chunk: Buffer) => {
        if (!socket.write(chunk)) await Promise.race([once(socket, 'drain'), closedWhileWriting])
      }
      await write(Buffer.from('zINSTREAM\0'))
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const data = bytes.subarray(offset, offset + 64 * 1024), length = Buffer.alloc(4)
        length.writeUInt32BE(data.length); await write(length); await write(data)
      }
      const terminator = write(Buffer.alloc(4))
      sent = true
      await terminator
      const result = (await response).toString('utf8')
      if (result === 'stream: OK') return
      if (/^stream: [^\r\n\0]+ FOUND$/.test(result)) throw new AppError(422, 'media_malware_detected', 'Файл не прошёл проверку безопасности')
      throw unavailable()
    } catch (error) {
      if (error instanceof AppError) throw error
      throw unavailable()
    } finally { clearTimeout(timer); socket.destroy() }
  }
}
