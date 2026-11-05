import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { normalizePortfolioPhoto, PHOTO_MAX_DIMENSION, PHOTO_MAX_PIXELS } from '../src/media/photo.js'
import { PHOTO_MAX_BYTES, checkStorageKey } from '../src/media/storage.js'

const image = () => sharp({ create: { width: 7, height: 5, channels: 3, background: '#338899' } })
describe('portfolio raster normalization', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('fully re-encodes %s to WebP without EXIF, ICC, XMP or orientation metadata', async format => {
    const input = await image().withMetadata({ orientation: 6, exif: { IFD0: { Artist: 'SYNTHETIC_PRIVATE' } } }).toFormat(format).toBuffer()
    expect((await sharp(input).metadata()).exif).toBeDefined()
    const output = await normalizePortfolioPhoto(input, `image/${format}`)
    const meta = await sharp(output.bytes).metadata()
    expect(output).toMatchObject({ width: 5, height: 7, sha256: createHash('sha256').update(output.bytes).digest('hex') })
    expect(meta).toMatchObject({ format: 'webp', width: 5, height: 7 })
    expect(meta.exif).toBeUndefined(); expect(meta.icc).toBeUndefined(); expect(meta.xmp).toBeUndefined(); expect(meta.orientation).toBeUndefined()
    expect(output.bytes.includes(Buffer.from('SYNTHETIC_PRIVATE'))).toBe(false)
  })
  it('rejects mismatched claimed MIME, SVG, empty and oversized inputs', async () => {
    const png = await image().png().toBuffer()
    for (const [bytes, mime] of [[png, 'image/jpeg'], [Buffer.from('<svg/>'), 'image/svg+xml'], [Buffer.alloc(0), 'image/png'], [Buffer.alloc(PHOTO_MAX_BYTES + 1), 'image/png']] as const) {
      await expect(normalizePortfolioPhoto(bytes, mime)).rejects.toMatchObject({ statusCode: 422 })
    }
  })
  it('rejects a raster exceeding the independent dimension limit', async () => {
    const bytes = await sharp({ create: { width: PHOTO_MAX_DIMENSION + 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
    await expect(normalizePortfolioPhoto(bytes, 'image/png')).rejects.toMatchObject({ statusCode: 422 })
  })
  it('rejects a compressed raster exceeding the input pixel budget', async () => {
    const edge = Math.floor(Math.sqrt(PHOTO_MAX_PIXELS)) + 1
    const bytes = await sharp({ create: { width: edge, height: edge, channels: 3, background: '#ffffff' } }).png().toBuffer()
    expect(bytes.length).toBeLessThan(PHOTO_MAX_BYTES)
    await expect(normalizePortfolioPhoto(bytes, 'image/png')).rejects.toMatchObject({ statusCode: 422 })
  })
  it('rejects truncated/malformed input rather than publishing a partial decode', async () => {
    const bytes = await image().jpeg().toBuffer()
    await expect(normalizePortfolioPhoto(bytes.subarray(0, Math.floor(bytes.length / 2)), 'image/jpeg')).rejects.toMatchObject({ statusCode: 422 })
    const png = await image().png().toBuffer(); png.writeUInt32BE(0xffffffff, 8)
    await expect(normalizePortfolioPhoto(png, 'image/png')).rejects.toMatchObject({ statusCode: 422 })
  })
  it('rejects APNG animation control even if there is only one frame', async () => {
    const bytes = await image().png().toBuffer(), animation = Buffer.alloc(20)
    animation.writeUInt32BE(8, 0); animation.write('acTL', 4); animation.writeUInt32BE(1, 8)
    await expect(normalizePortfolioPhoto(Buffer.concat([bytes.subarray(0, 33), animation, bytes.subarray(33)]), 'image/png')).rejects.toMatchObject({ statusCode: 422 })
  })
  it('rejects one-frame animation declarations in WebP', async () => {
    const bytes = await image().webp().toBuffer(), animation = Buffer.alloc(14)
    animation.write('ANIM', 0); animation.writeUInt32LE(6, 4)
    const combined = Buffer.concat([bytes.subarray(0, 12), animation, bytes.subarray(12)])
    combined.writeUInt32LE(combined.length - 8, 4)
    await expect(normalizePortfolioPhoto(combined, 'image/webp')).rejects.toMatchObject({ statusCode: 422 })
  })
})
describe('closed server-generated storage key grammar', () => {
  const id = '019a5154-1212-7123-8123-121212121212'
  it.each([`quarantine/${id}/original`, `clean/${id}/${id}.webp`])('accepts canonical %s only', key => {
    expect(() => checkStorageKey(key)).not.toThrow()
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029', '/extra', '?x=y']) expect(() => checkStorageKey(key + suffix)).toThrow()
  })
})
