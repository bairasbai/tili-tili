import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HOME = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_PATHS = new Set(['/health', '/legal/policy']);
const HASH = /^[A-Fa-f0-9]{64}$/;
const CLOCK_EPSILON = 0.001; // Server Date.now() has millisecond precision; no CDP monotonic-clock conversion.
const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const canonicalSHA = value => sha(Buffer.from(JSON.stringify(value), 'utf8'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
function fileSHA(file) {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, hashBuffer, 0, hashBuffer.length, null)) > 0) digest.update(hashBuffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex').toUpperCase();
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const digest = value => typeof value === 'string' && HASH.test(value) ? value.toUpperCase() : null;
const endpoint = value => typeof value === 'string' ? (value.startsWith('/api/') ? value.slice(4) : value) : null;
const identifier = row => row?.id ?? row?.requestId;

function safeNative(row, index) {
  return {serverOrdinal: index, path: PUBLIC_PATHS.has(row.path) ? row.path : 'OUT_OF_SCOPE', method: row.method === 'GET' ? 'GET' : 'OUT_OF_SCOPE', caseCookieSHA256: digest(row.caseCookieSHA256), startedAt: finite(row.startedAt) ? row.startedAt : null, finishedAt: finite(row.finishedAt) ? row.finishedAt : null, status: Number.isInteger(row.status) ? row.status : null, bodySHA256: digest(row.bodySHA256), bodyBytes: Number.isSafeInteger(row.bodyBytes) ? row.bodyBytes : null, rowSHA256: canonicalSHA(row)};
}

function errorArrays(value, source, output, location = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 30) return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...location, key];
    if (/(errors|failures)$/i.test(key)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) errorArrays(child, source, output, next, depth + 1);
      else {
        const count = Array.isArray(child) ? child.length : child === null ? 0 : 1;
        if (count) output.push({code: 'NONEMPTY_ERROR_ARRAY', source, fieldPathSHA256: canonicalSHA(next), count});
      }
    } else if (child && typeof child === 'object') errorArrays(child, source, output, next, depth + 1);
  }
}

function perfectMatching(serverIndices, browserIndices, edges, omitted = null) {
  if (serverIndices.length !== browserIndices.length) return null;
  const browserSet = new Set(browserIndices), owner = new Map();
  function augment(server, visited) {
    for (const browser of edges.get(server) ?? []) {
      if (!browserSet.has(browser) || (omitted && omitted[0] === server && omitted[1] === browser) || visited.has(browser)) continue;
      visited.add(browser);
      if (!owner.has(browser) || augment(owner.get(browser), visited)) { owner.set(browser, server); return true; }
    }
    return false;
  }
  for (const server of serverIndices) if (!augment(server, new Set())) return null;
  return new Map([...owner].map(([browser, server]) => [server, browser]));
}

export function reconcile({mode, admission, summary, browser, native, journal, runner, baseline}) {
  assert(mode === 'positive' || mode === 'main', 'MODE_REQUIRED');
  const errors = [], paired = [], closingRows = [], unpairedRows = [], unmatchedBrowser = [], ambiguousComponents = [];
  const issue = (code, metadata = {}) => errors.push({code, ...metadata});
  for (const [source, value] of Object.entries({summary, browser, native, journal, runner, baseline})) errorArrays(value, source, errors);
  const result = {mode, status: 'FAILED', production: false, historicalCaller: 'UNKNOWN', scope: 'New-run occurrence reconciliation only; no reconstructed historical transport request ID', precision: {serverSeconds: CLOCK_EPSILON, matchingUses: 'Actually retained PW network start/end epoch timestamps'}, errors, paired, closingRows, unpairedRows, unmatchedBrowser, ambiguousComponents};
  if (!Array.isArray(admission?.matrix) || admission.matrix.length !== 96) issue('FULL_ORIGINAL_MATRIX_REQUIRED');
  const matrix = admission?.matrix ?? [];
  const expected = mode === 'main' ? matrix.filter(row => row.network === 'offline') : matrix.filter(row => row.id === 'en-320-1-offline-normal');
  const expectedIDs = new Set(expected.map(row => row.id));
  if (expected.length !== (mode === 'main' ? 48 : 1) || expectedIDs.size !== expected.length) issue('EXPECTED_CASE_SET_INVALID');
  if (admission?.policyTeardownMode !== mode || runner?.mode !== mode || summary?.mode !== mode) issue('MODE_BINDING_FAILED');
  if (summary?.status !== 'CASE_COLLECTION_COMPLETE' || summary?.browserClosed !== true || summary?.contextsCreated !== expected.length || summary?.contextsClosed !== expected.length) issue('BROWSER_SUMMARY_NOT_COMPLETE');
  if (mode === 'main' && (summary?.traceEnabled !== false || summary?.injectedLoggers !== false)) issue('MAIN_PASSIVE_BROWSER_PROFILE_CHANGED');
  const expectedHeld = expected.reduce((total, row) => total + (row.scene === 4 ? 18 : 9), 0);
  const expectedCounts = {layouts: expected.length, held: expectedHeld, png: expectedHeld + expected.length};
  result.expectedCounts = {derivation: 'One layout/context per selected case; scene4 has18 held captures, scenes1-3 have9; one primary PNG plus held PNGs', ...expectedCounts};
  if (summary?.counts?.layouts !== expectedCounts.layouts || summary?.counts?.held !== expectedCounts.held || summary?.counts?.png !== expectedCounts.png) issue('BROWSER_CAPTURE_COUNTS_FAILED');
  if (!Array.isArray(summary?.selectedCaseIds) || JSON.stringify(summary.selectedCaseIds) !== JSON.stringify(expected.map(row => row.id))) issue('SELECTED_CASE_ORDER_OR_SET_CHANGED');
  const summaryCases = Array.isArray(summary?.cases) ? summary.cases : [];
  if (summaryCases.length !== expected.length) issue('SUMMARY_CASE_COUNT_INCOMPLETE');
  const summaryByID = new Map();
  for (const item of summaryCases) {
    const spec = expected.find(row => row.id === item.caseId);
    if (!spec || summaryByID.has(item.caseId)) { issue('SUMMARY_UNEXPECTED_OR_DUPLICATE_CASE'); continue; }
    summaryByID.set(item.caseId, item);
    const held = spec.scene === 4 ? 18 : 9;
    if (item.status !== 'CASE_COLLECTION_COMPLETE' || item.originalStatus !== 'CASE_COLLECTION_COMPLETE_UNQUALIFIED' || item.counts?.layouts !== 1 || item.counts?.held !== held || item.counts?.png !== held + 1 || !digest(item.capture?.sha256) || !Number.isSafeInteger(item.capture?.bytes) || item.capture.bytes <= 0) issue('SUMMARY_CASE_CAPTURE_INCOMPLETE', {caseId: item.caseId});
  }
  for (const key of ['layouts', 'held', 'png', 'requests', 'responses', 'finished']) {
    const values = summaryCases.map(item => item.counts?.[key]);
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(summary?.counts?.[key]) || values.reduce((total, value) => total + value, 0) !== summary.counts[key]) issue('SUMMARY_COUNT_SUM_FAILED', {field: key});
  }
  if (summary?.counts?.requests !== summary?.counts?.responses || summary?.counts?.requests !== summary?.counts?.finished) issue('SUMMARY_COMPLETION_COUNTS_FAILED');
  if (runner?.status !== 'SERVER_COLLECTION_COMPLETE_UNQUALIFIED' || runner?.inputsUnchanged !== true) issue('RUNNER_NOT_COMPLETE_OR_INPUTS_CHANGED');
  if (runner?.cleanup?.pythonClosed !== true || runner?.cleanup?.nginxClosed !== true || runner?.cleanup?.apiClosed !== true) issue('OWN_CLEANUP_NOT_COMPLETE');
  if (baseline?.passed !== true || baseline?.apiClosed !== true || baseline?.requests?.length !== 4 || baseline?.healthEqual !== true || baseline?.policyEqual !== true) issue('SEPARATE_RAW_BYTE_EQUIVALENCE_FAILED');
  if (native?.backendNullProof?.db !== null || native?.backendNullProof?.redis !== null || native?.backendNullProof?.jobs !== null || native?.appClosed !== true) issue('NULL_BACKEND_SCOPE_FAILED');
  const cases = Array.isArray(journal?.cases) ? journal.cases : [];
  if (cases.length !== expected.length) issue('CASE_COUNT_INCOMPLETE', {expected: expected.length, actual: cases.length});
  const casesByID = new Map(), casesByCookie = new Map();
  const validCases = [];
  for (const item of cases) {
    if (!expectedIDs.has(item.caseId) || casesByID.has(item.caseId)) { issue('UNEXPECTED_OR_DUPLICATE_CASE'); continue; }
    casesByID.set(item.caseId, item);
    const cookie = digest(item.caseCookieSHA256);
    if (!cookie || casesByCookie.has(cookie)) { issue('CASE_COOKIE_SHA_MISSING_OR_REUSED', {caseId: item.caseId}); continue; }
    casesByCookie.set(cookie, item);
    const validTimes = [item.startedAt, item.phaseEnd, item.closeCall, item.closeReturn, item.observeUntil].every(finite) && item.startedAt <= item.phaseEnd && item.phaseEnd <= item.closeCall && item.closeCall <= item.closeReturn && item.observeUntil >= item.closeReturn + 2;
    if (!validTimes || item.completed !== true || item.status !== 'CASE_COLLECTION_COMPLETE' || digest(summaryByID.get(item.caseId)?.caseCookieSHA256) !== cookie) { issue('CASE_LIFECYCLE_INCOMPLETE', {caseId: item.caseId}); continue; }
    if (mode === 'main' && !([item.unloadStart, item.unloadDone].every(finite) && item.phaseEnd <= item.unloadStart && item.unloadStart <= item.unloadDone && item.unloadDone <= item.closeCall)) { issue('APPLICATION_UNLOAD_BEFORE_CONTEXT_CLOSE_NOT_PROVED', {caseId: item.caseId}); continue; }
    validCases.push(item);
  }
  for (const id of expectedIDs) if (!casesByID.has(id)) issue('EXPECTED_CASE_MISSING', {caseId: id});
  const ordered = [...validCases].sort((a, b) => a.startedAt - b.startedAt);
  for (let i = 1; i < ordered.length; i++) if (ordered[i].startedAt < ordered[i - 1].observeUntil) issue('CASE_OBSERVATION_WINDOWS_OVERLAP', {priorCaseId: ordered[i - 1].caseId, nextCaseId: ordered[i].caseId});
  if (!finite(runner?.finalObservation?.completedAt) || ordered.some(item => runner.finalObservation.completedAt < item.closeReturn + 2)) issue('FINAL_SERVER_OBSERVATION_TOO_SHORT');

  const requestRows = Array.isArray(browser?.requests) ? browser.requests : [];
  const responseRows = Array.isArray(browser?.responses) ? browser.responses : [];
  const finishRows = Array.isArray(browser?.finished) ? browser.finished : [];
  if (![browser?.requests, browser?.responses, browser?.finished, native?.rows, native?.ordinalBindings].every(Array.isArray)) issue('OCCURRENCE_ARRAYS_REQUIRED');
  const requestsByID = new Map(), responsesByID = new Map(), finishedByID = new Map();
  for (const [kind, rows, target] of [['request', requestRows, requestsByID], ['response', responseRows, responsesByID], ['finished', finishRows, finishedByID]]) {
    for (const row of rows) {
      const id = identifier(row);
      if (typeof id !== 'string' || !id.length || target.has(id)) { issue('BROWSER_OCCURRENCE_ID_MISSING_OR_DUPLICATE', {kind}); continue; }
      target.set(id, row);
    }
  }
  const occurrences = [];
  for (const [id, request] of requestsByID) {
    const response = responsesByID.get(id), finish = finishedByID.get(id), item = casesByID.get(request.caseId);
    const safeID = item && id.startsWith(item.caseId + ':') && /^\d+$/.test(id.slice(item.caseId.length + 1)) ? id : null;
    const requestDigest = digest(request.caseCookieSHA256);
    if (!item || !safeID || !response || !finish || request.probeCookieObserved !== true) { issue('BROWSER_ID_OR_OBSERVED_COMPLETION_MISSING', {requestIDSHA256: canonicalSHA(id)}); continue; }
    if (response.caseId !== request.caseId || finish.caseId !== request.caseId || requestDigest !== digest(item.caseCookieSHA256)) { issue('OBSERVED_BROWSER_CASE_COOKIE_BINDING_FAILED', {caseId: item.caseId, browserID: safeID}); continue; }
    const route = endpoint(request.path);
    if (request.method !== 'GET' || !PUBLIC_PATHS.has(route) || (response.path !== undefined && endpoint(response.path) !== route) || (finish.path !== undefined && endpoint(finish.path) !== route) || response.status !== 200 || !digest(response.bodySHA256) || !Number.isSafeInteger(response.bodyBytes) || response.bodyBytes <= 0) { issue('BROWSER_PUBLIC_BYTES_SCOPE_FAILED', {caseId: item.caseId, browserID: safeID}); continue; }
    const networkStart = finite(request.networkStartAt) && request.networkStartAt > 0 ? request.networkStartAt : null;
    const networkEnd = finite(request.networkResponseEndAt) && request.networkResponseEndAt > 0 ? request.networkResponseEndAt : null;
    if (![request.at, response.at, finish.at].every(finite) || request.at > response.at || response.at > finish.at || request.at < item.startedAt || finish.at > item.observeUntil || networkStart === null || networkEnd === null || networkStart > networkEnd || networkStart < item.startedAt - CLOCK_EPSILON || networkEnd > item.observeUntil + CLOCK_EPSILON) { issue('BROWSER_OCCURRENCE_TIMESTAMPS_FAILED', {caseId: item.caseId, browserID: safeID}); continue; }
    occurrences.push({browserID: safeID, caseId: item.caseId, caseCookieSHA256: requestDigest, method: request.method, path: route, requestAt: request.at, networkStartAt: networkStart, networkResponseEndAt: networkEnd, responseAt: response.at, finishedAt: finish.at, status: response.status, bodySHA256: digest(response.bodySHA256), bodyBytes: response.bodyBytes, sourceSHA256: canonicalSHA({request, response, finish})});
  }
  for (const id of responsesByID.keys()) if (!requestsByID.has(id)) issue('ORPHAN_BROWSER_RESPONSE', {idSHA256: canonicalSHA(id)});
  for (const id of finishedByID.keys()) if (!requestsByID.has(id)) issue('ORPHAN_BROWSER_FINISH', {idSHA256: canonicalSHA(id)});
  if (occurrences.length !== requestRows.length || requestRows.length !== responseRows.length || requestRows.length !== finishRows.length) issue('BROWSER_OCCURRENCE_BIJECTION_COUNTS_FAILED');

  const nativeRows = Array.isArray(native?.rows) ? native.rows : [], bindings = native?.ordinalBindings ?? [];
  if (bindings.length !== nativeRows.length) issue('NATIVE_ORDINAL_BINDING_COUNT_FAILED');
  const safeRows = nativeRows.map(safeNative);
  for (let i = 0; i < nativeRows.length; i++) {
    const row = nativeRows[i], proof = bindings[i];
    if (!proof || proof.ordinal !== i || proof.bracketBound !== true || proof.rawResponseIdentity !== true || proof.finishBound !== true || proof.responseBound !== true) issue('NATIVE_ORDINAL_BINDING_FAILED', {serverOrdinal: i});
    if (row.method !== 'GET' || !PUBLIC_PATHS.has(row.path) || row.registeredPath !== row.path || row.authorizationPresent !== false || row.cookiePresent !== (digest(row.caseCookieSHA256) !== null) || row.status !== 200 || row.serializedStatus !== 200 || row.cacheControl !== 'no-store' || row.onSendCount !== 1 || row.rawFinishCount !== 1 || row.responseHookCount !== 1 || !digest(row.bodySHA256) || !Number.isSafeInteger(row.bodyBytes) || row.bodyBytes <= 0 || !finite(row.startedAt) || !finite(row.finishedAt) || row.startedAt > row.finishedAt) issue('NATIVE_PUBLIC_OBSERVATION_INVALID', {serverOrdinal: i});
  }

  const edges = new Map(), reverse = new Map();
  for (const row of safeRows) {
    const candidates = [];
    const item = casesByCookie.get(row.caseCookieSHA256);
    for (let index = 0; index < occurrences.length; index++) {
      const browserRow = occurrences[index];
      if (!item || browserRow.caseId !== item.caseId || browserRow.caseCookieSHA256 !== row.caseCookieSHA256 || row.path !== browserRow.path || row.method !== browserRow.method || row.status !== browserRow.status || row.bodySHA256 !== browserRow.bodySHA256 || row.bodyBytes !== browserRow.bodyBytes) continue;
      const lower = browserRow.networkStartAt - CLOCK_EPSILON, upper = browserRow.networkResponseEndAt + CLOCK_EPSILON;
      if (row.startedAt < lower || row.startedAt > upper || row.finishedAt > upper || row.finishedAt < lower || row.startedAt < item.startedAt - CLOCK_EPSILON || row.finishedAt > item.observeUntil + CLOCK_EPSILON) continue;
      candidates.push(index);
      if (!reverse.has(index)) reverse.set(index, []);
      reverse.get(index).push(row.serverOrdinal);
    }
    edges.set(row.serverOrdinal, candidates);
  }
  const visitedServers = new Set(), pairedServers = new Set(), pairedBrowsers = new Set();
  for (const server of safeRows) {
    if (!(edges.get(server.serverOrdinal)?.length) || visitedServers.has(server.serverOrdinal)) continue;
    const serverSet = new Set(), browserSet = new Set(), pending = [server.serverOrdinal];
    while (pending.length) {
      const candidateServer = pending.pop();
      if (serverSet.has(candidateServer)) continue;
      serverSet.add(candidateServer); visitedServers.add(candidateServer);
      for (const candidateBrowser of edges.get(candidateServer) ?? []) {
        browserSet.add(candidateBrowser);
        for (const neighbor of reverse.get(candidateBrowser) ?? []) if (!serverSet.has(neighbor)) pending.push(neighbor);
      }
    }
    const servers = [...serverSet], browsers = [...browserSet];
    const matching = perfectMatching(servers, browsers, edges);
    const ambiguous = !matching || [...matching].some(([s, b]) => perfectMatching(servers, browsers, edges, [s, b]) !== null);
    if (ambiguous) {
      ambiguousComponents.push({serverOrdinals: servers, browserIDs: browsers.map(index => occurrences[index].browserID), candidateEdges: servers.map(index => ({serverOrdinal: index, browserIDs: edges.get(index).map(b => occurrences[b].browserID)})), reason: matching ? 'MULTIPLE_PERFECT_BIJECTIONS' : 'NO_COMPLETE_BIJECTION'});
      continue;
    }
    for (const [s, b] of matching) {
      pairedServers.add(s); pairedBrowsers.add(b);
      paired.push({native: safeRows[s], browser: occurrences[b], candidateCount: edges.get(s).length, occurrenceBijectionUnique: true, sharedTransportRequestID: false});
    }
  }
  for (const row of safeRows) {
    if (pairedServers.has(row.serverOrdinal)) continue;
    const item = casesByCookie.get(row.caseCookieSHA256);
    const closeWindow = item && finite(item.closeCall) && finite(item.closeReturn) && row.startedAt >= item.closeCall && row.startedAt <= item.closeReturn + 2;
    // A possible observed browser match prevents classifying an ambiguous occurrence as a hidden closing request.
    if (!(edges.get(row.serverOrdinal)?.length) && closeWindow) closingRows.push({...row, caseId: item.caseId, window: {closeCall: item.closeCall, closeReturn: item.closeReturn, end: item.closeReturn + 2}, attribution: 'OBSERVED_NATIVE_PROBE_COOKIE_SHA_WITHIN_OWN_CLOSE_WINDOW'});
    else unpairedRows.push({...row, reason: edges.get(row.serverOrdinal)?.length ? 'AMBIGUOUS_BROWSER_OCCURRENCE' : !row.caseCookieSHA256 ? 'NO_CASE_COOKIE_SHA' : !item ? 'UNKNOWN_CASE_COOKIE_SHA' : 'OUTSIDE_OWN_CLOSE_WINDOW'});
  }
  for (let index = 0; index < occurrences.length; index++) if (!pairedBrowsers.has(index)) unmatchedBrowser.push(occurrences[index]);
  result.counts = {expectedCases: expected.length, completedCases: validCases.length, native: safeRows.length, browserRequests: requestRows.length, browserResponses: responseRows.length, browserFinished: finishRows.length, paired: paired.length, closing: closingRows.length, closingPolicy: closingRows.filter(row => row.path === '/legal/policy').length, unpaired: unpairedRows.length, unmatchedBrowser: unmatchedBrowser.length, ambiguousComponents: ambiguousComponents.length, errors: errors.length};
  result.cases = validCases.map(item => ({caseId: item.caseId, caseCookieSHA256: digest(item.caseCookieSHA256), startedAt: item.startedAt, phaseEnd: item.phaseEnd, unloadStart: item.unloadStart ?? null, unloadDone: item.unloadDone ?? null, closeCall: item.closeCall, closeReturn: item.closeReturn, observeUntil: item.observeUntil, native: safeRows.filter(row => row.caseCookieSHA256 === digest(item.caseCookieSHA256)).length, closing: closingRows.filter(row => row.caseId === item.caseId).length, paired: paired.filter(row => row.browser.caseId === item.caseId).length}));
  const common = errors.length === 0 && validCases.length === expected.length && unpairedRows.length === 0 && unmatchedBrowser.length === 0 && ambiguousComponents.length === 0 && paired.length + closingRows.length === safeRows.length;
  const passed = common && (mode === 'positive' ? closingRows.length >= 1 : closingRows.length === 0);
  result.status = passed ? (mode === 'positive' ? 'POSITIVE_CLOSING_REPRODUCED' : 'MAIN_48_CLEAN') : 'FAILED';
  result.criteria = {commonPassed: common, positiveAtLeastOneCorrectClosingRow: mode !== 'positive' || closingRows.length >= 1, main48CompleteWithoutClosingOrUnpaired: mode !== 'main' || validCases.length === 48 && closingRows.length === 0 && unpairedRows.length === 0};
  result.identityLimit = 'Unique occurrence bijection uses observed case-cookie digest, path, exact body digest/length, status and compatible recorded time interval. It is not a recovered/shared transport request ID; ambiguous duplicate occurrences are never assigned by nearest time or greedy order.';
  return result;
}

export function reconcileDirectory(mode) {
  assert(mode === 'positive' || mode === 'main', 'MODE_REQUIRED');
  const out = path.join(HOME, mode), output = path.join(out, 'reconciliation.json');
  assert(fs.existsSync(out) && !fs.existsSync(output), 'EXISTING_INPUT_AND_NEW_RECEIPT_REQUIRED');
  const names = ['admission-copy.json', 'browser-summary.json', 'api-browser.json', 'case-journal.json', 'actual-health.json', 'result.json', 'byte-equivalence.json', 'body-store.jsonl', 'cleanup.json'];
  const before = names.map(name => ({name, sha256: fileSHA(path.join(out, name)), bytes: fs.statSync(path.join(out, name)).size}));
  const result = reconcile({mode, admission: read(path.join(out, names[0])), summary: read(path.join(out, names[1])), browser: read(path.join(out, names[2])), journal: read(path.join(out, names[3])), native: read(path.join(out, names[4])), runner: read(path.join(out, names[5])), baseline: read(path.join(out, names[6]))});
  const summary = read(path.join(out, 'browser-summary.json')), captures = [];
  try {
    const storePath = path.join(out, 'body-store.jsonl');
    assert(fs.statSync(storePath).size <= 4 * 1024 * 1024, 'CAPTURE_REFERENCE_STORE_BOUND');
    const references = fs.readFileSync(storePath, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    assert(references.length === summary.cases.length, 'CAPTURE_REFERENCE_COUNT');
    for (const item of summary.cases) {
      assert(result.cases.some(row => row.caseId === item.caseId), 'CAPTURE_CASE_SCOPE');
      const expectedPath = path.resolve(out, 'cases', item.caseId + '.json');
      const samePath = value => typeof value === 'string' && path.resolve(value).toLowerCase() === expectedPath.toLowerCase();
      assert(samePath(item.capture.path), 'CAPTURE_PATH_OUTSIDE_OWN_CASES');
      const refs = references.filter(row => samePath(row.path));
      assert(refs.length === 1 && digest(refs[0].sha256) === digest(item.capture.sha256) && refs[0].bytes === item.capture.bytes, 'CAPTURE_REFERENCE_BIJECTION');
      const actual = {name: 'cases/' + item.caseId + '.json', sha256: fileSHA(expectedPath), bytes: fs.statSync(expectedPath).size};
      captures.push(actual);
      assert(actual.sha256 === digest(item.capture.sha256) && actual.bytes === item.capture.bytes, 'ACTUAL_CASE_CAPTURE_BYTES_CHANGED');
    }
  } catch { result.errors.push({code: 'CASE_CAPTURE_ARTIFACT_BINDING_FAILED'}); result.status = 'FAILED'; result.criteria.commonPassed = false; }
  const after = names.map(name => ({name, sha256: fileSHA(path.join(out, name)), bytes: fs.statSync(path.join(out, name)).size}));
  const capturesAfter = captures.map(row => ({name: row.name, sha256: fileSHA(path.join(out, row.name)), bytes: fs.statSync(path.join(out, row.name)).size}));
  result.inputs = before; result.captureInputs = captures; result.inputArtifactsUnchanged = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(captures) === JSON.stringify(capturesAfter);
  if (!result.inputArtifactsUnchanged) { result.errors.push({code: 'INPUT_ARTIFACT_CHANGED_DURING_RECONCILIATION'}); result.status = 'FAILED'; result.counts.errors = result.errors.length; }
  result.counts.errors = result.errors.length;
  fs.writeFileSync(output, JSON.stringify(result, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({mode, status: result.status, counts: result.counts, inputArtifactsUnchanged: result.inputArtifactsUnchanged}));
  if (result.status === 'FAILED') process.exitCode = 1;
  return result;
}

if (typeof process !== 'undefined' && process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) reconcileDirectory(process.argv[2]);
