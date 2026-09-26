// fixtures.json → tok-<phone>.json на роль (формат tok-server: tokens + weddingId), гостевой токен — в файле пары.
import { readFileSync, writeFileSync } from 'node:fs'
const D = (process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })())
const f = JSON.parse(readFileSync(`${D}/fixtures.json`, 'utf8'))
const pub = { run: f.run, weddingId: f.weddingId, dealId: f.dealId, chatId: f.chatId, vendorId: f.vendorId, floristVendorId: f.floristVendorId, guestId: f.guestId, guestCode: f.guestCode, phones: {} }
for (const [role, r] of Object.entries(f.roles)) {
  const out = {
    role, userId: r.userId ?? null, weddingId: ['couple', 'helper', 'coordinator'].includes(role) ? f.weddingId : null,
    tokens: { accessToken: r.accessToken, refreshToken: r.refreshToken },
    ...(role === 'couple' ? { guestToken: f.guestToken, guestCode: f.guestCode, dealId: f.dealId, chatId: f.chatId, vendorId: f.vendorId, floristVendorId: f.floristVendorId, guestId: f.guestId } : {}),
  }
  writeFileSync(`${D}/tok-${r.phone}.json`, JSON.stringify(out))
  pub.phones[role] = r.phone
}
writeFileSync(`${D}/fixtures-public.json`, JSON.stringify(pub, null, 2))
console.log('tok files:', Object.keys(f.roles).length)
