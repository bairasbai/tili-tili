# Presentation and accessibility fixes · 2026-10-02

Base: `aa85f8868154000cab2c5b049dcf92a1c679259f` (main). Work belongs to the separate
`fix/presentation-accessibility-20261002` branch and must not be merged automatically.

## Scope and implementation

- [x] Clamp the desktop sidebar's left edge at zero between 900 and 1179 px while retaining the centered 1180 px shell alignment on wider displays.
- [x] Render the date and city pickers through a shared `PickerDialog` portal. Its fixed, scrollable layout has no `.app-shell` positioning or sidebar padding.
- [x] Reuse the already installed Radix Dialog primitive for initial focus, Tab/Shift+Tab containment, Escape and background isolation. Capture and restore the opener explicitly because these conditional pickers have no Radix Trigger. Preserve focus through rerenders and only restore an opener still in the document.
- [x] Give every date a locale-formatted full accessible name and `aria-pressed` selection state; keep `aria-current="date"` for today separately.
- [x] Label and translate city-search clearing, return focus to the search field after clearing, and localize the shared dialog Close label (including AppUpdate).
- [x] Add deterministic regressions and keep the existing modal keyboard tests dispatching real bubbling keyboard events from the active element.

This is the five-group presentation fix, not a new feature or an application-wide audit.
No backend, contract, lockfile, authentication, invitation-code, membership or receipt logic was changed.

## Verification

Executed in an isolated checkout with Node 24.19.0 and the existing lockfile. Dependency
installation was explicitly authorized, used `pnpm install --frozen-lockfile --ignore-scripts
--node-linker=hoisted`, and did not change either lockfile.

- **Before-fix witness:** the final `presentationAccessibility.test.tsx` was copied into a separate checkout of the base commit; 15 failed / 2 passed. No base sources were edited.
- **After-fix targeted regression run:** 10 files / 104 tests passed, zero skipped.
- **TypeScript:** `node node_modules/typescript/bin/tsc -b` passed.
- **Frontend lint:** `node node_modules/eslint/bin/eslint.js .` passed.
- **Production build:** `node node_modules/vite/bin/vite.js build` passed. Vite reports the existing >500 kB chunk-size warning; no bundle optimization is included in this patch.
- **Diff hygiene:** `git diff --check` passed.

Targeted test command (run from `Тили-тили/app`):

```sh
node node_modules/vitest/vitest.mjs run   src/lib/presentationAccessibility.test.tsx src/lib/dialogs.test.tsx   src/lib/weddingDate.test.tsx src/lib/serviceWorkerUpdate.test.tsx   src/lib/dictionary.test.ts src/lib/e2e.test.tsx   src/lib/quizAnswers.test.tsx src/lib/quizAnswers.en.test.tsx   src/lib/quizRanges.test.ts src/lib/shell.test.tsx
```

## Verification limits and next step

Actual browser geometry, visual inspection, real keyboard input and screen-reader QA
were **not run**: no supported permitted local-preview route was available. The DOM
focus tests run in jsdom; the sidebar/layout tests inspect CSS declarations and expected
coordinate calculations, not rendered pixels. No full frontend suite, backend suite,
`init.sh`, deployment or live API test was run or claimed.

Next step: review the single-commit draft PR and, when a supported preview is available,
check 320/390/900/1024/1179/1180/1440 px, a scrolled quiz page, both keyboard directions,
repeated open/close, selection dismissal, and Russian/English screen-reader labels.
Publication and CI status are separate from these local results.
