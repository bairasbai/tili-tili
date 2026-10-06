# WP09 · observed order state before terms history · 2026-10-06

Base: c2354d767ff07751192b573aa01828d940c83c86. Candidate PR45 only; no merge, auto-merge or deployment.

## Confirmed defect and correction

The slot list and order catalog are separate server reads. A slot could still contain an active deal while the newer catalog already reported `done` or `cancelled`. The weekly reader checked wedding/role but ignored `dealState`, then loaded the legitimately readable historical terms and displayed their agreement as an active-order result.

The reader now checks the catalog state after the wedding/role check and before requesting terms. The five existing active states remain readable. Completed, cancelled and missing/unknown states produce distinct translated per-order errors and an explicit list refresh. Other orders continue normally. Existing HTTP403 behavior, concurrency limit, session/wedding cancellation and the server's history access rules are unchanged.

This is an observed-state guard, not an atomic database snapshot across GET requests. A closure after the catalog response is not proven absent. No extra state is written, no financial calculation or authority is added, and this change does not resolve the previously blocked weekly browser fixture.

## Verification

The first seven new React/HTTP regression cases gave 21 PASS / 7 FAIL on the previous reader. With the correction plus eight positive/language cases: 70 targeted tests PASS (34 existing pure + 36 React), including 15 new React cases. Historical tests keep their request assertions; catalog fixtures now include the real required dealState field.

A new seven-case API/PostgreSQL suite imports the actual frontend state predicate and metadata projections. It exercises all five active catalog states and both terminal states with real routes and synthetic database fixtures. The terminal cases prove that an old active list and a readable historical agreement can coexist with the newer closed state, and that fresh targets exclude the deal. Database state, receipts, audit and exact textual price are compared before/after reads. This is server/projection interoperability, not browser execution or a second implementation of the client queue.

The suite is registered in the existing serial group. A read-only dedicated workflow runs it alongside the existing orderTermsApi suite on a fenced loopback disposable database. It preserves actual exit, redacted report and checkout identity. The normal complete CI remains required.

Full local frontend on the candidate application files: 2336/2336 tests in 120 files, zero failed/pending/todo; TypeScript, ESLint and production build PASS. The 2321 base tests plus 15 new cases total 2336. The new backend suite passed source lint, but actual HTTP/PostgreSQL and exact-head CI remain unrun before publication; their outcomes are recorded in the PR only after execution.

## Previous base evidence

CI 37391755196 completed SUCCESS on c2354d76 (temporary merge tree equal to the feature tree). Backend diagnostic report: 3280 passed, 0 failed/pending/todo. Native C04/C05, preserving migration rehearsal, backend lint/build and frontend gates all passed. Native observer reports process exit0 and no observer error. This does not retrospectively establish the identity of the earlier PID1139 failure.

The weekly browser on that base still failed at the English button after 14 Russian checkpoints. No write to that blocked fixture, local browser policy change, or alternate browser execution is included here. Whole WP09, physical devices and production remain unaccepted.
