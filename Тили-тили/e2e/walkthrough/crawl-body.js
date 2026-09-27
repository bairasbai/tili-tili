async (page) => {
  // Обход кнопок одной роли по заданию crawl/job.json. Полный отчёт → POST /out/<name>.json, в чат — только сводка.
  const S = 'http://127.0.0.1:3999'
  const FE = 'http://127.0.0.1:3000'
  const job = await (await page.request.get(S + '/file/job.json')).json()
  const ctx = page.context()
  await page.setViewportSize(job.viewport || { width: 390, height: 844 })
  const SEL = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], summary, label[for]'
  const BLOCK = new RegExp(job.blocklist || 'удалить|удаление|отозвать|отменить свадьбу|отменить бронь|отменить сделку|выйти|заблокир|снять с публикации|сбросить|очистить|отказать|delete|logout|sign out|^english$|^русский$|^завершить$|^en$|^ru$', 'i')
  const started = Date.now()
  const report = { name: job.name, role: job.role, viewport: job.viewport, routes: [], bad: [], errors: [], newPages: [], sessionLost: false }
  let current = 'setup'
  let apiReq = 0
  const reqLog = []
  const onReq = (r) => {
    const u = r.url()
    if (!u.startsWith('http://127.0.0.1:3000/api/')) return
    apiReq++
    reqLog.push(r.method() + ' ' + u.slice(u.indexOf('/api/') + 4).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').split('?')[0])
  }
  const onResp = async (r) => {
    // След deep-link шима прод-сборки: 404 на ./assets/* относительно глубокого адреса — без последствий (см. flow-lib.cjs).
    if (r.status() < 400 || (r.status() === 404 && /^\/(?!assets\/)[^?#]+\/assets\/[^/?#]+\.(?:js|css)$/.test(new URL(r.url()).pathname))) return
    let body = ''
    try { body = (await r.text()).slice(0, 160) } catch { /* тело недоступно */ }
    report.bad.push({ at: current, m: r.request().method(), u: r.url().replace(/^http:\/\/127\.0\.0\.1:300[01](\/api)?/, ''), s: r.status(), b: body })
  }
  const onErr = (e) => report.errors.push({ at: current, kind: 'pageerror', text: String(e && e.message || e).slice(0, 300) })
  const onCon = (m) => {
    const t = m.type()
    if (t !== 'error' && t !== 'warning') return
    const text = m.text()
    if (/\[vite\]|hmr|websocket|React DevTools|Failed to load resource/i.test(text)) return
    report.errors.push({ at: current, kind: 'console.' + t, text: text.slice(0, 300) })
  }
  const onPage = (p) => { report.newPages.push({ at: current }); p.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {}).then(() => { report.newPages[report.newPages.length - 1].url = p.url(); return p.close() }).catch(() => {}) }
  let downloads = 0
  const onDl = (d) => { downloads++; d.cancel().catch(() => {}) }
  page.on('request', onReq); page.on('response', onResp); page.on('pageerror', onErr); page.on('console', onCon); ctx.on('page', onPage); page.on('download', onDl)
  if (!page.__ttInit) {
    await page.addInitScript(() => {
      window.confirm = () => { window.__confirms = (window.__confirms || 0) + 1; return false }
      window.alert = () => { window.__alerts = (window.__alerts || 0) + 1 }
      window.prompt = () => null
    })
    page.__ttInit = true
  }
  const settle = async (ms = 350) => {
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(ms)
  }
  const keyOf = (e) => e.tag + '|' + e.text
  /* Предварительные нажатия маршрута (job.pre[route] — тексты кнопок): конверт приглашения и т.п. */
  const pre = async (route) => {
    for (const text of (job.pre && job.pre[route]) || []) {
      const b = page.getByRole('button', { name: text }).first()
      const box = await b.boundingBox().catch(() => null)
      if (box) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await settle(900) }
    }
  }
  const pageState = () => page.evaluate(() => {
    const txt = document.body.innerText || ''
    return {
      len: txt.length,
      boundary: txt.includes('Что-то пошло не так'),
      signIn: /Войдите|Сессия истекла|Сначала войдите/.test(txt),
      noWedding: /Свадьба не найдена|Сначала создайте свадьбу|Нет свадьбы/.test(txt),
      busy: !!document.querySelector('[aria-busy="true"], .animate-pulse, .animate-spin'),
      dialog: !!document.querySelector('[role="dialog"],[role="alertdialog"],dialog[open]'),
      h1: (document.querySelector('h1') || {}).innerText || '',
      alerts: [...document.querySelectorAll('[role="alert"],[role="status"]')].map((e) => (e.innerText || '').trim().slice(0, 100)).filter(Boolean).slice(0, 4),
      mut: window.__mut || 0, confirms: window.__confirms || 0,
    }
  }).catch(() => null)
  const listEls = () => page.evaluate((SEL) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' }
    const out = []
    document.querySelectorAll(SEL).forEach((el, idx) => {
      if (!vis(el)) return
      const text = (el.innerText || el.getAttribute('aria-label') || el.title || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 50)
      out.push({ idx, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), text, href: el.getAttribute('href'), inNav: !!el.closest('nav'), disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true') })
    })
    return out
  }, SEL)
  const locate = (idx, key) => page.evaluate(async ({ SEL, idx, key }) => {
    const k = (e) => e.tagName.toLowerCase() + '|' + (e.innerText || e.getAttribute('aria-label') || e.title || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 50)
    let el = document.querySelectorAll(SEL)[idx]
    if (!el || k(el) !== key) el = [...document.querySelectorAll(SEL)].find((e) => k(e) === key)
    if (!el) return { missing: true }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    window.__mut = 0; window.__confirms = 0; window.__alerts = 0
    new MutationObserver((ms) => { window.__mut += ms.length }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    await new Promise((res) => setTimeout(res, 600))
    const idle = window.__mut
    window.__mut = 0
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1)
    const top = document.elementFromPoint(x, y)
    const covered = !(top && (top === el || el.contains(top) || top.contains(el)))
    return { x, y, covered, idle, cover: covered && top ? top.tagName.toLowerCase() + '.' + String(top.className || '').slice(0, 50) + '«' + (top.innerText || '').trim().slice(0, 30) + '»' : null }
  }, { SEL, idx, key })

  try {
    if (job.setup) {
      await page.goto(FE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.evaluate(() => localStorage.clear())
      if (job.phone) {
        const tok = await (await page.request.get(S + '/tok/' + encodeURIComponent(job.phone))).json()
        await page.evaluate(({ tok }) => {
          localStorage.setItem('tt_auth', JSON.stringify(tok.tokens))
          localStorage.setItem('tt_onboarded', '1')
          if (tok.weddingId) localStorage.setItem('tt_wedding_id', JSON.stringify(tok.weddingId))
        }, { tok })
      } else if (job.guestCode) {
        current = 'redeem /i/' + job.guestCode
        await page.goto(FE + '/i/' + job.guestCode, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await settle(800)
        report.redeem = { url: page.url(), state: await pageState(), hasToken: await page.evaluate(() => !!localStorage.getItem('tt_guest_token')) }
      }
    }
    for (const route of job.routes) {
      const url = FE + route
      const R = { route, els: [], skipped: [], t: Date.now() }
      current = 'load ' + route
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => { R.gotoError = String(e.message).slice(0, 120) })
      await settle(500)
      await pre(route)
      R.url = page.url().replace(FE, '')
      R.state = await pageState()
      if (R.state && R.state.busy) { await page.waitForTimeout(2500); R.state = await pageState(); R.stillBusy = !!(R.state && R.state.busy) }
      if (report.bad.some((b) => b.s === 401 && /\/auth\/refresh/.test(b.u)) || (R.state && R.state.signIn && job.phone)) { report.sessionLost = true; report.routes.push(R); break }
      let els = await listEls().catch(() => [])
      R.total = els.length
      if (!job.clicks) { R.keys = els.map((e) => (e.disabled ? '⛔' : '') + keyOf(e)); report.routes.push(R); continue }
      const seen = new Map()
      const isFirst = report.routes.length === 0
      const todo = []
      for (const e of els) {
        if (e.disabled) { R.skipped.push({ k: keyOf(e), why: 'disabled' }); continue }
        if (e.inNav && !isFirst) continue
        if (e.href && /^(https?:|tel:|mailto:|sms:)/.test(e.href)) { R.skipped.push({ k: keyOf(e), why: 'ext ' + e.href.slice(0, 60) }); continue }
        if (BLOCK.test(e.text)) { R.skipped.push({ k: keyOf(e), why: 'blocklist' }); continue }
        const n = (seen.get(keyOf(e)) || 0) + 1
        seen.set(keyOf(e), n)
        if (n > 2) continue
        todo.push(e)
      }
      const cap = job.maxPerRoute || 60
      if (todo.length > cap) { R.capped = todo.length; todo.length = cap }
      for (let i = 0; i < todo.length; i++) {
        const e = todo[i]
        const key = keyOf(e)
        const E = { k: key, href: e.href || undefined }
        if (i > 0 || page.url() !== url) {
          current = 'reload ' + route + ' #' + i
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
          await settle(300)
          await pre(route)
        }
        current = route + ' → ' + key
        const badBefore = report.bad.length, errBefore = report.errors.length, pagesBefore = report.newPages.length
        const pos = await locate(e.idx, key).catch((err) => ({ missing: true, err: String(err.message).slice(0, 80) }))
        if (!pos || pos.missing) { E.r = 'vanished'; R.els.push(E); continue }
        if (pos.covered) { E.r = 'covered'; E.cover = pos.cover; R.els.push(E); continue }
        const reqBefore = apiReq; reqLog.length = 0; const dlBefore = downloads
        const urlBefore = page.url()
        const s0 = await pageState()
        await page.mouse.click(pos.x, pos.y).catch((err) => { E.clickErr = String(err.message).slice(0, 80) })
        await page.waitForTimeout(450)
        await settle(150)
        const urlAfter = page.url()
        const s1 = await pageState()
        E.nav = urlAfter !== urlBefore ? urlAfter.replace(FE, '') : undefined
        E.req = apiReq - reqBefore || undefined
        if (E.req) E.reqs = [...new Set(reqLog)].slice(0, 15)
        E.mut = s1 ? s1.mut : undefined
        if (pos.idle) E.idle = pos.idle
        if (downloads > dlBefore) E.download = true
        if (s1 && s1.dialog && !(s0 && s0.dialog)) E.dialog = true
        if (s1 && s1.boundary) E.boundary = true
        if (s1 && s1.confirms) E.confirm = s1.confirms
        if (s1 && s1.alerts.length && JSON.stringify(s1.alerts) !== JSON.stringify(s0 ? s0.alerts : [])) E.alerts = s1.alerts
        if (report.newPages.length > pagesBefore) E.newPage = true
        if (report.bad.length > badBefore) E.bad = report.bad.slice(badBefore).map((b) => b.m + ' ' + b.u + ' ' + b.s)
        if (report.errors.length > errBefore) E.errors = report.errors.slice(errBefore).map((x) => x.kind + ': ' + x.text.slice(0, 120))
        const effect = E.nav || E.req || E.dialog || E.newPage || E.confirm || E.download || (E.mut !== undefined && E.mut > (pos.idle || 0)) || (s0 && s1 && s0.len !== s1.len)
        E.r = E.boundary ? 'boundary' : E.bad ? 'bad' : E.errors ? 'error' : effect ? 'ok' : 'no-effect'
        R.els.push(E)
      }
      R.ms = Date.now() - R.t
      report.routes.push(R)
      if (Date.now() - started > (job.budgetMs || 420000)) { report.budgetStop = route; break }
    }
  } finally {
    page.off('request', onReq); page.off('response', onResp); page.off('pageerror', onErr); page.off('console', onCon); ctx.off('page', onPage); page.off('download', onDl)
  }
  report.ms = Date.now() - started
  await page.request.post(S + '/out/' + job.name + '.json', { data: JSON.stringify(report), headers: { 'content-type': 'application/json' } })
  const done = report.routes.map((r) => r.route).join(', ')
  const flat = report.routes.flatMap((r) => r.els.map((e) => ({ route: r.route, ...e })))
  const count = (k) => flat.filter((e) => e.r === k).length
  const issues = flat.filter((e) => e.r !== 'ok').map((e) => `${e.route} [${e.k}] ${e.r}${e.cover ? ' by ' + e.cover : ''}${e.bad ? ' ' + e.bad.join('; ') : ''}${e.errors ? ' ' + e.errors.join('; ') : ''}`)
  const loads = report.routes.filter((r) => r.gotoError || (r.state && (r.state.boundary || r.state.signIn || r.state.noWedding)) || r.stillBusy || r.url !== r.route).map((r) => `${r.route} → ${r.url}${r.gotoError ? ' gotoError ' + r.gotoError : ''}${r.state && r.state.boundary ? ' BOUNDARY' : ''}${r.state && r.state.signIn ? ' signIn' : ''}${r.state && r.state.noWedding ? ' noWedding' : ''}${r.stillBusy ? ' stillBusy' : ''}`)
  const loadBad = report.bad.filter((b) => (b.at.startsWith('load ') || b.at.startsWith('reload ')) && !(b.s === 401 && !/auth\/refresh/.test(b.u))).map((b) => `${b.at.replace(/ #\d+$/, '')} ${b.m} ${b.u} ${b.s}`)
  const uniq = (a) => [...new Set(a)]
  return [
    `${job.name}: routes ${report.routes.length}/${job.routes.length} (${done}) in ${Math.round(report.ms / 1000)}s${report.budgetStop ? ' BUDGET STOP at ' + report.budgetStop : ''}${report.sessionLost ? ' SESSION LOST' : ''}`,
    `clicks: ok ${count('ok')}, no-effect ${count('no-effect')}, covered ${count('covered')}, vanished ${count('vanished')}, bad ${count('bad')}, error ${count('error')}, boundary ${count('boundary')}; skipped ${report.routes.reduce((n, r) => n + r.skipped.length, 0)}; pageerrors ${report.errors.filter((e) => e.kind === 'pageerror').length}, console ${report.errors.filter((e) => e.kind !== 'pageerror').length}; newPages ${report.newPages.length}`,
    report.redeem ? 'redeem: ' + JSON.stringify(report.redeem) : '',
    loads.length ? 'LOADS:\n' + loads.join('\n') : 'loads: all routes rendered at their own url',
    loadBad.length ? 'LOAD ≥400:\n' + uniq(loadBad).join('\n') : '',
    issues.length ? 'ISSUES:\n' + issues.slice(0, 80).join('\n') + (issues.length > 80 ? `\n… +${issues.length - 80}` : '') : 'issues: none',
  ].filter(Boolean).join('\n')
}
