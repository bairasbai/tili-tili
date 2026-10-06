# WP09 CI continuation: clock-dependent notification fixtures

Base: a30f3d73dfeb506ab8049c43fac4e772f19cbf8c, PR45. Do not merge or deploy.

## Confirmed cause, not the earlier native-admission failure

The actual log of backend job 111924256823 (run 37355864261, attempt 2)
reports two failed tests: audit7c vendor shift notification and audit7 push-limit
shift notification. Both fail at prepareShift's canConfirm assertion with
crosses_day, before their notification assertions.

Source: https://github.com/bairasbai/tili-tili/actions/runs/37355864261/job/111924256823

The first failing block started at 2026-10-05T20:52:32.875Z, or 23:52:32.875
in Europe/Moscow. A 15-minute move puts its start on the next local date.
The second failing block started at 20:57:01.216Z; its next five-minute move
crosses the same boundary after earlier iterations of the repeated-shift test.
The pure regression uses 18:57:01.216Z as an equivalent input clock for the old
now()+2h formula, not as a claimed actual clock of that second test.
The production planner correctly rejects both boundary inputs. This explains this second attempt, not the PID1139 native admission
failure of attempt 1; the latter remains separate and unresolved.

## Scoped change

Only test fixtures, regression tests, their read-only CI workflow and this report
change. No application source, database migrations, API, native admission guard,
permissions, payment logic or weekly browser fixture is changed.

Three legacy test files now assert the Moscow zone returned for Kazan and use a
shared futureShiftStart test helper for all four accidental now()+2h fixtures.
The helper chooses 09:00 UTC two calendar days ahead. The duration remains 60
minutes. Original assertions and the five actual shift requests remain intact.
Past blocks in stage7 remain genuinely past and must remain unchanged. A pure
regression separately proves exclusion reason past on the same selected day;
the future integration fixture may be on a different day from that past block.
No system, database, token, notification or authentication clock is mocked.

## Local results

33 new regression tests plus the existing 21 planner tests: 54 PASS, no skips.
The 24 hourly cases each exercise six minute boundaries and both the single
15-minute move and five consecutive five-minute moves. Other cases cover month,
year and leap-day rollover, the two failing block-start boundaries, unchanged input,
invalid clocks and same-day past exclusion. Explicit old boundary fixtures are
still rejected by the real production planner with crosses_day.

The first local run deliberately used a test helper equivalent to the old SQL
relative-clock formula: 45 PASS / 9 FAIL. Switching only that helper to the new
calendar fixture produced 54 PASS. This is a calculation-level reproduction,
not a rerun of historical HTTP/PostgreSQL tests under a fake clock.

The same 54 tests were repeated successfully under UTC, America/New_York,
Asia/Yekaterinburg and Pacific/Kiritimati: 216 executions, not 216 new tests.
ESLint passed for all five changed TS files. Local targeted TypeScript checking
was attempted but could not complete because this runtime has the restored
frontend dependencies, not backend fastify/pg types. That attempt is retained;
no full typecheck or live PostgreSQL acceptance is claimed from it.

Before publication, schema review found an unsupported tz field in the draft
POST /weddings fixture. It was removed; the returned city-derived timezone is
asserted instead. No application/API behavior was changed to accept that field.

## Cloud verification and handoff

The new Shift notification regression workflow checks the exact PR head, installs
locked backend dependencies, runs full backend typechecking, migrates disposable
PostgreSQL and runs the three original suites plus both planner suites under the
existing Vitest serial/parallel configuration. It retains a redacted report and
checkout/source hashes; raw reports and credentials are not uploaded. The normal
full CI is unchanged and remains mandatory. Actual cloud outcomes are recorded
in the PR only after completion; this document does not predeclare success.

The previously blocked weekly browser language write is not part of this patch.
Its missing English/helper/final acceptance, native isolation diagnostics, and
unimplemented WP09 requirements remain open. Main remains untouched.
