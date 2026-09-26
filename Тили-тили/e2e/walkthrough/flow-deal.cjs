// Сквозной сценарий: пара пишет DJ → DJ отвечает → бронь → аванс → договор → кабинет DJ видит сделку → гость по ссылке: RSVP и подарок → пара видит ответ.
// Требует flow-vendor.ids.json (DJ), state-couple.json, state-dj.json.
const fs = require('fs')
const { chromium } = require(process.env.PW_CORE || 'playwright-core')
const { run, D, FE } = require('./flow-lib.cjs')
const ids = JSON.parse(fs.readFileSync(`${D}/out/flow-vendor.ids.json`, 'utf8'))

// Второй браузер под другую роль (state-файл): свои вкладки, сохранение state после.
async function asRole(role, fn, viewport = { width: 390, height: 844 }) {
  const b = await chromium.launch({ headless: true })
  const c = await b.newContext({ viewport, locale: 'ru-RU', storageState: `${D}/state-${role}.json` })
  const p = await c.newPage()
  const bad = []
  p.on('response', async (r) => { if (r.status() >= 400) { let t = ''; try { t = (await r.text()).slice(0, 120) } catch { /* нет тела */ } bad.push(`${r.request().method()} ${r.url().replace(/^http:\/\/127\.0\.0\.1:300[01](\/api)?/, '')} ${r.status()} ${t}`) } })
  await p.addInitScript(() => { window.confirm = () => true })
  const h = {
    page: p, bad,
    goto: async (path) => { await p.goto(FE + path, { waitUntil: 'domcontentloaded', timeout: 20000 }); await h.settle(500) },
    settle: async (ms = 300) => { await p.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await p.waitForTimeout(ms) },
    text: () => p.evaluate(() => document.body.innerText || ''),
    tap: async (loc) => { const l = loc.first(); await l.waitFor({ state: 'visible', timeout: 8000 }); await l.scrollIntoViewIfNeeded().catch(() => {}); const bx = await l.boundingBox(); if (!bx) throw new Error('нет геометрии'); await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2); await h.settle() },
    btn: (re) => h.tap(p.getByRole('button', { name: re })),
    token: () => p.evaluate(() => JSON.parse(localStorage.getItem('tt_auth') || 'null')),
    url: () => p.url().replace(FE, ''),
  }
  try { return await fn(h) } finally { await c.storageState({ path: `${D}/state-${role}.json` }).catch(() => {}); await b.close() }
}
const expect = (c, what) => { if (!c) throw new Error('ожидалось: ' + what) }

run('flow-deal', async (step, a) => {
  const pub = await a.pub()
  let djSlotId = null, dealId = null, guestCode = null
  const msg1 = 'Здравствуйте! Свободны 4 сентября 2027? (обход)'
  const msg2 = 'Да, дата свободна. Пришлю программу (обход)'

  await step('пара: анкета DJ → «Написать» → чат → сообщение отправлено', async () => {
    await asRole('couple', async (h) => {
      await h.goto(`/vendor/${ids.vendorId}`)
      await h.btn(/^Написать$/)
      expect(/^\/us\/chats\//.test(h.url()), 'открылся чат, url ' + h.url())
      await h.page.getByPlaceholder(/Сообщение/).fill(msg1)
      await h.btn(/Отправить/)
      await h.settle(800)
      expect((await h.text()).includes(msg1), 'сообщение в ленте')
      expect(!h.bad.filter((x) => !x.includes('GET /vendor/profile 404') && !/ 401 $/.test(x)).length, 'без ≥400: ' + h.bad.join('; '))
    })
  })
  await step('DJ: кабинет → заявка/чат с парой → ответ отправлен', async () => {
    await asRole('dj', async (h) => {
      await h.goto('/vendor-app/chats')
      const txt = await h.text()
      expect(/Аня Обход/.test(txt), 'чат с парой в списке: ' + txt.slice(0, 200).replace(/\n/g, ' '))
      await h.tap(h.page.getByRole('button', { name: /Аня Обход/ }))
      expect(/^\/vendor-app\/chats\//.test(h.url()), 'открыт чат кабинета, url ' + h.url())
      expect((await h.text()).includes(msg1), 'сообщение пары видно подрядчику')
      await h.page.getByPlaceholder(/Сообщение/).fill(msg2)
      await h.btn(/Отправить/)
      await h.settle(800)
      expect((await h.text()).includes(msg2), 'ответ в ленте')
      await h.goto('/vendor-app')
      const cab = await h.text()
      expect(/Заявк|Лид|Новая/i.test(cab), 'кабинет показывает заявку: ' + cab.slice(0, 300).replace(/\n/g, ' '))
      expect(!h.bad.filter((x) => !x.includes('GET /vendor/profile 404') && !/ 401 $/.test(x)).length, 'без ≥400: ' + h.bad.join('; '))
    })
  })
  await step('пара: ответ DJ виден в чате; «Добавить в свадьбу» → бронь → мозаика', async () => {
    await asRole('couple', async (h) => {
      await h.goto('/us/chats')
      await h.tap(h.page.getByRole('button', { name: new RegExp(ids.name.split(' ')[0]) }))
      expect((await h.text()).includes(msg2), 'ответ подрядчика виден паре')
      await h.goto(`/vendor/${ids.vendorId}`)
      if (!/открыть сделку/i.test(await h.text())) {
        await h.btn(/Добавить в свадьбу/)
        await h.settle(1200)
        const t1 = await h.text()
        expect(/В моей свадьбе/.test(t1) || h.url() === '/wedding', 'галочка «В моей свадьбе» или переход в мозаику: ' + h.url())
      }
      await h.goto('/wedding')
      const t2 = await h.text()
      expect(/DJ/.test(t2) && /ЗАБРОНИРОВАН|Заброниров/i.test(t2), 'DJ забронирован в мозаике: ' + t2.slice(0, 400).replace(/\n/g, ' '))
      // повторный заход на анкету: CTA ведёт к сделке, а не в 409
      await h.goto(`/vendor/${ids.vendorId}`)
      expect(/открыть сделку/i.test(await h.text()), 'CTA «открыть сделку» у забронированного подрядчика')
      await h.btn(/открыть сделку/i)
      expect(/^\/deal\//.test(h.url()), 'переход на сделку: ' + h.url())
      dealId = h.url().split('/').pop()
      expect(!h.bad.filter((x) => !x.includes('GET /vendor/profile 404') && !/ 401 $/.test(x)).length, 'без ≥400: ' + h.bad.join('; '))
    })
    return { dealId }
  })
  await step('пара: сделка → «Внести аванс» → paid_deposit; «Выполнено» появляется', async () => {
    await asRole('couple', async (h) => {
      await h.goto(`/deal/${dealId}`)
      const t0 = await h.text()
      if (/Отметить оплату/.test(t0)) { await h.btn(/Отметить оплату/); await h.settle(1000) }
      const t1 = await h.text()
      expect(/Выполнено/.test(t1) && !/Отметить оплату/.test(t1), 'после аванса — шаг «Выполнено»: ' + t1.slice(0, 300).replace(/\n/g, ' '))
      expect(/Аванс|внесено|Оплачено/i.test(t1), 'сумма аванса показана')
      expect(!h.bad.filter((x) => !x.includes('GET /vendor/profile 404') && !/ 401 $/.test(x)).length, 'без ≥400: ' + h.bad.join('; '))
    })
  })
  await step('пара: договор по сделке → «Договор готов» → в списке документов', async () => {
    await asRole('couple', async (h) => {
      await h.goto(`/wedding/documents/new?deal=${dealId}`)
      await h.tap(h.page.getByRole('button', { name: /Универсальный договор/ }))
      await h.btn(/^Далее$/)
      await h.page.getByPlaceholder(/ФИО заказчика/).fill('Обход Анна Ивановна')
      await h.page.getByPlaceholder(/ФИО или название исполнителя/).fill(ids.name)
      await h.btn(/Сгенерировать договор/)
      await h.settle(1200)
      expect(/Договор готов/.test(await h.text()), 'экран «Договор готов»: ' + (await h.text()).slice(0, 200).replace(/\n/g, ' '))
      await h.goto('/wedding/documents')
      expect(/Универсальный|договор/i.test(await h.text()), 'документ в списке')
      expect(!h.bad.filter((x) => !x.includes('GET /vendor/profile 404') && !/ 401 $/.test(x)).length, 'без ≥400: ' + h.bad.join('; '))
    })
  })
  await step('DJ: сделки кабинета → карточка: аванс, договор, «Написать паре»', async () => {
    await asRole('dj', async (h) => {
      await h.goto('/vendor-app/deals')
      const t0 = await h.text()
      expect(/Аня Обход/.test(t0), 'сделка с парой в списке: ' + t0.slice(0, 200).replace(/\n/g, ' '))
      await h.tap(h.page.getByRole('button', { name: /Аня Обход/ }))
      expect(/^\/vendor-app\/deals\//.test(h.url()), 'карточка сделки, url ' + h.url())
      const t1 = await h.text()
      expect(/Оплачено|внесено|Аванс/i.test(t1), 'оплата видна подрядчику: ' + t1.slice(0, 400).replace(/\n/g, ' '))
      expect(/договор/i.test(t1), 'договор виден подрядчику')
      expect(/Написать паре/.test(t1), 'кнопка «Написать паре»')
      expect(!h.bad.filter((x) => !x.includes('GET /vendor/profile 404') && !/ 401 $/.test(x)).length, 'без ≥400: ' + h.bad.join('; '))
    })
  })
  await step('пара: ссылка гостю (API из сессии) → гость: конверт → RSVP «Приду» → «Ждём вас!»', async () => {
    await asRole('couple', async (h) => {
      await h.goto('/wedding/guests')
      const tok = await h.token()
      const r = await h.page.request.post(`http://127.0.0.1:3001/weddings/${pub.weddingId}/guests/${pub.guests[2]}/invite-link`, { headers: { authorization: 'Bearer ' + tok.accessToken } })
      expect(r.status() === 200 || r.status() === 201, 'ссылка гостю: ' + r.status())
      guestCode = (await r.json()).url.split('/').pop()
    })
    const b = await chromium.launch({ headless: true })
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
    const p = await c.newPage()
    const bad = []
    p.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.request().method()} ${r.url().slice(-60)} ${r.status()}`) })
    try {
      await p.goto(`${FE}/i/${guestCode}`, { waitUntil: 'domcontentloaded' })
      await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await p.waitForTimeout(800)
      expect(p.url().endsWith('/invite'), 'после обмена кода — /invite, url ' + p.url())
      const open = p.getByRole('button', { name: /Открыть приглашение/ }).first()
      const bx = await open.boundingBox()
      await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2)
      await p.waitForTimeout(1200)
      const tapBtn = async (re) => { const l = p.getByRole('button', { name: re }).first(); if (!(await l.count())) return false; await l.scrollIntoViewIfNeeded(); await p.waitForTimeout(600); const bb = await l.boundingBox(); await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(800); return true }
      if (!(await tapBtn(/Приду с радостью/))) { await tapBtn(/Всё-таки приду/) }
      await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await p.waitForTimeout(800)
      const txt = await p.evaluate(() => document.body.innerText)
      expect(/Ждём вас/.test(txt), '«Ждём вас!» после ответа: ' + txt.slice(0, 300).replace(/\n/g, ' '))
      // подарки: складчина на кофемашину
      await p.goto(`${FE}/gifts`, { waitUntil: 'domcontentloaded' })
      await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await p.waitForTimeout(500)
      const fund = p.getByRole('button', { name: /Скинуться/ }).first()
      const bf = await fund.boundingBox()
      expect(bf, 'кнопка «Скинуться» у групповой мечты')
      await p.mouse.click(bf.x + bf.width / 2, bf.y + bf.height / 2)
      await p.waitForTimeout(400)
      await p.getByPlaceholder(/Сумма/).fill('5000')
      const send = p.getByRole('button', { name: /Записать обещание/ }).first()
      const bs = await send.boundingBox()
      await p.mouse.click(bs.x + bs.width / 2, bs.y + bs.height / 2)
      await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await p.waitForTimeout(800)
      const g = await p.evaluate(() => document.body.innerText)
      expect(/Обещано\s[1-9]/.test(g), 'взнос учтён в «Обещано»: ' + g.slice(0, 300).replace(/\n/g, ' '))
      expect(!bad.length, 'гость без ≥400: ' + bad.join('; '))
    } finally { await b.close() }
  })
  await step('пара: гость в «Придут», складчина видна в желаниях', async () => {
    await asRole('couple', async (h) => {
      await h.goto('/wedding/guests')
      const t0 = await h.text()
      expect(/Придут/.test(t0), 'вкладка «Придут»')
      await h.btn(/^Придут/)
      expect(/Лена Обход/.test(await h.text()), 'Лена в списке «Придут»: ' + (await h.text()).slice(0, 300).replace(/\n/g, ' '))
      await h.goto('/wedding/wishlist')
      const t1 = await h.text()
      expect(/Обещано\s[1-9]/.test(t1), 'складчина видна паре: ' + t1.slice(0, 600).replace(/\n/g, ' '))
      expect(!h.bad.filter((x) => !x.includes('GET /vendor/profile 404') && !/ 401 $/.test(x)).length, 'без ≥400: ' + h.bad.join('; '))
    })
  })
}, { continueOnFail: true })
