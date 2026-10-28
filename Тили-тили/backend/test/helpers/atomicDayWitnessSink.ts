import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type WitnessFile = { file: string; bytes: number; sha256: string }
type WitnessEntry = { sequence: number; label: string; file: string; bytes: number; capturedAt: string;
  state: 'pending' | 'written' | 'failed'; late: boolean; sha256?: string; writtenAt?: string; error?: { name: string; code: string | null } }
type WitnessTask = { id: string; name: string; state: string; mode: string; errorCount: number }
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const norm = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const safeError = (error: unknown) => {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : {}
  return { name: typeof value.name === 'string' ? value.name : 'Error',
    code: typeof value.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(value.code) ? value.code : null }
}
function suiteTasks(value: unknown): WitnessTask[] {
  assert(value && typeof value === 'object')
  const task = value as { id?: unknown; name?: unknown; type?: unknown; mode?: unknown; tasks?: unknown;
    result?: { state?: unknown; errors?: unknown } }
  if (task.type !== 'test') { assert(Array.isArray(task.tasks)); return task.tasks.flatMap(suiteTasks) }
  assert(typeof task.id === 'string' && typeof task.name === 'string')
  return [{ id: task.id, name: task.name, mode: typeof task.mode === 'string' ? task.mode : 'unknown',
    state: typeof task.result?.state === 'string' ? task.result.state : 'unknown',
    errorCount: Array.isArray(task.result?.errors) ? task.result.errors.length : 0 }]
}

/** Atomic-only proof transport. No payload normalization, SQL, provider, or test result substitution. */
export function createAtomicDayWitnessSink() {
  const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), base = join(backend, '.ci', 'calendar371-native')
  const githubRun = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT
  assert((!githubRun && !attempt) || (/^[1-9][0-9]*$/.test(githubRun ?? '') && /^[1-9][0-9]*$/.test(attempt ?? '')))
  const namespace = githubRun ? `${githubRun}-${attempt}` : 'local', nonce = randomUUID()
  const rootName = `${namespace}-atomic-${nonce}`, root = join(base, rootName), ownerFile = `${rootName}.owner.json`
  const entries: WitnessEntry[] = [], pending: Promise<void>[] = [], errors: unknown[] = []
  let tail = Promise.resolve(), opened = false, closing = false, failedCase = false, abortedCase = false, sequence = 0
  let pendingBytes = 0, peakPendingBytes = 0
  let ownerRef: WitnessFile | undefined, startedRef: WitnessFile | undefined
  const atUTC = () => new Date().toISOString()
  async function directory(path: string, createIfMissing = false) {
    try { await lstat(path) } catch (error) {
      if (!createIfMissing || !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      try { await mkdir(path) } catch (race) {
        if (!(race && typeof race === 'object' && 'code' in race && race.code === 'EEXIST')) throw race
      }
    }
    const stat = await lstat(path)
    assert(stat.isDirectory() && !stat.isSymbolicLink() && norm(await realpath(path)) === norm(path), 'Witness directory redirects refused')
  }
  async function guardParent(path: string) {
    assert(path === base || path === root, 'Only the owned witness parent is writable')
    await directory(backend); await directory(join(backend, '.ci')); await directory(base)
    if (path === root) await directory(root)
  }
  async function persist(path: string, bytes: Uint8Array): Promise<WitnessFile> {
    const parent = dirname(path); await guardParent(parent)
    const fd = await open(path, 'wx', 0o600)
    let failure: { error: unknown } | undefined
    try { await fd.writeFile(bytes); await fd.sync() } catch (error) { failure = { error } }
    try { await fd.close() } catch (error) { failure = { error: failure ? new AggregateError([failure.error, error], 'Witness write/close failed') : error } }
    if (failure) throw failure.error
    await guardParent(parent)
    const stat = await lstat(path)
    assert(stat.isFile() && !stat.isSymbolicLink() && norm(await realpath(path)) === norm(path), 'Witness file redirects refused')
    const actual = await readFile(path)
    assert(actual.length === bytes.byteLength && actual.equals(bytes), 'Witness raw bytes changed')
    return { file: relative(base, path).split(sep).join('/'), bytes: actual.length, sha256: sha(actual) }
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')
  const receipt = (value: unknown) => process.stdout.write('CALENDAR371_NATIVE_WITNESS_FILE ' + JSON.stringify(value) + '\n')
  async function openSink() {
    assert(!opened && !ownerRef, 'Witness sink opens exactly once')
    await directory(backend); await directory(join(backend, '.ci'), true); await directory(base, true)
    ownerRef = await persist(join(base, ownerFile), encode({ schema: 'calendar371.atomic-witness-owner/1', owner: 'dealDayScopeAtomic.test.ts',
      state: 'incomplete', root: rootName, pid: process.pid, openedAt: atUTC(), githubRun: githubRun ?? null, attempt: attempt ?? null,
      checkoutSHA: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
      sourceBackend: backend, noDeletionBySink: true, noSemanticPassClaim: true }))
    await mkdir(root); await directory(root)
    const source = async (path: string) => {
      const stat = await lstat(path)
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4 * 1024 * 1024 && norm(await realpath(path)) === norm(path), 'Regular bounded own source required before read')
      const bytes = await readFile(path); assert(bytes.length === stat.size)
      return { path: relative(backend, path).split(sep).join('/'), bytes: bytes.length, sha256: sha(bytes) }
    }
    startedRef = await persist(join(root, 'manifest.started.json'), encode({ schema: 'calendar371.atomic-witness-manifest/1', state: 'incomplete',
      owner: ownerRef, createdAt: atUTC(), rawEncoding: 'UTF8', oldLiteral: '<label> <JSON.stringify(payload)>\n',
      sources: [await source(join(backend, 'test', 'dealDayScopeAtomic.test.ts')), await source(fileURLToPath(import.meta.url))],
      capturedAtOriginalCallsite: true, cpuSerializationDeferred: false, pendingWrites: true, testAssertionsQualified: false }))
    opened = true
    return { artifactRoot: root, owner: ownerRef, started: startedRef }
  }
  function capture(label: string, oldLine: string) {
    assert(opened && /^[A-Z0-9_]{1,128}$/.test(label) && oldLine.startsWith(label + ' ') && oldLine.endsWith('\n'), 'Exact original witness line required')
    // This UTF8 buffer fixes the old bytes NOW. JSON.stringify was evaluated by
    // the caller at its unchanged SQL/callback point; no deferred DB recapture.
    const bytes = Buffer.from(oldLine, 'utf8'), id = ++sequence
    const entry: WitnessEntry = { sequence: id, label, file: `witness-${String(id).padStart(6, '0')}.raw`, bytes: bytes.length,
      capturedAt: atUTC(), state: 'pending', late: closing }
    entries.push(entry)
    const retainedBytes = bytes.length; pendingBytes += retainedBytes; peakPendingBytes = Math.max(peakPendingBytes, pendingBytes)
    const task = tail.then(async () => {
      const result = await persist(join(root, entry.file), bytes)
      entry.state = 'written'; entry.sha256 = result.sha256; entry.writtenAt = atUTC()
      if (entry.late) await persist(join(root, `late-${String(id).padStart(6, '0')}.json`), encode({ sequence: id, lateCapture: true, raw: result }))
      receipt({ schema: 'calendar371.atomic-witness-file/1', root: rootName, label, sequence: id, file: entry.file,
        bytes: result.bytes, sha256: result.sha256, capturedAt: entry.capturedAt, writtenAt: entry.writtenAt, lateCapture: entry.late })
    }).catch((error: unknown) => { entry.state = 'failed'; entry.error = safeError(error); errors.push(error) })
      .then(() => { pendingBytes -= retainedBytes })
    tail = task; pending.push(task)
    if (entry.late) throw new Error('Late witness capture invalidates closed transport; raw write remains queued')
  }
  async function flush() {
    // A newly enqueued task while waiting must also settle before this flush.
    for (;;) {
      const last = tail; await last; await Promise.all(pending.splice(0))
      if (last === tail && pending.length === 0) break
    }
    assert(pendingBytes === 0, 'Witness batch did not fully drain')
    if (errors.length) throw new AggregateError([...errors], 'Atomic raw witness transport failed; retained files are incomplete')
  }
  function observeTest(state: string | undefined, aborted: boolean) {
    if (state !== 'pass' || aborted) failedCase = true
    if (aborted) abortedCase = true
  }
  async function beforeCase() {
    assert(opened && !closing && !abortedCase, 'An aborted case cannot start another artifact batch')
    await flush() // Slow prior afterEach cannot overlap another producer body.
  }
  async function closeSink(suite: unknown, setupCompleted: boolean, cleanupCompleted: boolean) {
    if (!opened) return // beforeAll already failed; no complete artifact is fabricated
    closing = true
    let flushFailure: { error: unknown } | undefined
    try { await flush() } catch (error) { flushFailure = { error } }
    const tasks = suiteTasks(suite)
    const complete = setupCompleted && cleanupCompleted && !failedCase && !abortedCase && !flushFailure && pendingBytes === 0 && pending.length === 0 && !entries.some(entry => entry.state !== 'written' || entry.late)
      && tasks.length > 0 && tasks.every(task => ['pass', 'skip', 'todo'].includes(task.state) && task.errorCount === 0)
    const sums = entries.filter(entry => entry.state === 'written').map(entry => `${entry.sha256}  ${entry.file}\n`).join('')
    let sumRef: WitnessFile | undefined, manifestRef: WitnessFile | undefined, finalFailure: { error: unknown } | undefined
    try {
      sumRef = await persist(join(root, 'SHA256SUMS'), Buffer.from(sums, 'utf8'))
      manifestRef = await persist(join(root, complete ? 'manifest.complete.json' : 'manifest.incomplete.json'), encode({
        schema: 'calendar371.atomic-witness-manifest/1', state: complete ? 'complete' : 'incomplete', closedAt: atUTC(),
        owner: ownerRef, started: startedRef, root: rootName, emitted: sequence, entries, sums: sumRef, tasks,
        setupCompleted, cleanupCompleted, failedCase, abortedCase, pendingBytes, peakPendingBytes, transportErrors: errors.map(safeError),
        completeMeans: 'all emitted raw bytes drained at this closure, not test or process acceptance',
        requiresNativeEOFAndClosedInventory: true, anyLateOrExtraArtifactInvalidatesComplete: true,
        testAssertionsQualified: false, noPayloadNormalizationOrTruncation: true }))
      receipt({ schema: 'calendar371.atomic-witness-closed/1', root: rootName, state: complete ? 'complete' : 'incomplete',
        emitted: sequence, manifest: manifestRef, testAssertionsQualified: false })
    } catch (error) { finalFailure = { error } }
    if (flushFailure || finalFailure) throw new AggregateError([...(flushFailure ? [flushFailure.error] : []), ...(finalFailure ? [finalFailure.error] : [])], 'Atomic witness finalization failed; started marker/raw files retained')
  }
  return { open: openSink, beforeCase, capture, observeTest, flush, close: closeSink }
}
