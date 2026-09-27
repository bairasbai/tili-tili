// Разрушительные сценарии на одноразовых аккаунтах (последними): отмена свадьбы (092), отзыв согласия (091), удаление аккаунта (090).
// Каждый — свой вход по SMS через UI (после разлогина/удаления сессий).
const { ph, run } = require('./flow-lib.cjs')
const expect = (c, what) => { if (!c) throw new Error('ожидалось: ' + what) }

async function login(a, digits) {
  await a.goto('/')
  await a.page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await a.goto('/auth')
  await a.page.locator('input[type=tel]').fill(digits)
  const boxes = a.page.getByRole('checkbox')
  await a.tap(boxes.nth(0).locator('span'))
  await a.tap(boxes.nth(1).locator('span'))
  await a.btn(/^Получить код$/)
  await a.settle(600)
  const code = await a.otp('+7' + digits)
  expect(code && code.length === 4, 'код в dev-логе для ' + digits)
  for (let k = 0; k < 4; k++) await a.page.locator(`#otp-${k}`).fill(code[k])
  await a.btn(/^Войти/)
  await a.settle(1200)
}

run('flow-destructive', async (step, a) => {
  await step('092: вход → настройки → «Отменить свадьбу» → подтверждение → свадьбы нет, главная честная', async () => {
    await login(a, ph('092'))
    expect(a.url() === '/home', 'после входа — /home, получили ' + a.url())
    await a.goto('/settings')
    await a.btn(/^Отменить свадьбу$/)
    expect(await a.has(/Подтвердить отмену/), 'кнопка подтверждения отмены')
    await a.btn(/Подтвердить отмену/)
    await a.settle(1500)
    const t = await a.text()
    const url = a.url()
    expect(!/Отменить свадьбу/.test(t) || url !== '/settings', 'после отмены — состояние без свадьбы: ' + url + ' ' + t.slice(0, 300).replace(/\n/g, ' '))
    await a.goto('/home')
    const home = await a.text()
    return { url, home: home.slice(0, 200).replace(/\n/g, ' ') }
  })
  await step('091: вход → «Отозвать согласие» → подтверждение → выход; повторный вход просит согласие заново', async () => {
    await login(a, ph('091'))
    await a.goto('/settings')
    await a.btn(/Отозвать согласие/)
    expect(await a.has(/Подтвердить отзыв согласия/), 'кнопка подтверждения отзыва')
    await a.btn(/Подтвердить отзыв согласия/)
    await a.settle(1500)
    const url = a.url()
    const left = await a.page.evaluate(() => localStorage.getItem('tt_auth'))
    expect(!left, 'токены стёрты после отзыва согласия; url ' + url)
    await a.page.waitForTimeout(61000)
    await login(a, ph('091'))
    return { urlAfterWithdraw: url, urlAfterRelogin: a.url(), text: (await a.text()).slice(0, 160).replace(/\n/g, ' ') }
  })
  await step('090: вход → «Удалить аккаунт и все данные» → подтверждение → выход; вход тем же номером — новый аккаунт без свадьбы', async () => {
    await login(a, ph('090'))
    await a.goto('/settings')
    await a.btn(/Удалить аккаунт и все данные/)
    expect(await a.has(/Подтвердить удаление/), 'кнопка подтверждения удаления')
    await a.btn(/Подтвердить удаление/)
    await a.settle(1500)
    const url = a.url()
    const t = await a.text()
    const left = await a.page.evaluate(() => localStorage.getItem('tt_auth'))
    await a.page.waitForTimeout(61000)
    await login(a, ph('090'))
    const after = await a.text()
    return { urlAfterDelete: url, textAfterDelete: t.slice(0, 160).replace(/\n/g, ' '), tokensLeft: !!left, urlAfterRelogin: a.url(), freshUser: /Мы планируем свадьбу/.test(after) }
  })
}, { continueOnFail: true })
