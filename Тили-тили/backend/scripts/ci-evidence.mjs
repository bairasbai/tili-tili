/** Diagnostic projections only. They cannot admit tests or turn a failed run green. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const SESSION_SQL = `select pid, backend_type, application_name, state,
  backend_start, xact_start, query_start, state_change, wait_event_type, wait_event
  from pg_stat_activity where datname = $1 order by pid`

export function sessionTarget(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.GITHUB_REPOSITORY, 'bairasbai/tili-tili')
  assert.equal(env.GITHUB_WORKFLOW, 'CI')
  assert.equal(env.GITHUB_JOB, 'backend')
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    assert.match(env[key] ?? '', /^[1-9][0-9]{0,19}$/)
  }
  const name = `tili_c04_c05_${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}_test`
  assert(name.length <= 63)
  return name
}

export function sessionRows(rows) {
  assert(Array.isArray(rows))
  return rows.map(row => {
    assert(Number.isInteger(row.pid) && row.pid > 0)
    const label = typeof row.application_name === 'string' ? row.application_name : ''
    // No SQL text, connection URL, client address, user name or raw application label.
    return {
      pid: row.pid, backendType: row.backend_type ?? null, state: row.state ?? null,
      hasApplicationName: label.length > 0,
      applicationNameSHA256: label ? createHash('sha256').update(label).digest('hex') : null,
      backendStart: row.backend_start ?? null, transactionStart: row.xact_start ?? null,
      queryStart: row.query_start ?? null, stateChange: row.state_change ?? null,
      waitEventType: row.wait_event_type ?? null, waitEvent: row.wait_event ?? null,
    }
  })
}

export function redact(text) {
  return String(text)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\b(postgres(?:ql)?|redis):\/\/[^\s"')]+/gi, '$1://[redacted]')
}

export function vitestSummary(result, exitCode) {
  assert(Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255)
  const files = Array.isArray(result?.testResults) ? result.testResults : []
  return {
    processExitCode: exitCode,
    reportPresent: result !== null,
    reportedSuccess: typeof result?.success === 'boolean' ? result.success : null,
    totals: Object.fromEntries(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']
      .map(key => [key, Number.isInteger(result?.[key]) ? result[key] : null])),
    failures: files.flatMap(file => (file.assertionResults ?? [])
      .filter(test => test.status === 'failed')
      .map(test => ({ name: redact(test.fullName ?? test.title ?? ''),
        messages: (test.failureMessages ?? []).map(redact) }))),
    // Failed suites can have no assertions (for example an import/collection error).
    failedSuites: files.filter(file => file.status === 'failed')
      .map(file => ({ name: redact(file.name ?? ''), message: redact(file.message ?? '') })),
    note: 'Diagnostic report only; the original process exit code remains authoritative.',
  }
}
