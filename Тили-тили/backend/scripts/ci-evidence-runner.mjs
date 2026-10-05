/** Preserve failure evidence without changing test selection or admission rules. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { SESSION_SQL, sessionTarget, sessionRows, vitestSummary } from './ci-evidence.mjs'

const mode = process.argv[2]
assert.deepEqual(process.argv.slice(2), [mode])
assert(['vitest', 'native'].includes(mode))
const target = sessionTarget(process.env)
assert(process.env.RUNNER_TEMP)
const directory = resolve(process.env.RUNNER_TEMP,
  `tili-backend-evidence-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`)
mkdirSync(directory, { recursive: true })
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2)+'\n', { flag: 'wx' })
const context = { head: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT, mode }

if (mode === 'vitest') {
  // The raw reporter is outside the repository and is NOT an uploaded artifact.
  const raw = join(process.env.RUNNER_TEMP, `vitest-raw-${context.run}-${context.attempt}.json`)
  const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    '--reporter=default', '--reporter=json', `--outputFile=${raw}`], { stdio: 'inherit' })
  const exitCode = child.status ?? 1
  let result = null, reportError = null
  try { result = JSON.parse(readFileSync(raw, 'utf8')) } catch (error) { reportError = { name: error.name, code: error.code ?? null } }
  save('vitest-summary.json', { context, ...vitestSummary(result, exitCode),
    signal: child.signal, spawnError: child.error?.code ?? null, reportError })
  // An otherwise successful run without readable evidence fails rather than claiming success.
  process.exitCode = exitCode || (reportError ? 1 : 0)
} else {
  const { selectProfile } = await import('../test-support/c04-c05-native-admission.mjs')
  const profile = selectProfile()
  assert.equal(profile.targetName, target)
  const { Client } = await import('pg')
  // Observe from postgres, never join the isolated target under test. All queries are SELECT.
  const observer = new Client({ connectionString: profile.adminURL,
    application_name: 'tili_ci_session_observer', statement_timeout: 2000, connectionTimeoutMillis: 5000 })
  const trace = join(directory, 'native-session-samples.jsonl')
  writeFileSync(trace, '', { flag: 'wx' })
  let child = null, done = false, samples = 0, previous = null, observerError = null, outcome = null
  const reportError = error => ({ name: error.name, code: error.code ?? null })
  try {
    await observer.connect()
    const identity = (await observer.query('select current_database() as name')).rows[0]
    assert.equal(identity.name, 'postgres')
    const sample = async () => {
      const rows = sessionRows((await observer.query(SESSION_SQL, [target])).rows)
      samples += 1
      const serialized = JSON.stringify(rows)
      if (serialized !== previous) {
        appendFileSync(trace, JSON.stringify({ at: new Date().toISOString(), rows })+'\n')
        previous = serialized
      }
    }
    await sample()
    child = spawn(process.execPath, ['scripts/c04-c05-isolated-lane.mjs', '--github-ci', '--run-approved-native'], { stdio: 'inherit' })
    const finished = new Promise(resolveDone => {
      let spawnError = null
      child.once('error', error => { spawnError = reportError(error) })
      child.once('close', (exitCode, signal) => { done = true; resolveDone({ exitCode, signal, spawnError }) })
    })
    const observations = (async () => {
      while (!done && samples < 12000) {
        try { await sleep(100); if (!done) await sample() }
        catch (error) { observerError = reportError(error); break }
      }
      if (!done && samples >= 12000) observerError = { name: 'ObservationLimit', code: null }
    })()
    outcome = await finished
    await observations
    // Keep a last snapshot, but never use its cleanliness to erase an earlier failed guard.
    try { await sample() } catch (error) { observerError ??= reportError(error) }
  } catch (error) {
    observerError = reportError(error)
  } finally {
    done = true
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await observer.end().catch(error => { observerError ??= reportError(error) })
    save('native-observation.json', { context, target, samples, outcome, observerError,
      note: 'Observer only. Native admission rules and test arguments are unchanged. No SQL text or raw connection labels collected.' })
    process.exitCode = outcome?.exitCode || (outcome?.exitCode === 0 && !observerError ? 0 : 1)
  }
}
