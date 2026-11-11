import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, chownSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const secretsRoot = '/run/tili-local'
export function requireLocal(value, code) { if (!value) throw new Error(code) }
export function projectName(value) {
  requireLocal(/^tili-local-media(?:-[a-z0-9][a-z0-9-]{0,40})?$/.test(value), 'LOCAL_PROJECT_INVALID')
  return value
}
export function port(value) {
  requireLocal(/^\d+$/.test(String(value)) && Number(value) >= 1024 && Number(value) <= 65535, 'LOCAL_PORT_INVALID')
  return Number(value)
}
export function json(path) { return JSON.parse(readFileSync(path, 'utf8')) }
export function atomic(path, value, { mode = 0o400, uid = 0 } = {}) {
  const tmp = path + '.' + randomUUID() + '.tmp'
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); fsyncSync(fd) }
  finally { closeSync(fd) }
  chownSync(tmp, uid, uid); chmodSync(tmp, mode); renameSync(tmp, path)
  const parent = openSync(dirname(path), 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
export function apiState(root = secretsRoot) {
  const phase = json(join(root, 'phase.json')), api = json(join(root, 'api.json'))
  requireLocal(phase.format === 1 && phase.project === projectName(process.env.LOCAL_PROJECT)
    && phase.instance === api.instance && phase.generation === api.generation, 'LOCAL_GENERATION_MISMATCH')
  return { phase, api }
}
export function localState(root = secretsRoot) {
  const identity = json(join(root, 'identity.json')), { phase, api } = apiState(root)
  requireLocal(identity.format === 1 && identity.provider === 'minio-chainguard-v1'
    && identity.project === projectName(process.env.LOCAL_PROJECT), 'LOCAL_IDENTITY_MISMATCH')
  requireLocal(identity.instance === phase.instance && identity.instance === api.instance
    && phase.generation === api.generation && phase.project === identity.project, 'LOCAL_GENERATION_MISMATCH')
  return { identity, phase, api }
}
export function reportFailure(error) {
  const text = error instanceof Error && /^LOCAL_[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_OPERATION_FAILED'
  console.error(text); process.exitCode = 1
  if (text === 'LOCAL_OPERATION_FAILED') {
    console.error('LOCAL_DIAGNOSTIC', JSON.stringify({ name: /^[A-Za-z0-9_]{1,80}$/.test(error?.name) ? error.name : undefined,
      httpStatus: Number.isInteger(error?.$metadata?.httpStatusCode) ? error.$metadata.httpStatusCode : undefined }))
  }
}
export function present(path) { return existsSync(path) }
