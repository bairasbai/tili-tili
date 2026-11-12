import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * FL-15 (ERR-0285): репетиция восстановления создаёт отдельную базу, поэтому
 * имя целевой базы и файл копии проверяются раньше любого обращения к серверу.
 *
 * Настоящих `psql`/`pg_dump`/`pg_restore` здесь нет: на PATH первыми стоят
 * подделки, которые пишут свои аргументы в журнал, а адрес базы ведёт на
 * закрытый порт — ни одна ветка теста не может тронуть живую базу.
 */
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/restore-drill.sh')
const slash = (p: string) => p.replace(/\\/g, '/')
let dir: string
let log: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-'))
  log = path.join(dir, 'calls.log')
  const fake = (name: string, body: string) =>
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${slash(log)}"\n${body}\n`, { mode: 0o755 })
  fake(
    'psql',
    'case "$*" in *rolcreatedb*) echo t ;; *CREATE\\ DATABASE*) [ "${STUB_TARGET_EXISTS:-}" != 1 ] ;; *current_database*) echo "${STUB_CONNECTED_DB:-${DRILL_DB:-tili_drill}}" ;; *information_schema*) echo 65 ;; *pgmigrations*) echo 40 ;; *users*) echo 3 ;; esac',
  )
  fake('pg_dump', 'for a in "$@"; do case "$a" in --file=*) echo archive > "${a#--file=}" ;; esac; done')
  fake('pg_restore', 'if [ "$1" = "--list" ]; then [ -s "$2" ]; fi')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function drill(env: Record<string, string>) {
  fs.writeFileSync(log, '')
  const r = spawnSync('sh', [script], {
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
      DATABASE_URL: 'postgres://tili:x@127.0.0.1:1/tili',
      ADMIN_URL: '',
      DRILL_DB: '',
      DUMP: '',
      STUB_TARGET_EXISTS: '',
      STUB_CONNECTED_DB: '',
      WORK: slash(path.join(dir, 'work')),
      ...env,
    },
    encoding: 'utf8',
  })
  return { code: r.status, err: r.stderr, calls: fs.readFileSync(log, 'utf8') }
}

describe('restore-drill.sh · FL-15: копия разворачивается только в отдельную базу', () => {
  it.each([
    ['боевая база из DATABASE_URL', { DRILL_DB: 'tili' }],
    ['боевая база, адрес с параметрами', { DRILL_DB: 'tili', DATABASE_URL: 'postgres://tili:x@127.0.0.1:1/tili?sslmode=disable' }],
    ['служебная база', { DRILL_DB: 'postgres' }],
    ['шаблон', { DRILL_DB: 'template1' }],
    ['имя с SQL внутри', { DRILL_DB: 'x"; drop database tili; --' }],
    ['адрес без имени базы', { DRILL_DB: 'tili_restore', DATABASE_URL: 'postgres://tili:x@127.0.0.1:1' }],
  ])('%s — остановка до любого вызова сервера', (_name, env) => {
    const r = drill(env)
    expect(r.code).toBe(2)
    expect(r.err).toContain('ОСТАНОВКА')
    expect(r.calls).toBe('')
  })

  it('копии нет по указанному пути — остановка, ничего не удалено', () => {
    const r = drill({ DRILL_DB: 'tili_restore', DUMP: slash(path.join(dir, 'нет-такой.dump')) })
    expect(r.code).toBe(2)
    expect(r.calls).toBe('')
  })

  it('файл не архив pg_dump — остановка после одной проверки, без DROP', () => {
    const empty = path.join(dir, 'empty.dump')
    fs.writeFileSync(empty, '')
    const r = drill({ DRILL_DB: 'tili_restore', DUMP: slash(empty) })
    expect(r.code).toBe(2)
    expect(r.calls).toMatch(/^pg_restore --list /)
    expect(r.calls).not.toMatch(/DROP|psql|pg_dump/)
  })

  it('выбранная копия разворачивается в отдельную базу, свежий дамп не снимается', () => {
    const file = path.join(dir, 'tili-20260926.dump')
    fs.writeFileSync(file, 'archive')
    const r = drill({ DRILL_DB: 'tili_restore', DUMP: slash(file) })
    expect(r.code, r.err).toBe(0)
    expect(r.calls).not.toMatch(/^pg_dump/m)
    expect(r.calls).toMatch(/CREATE DATABASE "tili_restore"/)
    expect(r.calls).toMatch(/pg_restore --dbname=postgres:\/\/tili:x@127\.0\.0\.1:1\/tili_restore /)
    expect(r.calls).not.toMatch(/DROP DATABASE/)
  })

  it('использует ADMIN_URL и для создания базы, и для восстановления', () => {
    const r = drill({
      DRILL_DB: 'tili_restore',
      ADMIN_URL: 'postgres://drill@127.0.0.1:2/postgres?sslmode=disable',
    })
    expect(r.code, r.err).toBe(0)
    expect(r.calls).toMatch(/pg_dump .*postgres:\/\/tili:x@127\.0\.0\.1:1\/tili$/m)
    expect(r.calls).toMatch(/CREATE DATABASE "tili_restore" postgres:\/\/drill@127\.0\.0\.1:2\/postgres\?sslmode=disable/)
    expect(r.calls).toMatch(/pg_restore --dbname=postgres:\/\/drill@127\.0\.0\.1:2\/tili_restore\?sslmode=disable /)
  })

  it('занятое имя базы оставляет её нетронутой', () => {
    const r = drill({ DRILL_DB: 'tili_restore', STUB_TARGET_EXISTS: '1' })
    expect(r.code).toBe(2)
    expect(r.err).toContain('Если имя занято')
    expect(r.calls).toMatch(/CREATE DATABASE "tili_restore"/)
    expect(r.calls).not.toMatch(/DROP DATABASE|^pg_restore --dbname/m)
  })

  it('проверяет имя фактического подключения до записи в базу', () => {
    const r = drill({ DRILL_DB: 'tili_restore', STUB_CONNECTED_DB: 'tili' })
    expect(r.code).toBe(2)
    expect(r.err).toContain('ведёт в другую базу')
    expect(r.calls).toMatch(/select current_database\(\)/)
    expect(r.calls).not.toMatch(/DROP DATABASE|^pg_restore --dbname/m)
  })

  it('без DUMP — плановая репетиция на свежем дампе боевой базы', () => {
    const r = drill({})
    expect(r.code, r.err).toBe(0)
    expect(r.calls).toMatch(/^pg_dump .*postgres:\/\/tili:x@127\.0\.0\.1:1\/tili$/m)
    expect(r.calls).toMatch(/CREATE DATABASE "tili_drill"/)
    expect(r.calls).not.toMatch(/DROP DATABASE/)
  })
})
