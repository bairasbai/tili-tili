// Окружение бэка для скриптов фикстур: переменные процесса поверх backend/.env (как у dotenv — заданное
// в окружении главнее файла), `pg` — из зависимостей бэка. В CI файла .env нет: всё приходит окружением.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const backend = new URL('../../backend/', import.meta.url)
const file = new URL('.env', backend)
const fromFile = existsSync(file)
  ? Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  : {}
export const env = { ...fromFile, ...process.env }
export const pg = createRequire(new URL('package.json', backend))('pg')
