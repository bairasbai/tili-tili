/** Simulated children/driver test the wrapper, not PostgreSQL or application behavior. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scripts = dirname(fileURLToPath(import.meta.url))
function exercise(mode, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-wrapper-unit-'))
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  try {
    for (const file of ['ci-evidence.mjs', 'ci-evidence-runner.mjs']) {
      mkdirSync(join(root, 'scripts'), { recursive: true }); copyFileSync(join(scripts, file), join(root, 'scripts', file))
    }
    write('node_modules/vitest/vitest.mjs', `import {writeFileSync} from 'node:fs';
      const out=process.argv.find(a=>a.startsWith('--outputFile=')).slice('--outputFile='.length);
      if(process.env.FIXTURE_REPORT!=='absent') writeFileSync(out,process.env.FIXTURE_REPORT==='broken'?'bad-json':JSON.stringify({success:true,numPassedTests:2,testResults:[]}));
      process.exit(Number(process.env.FIXTURE_EXIT));`)
    write('test-support/c04-c05-native-admission.mjs', `export const selectProfile=()=>({targetName:'tili_c04_c05_123_1_test',adminURL:'postgres://fixture'});`)
    write('node_modules/pg/package.json', '{"type":"module","exports":"./index.js"}')
    write('node_modules/pg/index.js', `export class Client {
      async connect() { if(process.env.FIXTURE_DRIVER==='fail') throw Object.assign(new Error('private detail'),{code:'ECONNREFUSED'}) }
      async query(sql,params) { if(sql.includes('current_database()')) return {rows:[{name:process.env.FIXTURE_DRIVER==='wrong-db'?'wrong':'postgres'}]};
        if(params[0]!=='tili_c04_c05_123_1_test') throw new Error('wrong target');return {rows:[{pid:1139,backend_type:'autovacuum worker',application_name:'',state:'active',query:'private SQL'}]}; }
      async end() {}
    }`)
    write('scripts/c04-c05-isolated-lane.mjs', `import assert from 'node:assert/strict';
      assert.deepEqual(process.argv.slice(2),['--github-ci','--run-approved-native']);
      if(process.env.FIXTURE_SIGNAL==='yes') process.kill(process.pid,'SIGTERM');else process.exit(Number(process.env.FIXTURE_EXIT));`)
    const run = spawnSync(process.execPath, ['scripts/ci-evidence-runner.mjs', mode], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bairasbai/tili-tili',
        GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'backend', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
        RUNNER_TEMP: join(root, 'evidence'), FIXTURE_EXIT: '0', ...settings },
    })
    assert.equal(run.signal, null, run.stderr)
    const dir = join(root, 'evidence', 'tili-backend-evidence-123-1')
    const result = JSON.parse(readFileSync(join(dir, mode === 'vitest' ? 'vitest-summary.json' : 'native-observation.json'), 'utf8'))
    const trace = mode === 'native' ? readFileSync(join(dir, 'native-session-samples.jsonl'), 'utf8') : null
    return { exit: run.status, result, trace }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
for (const mode of ['vitest', 'native']) {
  test(`${mode}: retains a successful simulated process exit`, () => assert.equal(exercise(mode).exit, 0))
  test(`${mode}: retains a nonzero simulated process exit`, () => assert.equal(exercise(mode, { FIXTURE_EXIT: '7' }).exit, 7))
}
for (const report of ['absent','broken']) {
  test(`vitest: missing/unreadable ${report} evidence cannot be reported as a pass`, () => {
    const out = exercise('vitest', { FIXTURE_REPORT: report })
    assert.equal(out.exit, 1); assert.equal(out.result.reportPresent, false)
    assert.equal(out.result.totals.numPassedTests, null)
  })
}
test('native: observer does not suppress an observed worker or native failure', () => {
  const out = exercise('native', { FIXTURE_EXIT: '7' })
  assert.equal(out.exit, 7); assert.match(out.trace, /autovacuum worker/)
  assert.doesNotMatch(out.trace, /private SQL/)
})
for (const driver of ['fail','wrong-db']) {
  test(`native: ${driver} observer fails closed without claiming execution`, () => {
    const out = exercise('native', { FIXTURE_DRIVER: driver })
    assert.equal(out.exit, 1); assert.equal(out.result.outcome, null)
    assert(out.result.observerError); assert.doesNotMatch(JSON.stringify(out.result), /private detail/)
  })
}
test('native: signal exit cannot become a successful diagnostic run', () => {
  const out = exercise('native', { FIXTURE_SIGNAL: 'yes' })
  assert.equal(out.exit, 1); assert.equal(out.result.outcome.signal, 'SIGTERM')
})
