# WP09 — CI failure evidence (unmerged candidate)

Base: `1b530fe78282ed71daa45906d08231a566256d0c`, PR45.
Owner instruction: keep feature commits outside main; no merge, auto-merge or deployment.

## Confirmed problem and scope

The first CI attempt's native admission stopped on an unexpected active PostgreSQL process (PID1139, empty application_name). The saved final snapshot was clean; it does not identify the earlier process. No assertion that it was autovacuum or a harmless transient is supported by that artifact.

This patch preserves diagnostic evidence in subsequent runs. It does not fix or admit the underlying failure. It does not change the blocked weekly browser language fixture.

## Changes

The complete backend Vitest command retains its default reporter and additionally produces an outside-repository JSON report. A whitelist summary preserves failed assertion and collection messages, counts and the actual process exit. Connection URLs and common token forms are redacted; the raw reporter is not uploaded. Missing/unreadable evidence is unknown, not zero passing tests.

During native C04/C05 admission a separate read-only observer connects to the existing postgres maintenance database, not the test target. Its parameterized SELECT captures only the current run/attempt target's process metadata. SQL text, addresses, user names and raw application labels are omitted. The original native script, arguments, admission predicates, migrations and test selection are unchanged. Neither an observed background worker nor a later clean snapshot excuses an earlier failure. The original process's nonzero exit is preserved; diagnostic failure cannot make it green.

A separate always-upload artifact contains these diagnostics. The original native artifact and all existing migration, type, lint/build steps remain. No permission or production configuration is changed.

## Local verification

- 34 node:test cases passed, zero failures/cancellations/skips/todos: 24 projection/context tests and 10 simulated process/driver cases. The latter are wrapper tests, not PostgreSQL or application acceptance.
- ESLint passed for the four new .mjs files using the repository backend configuration.
- JavaScript syntax and YAML parsing passed; frontend job unchanged, original 15 backend steps retained with two diagnostic steps added. An initial local check incorrectly expected 19 steps; corrected to 15 + 2 = 17. No test assertion was disabled.
- Actual PostgreSQL observer/native CI verification remains pending until the published exact-head workflow completes. No current pass is asserted for PR45 or the full product.

## Next step

Read the exact-head backend diagnostic artifact and correlate native admission failure PID with the sampled process type. A process shorter than the sample interval may not be observed; do not infer its identity. Diagnose the full-suite failure separately when a new test report is present. Resolve the weekly browser fixture only through an allowed write; its previous tool block is not bypassed here. Main remains untouched.

## Follow-up: invalid reporter regression fixed

The first diagnostic commit `e192ac36` had a wrapper edge case: valid JSON null, array or empty object could leave a zero wrapper exit, as could a reporter declaring failure when the process exited zero. Four additional process tests reproduced all four failures (34 PASS / 4 FAIL) before the fix.

The wrapper now validates reporter structure and records an effective exit code separately from the original process exit. Invalid/missing evidence or reported failure makes the wrapper fail; an original nonzero exit remains unchanged. The same frozen 38-test set then passed (38 PASS / 0 FAIL / 0 skipped). This is 24 projection/context cases plus 14 simulated child/driver cases, not a new application or PostgreSQL acceptance count. ESLint passed again for all four diagnostic scripts. Frozen runner-test SHA-256: `af3d1e06fb885c4ab8f16958745edf047df2e0b7a5d73e26a9854144e2725427`.

The weekly browser fixture is unchanged, and its write remains blocked by the tool. Full exact-head CI and the real observer are still pending; previous failed runs remain failed.
