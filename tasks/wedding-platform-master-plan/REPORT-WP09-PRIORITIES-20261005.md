# WP09: deadline priorities — scoped delivery, 2026-10-05

Base: `7c0cb5b60243e135bbc172b1b924eed4e61dd783`.
Published branch: `feature/wp09-deadlines-20261005` (PR #44).
Owner instruction: prepare separate feature commits and verified tests; **do not merge into main or enable auto-merge**.

## Scope

The Home deadline card now ranks all unfinished tasks by their actual API-provided deadline before taking the first three. Real dates precede unknown dates, including malformed dates. Equal dates and undated tasks retain server order. No period, title, or wedding date is converted into an invented task deadline.

The existing Home query-readiness gate also controls the displayed task rows. Cached task titles are not rendered during reload or after a query error/forbidden response. Existing loading, forbidden, empty and completed messages remain.

UI map addition: Home / Ближайшие дедлайны — earliest real deadlines first; still at most three task rows.
Button map addition: each task row still opens `/wedding/checklist`; no mutation or new authorization is introduced.

## Evidence and limits

The baseline Home source was reconstructed from GitHub reads and verified against Git blob `91ccaabdb13bf6fe903226fb7409d51c258ad905` before editing. Only its selector import and row expression change.

`taskPriorities.test.ts` contains 24 cases: ordering before limiting, completion, stable ties, unknown dates, no invented period deadlines, immutability, empty inputs, year rollover, 11 invalid date inputs and four valid date inputs.

At creation, the full repository test/type/lint/build gates have not yet run on this commit. Record actual GitHub Actions results for the exact published SHA before acceptance. A test file is not proof that it passed.

This is a bounded WP09 increment, not completion of FR-006/FR-063 or WP00–WP16. The combined weekly view of payments, pending responses, unconfirmed terms, current assignees, and broader browser/provider/physical-device acceptance remain open. Backend, OpenAPI, migrations, deployment, secrets and main are unchanged.

## Follow-up precision

The first increment guarded initial loading/error/403, not background `refreshing`: `ready(q)` does not include that flag. The second increment explicitly adds the refreshing gate. See `REPORT-WP09-WEEKLY-20261005.md`; do not treat the earlier broad reload wording as verified behavior of the first commit.
