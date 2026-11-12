import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as wait } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'

const exec = promisify(execFile)
const integrations = ['sms', 'storage', 'scanner', 'tilly']
const backupName = /^tili-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/
const signalsBySource = {
  http_unobserved: ['http_5xx', 'job_failure', ...integrations.map(name => `${name}_failure`)],
  readiness_unavailable: ['postgres_down', 'redis_down'],
  push_queue_unavailable: ['push_queue_stale', 'push_provider_failure'],
  backup_unavailable: ['backup_invalid', 'backup_missing', 'backup_stale'],
}
const incompleteSignals = [...Object.keys(signalsBySource), 'configuration_invalid', 'probe_failed']

function seconds(raw, fallback) {
  if (raw === undefined) return fallback
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Error('Invalid interval')
  return Number(raw)
}

export function probeConfig(env) {
  const url = new URL(env.OPS_HEALTH_URL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !url.pathname.endsWith('/health/ready')) throw new Error('Invalid health URL')
  const database = new URL(env.OPS_DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !env.OPS_BACKUP_DIR) throw new Error('Invalid probe sources')
  return {
    url, database: database.href, backupDir: env.OPS_BACKUP_DIR,
    windowSeconds: seconds(env.OPS_WINDOW_SECONDS, 900),
    pushAgeLimitSeconds: seconds(env.OPS_PUSH_AGE_SECONDS, 300),
    backupAgeLimitSeconds: seconds(env.OPS_BACKUP_AGE_SECONDS, 86400),
  }
}

export async function readHttpLog(input, now, windowSeconds) {
  const counts = { requests: 0, conflicts: 0, serverErrors: 0 }
  const failures = Object.fromEntries(integrations.map(name => [name, 0]))
  let jobFailureEvents = 0
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!Number.isFinite(row?.time) || row.time < now - windowSeconds * 1000 || row.time > now) continue
    if (row.opsEvent === 'job_failure') jobFailureEvents++
    if (integrations.includes(row.opsIntegration)) failures[row.opsIntegration]++
    const status = row.res?.statusCode
    if (row.msg !== 'request completed' || !Number.isInteger(status) || status < 200 || status >= 600) continue
    counts.requests++
    if (status === 409) counts.conflicts++
    if (status >= 500) counts.serverErrors++
  }
  return {
    ...counts, conflictsRate: counts.requests ? counts.conflicts / counts.requests : null,
    serverErrorRate: counts.requests ? counts.serverErrors / counts.requests : null, failures, jobFailureEvents,
  }
}

export async function readReadiness(url) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (response.status !== 200 && response.status !== 503) return { state: 'unavailable' }
    const body = await response.json()
    if (!['up', 'down'].includes(body?.db) || !['up', 'down'].includes(body?.redis)) return { state: 'unavailable' }
    const ready = body.db === 'up' && body.redis === 'up'
    if (response.status !== (ready ? 200 : 503) || body.status !== (ready ? 'ready' : 'not_ready')) return { state: 'unavailable' }
    return { state: ready ? 'ready' : 'degraded', db: body.db, redis: body.redis }
  } catch {
    return { state: 'unavailable' }
  }
}

export async function readPushQueue(database, windowSeconds) {
  const client = new pg.Client({ connectionString: database, connectionTimeoutMillis: 4000, statement_timeout: 4000, query_timeout: 5000 })
  client.on('error', () => undefined)
  try {
    await client.connect()
    await client.query('begin isolation level repeatable read read only')
    const { rows: [queue] } = await client.query(`select count(*)::float8 as due,
      floor(extract(epoch from now() - min(n.deliver_after)))::float8 as age
      from notifications n join users u on u.id=n.user_id and u.deleted_at is null
      where n.pushed_at is null and n.push_disposition='planned' and n.cancelled_at is null
        and n.deliver_after<=now() and (n.expires_at is null or n.expires_at>now())`)
    const { rows: [delivery] } = await client.query(`select count(*)::float8 as failures from notification_push_deliveries
      where updated_at>=now()-make_interval(secs=>$1::int)
        and status in ('retry_wait','permanent_failure')
        and (last_error='transport_failure' or (last_error ~ '^http_[45][0-9]{2}$'
          and last_error not in ('http_404','http_410')))`, [windowSeconds])
    return { state: 'observed', due: queue.due, oldestDueSeconds: queue.age, failedDeliveries: delivery.failures }
  } catch {
    return { state: 'unavailable' }
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function checkBackup(dir, now) {
  try {
    const names = await readdir(dir)
    let latest
    for (const name of names) {
      const match = backupName.exec(name)
      if (!match) continue
      const [, year, month, day, hour, minute, second] = match
      const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
      const time = Date.parse(iso)
      if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) continue
      if (!latest || time > latest.time) latest = { name, time }
    }
    if (!latest) return { state: 'missing' }
    const path = resolve(dir, latest.name)
    const file = await lstat(path)
    if (!file.isFile() || file.size === 0 || latest.time > now) return { state: 'invalid' }
    // The executable is resolved from the operator's PATH. It only reads the archive.
    try { await exec('pg_restore', ['--list', path], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }) }
    catch (error) { return { state: typeof error.code === 'number' ? 'invalid' : 'unavailable' } }
    return { state: 'checked', ageSeconds: Math.floor((now - latest.time) / 1000), bytes: file.size }
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unavailable' }
  }
}

export async function collectOps(config, input, now = Date.now()) {
  const [http, readiness, push, backup] = await Promise.all([
    readHttpLog(input, now, config.windowSeconds), readReadiness(config.url),
    readPushQueue(config.database, config.windowSeconds), checkBackup(config.backupDir, now),
  ])
  const alerts = []
  const incomplete = []
  if (http.requests === 0) incomplete.push('http_unobserved')
  if (http.serverErrors > 0) alerts.push('http_5xx')
  if (http.jobFailureEvents > 0) alerts.push('job_failure')
  for (const name of integrations) if (http.failures[name] > 0) alerts.push(`${name}_failure`)
  if (readiness.state === 'unavailable') incomplete.push('readiness_unavailable')
  if (readiness.db === 'down') alerts.push('postgres_down')
  if (readiness.redis === 'down') alerts.push('redis_down')
  if (push.state === 'unavailable') incomplete.push('push_queue_unavailable')
  if (push.oldestDueSeconds > config.pushAgeLimitSeconds) alerts.push('push_queue_stale')
  if (push.failedDeliveries > 0) alerts.push('push_provider_failure')
  if (backup.state === 'unavailable') incomplete.push('backup_unavailable')
  if (backup.state === 'invalid' || backup.state === 'missing') alerts.push(`backup_${backup.state}`)
  if (backup.ageSeconds > config.backupAgeLimitSeconds) alerts.push('backup_stale')
  return {
    status: alerts.length ? 'alert' : incomplete.length ? 'incomplete' : 'ok',
    windowSeconds: config.windowSeconds, alerts, incomplete, http, readiness, push, backup,
  }
}

export function renderOpsMetrics(result, now) {
  const incomplete = new Set(result.incomplete)
  const alerts = new Set(result.alerts)
  const failed = incomplete.has('configuration_invalid') || incomplete.has('probe_failed')
  const lines = [`tili_wp16_probe_timestamp_seconds ${Math.floor(now / 1000)}`]
  for (const [source, signals] of Object.entries(signalsBySource)) {
    for (const signal of signals) {
      if (alerts.has(signal) || (!failed && !incomplete.has(source))) {
        lines.push(`tili_wp16_confirmed_signal{signal="${signal}"} ${Number(alerts.has(signal))}`)
      }
    }
  }
  for (const signal of incompleteSignals) {
    lines.push(`tili_wp16_probe_issue{signal="${signal}"} ${Number(incomplete.has(signal))}`)
  }
  return lines.join('\n') + '\n'
}

export async function writeOpsMetrics(path, result, now) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx')
  try {
    try { await file.writeFile(renderOpsMetrics(result, now)) }
    finally { await file.close() }
    for (let delay = 25; ; delay *= 2) {
      try { await rename(temporary, path); break }
      catch (error) {
        // An open reader can briefly prevent replacement on Windows.
        if (process.platform !== 'win32' || error.code !== 'EPERM' || delay > 400) throw error
        await wait(delay)
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function main() {
  const now = Date.now()
  let config
  let result
  try { config = probeConfig(process.env) }
  catch { result = { status: 'incomplete', alerts: [], incomplete: ['configuration_invalid'] } }
  if (config) {
    try { result = await collectOps(config, process.stdin, now) }
    catch { result = { status: 'incomplete', alerts: [], incomplete: ['probe_failed'] } }
  }
  let deliveryFailed = false
  try {
    if (process.env.OPS_METRICS_FILE) await writeOpsMetrics(process.env.OPS_METRICS_FILE, result, now)
  } catch {
    deliveryFailed = true
    result.incomplete.push('metrics_write_failed')
    if (result.status === 'ok') result.status = 'incomplete'
  }
  console.log(JSON.stringify(result))
  process.exitCode = deliveryFailed ? 2 : result.status === 'ok' ? 0 : result.status === 'alert' ? 1 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
