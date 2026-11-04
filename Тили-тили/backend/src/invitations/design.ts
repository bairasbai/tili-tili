import sharp from 'sharp'
import { AppError } from '../errors.js'

export type InvitationBlock =
  | { type: 'Text'; props: { id: string; heading: string; body: string } }
  | { type: 'Photo'; props: { id: string; image: string; caption: string } }
  | { type: 'Program'; props: { id: string; items: Array<{ time: string; label: string }> } }
  | { type: 'Place'; props: { id: string; name: string; address: string } }
export interface InvitationDesign { schemaVersion: 1; content: InvitationBlock[] }
export const EMPTY_DESIGN: InvitationDesign = { schemaVersion: 1, content: [] }
const invalid = () => new AppError(422, 'validation_failed', 'Проверьте содержимое приглашения')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  const result = object(value)
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) throw invalid()
  return result
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || Array.from(value).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)))) throw invalid()
  return value
}

/** Decode untrusted raster bytes fully and remove metadata before storage/publication. */
export async function normalizeInvitationPhoto(value: unknown): Promise<string> {
  const uri = text(value, 180_000)
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri)
  if (!match || match[2]!.length % 4 !== 0) throw invalid()
  const bytes = Buffer.from(match[2]!, 'base64')
  if (!bytes.length || bytes.length > 128 * 1024 || bytes.toString('base64') !== match[2]) throw invalid()
  const format = match[1]!
  const magic = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : format === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!magic) throw invalid()
  // libvips may expose only the first APNG frame; reject the animation control chunk explicitly.
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      if (length > bytes.length - offset - 12) throw invalid()
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw invalid()
      offset += length + 12
    }
  }
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 8_000_000 })
    const meta = await image.metadata()
    if (meta.format !== format || !meta.width || !meta.height || meta.width > 4096 || meta.height > 4096
      || meta.width * meta.height > 8_000_000 || (meta.pages ?? 1) !== 1) throw invalid()
    const result = await image.rotate().webp({ quality: 80 }).toBuffer()
    if (result.length > 128 * 1024) throw invalid()
    return `data:image/webp;base64,${result.toString('base64')}`
  } catch { throw invalid() }
}

/** Closed block vocabulary: Puck data is never treated as HTML, CSS, URLs or nested code. */
export async function parseInvitationDesign(value: unknown): Promise<InvitationDesign> {
  const root = fields(value, ['schemaVersion', 'content'])
  if (root.schemaVersion !== 1 || !Array.isArray(root.content) || root.content.length > 16
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 768 * 1024) throw invalid()
  const seen = new Set<string>()
  let photos = 0
  const content: InvitationBlock[] = []
  for (const raw of root.content) {
    const block = fields(raw, ['type', 'props'])
    const p = object(block.props)
    const id = text(p.id, 80)
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) throw invalid()
    seen.add(id)
    switch (block.type) {
      case 'Text':
        fields(p, ['id', 'heading', 'body'])
        content.push({ type: 'Text', props: { id, heading: text(p.heading, 120), body: text(p.body, 4000) } }); break
      case 'Photo':
        fields(p, ['id', 'image', 'caption'])
        if (++photos > 3) throw invalid()
        content.push({ type: 'Photo', props: { id, image: await normalizeInvitationPhoto(p.image), caption: text(p.caption, 240) } }); break
      case 'Program': {
        fields(p, ['id', 'items'])
        if (!Array.isArray(p.items) || p.items.length > 24) throw invalid()
        const items = p.items.map(value => {
          const item = fields(value, ['time', 'label'])
          const time = text(item.time, 5)
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw invalid()
          return { time, label: text(item.label, 240) }
        })
        content.push({ type: 'Program', props: { id, items } }); break
      }
      case 'Place':
        fields(p, ['id', 'name', 'address'])
        content.push({ type: 'Place', props: { id, name: text(p.name, 240), address: text(p.address, 500) } }); break
      default: throw invalid()
    }
  }
  return { schemaVersion: 1, content }
}
