# WP09: read-only weekly agenda

Base: PR45 `7dc3ac93d922933ac25f48d618f03f8c3108a8dc`; no merge or production deployment.

## Scope and acceptance

Add `/wedding/week` from Home using existing permission-checked GET endpoints only.
Calendar week is Monday–Sunday in `Wedding.tz`, not the device zone. Invalid/missing zone is an explicit failure, never a guessed Moscow/UTC date. Keep overdue unfinished tasks/payment stages; separate undated/invalid task dates. Use server payment `remaining` and statuses, without recalculating financial balances. Pending guest responses are person rows, not invitations or deprecated plusOne; deadlines absent from the API are not invented or presented as weekly deadlines.

Each source must retain independent loading/error/403/empty states and explicit retry. No partial failure can show a fabricated zero or hide successful neighbouring sources. Changing wedding/account/session destroys the reader; access-token renewal keeps it. A manual refresh takes a new date snapshot and reloads all sources; no automatic write, payment, reminder, acceptance or background polling. All links lead to existing action screens.

Tests: calendar/DST/month/year boundaries, filtering and stable order, incomplete payload rejection, person counting; actual React/API client read-only navigation, partial failure/retry, missing wedding, denied access, session boundaries, stale results, language and refresh. Browser and full gates must be executed and recorded before any completion claim.

## Boundaries

This is a useful read-only subset of FR-006, not full WP09. Combined order-terms approvals, task dependencies, two-partner approval and restricted delegation remain separate work. No API/DDL/role matrix/generated types changes. Physical phones and production are not tested by viewport screenshots.
