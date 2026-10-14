import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HOME = path.dirname(fileURLToPath(import.meta.url));
const ORIGINAL = 'C:/Тили-тили/.unlazy/wp03-onboarding-20261010';
const ADMISSION_PATH = ORIGINAL + '/browser-d5ee2228-fba2-482e-bb96-838f174428c9/admission.json';
const ADMISSION_SHA256 = '3EA4CC8631510388157EB4CA4F98082F58EFAECB78787AAEFCFFF17F03B81A61';
const DIAGNOSTIC_V12_SHA256 = 'D5C6E36292B490F7C28D72637075D7863B7CE324210EF0B756072E6AB2D42A74';
const PUBLIC_PATHS = new Set(['/health', '/legal/policy']);
const now = () => Date.now() / 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const hashChunk = Buffer.allocUnsafe(1024 * 1024);
const fileSHA = file => {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, hashChunk, 0, hashChunk.length, null)) > 0) digest.update(hashChunk.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex').toUpperCase();
};
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (out, name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), {flag: 'wx'});
const bounded = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
};
const safeError = (stage, error) => ({stage, name: /^[A-Za-z]+Error$/.test(error?.name ?? '') ? error.name : 'Error', code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : null});

function probeCookie(headers) {
  if (headers.authorization !== undefined) return {valid: false, hash: null};
  if (headers.cookie === undefined) return {valid: true, hash: null};
  if (typeof headers.cookie !== 'string') return {valid: false, hash: null};
  const pieces = headers.cookie.split(';').map(part => part.trim());
  if (pieces.length !== 1) return {valid: false, hash: null};
  const match = /^tt_probe_case=([A-Za-z0-9._~-]{1,160})$/.exec(pieces[0]);
  return match ? {valid: true, hash: sha(Buffer.from(match[1], 'ascii'))} : {valid: false, hash: null};
}

function installScopedObserver(app, installPassivePublicObserver, rows, collectorErrors, bindingErrors, bindings) {
  const requests = new WeakMap();
  app.addHook('onRequest', (request, reply, done) => {
    const cookie = probeCookie(request.raw.headers);
    const observed = {raw: request.raw, response: reply.raw, ordinal: rows.length, cookieHash: cookie.hash, cookieValid: cookie.valid};
    if (requests.has(request.raw)) bindingErrors.push({stage: 'before', reason: 'DUPLICATE_RAW_REQUEST'});
    requests.set(request.raw, observed);
    done();
  });
  installPassivePublicObserver(app, rows, collectorErrors);
  app.addHook('onRequest', (request, reply, done) => {
    const observed = requests.get(request.raw);
    const row = observed ? rows[observed.ordinal] : null;
    const bound = Boolean(observed && row && rows.length === observed.ordinal + 1 && observed.raw === request.raw && observed.response === reply.raw && row.method === request.raw.method && row.path === request.raw.url);
    if (!bound) bindingErrors.push({stage: 'after', reason: 'ONREQUEST_ORDINAL_BINDING_FAILED'});
    else {
      // This is the only added native-row field. Raw Cookie is never persisted.
      row.caseCookieSHA256 = observed.cookieHash;
      observed.row = row;
      bindings.push({ordinal: observed.ordinal, bracketBound: true, rawResponseIdentity: true, finishBound: false, responseBound: false});
      const proof = bindings.at(-1);
      observed.proof = proof;
      reply.raw.once('finish', () => {
        proof.finishBound = rows[observed.ordinal] === row && observed.raw === request.raw && observed.response === reply.raw;
        if (!proof.finishBound) bindingErrors.push({stage: 'finish', reason: 'ROW_POSITION_OR_RESPONSE_CHANGED'});
      });
    }
    if (!observed?.cookieValid || request.raw.method !== 'GET' || !PUBLIC_PATHS.has(request.raw.url)) {
      bindingErrors.push({stage: 'guard', reason: 'ANONYMOUS_PUBLIC_GET_SCOPE_REJECTED'});
      reply.code(403).send({error: 'DIAGNOSTIC_PUBLIC_GET_ONLY'});
    }
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const observed = requests.get(request.raw);
    if (observed?.proof) {
      observed.proof.responseBound = rows[observed.ordinal] === observed.row && observed.response === reply.raw;
      if (!observed.proof.responseBound) bindingErrors.push({stage: 'onResponse', reason: 'ROW_POSITION_OR_RESPONSE_CHANGED'});
    } else bindingErrors.push({stage: 'onResponse', reason: 'UNBOUND_RESPONSE'});
    done();
  });
}

function validateScopedObservation(rows, collectorErrors, bindingErrors, bindings, policyVersion) {
  assert(collectorErrors.length === 0 && bindingErrors.length === 0, 'PUBLIC_OBSERVER_ERRORS');
  assert(rows.length > 0 && bindings.length === rows.length, 'PUBLIC_OBSERVER_COUNT');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], proof = bindings[index];
    assert(proof.ordinal === index && proof.bracketBound && proof.rawResponseIdentity && proof.finishBound && proof.responseBound, 'PUBLIC_OBSERVER_BINDING');
    assert(row.method === 'GET' && PUBLIC_PATHS.has(row.path) && row.registeredPath === row.path, 'PUBLIC_ENDPOINT_SCOPE');
    assert(row.authorizationPresent === false, 'AUTHORIZATION_REJECTED');
    assert(row.caseCookieSHA256 === null || /^[A-F0-9]{64}$/.test(row.caseCookieSHA256), 'COOKIE_SHA_SCOPE');
    assert(row.cookiePresent === (row.caseCookieSHA256 !== null), 'ONLY_PROBE_COOKIE_ALLOWED');
    assert(row.contentLength === null || row.contentLength === '0', 'GET_BODY_REJECTED');
    assert(row.status === 200 && row.serializedStatus === 200 && row.cacheControl === 'no-store', 'PUBLIC_RESPONSE_STATUS_CACHE');
    assert(/^application\/json(?:;\s*charset=utf-8)?$/i.test(row.contentType ?? ''), 'PUBLIC_CONTENT_TYPE');
    assert(row.onSendCount === 1 && row.responseHookCount === 1 && row.rawFinishCount === 1, 'PUBLIC_HOOK_COUNTS');
    assert(Number.isFinite(row.startedAt) && Number.isFinite(row.finishedAt) && row.startedAt <= row.finishedAt && Number.isFinite(row.onResponseAt), 'PUBLIC_RESPONSE_TIMESTAMPS');
    assert(/^[A-F0-9]{64}$/.test(row.bodySHA256) && Number.isSafeInteger(row.bodyBytes) && row.bodyBytes > 0, 'PUBLIC_BODY_BYTES');
    if (row.path === '/health') assert(row.body?.status === 'ok' && Number.isSafeInteger(row.body.uptime) && row.body.uptime >= 0 && Object.keys(row.body).sort().join(',') === 'status,uptime', 'HEALTH_BODY');
    else assert(row.body?.policyVersion === policyVersion && Object.keys(row.body).join(',') === 'policyVersion', 'POLICY_BODY');
  }
  return {passed: true, rows: rows.length, allOrdinalsBound: true};
}

async function reservePort() {
  const reservation = net.createServer();
  await bounded(new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); }), 5000, 'LOOPBACK_RESERVATION_DEADLINE');
  const port = reservation.address().port;
  await bounded(new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve())), 5000, 'RESERVATION_CLOSE_DEADLINE');
  return port;
}

function nullProof(app) {
  assert(app.db === null && app.redis === null && app.jobs === null, 'NULL_BACKEND_REQUIRED');
  return {verifiedAt: now(), db: null, redis: null, jobs: null};
}

async function closeApp(app) {
  if (!app) return;
  try { await bounded(app.close(), 15000, 'OWN_API_CLOSE_DEADLINE'); }
  catch (error) { app.server.closeAllConnections?.(); throw error; }
}

function rawGET(port, endpoint, cookieValue = null) {
  return bounded(new Promise((resolve, reject) => {
    const startedAt = now();
    const request = http.request({host: '127.0.0.1', port, path: endpoint, method: 'GET', agent: false, headers: cookieValue === null ? {} : {Cookie: 'tt_probe_case=' + cookieValue}}, response => {
      const pieces = []; let size = 0;
      response.on('data', piece => { size += piece.length; if (size > 65536) request.destroy(new Error('PUBLIC_BODY_SIZE')); else pieces.push(piece); });
      response.once('error', reject);
      response.once('end', () => {
        const body = Buffer.concat(pieces);
        const cacheValues = [];
        for (let i = 0; i < response.rawHeaders.length; i += 2) if (response.rawHeaders[i].toLowerCase() === 'cache-control') cacheValues.push(response.rawHeaders[i + 1]);
        const cacheBytes = Buffer.from(JSON.stringify(cacheValues), 'latin1');
        resolve({path: endpoint, probeCookiePresent: cookieValue !== null, probeCookieSHA256: cookieValue === null ? null : sha(Buffer.from(cookieValue, 'ascii')), startedAt, finishedAt: now(), status: response.statusCode, bodyBytes: body.length, bodySHA256: sha(body), bodyBase64: body.toString('base64'), cacheControl: cacheValues, cacheControlBytesSHA256: sha(cacheBytes)});
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('RAW_GET_DEADLINE')));
    request.once('error', reject); request.end();
  }), 6000, 'RAW_GET_OVERALL_DEADLINE');
}

async function baseline(buildApp, options, out) {
  let app; const result = {scope: 'Separate frozen null-backend instance; four raw GET only, no browser-runtime rows', requests: [], errors: [], passed: false};
  try {
    app = await buildApp({...options}, [], {tillyModel: null});
    app.addHook('onRequest', (request, reply, done) => { if (!probeCookie(request.raw.headers).valid || request.method !== 'GET' || !PUBLIC_PATHS.has(request.raw.url)) reply.code(403).send({error: 'DIAGNOSTIC_PUBLIC_GET_ONLY'}); done(); });
    await app.ready(); result.backendNullProof = nullProof(app);
    await app.listen({host: '127.0.0.1', port: 0}); result.port = app.server.address().port;
    // The compiled health route rounds real uptime. Stay away from the .5 boundary; never retry a mismatch.
    const uptime = process.uptime(), fraction = uptime % 1;
    if (fraction < 0.15 || fraction > 0.35) await sleep(Math.max(0, Math.ceil((Math.floor(uptime) + (fraction > 0.35 ? 1 : 0) + 0.2 - uptime) * 1000)));
    result.pairStartProcessUptime = process.uptime();
    const cookie = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    assert(/^[a-f0-9]{64}$/.test(cookie), 'BASELINE_COOKIE_FORMAT');
    result.probeCookieSHA256 = sha(Buffer.from(cookie, 'ascii'));
    for (const endpoint of ['/health', '/legal/policy']) {
      const without = await rawGET(result.port, endpoint), withCookie = await rawGET(result.port, endpoint, cookie);
      result.requests.push(without, withCookie);
      const equal = without.status === withCookie.status && without.bodyBase64 === withCookie.bodyBase64 && without.cacheControlBytesSHA256 === withCookie.cacheControlBytesSHA256;
      result[endpoint === '/health' ? 'healthEqual' : 'policyEqual'] = equal;
    }
    result.passed = result.healthEqual === true && result.policyEqual === true && result.requests.every(row => row.status === 200 && row.cacheControl.length === 1 && row.cacheControl[0] === 'no-store');
  } catch (error) { result.errors.push(safeError('baseline', error)); }
  finally {
    try { await closeApp(app); } catch (error) { result.errors.push(safeError('baseline-close', error)); }
    result.apiClosed = !app || !app.server.listening;
    result.passed = result.passed && result.apiClosed && result.errors.length === 0;
    save(out, 'byte-equivalence.json', result);
  }
  assert(result.passed, 'RAW_COOKIE_BYTE_EQUIVALENCE_FAILED');
  return {passed: true, requests: result.requests.length, separateAppClosed: result.apiClosed};
}

function launch(exe, args, prefix, out, name, environment = {}) {
  const fd = fs.openSync(path.join(out, name + '.log'), 'wx');
  let processHandle;
  try { processHandle = spawn(exe, args, {cwd: prefix, windowsHide: true, env: {...process.env, ...environment}, stdio: ['ignore', fd, fd]}); }
  finally { fs.closeSync(fd); }
  const state = {process: processHandle, closed: false};
  state.completed = new Promise(resolve => {
    processHandle.once('error', error => { state.spawnError = true; state.closed = true; resolve({error: safeError('spawn', error)}); });
    processHandle.once('close', (code, signal) => { state.closed = true; resolve({code, signal}); });
  });
  return state;
}

function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'OWN_PID_REQUIRED');
  const command = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '";if($p){$p|Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n="CreationUTC";e={$_.CreationDate.ToUniversalTime().ToString("o")}}|ConvertTo-Json -Compress}';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {windowsHide: true, encoding: 'utf8', timeout: 5000});
  assert(result.status === 0, 'OWN_PROCESS_METADATA_FAILED');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function bindProcess(state, executable, marker) {
  const identity = processIdentity(state.process.pid);
  assert(identity && identity.ParentProcessId === process.pid && identity.ProcessId === state.process.pid && identity.ExecutablePath.replaceAll('\\', '/').toLowerCase() === executable.replaceAll('\\', '/').toLowerCase() && identity.CommandLine.replaceAll('\\', '/').includes(marker.replaceAll('\\', '/')), 'OWN_PROCESS_IDENTITY_FAILED');
  state.identity = identity;
  return {pid: identity.ProcessId, parentPID: identity.ParentProcessId, createdUTC: identity.CreationUTC, commandLineSHA256: sha(Buffer.from(identity.CommandLine, 'utf8'))};
}

function assertStillOwned(state) {
  const current = processIdentity(state.process.pid);
  assert(current && state.identity && current.CreationUTC === state.identity.CreationUTC && current.ParentProcessId === process.pid && current.ExecutablePath === state.identity.ExecutablePath && current.CommandLine === state.identity.CommandLine, 'OWN_PROCESS_CHANGED');
}

async function forceOwnedTree(state) {
  if (!state || state.closed) return;
  assertStillOwned(state);
  const killed = spawnSync('taskkill.exe', ['/PID', String(state.process.pid), '/T', '/F'], {windowsHide: true, encoding: 'utf8', timeout: 5000});
  assert(killed.status === 0, 'OWN_PROCESS_TREE_KILL_FAILED');
  await bounded(state.completed, 5000, 'OWN_CHILD_CLOSE_DEADLINE');
}

export async function run(mode) {
  assert(mode === 'positive' || mode === 'main', 'MODE_REQUIRED');
  const out = path.join(HOME, mode); assert(!fs.existsSync(out), 'OUTPUT_MUST_NOT_EXIST'); fs.mkdirSync(out);
  let original, inputs = [], auxiliary = [], ownInputs = [], pins = [];
  const pinCheck = () => pins.map(row => ({path: row.path, expectedSHA256: row.sha256, actualSHA256: fileSHA(row.path)}));
  const report = {mode, status: 'FAILED', production: false, database: false, redis: false, scope: 'Pinned V14 bytes; cookie-only case attribution and teardown observation; no historical request identity or whole-WP acceptance', inputs: [], auxiliaryInputs: [], ownInputs: [], errors: [], startedAt: now()};
  const rows = [], collectorErrors = [], bindingErrors = [], bindings = [], cleanupErrors = [];
  let app, ui, child, prefix;
  try {
    original = readJSON(ADMISSION_PATH);
    assert(fileSHA(ADMISSION_PATH) === ADMISSION_SHA256, 'ORIGINAL_ADMISSION_PIN_CHANGED');
    assert(Array.isArray(original.build) && Array.isArray(original.backendBuild) && Array.isArray(original.harness) && Array.isArray(original.matrix), 'ORIGINAL_ADMISSION_SHAPE');
    inputs = [{path: ADMISSION_PATH, sha256: ADMISSION_SHA256}, ...original.build.map(row => ({path: original.staticRoot + '/' + row.path, sha256: row.sha256})), ...original.backendBuild.map(row => ({path: original.backendDist + '/' + row.path, sha256: row.sha256})), ...original.harness.slice(0, 2), original.nginx, original.python, original.chromium];
    auxiliary = [original.config, original.mime, original.harness.find(row => row.path.endsWith('/evidence.mjs'))];
    assert(auxiliary.every(row => row && typeof row.path === 'string' && /^[A-F0-9]{64}$/.test(row.sha256) && fs.existsSync(row.path)), 'ORIGINAL_AUXILIARY_PINS_REQUIRED');
    ownInputs = [fileURLToPath(import.meta.url), path.join(HOME, 'reconcile.mjs'), path.join(HOME, 'driver.py'), path.join(HOME, 'onboarding-browser-v12.py')].map(file => ({path: file, sha256: fileSHA(file)}));
    pins = [...inputs, ...auxiliary, ...ownInputs];
    Object.assign(report, {inputs, auxiliaryInputs: auxiliary, ownInputs});
    assert(inputs.length === 367 && original.build.length === 91 && original.backendBuild.length === 270 && original.matrix.length === 96, 'ORIGINAL_PIN_COUNTS');
    assert(ownInputs.at(-1).sha256 === DIAGNOSTIC_V12_SHA256, 'REVIEWED_DIAGNOSTIC_V12_BYTES_CHANGED');
    report.diagnosticObserver = {originalV12SHA256: original.harness[1].sha256, diagnosticV12SHA256: DIAGNOSTIC_V12_SHA256, scope: 'Root-reviewed diagnostic copy; the original remains separately pinned and unchanged'};
    report.beforePins = pinCheck(); assert(report.beforePins.every(row => row.actualSHA256 === row.expectedSHA256), 'INPUT_PINS_CHANGED');
    process.env.NODE_ENV = 'test'; process.env.DOTENV_CONFIG_PATH = path.join(out, 'absent.env');
    for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'REDIS_URL', 'TEST_REDIS_URL', 'SMS_PROVIDER', 'TILLY_PROVIDER', 'OPENROUTER_API_KEY', 'SENTRY_DSN']) delete process.env[key];
    const uiPort = await reservePort(), origin = 'http://127.0.0.1:' + uiPort;
    const secret = randomUUID() + randomUUID();
    const options = {env: 'test', databaseUrl: null, redisUrl: null, jobs: null, corsOrigins: [], jwtAccessSecret: secret, jwtRefreshSecret: secret + 'refresh', policyVersion: original.policyVersion, rateLimitPerSecond: 0, smsProvider: null, vapidPublicKey: null, vapidPrivateKey: null};
    const {buildApp} = await import(pathToFileURL(original.backendDist + '/app.js').href);
    const {installPassivePublicObserver} = await import(pathToFileURL(ORIGINAL + '/onboarding-browser-v14.mjs').href);
    report.baseline = await baseline(buildApp, options, out);
    app = await buildApp({...options}, [], {tillyModel: null});
    installScopedObserver(app, installPassivePublicObserver, rows, collectorErrors, bindingErrors, bindings);
    await app.ready(); report.backendNullProof = nullProof(app);
    await app.listen({host: '127.0.0.1', port: 0}); const apiPort = app.server.address().port;
    assert(uiPort !== apiPort, 'DISTINCT_OWN_PORTS_REQUIRED'); report.ports = {ui: uiPort, api: apiPort};
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'tili-policy-teardown-')).replaceAll('\\', '/'); assert(/^[\x20-\x7E]+$/.test(prefix), 'ASCII_NGINX_PREFIX_REQUIRED'); report.nginxPrefix = prefix;
    fs.mkdirSync(prefix + '/logs'); for (const name of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) fs.mkdirSync(prefix + '/' + name + '_temp');
    const originalConfig = fs.readFileSync(original.config.path, 'utf8');
    const substitutions = [[original.root + '/nginx', prefix], ['listen 127.0.0.1:8099;', 'listen 127.0.0.1:' + uiPort + ';'], ['proxy_pass http://127.0.0.1:8100/;', 'proxy_pass http://127.0.0.1:' + apiPort + '/;']];
    let configuration = originalConfig;
    for (const [from, to] of substitutions) { assert(configuration.includes(from), 'ORIGINAL_CONFIG_SUBSTITUTION_REQUIRED'); configuration = configuration.replaceAll(from, to); }
    let inverse = configuration; for (const [from, to] of [...substitutions].reverse()) inverse = inverse.replaceAll(to, from);
    assert(inverse === originalConfig, 'NGINX_ONLY_PORT_PREFIX_SUBSTITUTIONS');
    fs.writeFileSync(prefix + '/nginx.conf', configuration, {flag: 'wx'});
    report.nginxConfig = {originalSHA256: fileSHA(original.config.path), actualSHA256: sha(configuration), inverseExact: true, loggingAndHeadersUnchanged: true};
    const syntax = spawnSync(original.nginx.path, ['-p', prefix + '/', '-c', 'nginx.conf', '-t'], {cwd: prefix, windowsHide: true, encoding: 'utf8', timeout: 15000});
    fs.writeFileSync(path.join(out, 'nginx-syntax.log'), (syntax.stdout ?? '') + (syntax.stderr ?? ''), {flag: 'wx'}); assert(syntax.status === 0, 'OWN_NGINX_SYNTAX_FAILED');
    ui = launch(original.nginx.path, ['-p', prefix + '/', '-c', 'nginx.conf'], prefix, out, 'nginx');
    report.nginxOwner = bindProcess(ui, original.nginx.path, prefix + '/');
    await bounded((async () => { while (true) { assert(!ui.closed, 'NGINX_EXITED_BEFORE_READY'); const pidFile = prefix + '/nginx.pid'; if (fs.existsSync(pidFile)) { const value = fs.readFileSync(pidFile, 'utf8').trim(); if (/^[1-9]\d*$/.test(value)) { assert(Number(value) === ui.process.pid, 'OWN_NGINX_PID_MISMATCH'); return; } } await sleep(20); } })(), 5000, 'OWN_NGINX_READY_DEADLINE');
    save(out, 'admission-copy.json', {...original, origin, ports: {ui: uiPort, api: apiPort}, out, diagnosticOnly: true, policyTeardownMode: mode});
    save(out, 'server-ready.json', {origin, ports: report.ports, backendNullProof: report.backendNullProof, mode, noProbeHeaders: true});
    child = launch(original.python.path, [path.join(HOME, 'driver.py'), mode], prefix, out, 'browser', {ONBOARDING_OUT: out, TILI_POLICY_MODE: mode, TILI_POLICY_BASE_URL: origin, PLAYWRIGHT_CHROMIUM_EXECUTABLE: original.chromium.path, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'});
    report.pythonOwner = bindProcess(child, original.python.path, path.join(HOME, 'driver.py'));
    report.childDeadlineMs = mode === 'positive' ? 120000 : 3600000;
    report.child = await bounded(child.completed, report.childDeadlineMs, 'OWN_BROWSER_DRIVER_DEADLINE');
    assert(report.child.code === 0 && report.child.signal === null, 'BROWSER_DRIVER_FAILED');
    const journal = readJSON(path.join(out, 'case-journal.json'));
    assert(Array.isArray(journal.cases) && journal.cases.length > 0, 'CASE_JOURNAL_REQUIRED');
    const closeTimes = journal.cases.map(row => row.closeReturn);
    assert(closeTimes.every(value => Number.isFinite(value) && value > 0), 'CLOSE_RETURN_TIMESTAMPS_REQUIRED');
    const observeUntil = Math.max(...closeTimes) + 2;
    report.finalObservation = {lastCloseReturn: Math.max(...closeTimes), requiredUntil: observeUntil};
    // Retain every native occurrence through the complete final two-second observation window.
    await sleep(Math.max(0, Math.ceil((observeUntil - now()) * 1000)));
    report.finalObservation.completedAt = now();
    assert(report.finalObservation.completedAt >= observeUntil, 'POST_CLOSE_OBSERVATION_TOO_SHORT');
    report.observation = validateScopedObservation(rows, collectorErrors, bindingErrors, bindings, original.policyVersion);
    report.status = 'SERVER_COLLECTION_COMPLETE_UNQUALIFIED';
  } catch (error) { report.errors.push(safeError('run', error)); process.exitCode = 1; }
  finally {
    if (child && !child.closed) {
      try {
        fs.writeFileSync(path.join(out, 'stop.request.json'), JSON.stringify({reason: 'OWN_RUNNER_FINALLY', mode}), {flag: 'wx'});
        await bounded(child.completed, 5000, 'OWN_DRIVER_GRACEFUL_CLOSE_DEADLINE');
      } catch (error) { cleanupErrors.push(safeError('driver-graceful-close', error)); try { await forceOwnedTree(child); } catch (killError) { cleanupErrors.push(safeError('driver-tree-close', killError)); } }
    }
    if (ui && !ui.closed) {
      try {
        assertStillOwned(ui);
        const quit = spawnSync(original.nginx.path, ['-p', prefix + '/', '-c', 'nginx.conf', '-s', 'quit'], {cwd: prefix, windowsHide: true, encoding: 'utf8', timeout: 5000});
        assert(quit.status === 0, 'OWN_NGINX_QUIT_FAILED'); await bounded(ui.completed, 15000, 'OWN_NGINX_CLOSE_DEADLINE');
      } catch (error) { cleanupErrors.push(safeError('nginx-close', error)); try { await forceOwnedTree(ui); } catch (killError) { cleanupErrors.push(safeError('nginx-tree-close', killError)); } }
    }
    try { await closeApp(app); } catch (error) { cleanupErrors.push(safeError('api-close', error)); }
    try { report.afterPins = pinCheck(); report.inputsUnchanged = pins.length >= 367 && report.afterPins.every(row => row.actualSHA256 === row.expectedSHA256); } catch (error) { report.inputsUnchanged = false; report.errors.push(safeError('after-pins', error)); }
    report.cleanup = {errors: cleanupErrors, pythonClosed: !child || child.closed, nginxClosed: !ui || ui.closed, apiClosed: !app || !app.server.listening};
    report.finishedAt = now();
    if (cleanupErrors.length || !report.inputsUnchanged || !report.cleanup.pythonClosed || !report.cleanup.nginxClosed || !report.cleanup.apiClosed) { report.status = 'FAILED'; process.exitCode = 1; }
    save(out, 'actual-health.json', {scope: 'All browser-runtime native rows without exclusions; baseline is a separate closed app', backendNullProof: report.backendNullProof ?? null, appClosed: report.cleanup.apiClosed, rows, collectorErrors, bindingErrors, ordinalBindings: bindings});
    save(out, 'cleanup.json', report.cleanup); save(out, 'result.json', report);
    console.log(JSON.stringify({mode, status: report.status, nativeRows: rows.length, collectorErrors: collectorErrors.length, bindingErrors: bindingErrors.length, cleanupErrors: cleanupErrors.length, inputsUnchanged: report.inputsUnchanged}));
    if (cleanupErrors.length || !report.cleanup.pythonClosed || !report.cleanup.nginxClosed || !report.cleanup.apiClosed) process.exit(1);
  }
  return report;
}

if (typeof process !== 'undefined' && process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await run(process.argv[2]);
