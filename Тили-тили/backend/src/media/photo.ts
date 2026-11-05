import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { PHOTO_MAX_BYTES, photoInvalid } from './storage.js'

export const PHOTO_MAX_PIXELS = 40_000_000
export const PHOTO_MAX_DIMENSION = 8192
export interface NormalizedPhoto { bytes: Buffer; width: number; height: number; sha256: string }

/** Fully decoded/re-encoded raster only. No original EXIF, attachment or URL survives. */
export async function normalizePortfolioPhoto(bytes: Buffer, claimedType: string): Promise<NormalizedPhoto> {
  if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) throw photoInvalid()
  const format = claimedType === 'image/jpeg' ? 'jpeg' : claimedType === 'image/png' ? 'png' : claimedType === 'image/webp' ? 'webp' : null
  const magic = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : format === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : format === 'webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!magic || !format) throw photoInvalid()
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      if (length > bytes.length - offset - 12 || bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw photoInvalid()
      offset += length + 12
    }
  }
  if (format === 'webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = bytes.readUInt32LE(offset + 4), kind = bytes.toString('ascii', offset, offset + 4)
      if (length > bytes.length - offset - 8 || kind === 'ANIM' || kind === 'ANMF'
        || (kind === 'VP8X' && length > 0 && (bytes[offset + 8]! & 2) !== 0)) throw photoInvalid()
      offset += 8 + length + (length % 2)
    }
  }
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: PHOTO_MAX_PIXELS })
    const meta = await decoder.metadata()
    if (meta.format !== format || !meta.width || !meta.height || meta.width > PHOTO_MAX_DIMENSION || meta.height > PHOTO_MAX_DIMENSION
      || meta.width * meta.height > PHOTO_MAX_PIXELS || (meta.pages ?? 1) !== 1) throw photoInvalid()
    const output = await decoder.rotate().webp({ quality: 85 }).toBuffer({ resolveWithObject: true })
    if (output.data.length > PHOTO_MAX_BYTES) throw photoInvalid()
    return { bytes: output.data, width: output.info.width, height: output.info.height,
      sha256: createHash('sha256').update(output.data).digest('hex') }
  } catch { throw photoInvalid() }
}
