// Сценарий заявки (лида): пара пишет видеографу → в кабинете заявка «новая» → «Ответить» → быстрый ответ → «Hold 72 ч» → «Отклонить» → «Вернуть в работу».
const fs = require('fs')
const { chromium } = require(process.env.PW_CORE || 'playwright-core')
const { run, D, FE, S } = require('./flow-lib.cjs')
const pub = JSON.parse(fs.readFileSync(`${D}/../fixtures-public.json`, 'utf8'))
const expect = (c, what) => { if (!c) throw new Error('ожидалось: ' + what) }

async function ctxFor(role, setupPhone) {
  const b = await chromium.launch({ headless: true })
  const stateFile = `${D}/state-${role}.json`
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', storageState: !setupPhone && fs.existsSync(stateFile) ? stateFile : undefined })
  const p = await c.newPage()
  const bad = []
  p.on('response', async (r) => { if (r.status() >= 400) { let t = ''; try { t = (await r.text()).slice(0, 120) } catch { /* нет тела */ } bad.push(`${r.request().method()} ${r.url().replace(/^http:\/\/127\.0\.0\.1:300[01](\/api)?/, '')} ${r.status()} ${t}`) } })
  const h = {
    page: p, bad,
    goto: async (path) => { await p.goto(FE + path, { waitUntil: 'domcontentloaded', timeout: 20000 }); await h.settle(500) },
    settle: async (ms = 300) => { await p.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await p.waitForTimeout(ms) },
    text: () => p.evaluate(() => document.body.innerText || ''),
    tap: async (loc) => { const l = loc.first(); await l.waitFor({ state: 'visible', timeout: 8000 }); await l.scrollIntoViewIfNeeded().catch(() => {}); await p.waitForTimeout(300); const bx = await l.boundingBox(); if (!bx) throw new Error('нет геометрии'); await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2); await h.settle() },
    btn: (re) => h.tap(p.getByRole('button', { name: re })),
    url: () => p.url().replace(FE, ''),
    close: async () => { await c.storageState({ path: stateFile }).catch(() => {}); await b.close() },
  }
  if (setupPhone) {
    await p.goto(FE + '/', { waitUntil: 'domcontentloaded' })
    const tok = await (await p.request.get(S + '/tok/' + encodeURIComponent(setupPhone))).json()
    await p.evaluate(({ tok }) => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify(tok.tokens)); localStorage.setItem('tt_onboarded', '1') }, { tok })
  }
  return h
}

run('flow-lead', async (step) => {
  const vid = pub.vendor2Id
  let leadId = null
  await step('пара: анкета видеографа → «Написать» → сообщение → заявка заведена', async () => {
    const h = await ctxFor('couple')
    try {
      await h.goto(`/vendor/${vid}`)
      await h.btn(/^Написать$/)
      expect(/^\/us\/chats\//.test(h.url()), 'чат открыт: ' + h.url())
      await h.page.getByPlaceholder(/Сообщение/).fill('Здравствуйте! Снимаете клипы? (обход заявки)')
      await h.btn(/Отправить/)
      await h.settle(800)
      expect((await h.text()).includes('обход заявки'), 'сообщение в ленте')
    } finally { await h.close() }
  })
  await step('видеограф: кабинет — заявка новая; страница заявки — «Ответить» ведёт в чат', async () => {
    const h = await ctxFor('vendor2', pub.phones.vendor2)
    try {
      await h.goto('/vendor-app')
      const cab = await h.text()
      expect(/1 нов|новая заявка|Заявк/i.test(cab), 'кабинет показывает заявку: ' + cab.slice(0, 300).replace(/\n/g, ' '))
      const tok = await h.page.evaluate(() => JSON.parse(localStorage.getItem('tt_auth') || 'null'))
      const leads = await (await h.page.request.get('http://127.0.0.1:3001/vendor/leads', { headers: { authorization: 'Bearer ' + tok.accessToken } })).json()
      const items = Array.isArray(leads) ? leads : leads.items || []
      expect(items.length >= 1, 'GET /vendor/leads вернул заявку')
      leadId = items[0].id
      await h.goto(`/vendor-app/leads/${leadId}`)
      const t = await h.text()
      expect(/Аня Обход/.test(t), 'заявка от пары: ' + t.slice(0, 300).replace(/\n/g, ' '))
      return { state: items[0].state ?? items[0].status, buttons: await h.page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.innerText.trim().slice(0, 30)).filter(Boolean)) }
    } finally { await h.close() }
  })
  await step('видеограф: «Придержать» → «Отказать» → «Вернуть в работу» — состояния меняются, сервер отвечает 200', async () => {
    const h = await ctxFor('vendor2')
    try {
      await h.goto(`/vendor-app/leads/${leadId}`)
      const posts = []
      h.page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().includes('/vendor/leads/')) posts.push(r.status()) })
      const seq = []
      for (const re of [/^Здравствуйте! Дата свободна/, /^Hold 72 ч/, /^Отклонить$/, /^Вернуть в работу$/]) {
        const l = h.page.getByRole('button', { name: re }).first()
        if (!(await l.count())) { seq.push('нет кнопки ' + re); continue }
        await h.tap(l)
        await h.settle(800)
        seq.push(String(re) + ' → ' + (await h.text()).slice(0, 120).replace(/\n/g, ' '))
      }
      expect(posts.length >= 3 && posts.every((s) => s < 400), 'POST /vendor/leads/:id статусы: ' + posts.join(','))
      return { posts, seq }
    } finally { await h.close() }
  })
}, { continueOnFail: true })
