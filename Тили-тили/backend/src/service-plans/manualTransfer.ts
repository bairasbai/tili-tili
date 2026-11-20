import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

export type ManualTransfer = { url: string; qrJpegBase64: string }

export function loadManualTransfer(file: string | null): ManualTransfer | null {
  if (!file) return null
  if (!isAbsolute(file)) throw new Error('Expected an absolute configuration path')
  const fd = openSync(file, 'r')
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 200_000) throw new Error('Invalid transfer configuration size')
    return parseManualTransfer(JSON.parse(readFileSync(fd, 'utf8')))
  } finally {
    closeSync(fd)
  }
}

export function parseManualTransfer(value: unknown): ManualTransfer {
  if (!value || typeof value !== 'object') throw new Error('Invalid transfer configuration')
  const { url, qrJpegBase64, pairingSha256 } = value as Partial<ManualTransfer & { pairingSha256: string }>
  if (typeof url !== 'string' || typeof qrJpegBase64 !== 'string') {
    throw new Error('Expected a paired transfer URL and QR image')
  }

  const link = new URL(url)
  const params = Array.from(link.searchParams)
  if (link.origin !== 'https://www.sberbank.com' || link.pathname !== '/sms/pbpn' ||
      link.username || link.password || link.hash || params.length !== 1 ||
      params[0]?.[0] !== 'requisiteNumber' || !/^(?:7)?[1-9]\d{9}$/.test(params[0][1])) {
    throw new Error('Expected a Sber transfer link by phone number')
  }

  if (qrJpegBase64.length > 180_000) throw new Error('Transfer QR is too large')
  const bytes = Buffer.from(qrJpegBase64, 'base64')
  if (bytes.length < 4 || bytes.toString('base64') !== qrJpegBase64 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('Expected a JPEG QR image')
  }
  const pairing = createHash('sha256').update(link.href + '\n').update(bytes).digest('hex')
  if (pairing !== pairingSha256) throw new Error('Expected the verified URL and QR image pairing')
  return { url: link.href, qrJpegBase64 }
}
