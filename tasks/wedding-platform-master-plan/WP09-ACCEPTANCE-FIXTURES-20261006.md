# PR45: acceptance fixture corrections, 6 October 2026

Do not merge, enable auto-merge or deploy. This continuation starts at 84cd63d3 and changes test fixtures, browser assertions and this report, not application behavior or permissions.

## Published corrections

- 5966cea1 completes the synthetic deal package snapshot with both title and includes. The original database constraint and all seven new API assertions remain. Metadata workflow 37395834634 on c0862c13 completed successfully, including real PostgreSQL, types and lint. This result is not automatically assigned to later heads.
- c0862c13 stores tt_lang as raw ru/en, which StoreProvider actually consumes, and asserts that setup. The previously indeterminate tool writes were resubmitted transparently through the same update_file action after rereading the files; both were accepted. No alternate route was used for a rejected operation.
- Browser run 37395834369 passed 27 checkpoints then failed because the existing English error button is Try again, not the fixture's Retry. Artifact 11382338646 retains this failure. e15978c0 corrects that label and adds explicit real-API order terms checks in six viewports plus helper access denial. Existing 30 checkpoints are retained; seven additional terms checks are required separately.

## Further fixture findings

Run 37396338925 stopped during setup before browser checks: GET order/terms returned 503 terms_proof_unavailable. The shared task browser fixture used a 48-character access signing key containing only the letter a. The real terms proof code correctly requires diversity as well as length. Replace only this disposable fixture's access secret with randomBytes(48).toString('base64url'). The generated signing secret is not logged or exported. Existing synthetic OTP/refresh setup, database fences, test accounts and production key validation remain unchanged. This shared fixture change must also pass task and payment browser workflows.

Source review also corrected the newly authored helper expectation: lockOrderContext intentionally returns 404 to an unentitled helper, not 403. The test requires the exact catalog URL and status 404, a visible unconfirmed error, no history request, no agreement and no order-action link. It allows the existing explicit refresh after an uncertain 404; it does not change the UI to satisfy a mistaken test. Financial access remains an independently tested 403 with no retry.

The browser result excludes terms snapshots and read proofs. Before/after comparison includes stable terms revision/pointers and existing task, guest and payment data. Browser mutations must remain empty. Only the exact fixture payment URL with 403/503 and private catalog URL with 404 are allowed HTTP errors; no general 4xx/5xx suppression is added.

## Verification boundary

Local restored tree was compared to GitHub tree e031e98e098d83772bfb0cb46180e857ca3233f7 before changes; published c086/e159 trees also match. Existing 70 frontend terms tests and 38 diagnostic tests passed locally. Python AST and execution of the exact locale initializer confirm the raw-language fix; the original English initializer reproduced Russian fallback. No local browser policy was altered or bypassed.

Final exact-head full CI, native metadata, shift regression and browser outcomes must be read from Actions and recorded in PR45 after they finish. This document does not predeclare them successful. Browser coverage is Chromium viewports, not physical mobile devices; published/agreed/stale native cases and unpublished browser coverage are distinct. All earlier failed results remain failed.
