/**
 * Читает контракт и выписывает список операций в src/contract/paths.generated.ts.
 *
 * Зачем генерировать, а не читать YAML в рантайме: сервер не должен зависеть
 * от файла, лежащего вне его папки. Сгенерированный файл коммитится, а тест
 * contract-sync.test.ts падает, если контракт ушёл вперёд, а сервер отстал.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const here = path.dirname(url.fileURLToPath(import.meta.url))
export const CONTRACT_FILE = path.resolve(here, '..', '..', 'Тили-тили_API_openapi.yaml')
export const OUT_FILE = path.resolve(here, '..', 'src', 'contract', 'paths.generated.ts')

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
const SERVICE_PLAN_ACCESS = ['wedding', 'vendor_month', 'conditional']

/** `/weddings/{weddingId}/slots` → `/weddings/:weddingId/slots` */
export function toFastifyPath(openapiPath) {
  return openapiPath.replace(/\{([^}]+)\}/g, ':$1')
}

export function readOperations(file = CONTRACT_FILE) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'))
  const out = []
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) {
      if (!item[m]) continue
      const servicePlanAccess = item[m]['x-service-plan-access']
      if (servicePlanAccess !== undefined &&
          (!SERVICE_PLAN_ACCESS.includes(servicePlanAccess) || ['get', 'head', 'options'].includes(m))) {
        throw new Error('Invalid x-service-plan-access for ' + m + ' ' + p)
      }
      out.push({
        method: m.toUpperCase(),
        openapi: p,
        url: toFastifyPath(p),
        operationId: item[m].operationId ?? null,
        summary: (item[m].summary ?? '').trim(),
        tag: (item[m].tags ?? [])[0] ?? null,
        ...(servicePlanAccess === undefined ? {} : { servicePlanAccess }),
      })
    }
  }
  out.sort((a, b) => a.openapi.localeCompare(b.openapi) || a.method.localeCompare(b.method))
  return out
}

export function render(ops, version) {
  const head = [
    '/* СГЕНЕРИРОВАНО. Не править руками — правится контракт, потом `pnpm run gen:contract`.',
    ` * Источник: Тили-тили_API_openapi.yaml (версия ${version}).`,
    ` * Операций: ${ops.length}. Путей: ${new Set(ops.map((o) => o.openapi)).size}. */`,
    '',
    'export interface ContractOperation {',
    '  /** HTTP-метод в верхнем регистре. */',
    '  readonly method: string',
    '  /** Путь как в контракте: /weddings/{weddingId}. */',
    '  readonly openapi: string',
    '  /** Тот же путь в нотации Fastify: /weddings/:weddingId. */',
    '  readonly url: string',
    '  readonly operationId: string | null',
    '  readonly summary: string',
    '  readonly tag: string | null',
    '  readonly servicePlanAccess?: ' + SERVICE_PLAN_ACCESS.map(value => JSON.stringify(value)).join(' | '),
    '}',
    '',
    'export const CONTRACT_OPERATIONS: readonly ContractOperation[] = [',
  ]
  const body = ops.map((o) => `  ${JSON.stringify(o)},`)
  return [...head, ...body, '] as const', ''].join('\n')
}

function readVersion(file = CONTRACT_FILE) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'))
  return doc.info?.version ?? 'unknown'
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const ops = readOperations()
  fs.writeFileSync(OUT_FILE, render(ops, readVersion()), 'utf8')
  const paths = new Set(ops.map((o) => o.openapi)).size
  console.log(`${OUT_FILE}: путей ${paths}, операций ${ops.length}`)
}
