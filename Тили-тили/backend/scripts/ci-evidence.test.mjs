import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SESSION_SQL, sessionTarget, sessionRows, redact, vitestSummary } from './ci-evidence.mjs'

const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bairasbai/tili-tili',
  GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'backend', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }

test('targets only the current isolated run and attempt', () => {
  assert.equal(sessionTarget(env), 'tili_c04_c05_123_2_test')
})
for (const [key, value] of [['GITHUB_ACTIONS','false'], ['GITHUB_REPOSITORY','other/repo'],
  ['GITHUB_WORKFLOW','other'], ['GITHUB_JOB','other'], ['GITHUB_RUN_ID','0'],
  ['GITHUB_RUN_ID',"1' OR 1=1"], ['GITHUB_RUN_ID','../x'], ['GITHUB_RUN_ATTEMPT',''],
  ['GITHUB_RUN_ATTEMPT','1.1'], ['GITHUB_RUN_ID','1'.repeat(21)]]) {
  test(`rejects invalid execution context ${key}=${value}`, () => {
    assert.throws(() => sessionTarget({ ...env, [key]: value }))
  })
}
test('uses a parameterized read, never a database-changing statement', () => {
  assert.match(SESSION_SQL, /where datname = \$1 order by pid$/)
  assert.doesNotMatch(SESSION_SQL, /\b(?:insert|update|delete|drop|alter|terminate|cancel)\b/i)
  assert.doesNotMatch(SESSION_SQL, /(?:^|,)\s*query\s*(?:,|from)/i)
})
for (const type of ['client backend','autovacuum worker','parallel worker',null]) {
  test(`retains observed process type ${type} without admitting or filtering it`, () => {
    const rows = sessionRows([{ pid: 1139, backend_type: type, application_name: '', state: 'active' }])
    assert.equal(rows.length, 1); assert.equal(rows[0].backendType, type)
    assert.equal(rows[0].pid, 1139); assert.equal(rows[0].hasApplicationName, false)
  })
}
test('does not export raw labels, SQL or connection secrets from a snapshot', () => {
  const raw = 'private-label-value'
  const rows = sessionRows([{ pid: 2, application_name: raw, query: 'private SQL', client_addr: 'private address', password: 'private password' }])
  assert.equal(rows[0].hasApplicationName, true)
  assert.match(rows[0].applicationNameSHA256, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(rows), /private|password|client_addr/)
})
test('does not mutate incoming observations', () => {
  const input = [{ pid: 7, backend_type: 'client backend', state: null }]
  const before = structuredClone(input); sessionRows(input); assert.deepEqual(input, before)
})
test('rejects a malformed observation instead of reporting an empty database', () => {
  assert.throws(() => sessionRows([{ pid: null }]))
  assert.throws(() => sessionRows(null))
})
test('records missing test evidence as unknown, never zero tests passed', () => {
  const result = vitestSummary(null, 1)
  assert.equal(result.reportPresent, false); assert.equal(result.totals.numPassedTests, null)
  assert.equal(result.processExitCode, 1); assert.equal(result.reportedSuccess, null)
})
test('retains process failure even when a reporter claims success', () => {
  const result = vitestSummary({ success: true, numPassedTests: 3, testResults: [] }, 1)
  assert.equal(result.processExitCode, 1); assert.equal(result.reportedSuccess, true)
})
test('records failed assertions and collection failures separately', () => {
  const result = vitestSummary({ success: false, testResults: [
    { name: 'suite-one', status: 'failed', assertionResults: [{ fullName: 'case-one', status: 'failed', failureMessages: ['expected A'] }] },
    { name: 'suite-two', status: 'failed', message: 'collection failed', assertionResults: [] },
  ] }, 1)
  assert.equal(result.failures.length, 1); assert.equal(result.failedSuites.length, 2)
  assert.equal(result.failedSuites[1].message, 'collection failed')
})
test('redacts JWT, bearer and database connection strings from failure messages', () => {
  const value = redact('eyJmb28.abc.def Bearer opaqueValue postgres://user:pass@host/db redis://user:pass@host/0')
  assert.doesNotMatch(value, /opaqueValue|user:pass|eyJmb28/)
  assert.match(value, /redacted-token/)
})
test('retains finite skipped/todo counts without calling them passed', () => {
  const result = vitestSummary({ numTotalTests: 4, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numTodoTests: 1 }, 1)
  assert.deepEqual(result.totals, { numTotalTests: 4, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numTodoTests: 1 })
})
