# FR005 — schema84 native child bindings · 2026-10-06

Base3133a27e / tree86543d8, PR47 only. No merge, main/PR45 change or deployment.

## Observed exact-head result

CI37535361621 completed3321/3321 backend tests, frontend2360/2360 and the preserving rehearsal successfully. The subsequent native step FAILED before either C04 or C05 tests: control/stderr.log records84!==83 in the receipt barrier checker. The artifact11445614266 was downloaded and verified as SHA2564774c6e2446d2a51d52ef48016b1671c33919361d6daf5b53f963ed03b7d756c. C04 and worker are explicitlyUNRUN; final backend lint/build were skipped. This is a new observed failure, not the previously blocked log.

Source inspection additionally found the C05 worker's unchanged hardcoded migrationCount83. That second mismatch was caught before runtime reached it; it is not claimed as an observed C05 failure.

## Narrow repair

The receipt barrier now imports/re-exports the same strict assertJournal used by the parent instead of duplicating an83-only version. It requires exactly84 distinct sorted names, the exact final task-dependencies migration, and an identical actual journal. The full manifest/hash/directory checks, identity, owned namespace and genuine lock-wait witnesses are unchanged.

The C05 entry retains an exact numeric assertion, now84. Its portability ledger appends the explicit83→84 replacement and updates only the candidate hash. All four original independent test/config hashes are unchanged; reverse replacement reproduces those exact original bytes. None of the30 C04 or19 C05 behavioral cases is removed or weakened.

Four added node:test cases inspect the real child entry points (without loading a native entry or granting a receipt) and verify the complete inverse ledger. Original source:13PASS/3FAIL out of16. Repaired source plus the38 prior diagnostics:54PASS/0FAIL/0SKIP. Full backend TypeScript and full ESLint passed. These are structural/manifest/projection tests, not a successful native SQL run.

Old local83 receipts remain refused, no alternative runtime profile or permissive83/84 union is introduced. Application/API/schema/migrations unchanged by this repair. Exact-head native/full-CI/browser acceptance still requires new successful execution; results belong in PR47 after completion. The3321 and2360 previous passes are not automatically outcomes of the next commit.
