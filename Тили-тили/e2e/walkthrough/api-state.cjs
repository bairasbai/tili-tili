// Вызов API из сессии браузера роли (state-<role>.json): приложение само обновит токен. node api-state.cjs <role> <METHOD> <path> [json]
const fs = require('fs')
const D = require('path').join((process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })()), 'crawl')
const { chromium } = require(process.env.PW_CORE || 'playwright-core')
const [role, method, path, body] = process.argv.slice(2)
;(async () => {
  const state = `${D}/state-${role}.json`
  if (!fs.existsSync(state)) { console.log('нет state-файла роли', role); process.exit(1) }
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ storageState: state })
  const page = await ctx.newPage()
  await page.goto('http://127.0.0.1:3000/settings', { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  const tok = await page.evaluate(() => JSON.parse(localStorage.getItem('tt_auth') || 'null'))
  if (!tok) { console.log('в сессии нет токенов'); await browser.close(); process.exit(1) }
  const r = await page.request.fetch('http://127.0.0.1:3001' + path, { method, headers: { authorization: 'Bearer ' + tok.accessToken, 'content-type': 'application/json', 'idempotency-key': String(Date.now()) }, data: body })
  const text = (await r.text()).replace(/"(accessToken|refreshToken|guestToken)":"[^"]+"/g, '"$1":"…"')
  console.log(r.status(), text.slice(0, 1200))
  await ctx.storageState({ path: state })
  await browser.close()
})()
