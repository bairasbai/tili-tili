// Пишет crawl/job.json: node mkjob.mjs <name> <role|guest|anon> <setup:0|1> <clicks:0|1> [w=390] route...  (плейсхолдеры {vendorId} и т.п. из fixtures-public.json)
import { readFileSync, writeFileSync } from 'node:fs'
const D = (process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })())
const pub = JSON.parse(readFileSync(`${D}/fixtures-public.json`, 'utf8'))
const [name, role, setup, clicks, ...rest] = process.argv.slice(2)
let width = 390
const routes = []
let blocklist
const pre = {}
for (const r of rest) {
  if (/^w=\d+$/.test(r)) width = Number(r.slice(2))
  else if (r.startsWith('block=')) blocklist = r.slice(6)
  else if (r.startsWith('pre=')) { const [route, text] = r.slice(4).split('='); (pre[route] ||= []).push(text) }
  else routes.push(r.replace(/\{(\w+)\}/g, (_, k) => { const v = pub[k]; if (v == null) throw new Error('нет ' + k); return v }))
}
const job = {
  name, role, setup: setup === '1', clicks: clicks === '1',
  viewport: { width, height: width > 600 ? 800 : 844 },
  phone: role === 'guest' || role === 'anon' ? null : pub.phones[role],
  guestCode: role === 'guest' ? pub.freshGuestCode : null,
  routes, blocklist, pre, maxPerRoute: 60, budgetMs: 480000,
}
if (role !== 'guest' && role !== 'anon' && !job.phone) throw new Error('нет телефона роли ' + role)
writeFileSync(`${D}/crawl/job.json`, JSON.stringify(job, null, 1))
console.log(`job ${name}: role=${role} setup=${job.setup} clicks=${job.clicks} w=${width} routes=${routes.length}`)
