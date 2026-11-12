import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { checkBackup, probeConfig, readHttpLog } from '../scripts/wp16-ops-check.mjs'

const now = Date.UTC(2026, 10, 12, 20, 0, 0)
const privateValue = 'synthetic-private-data'

function logs(rows: unknown[]) {
  return Readable.from(rows.map(row => JSON.stringify(row) + '\n'))
}

describe('WP16 operator signals', () => {
  it('counts only recent completion, conflict and failure signals and never returns raw log data', async () => {
    const result = await readHttpLog(logs([
      { time: now - 1000, msg: 'request completed', res: { statusCode: 200 }, reqId: privateValue },
      { time: now - 2000, msg: 'request completed', res: { statusCode: 409 }, body: privateValue },
      { time: now - 3000, msg: 'request completed', res: { statusCode: 502 }, err: privateValue },
      { time: now - 1000, opsIntegration: 'sms', err: privateValue },
      { time: now - 1000, opsIntegration: privateValue, url: privateValue },
      { time: now - 1000, opsEvent: 'job_failure', job: privateValue },
      { time: now - 1000, msg: 'incoming request', res: { statusCode: 500 } },
      { time: now - 1001_000, msg: 'request completed', res: { statusCode: 503 } },
      { time: now + 1, msg: 'request completed', res: { statusCode: 500 } },
    ]), now, 900)
    expect(result).toEqual({
      requests: 3, conflicts: 1, serverErrors: 1, conflictsRate: 1 / 3, serverErrorRate: 1 / 3,
      failures: { sms: 1, storage: 0, scanner: 0, tilly: 0 }, jobFailureEvents: 1,
    })
    expect(JSON.stringify(result)).not.toContain(privateValue)
  })

  it('keeps rates unknown when the log contains no completed requests', async () => {
    expect(await readHttpLog(Readable.from(['not JSON\n']), now, 900)).toMatchObject({
      requests: 0, conflictsRate: null, serverErrorRate: null,
    })
  })

  it('separates missing backups from an invalid newest candidate', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'wp16-ops-'))
    try {
      await writeFile(join(folder, 'tili-20260230T160000Z.dump'), 'ignored')
      expect(await checkBackup(folder, now)).toEqual({ state: 'missing' })
      await writeFile(join(folder, 'tili-20261112T195959Z.dump'), '')
      expect(await checkBackup(folder, now)).toEqual({ state: 'invalid' })
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('requires explicit sources and rejects credential-bearing readiness URLs', () => {
    const env = {
      OPS_HEALTH_URL: 'http://127.0.0.1:1/health/ready', OPS_DATABASE_URL: 'postgres://tester@127.0.0.1:1/local',
      OPS_BACKUP_DIR: '.',
    }
    expect(probeConfig(env)).toMatchObject({ windowSeconds: 900, pushAgeLimitSeconds: 300, backupAgeLimitSeconds: 86400 })
    expect(() => probeConfig({ ...env, OPS_HEALTH_URL: 'http://login:secret@127.0.0.1:1/health/ready' })).toThrow()
    expect(() => probeConfig({ ...env, OPS_WINDOW_SECONDS: '0' })).toThrow()
  })
})
