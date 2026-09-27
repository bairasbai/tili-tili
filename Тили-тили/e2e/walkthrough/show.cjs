// Компактная таблица отчёта обхода: node show.cjs <name> [all]
const fs = require('fs')
const D = require('path').join((process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })()), 'crawl', 'out')
const [name, all] = process.argv.slice(2)
const r = JSON.parse(fs.readFileSync(`${D}/${name}.json`, 'utf8'))
for (const R of r.routes) {
  console.log(`== ${R.route}${R.url !== R.route ? ' → ' + R.url : ''}  h1=«${R.state && R.state.h1}» els=${R.total} ${R.ms ? Math.round(R.ms / 1000) + 's' : ''}${R.capped ? ' capped ' + R.capped : ''}`)
  if (R.skipped.length) console.log('   skipped: ' + R.skipped.map((s) => `${s.k} (${s.why})`).join(' | '))
  for (const e of R.els) {
    if (!all && e.r === 'ok') continue
    const bits = [e.r, e.nav ? '→' + e.nav : '', e.req ? 'req' + e.req : '', e.dialog ? 'dialog' : '', e.mut !== undefined ? 'mut' + e.mut : '', e.confirm ? 'confirm' : '', e.newPage ? 'newPage' : '', e.alerts ? 'alerts=' + JSON.stringify(e.alerts) : '', e.bad ? 'BAD ' + e.bad.join('; ') : '', e.errors ? 'ERR ' + e.errors.join('; ') : '', e.cover ? 'by ' + e.cover : '', e.clickErr ? 'clickErr ' + e.clickErr : ''].filter(Boolean)
    console.log(`   [${e.k}] ${bits.join(' ')}`)
  }
}
const loadBad = r.bad.filter((b) => /^(re)?load /.test(b.at))
if (loadBad.length) console.log('LOAD ≥400: ' + [...new Set(loadBad.map((b) => `${b.at.replace(/ #\d+$/, '')} ${b.m} ${b.u} ${b.s}`))].join('\n  '))
if (r.errors.length) console.log('ERRORS: ' + r.errors.map((e) => `${e.at}: ${e.kind} ${e.text.slice(0, 200)}`).join('\n  '))
if (r.newPages.length) console.log('NEW PAGES: ' + r.newPages.map((p) => `${p.at} → ${p.url}`).join('\n  '))
if (r.redeem) console.log('REDEEM: ' + JSON.stringify(r.redeem))
