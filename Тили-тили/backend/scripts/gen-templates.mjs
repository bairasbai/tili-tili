/**
 * Категории и шаблоны новой свадьбы берутся из `app/src/lib/data.ts` —
 * там же, откуда их рисует фронт. Вторая копия разошлась бы с первой.
 *
 * Важное отличие сида от мока: в моке свадьба показана «в разгаре» —
 * площадка забронирована, пять задач сделаны. Новой паре достаётся тот же
 * НАБОР, но пустой: слоты без сделок, задачи не отмечены. Иначе человек
 * увидит чужие брони в своей свадьбе.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
export const SOURCE_FILE = path.resolve(here, '..', '..', 'app', 'src', 'lib', 'data.ts')
export const CATEGORIES_FILE = path.resolve(here, '..', 'migrations', 'data', 'categories.json')
export const TEMPLATES_FILE = path.resolve(here, '..', 'src', 'wedding', 'templates.generated.ts')

/** `t('Фотограф')` и `'CinemaWedding'` — обе формы встречаются в данных. */
function unwrap(raw) {
  const t = /^t\('(.*)'\)$/.exec(raw.trim())
  if (t) return t[1]
  const plain = /^'(.*)'$/.exec(raw.trim())
  return plain ? plain[1] : raw.trim()
}

function section(src, name) {
  const start = src.indexOf(`export const ${name}`)
  if (start < 0) throw new Error(`${name} не найден`)
  const end = src.indexOf('\n]', start)
  if (end < 0) throw new Error(`${name}: конец списка не найден`)
  return src.slice(start, end)
}

export function readSeeds(file = SOURCE_FILE) {
  const src = fs.readFileSync(file, 'utf8')

  const categories = []
  for (const m of section(src, 'categories').matchAll(
    /\{\s*id:\s*'([^']+)'\s*,\s*name:\s*(t\('[^']*'\)|'[^']*')\s*,\s*icon:\s*'([^']*)'\s*,\s*tile:\s*'([^']*)'/g,
  )) {
    categories.push({ id: m[1], name: unwrap(m[2]), icon: m[3], tile: m[4] })
  }

  // Из мока берётся только состав мозаики: категория, подпись и порядок.
  // Брони, подрядчики и цены — чужие данные, в шаблон не идут.
  const slots = []
  for (const m of section(src, 'initialSlots').matchAll(
    /\{\s*id:\s*'[^']+'\s*,\s*categoryId:\s*'([^']+)'\s*,\s*label:\s*(t\('[^']*'\)|'[^']*')/g,
  )) {
    slots.push({ categoryId: m[1], label: unwrap(m[2]), sort: slots.length })
  }

  // `period` — за сколько месяцев до свадьбы. В моке это строка для группировки,
  // здесь из неё считается настоящая дата дедлайна относительно даты свадьбы.
  const tasks = []
  for (const m of section(src, 'tasks').matchAll(
    /\{\s*id:\s*'[^']+'\s*,\s*title:\s*(t\('[^']*'\)|'[^']*')[^}]*?period:\s*'(\d+)'/g,
  )) {
    tasks.push({ title: unwrap(m[1]), monthsBefore: Number(m[2]), sort: tasks.length })
  }

  const timeline = []
  for (const m of section(src, 'timeline').matchAll(
    /\{\s*id:\s*'[^']+'\s*,\s*icon:\s*'([^']*)'[^}]*?name:\s*(t\('[^']*'\)|'[^']*')\s*,\s*loc:\s*(t\('[^']*'\)|'[^']*')\s*,\s*time:\s*'(\d{2}:\d{2}) — (\d{2}:\d{2})'\s*,\s*who:\s*(t\('[^']*'\)|'[^']*')/g,
  )) {
    timeline.push({
      icon: m[1],
      name: unwrap(m[2]),
      // Место и участники в моке привязаны к чужой свадьбе — в шаблоне пусто.
      location: null,
      startsAt: m[4],
      endsAt: m[5],
      who: null,
      sort: timeline.length,
    })
  }

  // Пять строк бюджета и доля каждой. В моке лимиты заданы под свадьбу за
  // 1,5 млн; у новой пары бюджет свой, поэтому берётся не сумма, а ДОЛЯ
  // от общей — так лимиты масштабируются под любой бюджет.
  const budget = []
  for (const m of section(src, 'budgetItems').matchAll(
    /\{\s*name:\s*(t\('[^']*'\)|'[^']*')\s*,\s*amount:\s*rub\((\d+)\)\s*,\s*limit:\s*rub\((\d+)\)\s*,\s*color:\s*'([^']*)'/g,
  )) {
    budget.push({ title: unwrap(m[1]), limitRub: Number(m[3]), color: m[4] })
  }
  const limitSum = budget.reduce((a, b) => a + b.limitRub, 0)
  const budgetCategories = budget.map((b, i) => ({
    id: `b${i + 1}`,
    title: b.title,
    color: b.color,
    share: limitSum > 0 ? Math.round((b.limitRub / limitSum) * 10000) / 10000 : 0,
  }))

  // Какая категория подрядчика к какой строке бюджета относится. Источник —
  // categoryOf() в `lib/budget.ts`: там же, где это считает фронт.
  const byTitle = new Map(budgetCategories.map((b) => [b.title, b.id]))
  const mapping = {}
  const budgetSrc = fs.readFileSync(path.resolve(path.dirname(file), 'budget.ts'), 'utf8')
  const catOf = budgetSrc.slice(
    budgetSrc.indexOf('export function categoryOf'),
    budgetSrc.indexOf('export interface BudgetRow'),
  )
  for (const m of catOf.matchAll(/(\w+):\s*(t\('[^']*'\))/g)) {
    const id = byTitle.get(unwrap(m[2]))
    if (id) mapping[m[1]] = id
  }
  // Пустое сопоставление означало бы, что ВСЕ сделки попадают в «Прочее»
  // и бюджет по категориям врёт. Молча этого допускать нельзя.
  if (Object.keys(mapping).length === 0) {
    throw new Error('categoryOf() не разобрался: сопоставление категорий пусто')
  }

  return { categories, slots, tasks, timeline, budgetCategories, mapping }
}

export function render({ slots, tasks, timeline, budgetCategories, mapping }) {
  return [
    '/* СГЕНЕРИРОВАНО. Не править руками — правится app/src/lib/data.ts,',
    ' * потом `pnpm run gen:templates`. */',
    '',
    'export interface SlotTemplate {',
    '  readonly categoryId: string',
    '  readonly label: string',
    '  readonly sort: number',
    '}',
    '',
    'export interface TaskTemplate {',
    '  readonly title: string',
    '  /** За сколько месяцев до свадьбы истекает срок. */',
    '  readonly monthsBefore: number',
    '  readonly sort: number',
    '}',
    '',
    'export interface TimelineTemplate {',
    '  readonly icon: string',
    '  readonly name: string',
    '  readonly location: string | null',
    '  readonly startsAt: string',
    '  readonly endsAt: string',
    '  readonly who: string | null',
    '  readonly sort: number',
    '}',
    '',
    `export const SLOT_TEMPLATE: readonly SlotTemplate[] = [`,
    ...slots.map((s) => `  ${JSON.stringify(s)},`),
    '] as const',
    '',
    `export const TASK_TEMPLATE: readonly TaskTemplate[] = [`,
    ...tasks.map((t) => `  ${JSON.stringify(t)},`),
    '] as const',
    '',
    `export const TIMELINE_TEMPLATE: readonly TimelineTemplate[] = [`,
    ...timeline.map((e) => `  ${JSON.stringify(e)},`),
    '] as const',
    '',
    'export interface BudgetCategory {',
    '  readonly id: string',
    '  readonly title: string',
    '  readonly color: string',
    '  /** Доля от общего бюджета пары: лимиты мока пересчитаны в проценты. */',
    '  readonly share: number',
    '}',
    '',
    'export const BUDGET_CATEGORIES: readonly BudgetCategory[] = [',
    ...budgetCategories.map((b) => `  ${JSON.stringify(b)},`),
    '] as const',
    '',
    '/** Категория подрядчика — строка бюджета. Неизвестная попадает в «Прочее». */',
    `export const BUDGET_BY_VENDOR_CATEGORY: Readonly<Record<string, string>> = ${JSON.stringify(mapping, null, 2)}`,
    '',
    `export const BUDGET_FALLBACK = ${JSON.stringify(budgetCategories.at(-1)?.id ?? 'b5')}`,
    '',
  ].join('\n')
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const seeds = readSeeds()
  fs.mkdirSync(path.dirname(CATEGORIES_FILE), { recursive: true })
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(seeds.categories, null, 2) + '\n', 'utf8')
  fs.mkdirSync(path.dirname(TEMPLATES_FILE), { recursive: true })
  fs.writeFileSync(TEMPLATES_FILE, render(seeds), 'utf8')
  console.log(
    `категорий ${seeds.categories.length}, слотов ${seeds.slots.length}, задач ${seeds.tasks.length}, ` +
      `событий ${seeds.timeline.length}, строк бюджета ${seeds.budgetCategories.length}, ` +
      `сопоставлений ${Object.keys(seeds.mapping).length}`,
  )
}
