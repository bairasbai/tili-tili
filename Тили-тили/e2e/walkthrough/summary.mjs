// Сводка живого обхода — в лог и, в CI, в $GITHUB_STEP_SUMMARY. По заданию обхода: строки обходчика и находки,
// которые требуют взгляда человека; по сценарию — шаги ✓/✗. Полные отчёты — $LIVE_DIR/crawl/out/*.json.
//
// Код выхода 1 — явная поломка: сценарий не прошёл, у задания нет отчёта, обходчик упал (CRASH) или упёрся в экран
// ошибки (boundary). «no-effect», «covered», ответы ≥400 — находки на разбор, а не повод красить прогон: часть из них
// законна (отказ по роли словами, кнопка без запроса по замыслу), их отделяет человек, как в обходе 19.09.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const LIVE = process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })()
const D = `${LIVE}/crawl/out`
const JOBS = ['couple-2', 'couple-3', 'couple-4', 'couple-5', 'couple-6', 'helper-1', 'coord-1', 'vendor-1', 'florist-1', 'staff-1', 'guest-1', 'couple-d']
const FLOWS = ['flow-onboard', 'flow-vendor', 'flow-deal', 'flow-lead', 'flow-join', 'flow-misc', 'flow-onboard-092', 'flow-destructive']
const SHOW = 12 // строк находок на задание в сводке; остальное — в полном отчёте

const out = []
let broken = 0

// Раздел лога обходчика: строки после заголовка («ISSUES:») до следующего заголовка или пустой строки.
const section = (lines, title) => {
  const i = lines.indexOf(title)
  if (i < 0) return []
  const rows = []
  for (let k = i + 1; k < lines.length && lines[k] && !/^[A-Za-zА-Я ≥]+:( |$)/.test(lines[k]); k++) rows.push(lines[k])
  return rows
}

out.push('## Обход ролей', '')
for (const job of JOBS) {
  const file = `${D}/${job}.log`
  const log = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!log.trim()) { out.push(`- **${job}: нет отчёта**`); broken++; continue }
  const lines = log.split(/\r?\n/)
  const clicks = lines.find((l) => l.startsWith('clicks:')) ?? ''
  const boundary = Number(/boundary (\d+)/.exec(clicks)?.[1] ?? 0)
  const crash = /\bCRASH\b/.test(log)
  if (crash || boundary > 0) broken++
  out.push(`- ${crash || boundary ? '**✗** ' : ''}${lines[0]}`, `  - ${clicks || 'clicks: —'}`)
  const loadBad = section(lines, 'LOAD ≥400:')
  const issues = section(lines, 'ISSUES:')
  const loads = section(lines, 'LOADS:')
  for (const [title, rows] of [['не на своём адресе', loads], ['загрузка ≥400', loadBad], ['находки', issues]]) {
    if (!rows.length) continue
    out.push(`  - ${title} (${rows.length}):`)
    for (const r of rows.slice(0, SHOW)) out.push(`    - \`${r.slice(0, 220)}\``)
    if (rows.length > SHOW) out.push(`    - … ещё ${rows.length - SHOW}`)
  }
}

out.push('', '## Сценарии', '')
for (const name of FLOWS) {
  const file = `${D}/${name}.json`
  if (!existsSync(file)) {
    broken++
    const txt = existsSync(`${D}/${name}.txt`) ? readFileSync(`${D}/${name}.txt`, 'utf8').trim().slice(-600) : ''
    out.push(`- **✗ ${name}: нет отчёта**${txt ? '\n\n```\n' + txt + '\n```' : ''}`)
    continue
  }
  const r = JSON.parse(readFileSync(file, 'utf8'))
  const done = r.steps.filter((s) => s.ok).length
  if (!r.ok) broken++
  out.push(`- ${r.ok ? '✓' : '**✗**'} ${name}: ${done}/${r.steps.length} шагов`)
  for (const s of r.steps.filter((x) => !x.ok)) {
    out.push(`  - ✗ ${s.label} @${s.url}: ${String(s.error).slice(0, 300)}`)
    if (s.page) out.push(`    - экран: «${s.page.slice(0, 200).replace(/\s+/g, ' ')}»`)
  }
  if (r.fatal) out.push(`  - FATAL ${r.fatal.slice(0, 300)}`)
  const bad = [...new Set(r.steps.flatMap((s) => s.bad ?? []))]
  if (bad.length) out.push(`  - ответы ≥400 (${bad.length}): ${bad.slice(0, 6).map((b) => '`' + b.slice(0, 120) + '`').join(', ')}`)
}

out.push('', broken ? `**Итог: явных поломок — ${broken}.**` : '**Итог: явных поломок нет; находки выше — на разбор.**')
const text = out.join('\n')
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
process.exitCode = broken ? 1 : 0
