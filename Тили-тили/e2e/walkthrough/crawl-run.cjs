// Автономный запуск обходчика без MCP: chromium headless + тело crawl-body.js. Сводка → stdout, отчёт → crawl/out/<name>.json.
const fs = require('fs')
const D = require('path').join((process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })()), 'crawl')
const { chromium } = require(process.env.PW_CORE || 'playwright-core')
;(async () => {
  const job = JSON.parse(fs.readFileSync(`${D}/job.json`, 'utf8'))
  const body = fs.readFileSync(require('path').join(__dirname, 'crawl-body.js'), 'utf8')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: job.viewport || { width: 390, height: 844 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', storageState: fs.existsSync(`${D}/state-${job.role}.json`) && !job.setup ? `${D}/state-${job.role}.json` : undefined })
  const page = await ctx.newPage()
  let out
  try {
    out = await new Function('page', 'return (' + body + ')(page)')(page)
    // Сессия роли (localStorage с обновлёнными токенами) — для следующих чанков без setup.
    await ctx.storageState({ path: `${D}/state-${job.role}.json` })
  } catch (e) {
    out = 'CRASH ' + (e.stack || e.message)
  }
  console.log(out)
  await browser.close()
})()
