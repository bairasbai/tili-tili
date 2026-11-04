import { z } from 'zod'
import type { components } from './api/schema'
export type InvitationDesign = components['schemas']['InvitationDesign']
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
const plain = (max: number) => z.string().max(max).refine(value => !Array.from(value).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))))
const shape = z.strictObject({ schemaVersion: z.literal(1), content: z.array(z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Text'), props: z.strictObject({ id, heading: plain(120), body: plain(4000) }) }),
  z.strictObject({ type: z.literal('Photo'), props: z.strictObject({ id, image: z.string().max(180000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/), caption: plain(240) }) }),
  z.strictObject({ type: z.literal('Program'), props: z.strictObject({ id, items: z.array(z.strictObject({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), label: plain(240) })).max(24) }) }),
  z.strictObject({ type: z.literal('Place'), props: z.strictObject({ id, name: plain(240), address: plain(500) }) }),
])).max(16) }).refine(data => new Set(data.content.map(b => b.props.id)).size === data.content.length && data.content.filter(b => b.type === 'Photo').length <= 3)
export function parseInvitationDesign(value: unknown): InvitationDesign { return shape.parse(value) }

/** Raster decode stays in this browser; no uploads or external URL lookup. Server validates again. */
export async function invitationPhoto(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) throw new Error('invalid photo')
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 8_000_000) throw new Error('large photo')
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d'); if (!context) throw new Error('canvas unavailable')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const uri = canvas.toDataURL('image/webp', 0.78)
    if (!uri.startsWith('data:image/webp;base64,') || atob(uri.split(',')[1]!).length > 128 * 1024) throw new Error('photo too large')
    return uri
  } finally { bitmap.close() }
}
