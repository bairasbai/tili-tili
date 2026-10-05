/*
 * Разбор вставленного списка гостей (фича 008, План §20.1 экран 29).
 *
 * Пара вставляет список из заметок, таблицы или мессенджера — строка на
 * гостя. Разбор идёт здесь, на клиенте: предпросмотр должен появляться по
 * мере набора, без запроса. Сервер (`POST …/guests/import`) принимает уже
 * разобранные строки, сам приводит телефон к `+7…` и сам решает, что
 * дубликат, — поэтому здесь телефон остаётся как написан, а правило имени и
 * телефона для пометки «уже в списке» до запроса повторяет серверное
 * (`guestNameKey`/`normalizeRuPhone` в `routes/guests.ts`).
 *
 * Модуль чистый: ни сети, ни словаря. Слова пометок даёт экран через `t()`.
 */

export interface ParsedGuest {
  /** Позиция среди непустых строк, с нуля — по ней экран находит строку в предпросмотре. */
  index: number
  /** Исходная строка без краевых пробелов — предпросмотр показывает её при ошибке. */
  raw: string
  /** Имя как написано (краевые пробелы сняты); пустое — имени в строке нет. */
  name: string
  /** Телефон как написан: к `+7XXXXXXXXXX` приводит сервер. */
  phone?: string
  /** Preserve malformed input for correction instead of silently dropping it. */
  invalidPhone?: string
  plusOne: boolean
  /** `name` — имени нет или оно короче двух знаков; `phone` — цифры есть, но это не российский номер. */
  error?: 'name' | 'phone'
}

/* Разделители полей внутри строки: запятая, точка с запятой, таб. Пробел
   разделителем не считается — «Ольга и Сергей» это один гость. */
const FIELD_SEP = /[,;\t]/
/* Нумерация и маркеры списка в начале строки: «1. Анна», «2) Марк», «- Ольга», «• Денис». */
const LIST_MARK = /^(?:\d{1,3}[.)]|[-–—•*·])\s+/
/* «+1» в принятых написаниях — отдельным полем или хвостом имени. */
const PLUS_ONE = /^(?:с\s*)?\+\s*1$|^(?:плюс\s+один|plus\s+one)$/i
const PLUS_ONE_TAIL = /\s+(?:(?:с\s*)?\+\s*1|плюс\s+один|plus\s+one)$/i
/* Поле из одних «телефонных» знаков — цифр, пробелов, `+ - ( ) .` — это
   попытка написать номер, даже если цифр мало: «12345» помечается ошибкой
   телефона, а не становится гостем. */
const PHONE_CHARS = /^[\d\s+\-().]+$/

/** Ключ имени для поиска дубликата: без регистра и лишних пробелов — как на сервере. */
export function guestNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Российский номер из любого написания: 11 цифр с 7 или 8 в начале либо
 * 10 цифр с 9 → `+7XXXXXXXXXX`; иное — `null`. Правило сервера один в один,
 * чтобы «уже в списке» до запроса совпадало с `duplicate` после него.
 */
export function normalizeRuPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`
  if (digits.length === 10 && digits[0] === '9') return `+7${digits}`
  return null
}

/** Поле похоже на телефон: десять и больше цифр в любом окружении или только телефонные знаки. */
function looksLikePhone(field: string): boolean {
  const digits = field.replace(/\D/g, '').length
  return digits >= 10 || (digits > 0 && PHONE_CHARS.test(field))
}

function parseLine(raw: string, index: number): ParsedGuest {
  const row: ParsedGuest = { index, raw, name: '', plusOne: false }
  const fields = raw.replace(LIST_MARK, '').split(FIELD_SEP).map(f => f.trim()).filter(Boolean)
  for (const field of fields) {
    if (PLUS_ONE.test(field)) { row.plusOne = true; continue }
    if (looksLikePhone(field)) {
      /* Первый телефон в строке — телефон гостя; второй некуда писать. */
      if (row.phone !== undefined || row.error === 'phone') continue
      if (normalizeRuPhone(field) === null) {
        row.error = 'phone'
        row.invalidPhone = field
      }
      else row.phone = field
      continue
    }
    /* Имя — первое из остальных полей; что дальше («мама жениха») —
       не разбирается: надёжного признака группы в тексте нет (план). */
    if (row.name) continue
    const tail = PLUS_ONE_TAIL.exec(field)
    if (tail) { row.plusOne = true; row.name = field.slice(0, tail.index).trim() }
    else row.name = field
  }
  /* Без имени строка не уйдёт в любом случае — эта ошибка главнее телефона.
     Имя длиннее предела сервера (120 знаков) — та же ошибка строки, а не 422
     на весь список: одна вставленная заметка на абзац иначе роняла импорт
     целиком (ревью 015). */
  if (guestNameKey(row.name).length < 2 || row.name.length > NAME_MAX) row.error = 'name'
  return row
}

/** Предел имени гостя — как у сервера (`maxLength: 120` в схеме импорта). */
export const NAME_MAX = 120

/**
 * Текст → строки гостей. Строка = гость; пустые строки и строки из пробелов
 * не считаются; границы строк — `\n`, `\r\n` и одинокий `\r` (вставка из
 * Windows и старых таблиц).
 */
export function parseGuestList(text: string): ParsedGuest[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseLine)
}
