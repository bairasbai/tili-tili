/**
 * Сид городов берётся из фронта — `app/src/lib/cities.ts`, — а не набирается
 * заново. Это те же данные, что видит пользователь в CityPicker; вторая копия
 * разошлась бы с первой на первой же правке.
 *
 * Координаты во фронте есть у 27 городов из 120. Остальные приедут с Яндекс
 * Геокодером (План этап 1); выдумывать их нельзя — `/geo/nearest` вернёт
 * неправильный город и человек поедет не туда.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
export const SOURCE_FILE = path.resolve(here, '..', '..', 'app', 'src', 'lib', 'cities.ts')
export const OUT_FILE = path.resolve(here, '..', 'migrations', 'data', 'cities.json')

export function readCities(file = SOURCE_FILE) {
  const src = fs.readFileSync(file, 'utf8')

  const listStart = src.indexOf('export const CITIES')
  const listEnd = src.indexOf('\n]', listStart)
  if (listStart < 0 || listEnd < 0) throw new Error('CITIES не найден в ' + file)
  const list = src.slice(listStart, listEnd)

  const cities = []
  for (const m of list.matchAll(/\{\s*n:\s*'([^']+)'\s*,\s*r:\s*'([^']+)'([^}]*)\}/g)) {
    const [, name, region, rest] = m
    const district = /d:\s*'([^']+)'/.exec(rest ?? '')?.[1] ?? null
    cities.push({ name, region, district, big: /big:\s*true/.test(rest ?? '') })
  }

  const coordsStart = src.indexOf('export const CITY_COORDS')
  const coordsEnd = src.indexOf('\n}', coordsStart)
  if (coordsStart < 0 || coordsEnd < 0) throw new Error('CITY_COORDS не найден в ' + file)
  const coords = new Map()
  for (const m of src.slice(coordsStart, coordsEnd).matchAll(/'([^']+)':\s*\[([-\d.]+),\s*([-\d.]+)\]/g)) {
    coords.set(m[1], [Number(m[2]), Number(m[3])])
  }

  return cities.map((c, i) => {
    const ll = coords.get(c.name) ?? null
    return {
      id: i + 1,
      name: c.name,
      region: c.region,
      district: c.district,
      big: c.big,
      lat: ll ? ll[0] : null,
      lon: ll ? ll[1] : null,
    }
  })
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const cities = readCities()
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(cities, null, 2) + '\n', 'utf8')
  const withCoords = cities.filter((c) => c.lat !== null).length
  console.log(`${OUT_FILE}: городов ${cities.length}, с координатами ${withCoords}, крупных ${cities.filter((c) => c.big).length}`)
}
