import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const backend = fileURLToPath(new URL('..', import.meta.url))
const databaseUrl = 'postgres://codex_test@127.0.0.1:15432/tili_ecosystem_migration_drill12_20260930_test'
function admit(overrides: NodeJS.ProcessEnv = {}, args = ['--source-admission-only']) {
  return spawnSync(process.execPath, ['scripts/ecosystem-migration-drill.mjs', ...args], {
    cwd: backend,
    env: { ...process.env, TILI_DISPOSABLE_PG_PORT: '15432', DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, ...overrides },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  })
}

describe('real historical migration source admission before the database rehearsal', () => {
  it('qualifies the reviewed current sources without starting the database rehearsal', () => {
    const result = admit()
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('HISTORICAL_MOVE_CANCEL_SOURCE_ADMISSION_ONLY_OK')
  })

  it.each(['NODE_CONFIG_AUDIT22', 'TSX_TSCONFIG_PATH'])('refuses inherited %s even in source-only mode', key => {
    const result = admit({ [key]: 'audit22-untrusted-input' })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Historical runtime rejects inherited override: ' + key)
    expect(result.stdout).not.toContain('HISTORICAL_MOVE_CANCEL_SOURCE_ADMISSION_ONLY_OK')
  })

  it('rejects a misspelled source-only argument before a database connection', () => {
    const result = admit({}, ['--source-admission-onyl'])
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unknown drill arguments are forbidden')
    expect(result.stdout).not.toContain('HISTORICAL_MOVE_CANCEL_SOURCE_ADMISSION_ONLY_OK')
  })
})
