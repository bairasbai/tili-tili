# FR005 — preserving drill module boundary repair · 2026-10-06

Base `788ff31373e23d60a9321e5815fc04f37fc6ae93`, PR47 only. No main/PR45 merge, deployment or permission changes.

## What is established

CI37531744544 ran all3318 backend tests successfully with no failed/pending/todo cases, then failed its preserving rehearsal. C04/C05 and final lint/build did not execute. The diagnostic artifact11445437101, SHA256 `34905348cb5d2f69baea54526aa392d8da04015c9d1b744508b68d8c03988396`, confirms the test totals only; it does not contain the migration failure. The job-log read was blocked because the tool could not determine its safety status. That log was not obtained through another route, so its exact exception is not asserted here.

Independent source inspection found the dependency-drill import twice: correctly in the parent script and incorrectly in the inline current-vendor-erasure child. That child runs from the backend directory, where `./task-dependency-migration-drill.mjs` does not exist. The helper actually belongs to scripts/. An executable resolver check on the extracted child imports reproduced the missing file without executing application or database code.

## Minimal repair and regression

Remove only the accidental child import and restore the semicolon on its existing pg import. The parent import and actual schema83to84 call remain. The real eraseUser child, all URL/database/identity fences, migration commands, refusal assertions, before/after data comparisons and native admission remain unchanged.

Three new ordinary Vitest cases parse the actual child template, check its module syntax in Node, resolve every static import from its real working directory without loading those modules, and retain the intended parent/dependency and child/privacy boundaries. No database connection or privacy operation is executed by these three tests.

On the original source:1PASS/2FAIL. After the source fix:3PASS. Together with unchanged audit53, repaired audit55 and existing contract-sync checks:42PASS/3PostgreSQL-onlySKIP. Full backend TypeScript and full ESLint pass. The first combined command used an unmatched camel-case contract filename and selected only three suites; the later four-suite run uses the actual contract-sync.test.ts and is the reported42PASS result.

## Acceptance boundary

The real preserving rehearsal still needs an execution on the corrected tree. A source/module reproduction is not a native schema or privacy-erasure acceptance result. The initial failed run is retained. Exact-head full CI/browser/native outcomes are recorded in PR47 only after completion. Three new tests are additional to3318; no earlier successful result is automatically attributed to a new commit.
