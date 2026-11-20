// Сценарий: команда — пара выдаёт ссылку помощнику в /us/team → новый человек открывает /join/<code> без входа →
// вход по SMS → «Принять приглашение» → «Вы в команде!» → главная чужой свадьбы; бюджет закрыт для роли.
const fs = require('fs')
const { chromium } = require(process.env.PW_CORE || 'playwright-core')
const { ph, run, D, FE } = require('./flow-lib.cjs')
const digits = process.argv[2] || ph('094')
const phone = '+7' + digits
const expect = (c, what) => { if (!c) throw new Error('ожидалось: ' + what) }

run('flow-join', async (step, a) => {
  let code = null
  const { weddingId: expectedWeddingId } = await a.pub()
  await step('пара: /us/team → «Помощник» → ссылка с кодом на экране', async () => {
    const b = await chromium.launch({ headless: true })
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', storageState: `${D}/state-couple.json` })
    const p = await c.newPage()
    try {
      await p.goto(FE + '/us/team', { waitUntil: 'domcontentloaded' })
      await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await p.waitForTimeout(500)
      const helper = p.getByRole('button', { name: /Помощник/ }).first()
      const bx = await helper.boundingBox()
      expect(bx, 'кнопка «Помощник» на экране команды')
      await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2)
      await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await p.waitForTimeout(800)
      const txt = await p.evaluate(() => document.body.innerText)
      const m = txt.match(/\/join\/([A-ZА-Я0-9-]+)/i) || txt.match(/\b([А-ЯA-Z]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\b/)
      expect(m, 'код приглашения виден на экране: ' + txt.slice(0, 400).replace(/\n/g, ' '))
      code = m[1]
      expect(/Скопировать ссылку/.test(txt), 'кнопка «Скопировать ссылку»')
      await c.storageState({ path: `${D}/state-couple.json` })
    } finally { await b.close() }
    return { code }
  })
  await step('новый человек: /join/<code> без входа — предпросмотр, «Принять» → вход по SMS', async () => {
    await a.goto('/')
    await a.page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
    await a.goto('/join/' + code)
    const t0 = await a.text()
    expect(/приглашают вас/.test(t0) && /Аня Обход/.test(t0), 'предпросмотр с названием свадьбы: ' + t0.slice(0, 300).replace(/\n/g, ' '))
    expect(/помощник|Помощник/.test(t0), 'роль названа')
    await a.btn(/Принять приглашение/)
    expect(a.url() === '/auth', 'без входа ведёт на /auth, получили ' + a.url())
    await a.page.locator('input[type=tel]').fill(digits)
    const boxes = a.page.getByRole('checkbox')
    await a.tap(boxes.nth(0).locator('span'))
    await a.tap(boxes.nth(1).locator('span'))
    await a.btn(/^Получить код$/)
    await a.settle(600)
    const otp = await a.otp(phone)
    expect(otp && otp.length === 4, 'код в dev-логе')
    for (let k = 0; k < 4; k++) await a.page.locator(`#otp-${k}`).fill(otp[k])
    await a.btn(/^Войти/)
    await a.settle(1000)
    expect(a.url().startsWith('/join/'), 'после входа — обратно на /join, получили ' + a.url())
  })
  await step('«Принять приглашение» → «Вы в команде!» → «Открыть нашу свадьбу» → главная', async () => {
    const acceptPath = `/api/invites/${encodeURIComponent(code)}/accept`
    const [accepted] = await Promise.all([
      a.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === acceptPath),
      a.page.getByRole('button', { name: /^Принять приглашение$/ }).click(),
    ])
    expect(accepted.ok(), `вступление подтверждено сервером, HTTP ${accepted.status()}`)
    const { role, weddingId } = await accepted.json()
    expect(role === 'helper' && weddingId === expectedWeddingId, 'сервер выдал роль помощника для указанной свадьбы')
    await a.page.getByRole('heading', { name: 'Вы в команде!' }).waitFor({ state: 'visible' })
    await Promise.all([
      a.page.waitForURL(a.FE + '/home'),
      a.page.getByRole('button', { name: /Открыть нашу свадьбу/ }).click(),
    ])
    await a.page.getByText(/Аня Обход/).first().waitFor({ state: 'visible' })
    await a.page.getByText(/Бюджет ведёт пара/).first().waitFor({ state: 'visible' })
  })
  await step('помощник: /us/team показывает роль, /wedding/budget — «ведёт пара», без «Отменить свадьбу» в настройках', async () => {
    await a.goto('/us/team')
    await a.page.getByText('Помощник', { exact: true }).first().waitFor({ state: 'visible' })
    await a.goto('/wedding/budget')
    await a.page.getByText(/Бюджет ведёт пара/).first().waitFor({ state: 'visible' })
    await a.goto('/settings')
    await a.page.getByRole('button', { name: 'Удалить аккаунт', exact: true }).waitFor({ state: 'visible' })
    expect(await a.page.getByRole('button', { name: 'Отменить свадьбу', exact: true }).count() === 0, 'помощнику недоступна отмена свадьбы')
  })
  await step('повторное использование кода — «Ссылка истекла или отозвана»', async () => {
    await a.goto('/')
    await a.page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
    await a.goto('/join/' + code)
    const t = await a.text()
    expect(/истекла|отозвана/i.test(t), 'одноразовый код погашен: ' + t.slice(0, 300).replace(/\n/g, ' '))
  })
}, { continueOnFail: true, saveState: 'state-helper2.json' })
