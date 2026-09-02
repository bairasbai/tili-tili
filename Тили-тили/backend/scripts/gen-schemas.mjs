/**
 * Переносит components.schemas контракта в JSON Schema, понятную AJV Fastify.
 *
 * Зачем: чтобы валидация запроса была не второй копией правил, а тем же самым
 * контрактом. Обработчик пишет `body: ref('Wedding')` — и если контракт поменяли,
 * валидатор меняется вместе с ним, без ручной синхронизации.
 *
 * Что приходится чинить по дороге: OpenAPI 3.0 — это НЕ JSON Schema. Отличия,
 * которые ломают AJV:
 *   - `nullable: true`     → в JSON Schema так нельзя, нужно type: [x, 'null']
 *   - `example`            → не ключевое слово JSON Schema, AJV в strict падает
 *   - `readOnly` на поле   → в запросе такое поле присылать нельзя, но AJV этого
 *                            не знает; оставляем как есть, чистка — на входе
 *   - `$ref` на соседа     → путь надо переписать на $id этого документа
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const here = path.dirname(url.fileURLToPath(import.meta.url))
export const CONTRACT_FILE = path.resolve(here, '..', '..', 'Тили-тили_API_openapi.yaml')
export const OUT_FILE = path.resolve(here, '..', 'src', 'contract', 'schemas.generated.ts')
export const SCHEMA_ID = 'contract'

const DROP = new Set(['example', 'examples', 'discriminator', 'xml', 'externalDocs', 'deprecated'])

export function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema)
  if (node === null || typeof node !== 'object') return node

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (DROP.has(key)) continue

    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      out.$ref = `${SCHEMA_ID}#/definitions/${value.slice('#/components/schemas/'.length)}`
      continue
    }
    if (key === 'nullable') continue
    out[key] = toJsonSchema(value)
  }

  if (node.nullable === true) {
    if (typeof out.type === 'string') {
      out.type = [out.type, 'null']
    } else if (Array.isArray(out.type)) {
      if (!out.type.includes('null')) out.type = [...out.type, 'null']
    } else if (out.$ref) {
      // `{ $ref, nullable: true }` в JSON Schema выражается только через anyOf:
      // рядом с $ref другие ключевые слова в draft-07 игнорируются.
      const ref = out.$ref
      delete out.$ref
      out.anyOf = [{ $ref: ref }, { type: 'null' }]
    } else {
      out.type = ['object', 'array', 'string', 'number', 'boolean', 'null']
    }
  }

  // enum с null внутри и type без 'null' — AJV отвергнет валидное значение.
  if (Array.isArray(out.enum) && out.enum.includes(null) && typeof out.type === 'string') {
    out.type = [out.type, 'null']
  }
  return out
}

export function readSchemas(file = CONTRACT_FILE) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'))
  const schemas = doc.components?.schemas ?? {}
  const converted = {}
  for (const name of Object.keys(schemas).sort()) {
    converted[name] = toJsonSchema(schemas[name])
  }
  return converted
}

export function render(schemas) {
  const names = Object.keys(schemas)
  return [
    '/* СГЕНЕРИРОВАНО. Не править руками — правится контракт, потом `pnpm run gen:schemas`.',
    ` * Схем: ${names.length}. */`,
    '',
    `export const CONTRACT_SCHEMA_ID = ${JSON.stringify(SCHEMA_ID)}`,
    '',
    '/** Единый документ схем; подключается через app.addSchema.',
    '  * Ключ `definitions`, а не `components.schemas`: AJV в strict-режиме',
    '  * отвергает неизвестное ключевое слово, а `definitions` он знает. */',
    'export const CONTRACT_SCHEMAS = {',
    `  $id: ${JSON.stringify(SCHEMA_ID)},`,
    '  definitions: ' + JSON.stringify(schemas, null, 4).split('\n').join('\n  ') + ',',
    '} as const',
    '',
    '/** Ссылка на схему контракта для body/response обработчика. */',
    'export function ref(name: ContractSchemaName): { $ref: string } {',
    '  return { $ref: `contract#/definitions/${name}` }',
    '}',
    '',
    'export type ContractSchemaName =',
    ...names.map((n) => `  | ${JSON.stringify(n)}`),
    '',
  ].join('\n')
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const schemas = readSchemas()
  fs.writeFileSync(OUT_FILE, render(schemas), 'utf8')
  console.log(`${OUT_FILE}: схем ${Object.keys(schemas).length}`)
}
