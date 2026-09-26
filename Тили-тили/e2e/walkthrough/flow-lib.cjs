// Мини-каркас сценариев: браузер, сборщики ошибок/≥400, шаги с проверками, отчёт в crawl/out/<name>.json.
const fs = require('fs')
const D = require('path').join((process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })()), 'crawl')
const { chromium } = require(process.env.PW_CORE || 'playwright-core')
const FE = 'http://127.0.0.1:3000'
const S = 'http://127.0.0.1:3999'

async function run(name, fn, opts = {}) {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', storageState: opts.storageState })
  const page = await ctx.newPage()
  const report = { name, steps: [], bad: [], errors: [], ok: true }
  let current = 'start'
  page.on('response', async (r) => {
    if (r.status() < 400) return
    let body = ''
    try { body = (await r.text()).slice(0, 200) } catch { /* нет тела */ }
    report.bad.push({ at: current, m: r.request().method(), u: r.url().replace(/^http:\/\/127\.0\.0\.1:300[01](\/api)?/, ''), s: r.status(), b: body })
  })
  page.on('pageerror', (e) => report.errors.push({ at: current, kind: 'pageerror', text: String(e && e.message || e).slice(0, 300) }))
  page.on('console', (m) => {
    const t = m.type()
    if (t !== 'error' && t !== 'warning') return
    const text = m.text()
    if (/\[vite\]|hmr|websocket|React DevTools|Failed to load resource/i.test(text)) return
    report.errors.push({ at: current, kind: 'console.' + t, text: text.slice(0, 300) })
  })
  await page.addInitScript(() => { window.confirm = () => true; window.alert = () => {} })
  const api = {
    page, ctx, FE, S, report,
    text: async () => (await page.evaluate(() => document.body.innerText || '')),
    has: async (re) => re.test(await page.evaluate(() => document.body.innerText || '')),
    settle: async (ms = 300) => { await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await page.waitForTimeout(ms) },
    tap: async (loc) => { const l = loc.first(); await l.waitFor({ state: 'visible', timeout: 8000 }); await l.scrollIntoViewIfNeeded().catch(() => {}); const b = await l.boundingBox(); if (!b) throw new Error('нет геометрии у ' + String(loc)); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await api.settle() },
    click: async (sel) => api.tap(page.locator(sel)),
    clickText: async (re) => api.tap(page.getByText(re)),
    btn: async (re) => api.tap(page.getByRole('button', { name: re })),
    goto: async (path) => { await page.goto(FE + path, { waitUntil: 'domcontentloaded', timeout: 20000 }); await api.settle(500) },
    otp: async (phone) => (await (await page.request.get(S + '/otp/' + encodeURIComponent(phone))).json()).code,
    tok: async (phone) => (await page.request.get(S + '/tok/' + encodeURIComponent(phone))).json(),
    pub: async () => (await page.request.get(S + '/pub')).json(),
    expect: (cond, what) => { if (!cond) throw new Error('ожидалось: ' + what) },
    url: () => page.url().replace(FE, ''),
  }
  const step = async (label, f) => {
    current = label
    const badN = report.bad.length, errN = report.errors.length
    const t = Date.now()
    try {
      const r = await f(api)
      report.steps.push({ label, ok: true, ms: Date.now() - t, url: api.url(), note: r === undefined ? undefined : r, bad: report.bad.slice(badN).map((b) => `${b.m} ${b.u} ${b.s} ${b.b.slice(0, 80)}`), errors: report.errors.slice(errN).map((e) => `${e.kind}: ${e.text.slice(0, 160)}`) })
    } catch (e) {
      report.ok = false
      let txt = ''
      try { txt = (await api.text()).slice(0, 400) } catch { /* страница закрыта */ }
      report.steps.push({ label, ok: false, ms: Date.now() - t, url: api.url(), error: String(e.message).slice(0, 700), page: txt, bad: report.bad.slice(badN).map((b) => `${b.m} ${b.u} ${b.s} ${b.b.slice(0, 80)}`), errors: report.errors.slice(errN).map((e) => `${e.kind}: ${e.text.slice(0, 160)}`) })
      if (!opts.continueOnFail) throw e
    }
  }
  try {
    await fn(step, api)
  } catch (e) {
    if (!report.steps.length || report.steps[report.steps.length - 1].ok) { report.ok = false; report.fatal = String(e.stack || e.message).slice(0, 400) }
  }
  if (opts.saveState) await ctx.storageState({ path: `${D}/${opts.saveState}` }).catch(() => {})
  await browser.close()
  fs.writeFileSync(`${D}/out/${name}.json`, JSON.stringify(report, null, 1))
  const lines = [`${name}: ${report.ok ? 'OK' : 'FAIL'} — ${report.steps.filter((s) => s.ok).length}/${report.steps.length} шагов`]
  for (const s of report.steps) {
    lines.push(`  ${s.ok ? '✓' : '✗'} ${s.label} (${s.ms}ms) @${s.url}${s.note !== undefined ? ' — ' + JSON.stringify(s.note).slice(0, 200) : ''}${s.error ? '\n      ERROR ' + s.error + (s.page ? '\n      PAGE «' + s.page.replace(/\s+/g, ' ').slice(0, 300) + '»' : '') : ''}${s.bad.length ? '\n      ≥400: ' + s.bad.join(' | ') : ''}${s.errors.length ? '\n      ERRORS: ' + s.errors.join(' | ') : ''}`)
  }
  if (report.fatal) lines.push('  FATAL ' + report.fatal)
  console.log(lines.join('\n'))
  return report
}
// Телефоны сценариев (10 цифр без +7) — из набора фикстур текущего прогона: +79<run><nnn>. «Новый» аккаунт
// сценария так и остаётся новым, даже если база уже видела прошлые прогоны.
const ph = (suffix) => '9' + JSON.parse(fs.readFileSync(require('path').join(D, '..', 'fixtures-public.json'), 'utf8')).run + suffix

module.exports = { run, D, FE, S, ph }
