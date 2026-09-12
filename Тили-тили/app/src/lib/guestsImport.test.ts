/*
 * Разбор вставленного списка гостей (фича 008, экран 29 «Импорт гостей»).
 *
 * Модуль чистый: текст на входе, строки с пометками на выходе. Экран гостей
 * рисует по ним предпросмотр и отправляет на сервер только строки без ошибок;
 * что из них дубликат — решает сервер (`skipped`), здесь лишь то же правило
 * имени и телефона для пометки «уже в списке» до запроса.
 */
import { describe, it, expect } from 'vitest'
import { parseGuestList, guestNameKey, normalizeRuPhone } from './guestsImport'

describe('parseGuestList: строка = гость', () => {
  it('три строки из спеки — три гостя: имя, телефон как написан, «+1»', () => {
    const rows = parseGuestList('Анна Петрова, +79170001111, +1\nМарк\nОльга и Сергей')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ index: 0, name: 'Анна Петрова', phone: '+79170001111', plusOne: true })
    expect(rows[0]!.error).toBeUndefined()
    expect(rows[1]).toMatchObject({ index: 1, name: 'Марк', plusOne: false })
    expect(rows[1]!.phone).toBeUndefined()
    expect(rows[2]).toMatchObject({ index: 2, name: 'Ольга и Сергей', plusOne: false })
  })

  it('«Ольга и Сергей, +1» — имя целиком, с парой', () => {
    expect(parseGuestList('Ольга и Сергей, +1')[0]).toMatchObject({ name: 'Ольга и Сергей', plusOne: true })
  })

  it('пустые строки и строки из пробелов пропускаются, номера строк — по непустым', () => {
    const rows = parseGuestList('\n\nАнна\n   \n\t\nМарк\n\n')
    expect(rows.map(r => [r.index, r.name])).toEqual([[0, 'Анна'], [1, 'Марк']])
  })

  it('переносы Windows (\\r\\n) и одинокий \\r — тоже границы строк', () => {
    const rows = parseGuestList('Анна\r\nМарк\rОльга\r\n')
    expect(rows.map(r => r.name)).toEqual(['Анна', 'Марк', 'Ольга'])
    for (const r of rows) expect(r.name).not.toContain('\r')
  })

  it('разделители внутри строки — запятая, точка с запятой, таб; лишние пробелы вокруг полей снимаются', () => {
    expect(parseGuestList('Анна ; +79170001111 ; +1')[0]).toMatchObject({ name: 'Анна', phone: '+79170001111', plusOne: true })
    expect(parseGuestList('Анна\t89170001111\tс +1')[0]).toMatchObject({ name: 'Анна', phone: '89170001111', plusOne: true })
    expect(parseGuestList('  Анна Петрова  ,  9170001111  ')[0]).toMatchObject({ name: 'Анна Петрова', phone: '9170001111' })
  })

  it('«8 917 000-11-22» — телефон как написан: к +7 приводит сервер', () => {
    const [row] = parseGuestList('Марк, 8 917 000-11-22')
    expect(row).toMatchObject({ name: 'Марк', phone: '8 917 000-11-22' })
    expect(row!.error).toBeUndefined()
  })

  it('телефон узнаётся по цифрам: 11 с 7 или 8 в начале, 10 с 9 — в любом написании', () => {
    expect(parseGuestList('Анна, +7 (917) 000-11-22')[0]!.phone).toBe('+7 (917) 000-11-22')
    expect(parseGuestList('Анна, 7-917-000-11-22')[0]!.phone).toBe('7-917-000-11-22')
    expect(parseGuestList('Анна, 917 000 11 22')[0]!.phone).toBe('917 000 11 22')
  })

  it('телефон первым полем — имя берётся из следующего', () => {
    expect(parseGuestList('+79170001111, Анна Петрова')[0]).toMatchObject({ name: 'Анна Петрова', phone: '+79170001111' })
  })

  it('«+1» в любом принятом написании и регистре: +1, с +1, + 1, плюс один, plus one', () => {
    for (const mark of ['+1', 'с +1', 'С +1', '+ 1', 'плюс один', 'Плюс Один', 'plus one', 'PLUS ONE']) {
      expect(parseGuestList(`Анна, ${mark}`)[0], mark).toMatchObject({ name: 'Анна', plusOne: true })
    }
    expect(parseGuestList('Анна')[0]!.plusOne).toBe(false)
  })

  it('«Иван Петров +1» без запятой — пометка снимается с конца имени', () => {
    expect(parseGuestList('Иван Петров +1')[0]).toMatchObject({ name: 'Иван Петров', plusOne: true })
    expect(parseGuestList('Иван Петров плюс один')[0]).toMatchObject({ name: 'Иван Петров', plusOne: true })
  })

  it('нумерация и маркеры списка в начале строки — не часть имени', () => {
    expect(parseGuestList('1. Анна\n2) Марк\n- Ольга\n• Денис\n— Ира').map(r => r.name)).toEqual(['Анна', 'Марк', 'Ольга', 'Денис', 'Ира'])
  })

  it('имя короче двух знаков или его нет — error: name', () => {
    expect(parseGuestList('А, +79170001111')[0]).toMatchObject({ name: 'А', error: 'name' })
    expect(parseGuestList('+79170001111')[0]).toMatchObject({ name: '', phone: '+79170001111', error: 'name' })
    expect(parseGuestList('+1')[0]).toMatchObject({ name: '', plusOne: true, error: 'name' })
  })

  it('цифры, но не российский номер — error: phone; имя при этом разобрано', () => {
    expect(parseGuestList('Анна, 12345')[0]).toMatchObject({ name: 'Анна', error: 'phone' })
    expect(parseGuestList('Анна, +1 917 000 11 22')[0]).toMatchObject({ name: 'Анна', error: 'phone' })
    expect(parseGuestList('Анна, 8 917 000-11-2')[0]).toMatchObject({ name: 'Анна', error: 'phone' })
    expect(parseGuestList('Анна, 12345')[0]!.phone).toBeUndefined()
  })

  it('без имени и с плохим телефоном — error: name (без имени строка не уйдёт в любом случае)', () => {
    expect(parseGuestList('12345')[0]).toMatchObject({ name: '', error: 'name' })
  })

  it('второе поле без цифр и без «+1» — не телефон и не имя, пропускается (имя — первое такое поле)', () => {
    expect(parseGuestList('Анна Петрова, мама жениха, +1')[0]).toMatchObject({ name: 'Анна Петрова', plusOne: true })
  })

  it('исходная строка сохраняется в raw — предпросмотр показывает её при ошибке', () => {
    expect(parseGuestList('  Анна, 12345  ')[0]!.raw).toBe('Анна, 12345')
  })

  it('пустой текст и текст из одних переносов — пустой список', () => {
    expect(parseGuestList('')).toEqual([])
    expect(parseGuestList('\r\n\n  \n')).toEqual([])
  })
})

describe('ключи дедупликации — то же правило, что у сервера', () => {
  it('guestNameKey: без регистра и лишних пробелов', () => {
    expect(guestNameKey('  Анна   Петрова ')).toBe('анна петрова')
    expect(guestNameKey('МАРК')).toBe(guestNameKey('марк'))
  })

  it('normalizeRuPhone: 8…/7…/+7… и десять цифр с 9 → +7XXXXXXXXXX; иное — null', () => {
    expect(normalizeRuPhone('8 917 000-11-22')).toBe('+79170001122')
    expect(normalizeRuPhone('+7 (917) 000-11-22')).toBe('+79170001122')
    expect(normalizeRuPhone('79170001122')).toBe('+79170001122')
    expect(normalizeRuPhone('9170001122')).toBe('+79170001122')
    expect(normalizeRuPhone('12345')).toBeNull()
    expect(normalizeRuPhone('+1 917 000 11 22')).toBeNull()
    expect(normalizeRuPhone('')).toBeNull()
  })
})
