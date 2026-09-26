// Сценарий: новая пара — онбординг → вход по SMS → квиз → свадьба создана → главная. node flow-onboard.cjs <10 цифр>
const { ph, run } = require('./flow-lib.cjs')
const digits = process.argv[2] || ph('090')
// Имя отчёта: второй прогон онбординга (подготовка номера для разрушительных сценариев) не затирает основной.
const name = process.argv[3] || 'flow-onboard'
const phone = '+7' + digits
run(name, async (step, a) => {
  await step('онбординг: слайды → «Начать» → /auth', async () => {
    await a.goto('/')
    for (let i = 0; i < 6; i++) {
      const start = a.page.getByRole('button', { name: /^Начать/ })
      if (await start.count()) { await a.tap(start); break }
      await a.btn(/^Далее/)
    }
    await a.settle()
    a.expect(a.url() === '/auth', '/auth, получили ' + a.url())
  })
  await step('вход: номер, две галочки, «Получить код» активна', async () => {
    await a.page.locator('input[type=tel]').fill(digits)
    const boxes = a.page.getByRole('checkbox')
    a.expect((await boxes.count()) === 2, 'две галочки, есть ' + (await boxes.count()))
    await a.tap(boxes.nth(0).locator("span"))
    await a.tap(boxes.nth(1).locator("span"))
    const checked = await boxes.evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')))
    a.expect(checked.join() === 'true,true', 'обе отмечены, есть ' + checked.join())
    const get = a.page.getByRole('button', { name: /^Получить код/ })
    a.expect(!(await get.isDisabled()), '«Получить код» активна')
    await a.tap(get)
    await a.settle(600)
    a.expect(await a.has(/Код из SMS/), 'шаг кода')
    return { checked }
  })
  await step('код из SMS (dev-лог) → «Войти» → выбор пути', async () => {
    const code = await a.otp(phone)
    a.expect(code && code.length === 4, 'код найден в логе')
    for (let k = 0; k < 4; k++) await a.page.locator(`#otp-${k}`).fill(code[k])
    await a.btn(/^Войти/)
    await a.settle(800)
    a.expect(await a.has(/Мы планируем свадьбу/), 'шаг «кто вы» для нового номера')
  })
  await step('«Мы планируем свадьбу» → квиз', async () => {
    await a.btn(/Мы планируем свадьбу/)
    a.expect(a.url() === '/quiz', '/quiz, получили ' + a.url())
    a.expect(await a.has(/Когда ваша свадьба/), 'первый вопрос')
  })
  // Фича 018: формат «Выездная церемония» и «Площадка» в «уже забронировано» доходят до свадьбы кодами;
  // последний шаг — два имени, и своё уходит в профиль до создания свадьбы.
  await step('квиз: 9 шагов → «Создать мою свадьбу»', async () => {
    await a.btn(/Ещё не решили/); await a.btn(/^Далее/)
    await a.btn(/^Уфа$/); await a.btn(/^Далее/)
    await a.btn(/^30–60$/); await a.btn(/^Далее/)
    await a.btn(/1–2 млн/); await a.btn(/^Далее/)
    await a.btn(/Выездная церемония/); await a.btn(/^Далее/)
    await a.tap(a.page.locator("button.card-s")); await a.btn(/^Далее/)
    await a.btn(/^Сами$/); await a.btn(/^Далее/)
    await a.btn(/^Площадка$/); await a.btn(/^Далее/)
    a.expect(await a.has(/Как вас зовут/), 'последний шаг — имена')
    const create = a.page.getByRole('button', { name: /Создать мою свадьбу/ })
    const own = a.page.getByPlaceholder('Ваше имя')
    const partner = a.page.getByPlaceholder('Имя партнёра')
    a.expect((await own.inputValue()) === '', 'у нового номера имени в профиле нет — поле пустое')
    a.expect(await create.isDisabled(), 'без имён кнопка закрыта')
    await partner.fill('Тимур')
    a.expect(await create.isDisabled(), 'без своего имени кнопка закрыта')
    await own.fill('Алина')
    a.expect(!(await create.isDisabled()), 'с двумя именами кнопка открыта')
    await a.tap(create)
    await a.page.waitForURL('**/home', { timeout: 15000 })
    await a.settle(800)
    return { url: a.url(), h1: await a.page.locator('h1').first().innerText() }
  })
  await step('главная новой свадьбы: «Алина ♥ Тимур», «Площадка — Уже забронировано», чек-лист, мозаика', async () => {
    const txt = await a.text()
    a.expect(/Алина ♥ Тимур/.test(txt), 'название из двух имён: «Алина ♥ Тимур»')
    a.expect(/Чек-лист/.test(txt), 'блок чек-листа')
    const venue = a.page.locator('[data-testid="prebooked-slot"]', { hasText: 'Площадка' })
    a.expect((await venue.count()) === 1, 'на главной одна плитка «Площадка» с отметкой, есть ' + (await venue.count()))
    // Кнопки пары появляются по ответу GET /weddings (роль): ждём их, а не читаем карточку раньше.
    await venue.first().getByRole('button', { name: 'Нет, ещё ищем' }).waitFor({ state: 'visible', timeout: 8000 })
    const card = await venue.first().innerText()
    a.expect(/Уже забронировано/.test(card), 'плитка «Площадка — Уже забронировано»: ' + card.replace(/\s+/g, ' '))
    a.expect(/Добавить подрядчика/.test(card) && /Нет, ещё ищем/.test(card), 'у пары два действия на плитке')
    await a.goto('/wedding')
    a.expect(await a.has(/Фотограф|Площадка/), 'мозаика слотов')
    a.expect(await a.has(/Площадка выездной церемонии/) && await a.has(/Церемониймейстер/), 'выездная церемония добавила два слота')
    return { weddingTitle: (txt.match(/[^\n]*♥[^\n]*/) || [''])[0], card: card.replace(/\s+/g, ' ') }
  })
  await step('«Добавить подрядчика» на плитке → форма своего подрядчика открыта, страница не шире экрана', async () => {
    await a.goto('/home')
    const venue = a.page.locator('[data-testid="prebooked-slot"]', { hasText: 'Площадка' })
    await a.tap(venue.getByRole('button', { name: 'Добавить подрядчика' }))
    a.expect(/^\/wedding\/slot\//.test(a.url()), 'экран слота, получили ' + a.url())
    a.expect(await a.page.getByPlaceholder(/Имя \/ название/).isVisible(), 'форма своего подрядчика открыта сразу')
    // Строка «Цена / Телефон» раздувала страницу до 449 px на экране 390 px (ERR-0309).
    const [scroll, inner] = await a.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth])
    a.expect(scroll <= inner, `страница шире экрана: ${scroll} > ${inner}`)
    return { url: a.url(), scroll, inner }
  })
  await step('повторный вход тем же номером ведёт сразу на главную', async () => {
    await a.page.evaluate(() => localStorage.clear())
    await a.goto('/auth')
    await a.page.locator('input[type=tel]').fill(digits)
    const boxes = a.page.getByRole('checkbox')
    await a.tap(boxes.nth(0).locator("span"))
    await a.tap(boxes.nth(1).locator("span"))
    await a.page.waitForTimeout(61000)
    await a.btn(/^Получить код$/)
    await a.settle(600)
    const code = await a.otp(phone)
    for (let k = 0; k < 4; k++) await a.page.locator(`#otp-${k}`).fill(code[k])
    await a.btn(/^Войти/)
    await a.page.waitForURL('**/home', { timeout: 15000 })
    return { url: a.url() }
  })
}, { saveState: name === 'flow-onboard' ? 'state-newcouple.json' : undefined })
