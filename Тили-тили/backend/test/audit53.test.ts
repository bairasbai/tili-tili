import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Сторож серийной группы (F6, шаг 7-8) — без базы, без сети: устройство
 * прогона, а не поведение сервера.
 *
 * Файл, который проходит по всей таблице табличной задачей или правит
 * общий справочник категорий, делит состояние со всеми соседями (FP-1) —
 * он обязан идти по одному и после остальных (`vitest.serial.json`), а не
 * параллельно. Этот сторож — единственное, что держит список верным: он
 * красный, если список отстал от кода (новый файл завёл такой же импорт и
 * забыл себя дописать) или обогнал его (путь в списке ничего такого не
 * делает), и красный, если сама конфигурация не читает список или не
 * держит серийную группу отдельно от параллельной (R6-1).
 *
 * В список не входит сам этот файл: его литералы — образцы поиска для
 * проверки (4), в том числе `/admin/categories`, а не настоящие вызовы.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SELF = path.basename(fileURLToPath(import.meta.url))

function testFileNames(): string[] {
  return fs
    .readdirSync(DIR)
    .filter((name) => name.endsWith('.test.ts') && name !== SELF)
    .sort()
}

/* Один токенайзер на оба применения — вырезание комментариев и разбор
 * литералов — и то, и другое ОДНИМ проходом по одному и тому же устройству
 * распознавания строк. Раздельные проходы (сперва наивно резать `//…` по
 * всему тексту, потом искать литералы) ломаются на первом же `https://…`
 * внутри шаблонной строки: `//` там — часть адреса, а не комментарий, и
 * наивная резка срезает всё до конца строки, включая закрывающую кавычку —
 * дальше кавычки расходятся до конца файла. Здесь `//` и `/* … *\/` ищутся
 * TOGETHER с самими литералами: строковый литерал целиком (в том числе
 * многострочный шаблон и `://` внутри него) — один матч этого же регэкспа,
 * и `//`/`/* … *\/` внутри уже отработавшего матча строки заявку на новый
 * старт не получают.
 *
 * Регулярные литералы (F6-G6-05) — тем же проходом: без своей ветки кавычка
 * внутри `/…/` (например, `/"/g`) читалась бы как начало НАСТОЯЩЕЙ строки и
 * тянула бы разбор до следующей случайной кавычки в файле — голый
 * `update … set` без `where` между ними проверка (4) не увидела бы вовсе.
 * Признак начала — `/`, не после буквы/цифры/`$`/`)`/`]` (иначе это деление,
 * не литерал); тело — не `/`\`CR`LF`[`, экранированный символ или `[…]`
 * (класс символов, в котором `]` без экрана не бывает); перевод строки внутри
 * тела не бывает — как и в настоящем JS, недописанный до конца строки «регэкс»
 * такой веткой не матчится и остаётся обычным текстом (деление, а не литерал).
 * Найденный литерал — как комментарий: не несёт значения, из текста вырезается. */
const TOKEN =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<![\w$)\]])\/(?:[^/\\\r\n[]|\\.|\[(?:[^\]\\\r\n]|\\.)*\])+\/[a-z]*|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gs
/** Комментарии и регулярные литералы начинаются с `/` — строковые и шаблонные
 *  литералы никогда: единственного признака достаточно (F6-G6-05). */
const isComment = (token: string) => token.startsWith('/')

/** Комментарии вырезаны, строковые литералы — байт в байт как в исходнике. */
function stripComments(text: string): string {
  return text.replace(TOKEN, (m) => (isComment(m) ? '' : m))
}

/** Все строковые и шаблонные литералы файла — целиком, не построчно: SQL
 *  часто многострочный, и `where` может стоять на следующей строке того же
 *  запроса — резать по строке значило бы путать перенос строки с концом
 *  запроса (проверено на `audit7.test.ts`/`stage7.test.ts` — там `where`
 *  всегда на следующей строке того же литерала). */
function stringLiterals(rawText: string): string[] {
  const out: string[] = []
  for (const m of rawText.matchAll(TOKEN)) {
    if (!isComment(m[0])) out.push(m[0])
  }
  return out
}

const JOBS_EXPORTS_EXCLUDED = new Set(['eraseUser', 'registerJobs', 'JobStats'])

/** Импортирует табличную задачу (jobs/index.js — всё, кроме eraseUser,
 *  registerJobs и типов; reviews/rating.js — recomputeAllRatings;
 *  notify/push.js — sendDuePushes) или трогает справочник категорий. */
function touchesSharedState(rawText: string): boolean {
  const code = stripComments(rawText)

  const jobsImport = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]\.\.\/src\/jobs\/index\.(?:js|ts)['"]/g
  for (const m of code.matchAll(jobsImport)) {
    // Группа обязательная (не `(…)?`) — при матче она всегда захвачена, пусть
    // и пустой строкой; `!` закрывает TS2532 под noUncheckedIndexedAccess.
    const names = m[1]!
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean)
    if (names.some((n) => !JOBS_EXPORTS_EXCLUDED.has(n))) return true
  }
  if (/from\s*['"]\.\.\/src\/reviews\/rating\.(?:js|ts)['"]/.test(code) && /\brecomputeAllRatings\b/.test(code)) return true
  if (/from\s*['"]\.\.\/src\/notify\/push\.(?:js|ts)['"]/.test(code) && /\bsendDuePushes\b/.test(code)) return true
  if (code.includes('/admin/categories')) return true
  if (/\b(insert\s+into|update|delete\s+from)\s+(categories|category_synonyms)\b/i.test(code)) return true
  return false
}

function readSerialList(): string[] {
  const p = path.join(DIR, '..', 'vitest.serial.json')
  if (!fs.existsSync(p)) return [] // нет файла — пустой список (F6 шаг 7)
  return JSON.parse(fs.readFileSync(p, 'utf8')) as string[]
}

/**
 * Индекс закрывающей скобки, парной открывающей на `openIdx` (F6-G6-04).
 *
 * `{`/`[` считаются в одну глубину (валидный TS их и так вкладывает
 * согласованно) — отдельного типа парности не нужно. Строковые/шаблонные
 * литералы и комментарии пропускаются ЦЕЛИКОМ тем же `TOKEN`, что и выше:
 * скобка внутри пути (`'./vitest.serial.json'`) или комментария в глубину
 * не считается. `-1` — скобки не сошлись (испорченный файл).
 *
 * `TOKEN` — общий модульный regex с флагом `g`, которым пользуется и (4)
 * (`stringLiterals`, через `matchAll` — по спеку ECMA-262 `matchAll` СНИМАЕТ
 * стартовую позицию с `lastIndex` регэкспа В МОМЕНТ ВЫЗОВА). Ручной
 * `TOKEN.exec()` ниже двигает `TOKEN.lastIndex`; без сброса в `finally` ниже
 * не покрывал (F6-G4r5, P1-смежная находка): после (3) он оставался на
 * позиции последнего найденного здесь токена (успешный выход по `depth===0`
 * или исчерпание текста — оба пути без явного «нет совпадения», который
 * иначе обнулил бы его сам), и (4) в СЛЕДУЮЩЕМ `it` начинал `matchAll` не с
 * начала файла, а с этого чужого места — совпадения съезжали, кавычки
 * расходились, и в offenders набивался мусор из audit15/audit43/audit44/
 * audit8/stage7 (порядок тестов внутри файла — объявленный, (3) перед (4)). */
function matchBracket(text: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  try {
    while (i < text.length) {
      const ch = text[i]!
      if (ch === '"' || ch === "'" || ch === '`' || (ch === '/' && (text[i + 1] === '*' || text[i + 1] === '/'))) {
        TOKEN.lastIndex = i
        const m = TOKEN.exec(text)
        if (m && m.index === i) {
          i += m[0].length
          continue
        }
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return i
      }
      i++
    }
    return -1
  } finally {
    TOKEN.lastIndex = 0
  }
}

describe('audit53: устройство серийной группы держит верный список файлов', () => {
  const serial = readSerialList()
  const serialSet = new Set(serial)

  it('(1) каждый файл, трогающий общее состояние, — в vitest.serial.json', () => {
    const missing: string[] = []
    for (const name of testFileNames()) {
      const text = fs.readFileSync(path.join(DIR, name), 'utf8')
      if (touchesSharedState(text) && !serialSet.has(`test/${name}`)) missing.push(name)
    }
    expect(missing, `трогают общее состояние, но не в списке: ${missing.join(', ')}`).toEqual([])
  })

  it('(2) каждый путь списка существует и подпадает под правило (1)', () => {
    const bad: string[] = []
    for (const rel of serial) {
      const abs = path.join(DIR, '..', rel)
      if (!fs.existsSync(abs)) {
        bad.push(`${rel}: пути не существует`)
        continue
      }
      if (!touchesSharedState(fs.readFileSync(abs, 'utf8'))) bad.push(`${rel}: не трогает общее состояние`)
    }
    expect(bad, bad.join('; ')).toEqual([])
  })

  it('(3) vitest.config.ts читает vitest.serial.json и держит серийную группу отдельно проектом', () => {
    const cfgPath = path.join(DIR, '..', 'vitest.config.ts')
    const cfg = fs.readFileSync(cfgPath, 'utf8')
    expect(cfg.includes('vitest.serial.json'), 'конфигурация не читает vitest.serial.json').toBe(true)
    expect(/\bprojects\s*:/.test(cfg), 'нет test.projects').toBe(true)
    expect(/fileParallelism\s*:\s*false/.test(cfg), 'нет fileParallelism: false у серийного проекта').toBe(true)
    expect(/groupOrder\s*:\s*1/.test(cfg), 'нет sequence.groupOrder: 1').toBe(true)
    /* R6-1: корневой `test.include` склеился бы с `include: SERIAL` через
     * `extends: true` + `mergeConfig` (массивы конкатенируются) — серийный
     * проект получил бы ВСЕ файлы, а не-серийные шли бы дважды. Вырезаем
     * ИМЕННО массив `projects: [...]` по границам скобок (F6-G6-04: не по
     * первому вхождению слова «projects» текстом — оно может стоять раньше
     * корневого `include`, а корневой `include` может стоять и ПОСЛЕ того,
     * как массив `projects` уже закрылся, в том же объекте `test`, — старая
     * проверка такую перестановку не видела) и ищем ВКЛЮЧЕНИЕ ФАЙЛОВ ТЕСТА
     * (значение начинается на `test/`) в том, что осталось: это и есть
     * корневой блок `test` целиком, а не только его префикс. `coverage.include`
     * (значения `src/**\/*.ts`) — другое поле с тем же именем ключа и
     * законно остаётся в корне; отличать по значению, не по имени ключа. */
    const projectsArray = /\bprojects\s*:\s*\[/.exec(cfg)
    const bracketStart = projectsArray ? projectsArray.index + projectsArray[0].length - 1 : -1
    const bracketEnd = bracketStart >= 0 ? matchBracket(cfg, bracketStart) : -1
    expect(bracketEnd, 'скобки projects: [...] не сошлись').toBeGreaterThanOrEqual(0)
    const withoutProjectsArray = cfg.slice(0, bracketStart) + cfg.slice(bracketEnd + 1)
    expect(
      /include\s*:\s*\[\s*['"]test\//.test(withoutProjectsArray),
      'include с путём test/… не должен остаться в корневом test — только в projects (R6-1)',
    ).toBe(false)
  })

  it('(4) без update/delete по всей таблице в строковых литералах теста (кроме stage1 — там ждут отказа триггера)', () => {
    const offenders: string[] = []
    const bare = /\b(update\s+\w+\s+set\b|delete\s+from\s+\w+\b)/gi
    for (const name of testFileNames()) {
      if (name === 'stage1.test.ts') continue
      const raw = fs.readFileSync(path.join(DIR, name), 'utf8')
      for (const literal of stringLiterals(raw)) {
        bare.lastIndex = 0
        if (bare.test(literal) && !/\bwhere\b/i.test(literal)) {
          offenders.push(`${name}: ${literal.replace(/\s+/g, ' ').slice(0, 100)}`)
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
