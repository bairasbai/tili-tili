#!/usr/bin/env node
/*
 * Прогон ВСЕХ миграций с нуля — в чистой схеме той же базы (блокер №22).
 *
 * Пустая база — лучший стенд для этой проверки, но у роли `tili` нет `CREATEDB`,
 * а пароля `postgres` в окружении нет. Поэтому стенд — схема: она создаётся
 * пустой, `node-pg-migrate` работает в ней (search_path = схема, затем `public`
 * — оттуда берётся расширение `citext`, которое в настоящей пустой базе легло
 * бы в `public` само), после прогона схема удаляется. Таблица миграций живёт
 * в той же схеме — боевая `public.pgmigrations` не трогается.
 *
 * Запуск (из `backend/`, база из `.env`):
 *   npm run migrate:fresh
 * Печатает число таблиц, миграций и категорий и состояние трёх проверок,
 * которые в истории ставились `NOT VALID`. Любая ошибка миграции — ненулевой код.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL не задан: запускайте через `npm run migrate:fresh` (переменные из .env)')
  process.exit(2)
}
const SCHEMA = process.env.FRESH_SCHEMA ?? 'tili_fresh'
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA) || SCHEMA === 'public') {
  console.error(`FRESH_SCHEMA должна быть простым именем и не public: ${SCHEMA}`)
  process.exit(2)
}
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = new pg.Client({ connectionString: url })
await client.connect()
let code = 1
try {
  await client.query(`drop schema if exists "${SCHEMA}" cascade`)
  await client.query(`create schema "${SCHEMA}"`)
  const run = spawnSync(
    process.execPath,
    [path.join(backend, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'), 'up', '-m', 'migrations', '--schema', SCHEMA, '--schema', 'public'],
    { cwd: backend, env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' },
  )
  if (run.status !== 0) throw new Error(`миграции упали, код ${run.status}`)
  const tables = await client.query('select count(*)::int as n from information_schema.tables where table_schema = $1', [SCHEMA])
  const applied = await client.query(`select count(*)::int as n from "${SCHEMA}".pgmigrations`)
  const categories = await client.query(`select count(*)::int as n from "${SCHEMA}".categories`)
  const checks = await client.query(
    `select conname, convalidated from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = $1 and conname in ('bus_taken_bounded', 'complaints_resolution_by_target', 'reviews_key_matches_source')
      order by conname`,
    [SCHEMA],
  )
  console.log(`таблиц: ${tables.rows[0].n}, миграций применено: ${applied.rows[0].n}, категорий: ${categories.rows[0].n}`)
  for (const row of checks.rows) console.log(`  ${row.conname}: ${row.convalidated ? 'проверена' : 'NOT VALID'}`)
  if (checks.rows.some((r) => !r.convalidated)) throw new Error('есть непроверенная CHECK-проверка')
  code = 0
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
} finally {
  await client.query(`drop schema if exists "${SCHEMA}" cascade`).catch(() => undefined)
  await client.end()
}
process.exit(code)
