# Weekly agenda × explicit task dependencies · 2026-10-07

Base: PR47 `1d1ae36edf34f8f58bb6e14788f1cdf3f3a5d189`, tree `62faedd3749527682a3184d2d6a287e95125d491`.
New isolated candidate; do not change main, PR45, PR47, merge, auto-merge or deployment.

## Scope

The existing weekly page did not expose FR005 prerequisite metadata and every task card opened the default checklist period instead of the selected task. This change connects the existing API response to the existing deep-link editor. There is no new API, permission, database migration, task mutation, storage layer or inferred dependency graph.

Each task link includes its exact wedding and task query parameters. The section-wide checklist link also retains the selected wedding. Unfinished direct prerequisites are shown with their own links, even when their deadlines lie outside the week. Links are siblings, never nested anchors. Prerequisite identity/title/done come only from the server-supplied dependencies; unrelated tasks are not guessed from names or dates.

Absent or malformed dependency metadata is explicitly unconfirmed, not empty or satisfied. A valid empty list remains empty; a nonempty list of completed prerequisites is labelled accordingly, not as automatic completion of the task. Invalid entries, duplicate UUIDs, self-references and oversized lists do not produce misleading links. The view does not retain or expose manual-override audit reasons. RU/EN uses the existing dictionary. Existing independent source errors, refreshing guards and wedding/session fences remain.

This is an at-read snapshot, not live or transactional UI across multiple requests. Actions require the existing checklist and its current server validation. There is no automatic completion, graph write, reminder or background poll. FR007 pair decisions, FR008 delegation and automatic guest-driven dependencies remain outside this slice.

## Verification

Four new UI regressions first failed on the unchanged page; the same four passed after the change. The separate filtered RED run did not select the existing18 cases; no skipped test is claimed as a pass.

New tests:28 pure projection/URL cases +11 UI/HTTP cases =39. The combined selected suite includes18 existing UI cases:57 tests. These run real React components and the API client with controlled HTTP, not PostgreSQL. Initial full lint found two chained-call line-break formatting errors; corrected without disabling rules or tests. Initial TypeScript calls exceeded the per-call execution limit; the subsequent complete gate process returned exit0.

The real weekly browser harness retains its previous30 checkpoints and7 terms checks, then adds19 prerequisite checkpoints:3×6 pair language/viewport combinations +1 helper. It checks the actual selected editor, a prerequisite outside this week, full reload, query identity, no nested links and layout. Domain before/after evidence now includes dependencyVersion and exact prerequisite id/title/done. It permits no browser mutations. Only synthetic fixture setup writes disposable test data. Required browser assertions are enforced both by the script and workflow.

Exact published-head frontend/backend CI, task-dependency browser and extended weekly browser outcomes are recorded in the PR after they finish. Authored browser checks and historical green runs are not a current PASS. Physical phones, all database-table equality, production and independent-agent review are not claimed.

## Accepted predecessor

PR47 exact-head CI37537841743 and browser37537841729 completed SUCCESS. Backend3321/3321, zero failed/pending/todo, preserving84, native C04/C05, types/lint/build passed. Browser19 checkpoints/12 expected PATCH/7PNG/no page errors. This was independently verified on7October, not newly implemented by this slice. Diagnostics artifact11448002547 SHA256bf9658a9af49bdf696a1e904b616d4079e46c3b7a00685422fb18cf777ad8076. Browser artifact11447385966 SHA25693cf95571c0fbc9fba21ba003e0bc1cc46e49ec00a28b75250f932061005ffe3. The CI merge304884d1 has the same62faedd3 tree; it is not a merge into main. Historical missing/blocked statements are preserved in prior reports.
