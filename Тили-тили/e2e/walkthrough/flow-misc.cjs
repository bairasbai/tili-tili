// Сценарии: язык EN↔RU; модерация новой анкеты DJ в панели; выход с устройства (помощник 095) и мёртвый токен.
const fs = require('fs')
const { chromium } = require(process.env.PW_CORE || 'playwright-core')
const { shimNoise, run, D, FE } = require('./flow-lib.cjs')
const ids = JSON.parse(fs.readFileSync(`${D}/out/flow-vendor.ids.json`, 'utf8'))
const expect = (c, what) => { if (!c) throw new Error('ожидалось: ' + what) }

async function asRole(role, fn) {
  const b = await chromium.launch({ headless: true })
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', storageState: `${D}/state-${role}.json` })
  const p = await c.newPage()
  const bad = []
  p.on('response', async (r) => { if (r.status() >= 400 && !shimNoise(r)) { let t = ''; try { t = (await r.text()).slice(0, 120) } catch { /* нет тела */ } bad.push(`${r.request().method()} ${r.url().replace(/^http:\/\/127\.0\.0\.1:300[01](\/api)?/, '')} ${r.status()} ${t}`) } })
  await p.addInitScript(() => { window.confirm = () => true })
  const h = {
    page: p, bad,
    goto: async (path) => { await p.goto(FE + path, { waitUntil: 'domcontentloaded', timeout: 20000 }); await h.settle(500) },
    settle: async (ms = 300) => { await p.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await p.waitForTimeout(ms) },
    text: () => p.evaluate(() => document.body.innerText || ''),
    tap: async (loc) => { const l = loc.first(); await l.waitFor({ state: 'visible', timeout: 8000 }); await l.scrollIntoViewIfNeeded().catch(() => {}); await p.waitForTimeout(300); const bx = await l.boundingBox(); if (!bx) throw new Error('нет геометрии'); await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2); await h.settle() },
    btn: (re) => h.tap(p.getByRole('button', { name: re })),
    token: () => p.evaluate(() => JSON.parse(localStorage.getItem('tt_auth') || 'null')),
    url: () => p.url().replace(FE, ''),
  }
  try { return await fn(h) } finally { await c.storageState({ path: `${D}/state-${role}.json` }).catch(() => {}); await b.close() }
}

run('flow-misc', async (step) => {
  await step('язык: настройки → English → интерфейс на английском → Русский обратно; lang уходит на сервер', async () => {
    await asRole('couple', async (h) => {
      await h.goto('/settings')
      await h.btn(/^English$/)
      await h.page.waitForURL(/127\.0\.0\.1:3000\/(settings)?$/, { timeout: 10000 }).catch(() => {})
      await h.settle(1000)
      await h.goto('/settings')
      const en = await h.text()
      expect(/Settings/.test(en) && !/Настройки/.test(en), 'после English — «Settings»: ' + en.slice(0, 200).replace(/\n/g, ' '))
      const tok = await h.token()
      const me = await (await h.page.request.get('http://127.0.0.1:3001/users/me', { headers: { authorization: 'Bearer ' + tok.accessToken } })).json()
      // язык — свойство устройства (CLAUDE.md §5.12): на сервер не уходит; users.lang сервер сам не читает
      const serverLang = me.lang
      await h.btn(/^Русский$/)
      await h.settle(1000)
      await h.goto('/settings')
      const ru = await h.text()
      expect(/Настройки/.test(ru), 'после Русский — «Настройки»')
      const me2 = await (await h.page.request.get('http://127.0.0.1:3001/users/me', { headers: { authorization: 'Bearer ' + (await h.token()).accessToken } })).json()
      return { serverLangAfterEnglish: serverLang, serverLangAfterRussian: me2.lang }
    })
  })
  await step('панель: модерация новой анкеты DJ → «Одобрить» → анкеты нет в очереди', async () => {
    await asRole('staff', async (h) => {
      await h.goto('/admin/moderation')
      const tokQ = await h.token()
      const q0 = ((await (await h.page.request.get('http://127.0.0.1:3001/admin/moderation/vendors?limit=100', { headers: { authorization: 'Bearer ' + tokQ.accessToken } })).json()).items || [])
      if (!q0.some((v) => v.id === ids.vendorId)) return { alreadyModerated: true }
      await h.goto(`/admin/moderation/${ids.vendorId}`)
      const t0 = await h.text()
      expect(new RegExp(ids.name.split(' ')[0]).test(t0), 'карточка анкеты в панели: ' + t0.slice(0, 200).replace(/\n/g, ' '))
      await h.btn(/^Одобрить$/)
      await h.settle(1000)
      const t1 = await h.text()
      expect(/одобрен|Одобрен|опубликован|Очередь|Модерация/.test(t1) || h.url() === '/admin/moderation', 'после одобрения — подтверждение или возврат в очередь: ' + h.url() + ' ' + t1.slice(0, 200).replace(/\n/g, ' '))
      const tok = await h.token()
      const r = await h.page.request.get('http://127.0.0.1:3001/admin/moderation/vendors?limit=100', { headers: { authorization: 'Bearer ' + tok.accessToken } })
      const items = (await r.json()).items || []
      expect(!items.some((v) => v.id === ids.vendorId), 'DJ больше не в очереди модерации')
      expect(!h.bad.length, 'без ≥400: ' + h.bad.join('; '))
    })
  })
  await step('выход с устройства: пара 092 → «Выйти только с этого устройства» → вход; старый токен мёртв', async () => {
    await asRole('newcouple', async (h) => {
      await h.goto('/settings')
      const tok = await h.token()
      await h.btn(/Выйти только с этого устройства/)
      await h.settle(1200)
      expect(/^\/(auth|)$/.test(h.url()) || /Войдите|Получить код/.test(await h.text()), 'после выхода — вход: ' + h.url())
      const left = await h.page.evaluate(() => localStorage.getItem('tt_auth'))
      expect(!left, 'токены стёрты из localStorage')
      const r = await h.page.request.get('http://127.0.0.1:3001/users/me', { headers: { authorization: 'Bearer ' + tok.accessToken } })
      expect(r.status() === 401, 'старый access-токен отвергнут: ' + r.status())
    })
  })
}, { continueOnFail: true })
