import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { escapeLike } from '../catalog/vendors.js'

interface CityRow {
  id: number
  name: string
  region: string
  district: string | null
  big: boolean
  lat: number | null
  lon: number | null
  population: number | null
}

const toCity = (r: CityRow) => ({
  id: r.id,
  name: r.name,
  region: r.region,
  district: r.district,
  lat: r.lat,
  lon: r.lon,
  population: r.population,
  big: r.big,
})

/** Та же нормализация, что у вычисляемой колонки `cities.name_norm`. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/ё/g, 'е')
}

export async function geoRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.get(
    '/geo/cities',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 60 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
          },
        },
      },
    },
    async (request) => {
      const { q, limit = 12 } = request.query as { q: string; limit?: number }
      // `%` и `_` в наборе — буквы, а не шаблон: `q=%%` иначе отдавал весь
      // справочник (D5-11). Экранированная строка — только в `like … escape`.
      const needle = escapeLike(normalizeQuery(q))

      // Сортировка отвечает на вопрос «что человек скорее всего набирает»:
      // сначала то, что начинается с введённого («сиб» → Сибай, не Новосибирск),
      // потом крупные города, потом по алфавиту. Населения в данных нет —
      // признак `big` из фронта пока его заменяет.
      const { rows } = await db().query<CityRow>(
        `select id, name, region, district, big, lat, lon, population
           from cities
          where name_norm like $1 || '%' escape '\\' or name_norm like '%' || $1 || '%' escape '\\'
          order by (name_norm like $1 || '%' escape '\\') desc, big desc, population desc nulls last, name
          limit $2`,
        [needle, limit],
      )
      return rows.map(toCity)
    },
  )

  app.get(
    '/geo/nearest',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['lat', 'lon'],
          properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lon: { type: 'number', minimum: -180, maximum: 180 },
          },
        },
      },
    },
    async (request) => {
      const { lat, lon } = request.query as { lat: number; lon: number }

      // Расстояние по большому кругу прямо в SQL. Кандидаты — только города
      // с координатами: их 27 из 119. Остальные приедут с Яндекс Геокодером;
      // выдумывать координаты нельзя — человек поедет не в тот город.
      const { rows } = await db().query<CityRow>(
        `select id, name, region, district, big, lat, lon, population
           from cities
          where lat is not null and lon is not null
          order by 6371 * acos(least(1, greatest(-1,
                     sin(radians($1)) * sin(radians(lat))
                   + cos(radians($1)) * cos(radians(lat)) * cos(radians(lon - $2)))))
          limit 1`,
        [lat, lon],
      )
      if (!rows[0]) throw notFound('Города с координатами не найдены')
      return toCity(rows[0])
    },
  )
}
