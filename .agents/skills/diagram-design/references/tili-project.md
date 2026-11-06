# Тили-тили: project overlay

Apply this overlay before the upstream style guide and examples. The approved product direction is Soft Pastel; its authority is [the application plan, §10.2](../../../../Тили-тили/Тили-тили_План_приложения.md) and [CLAUDE.md](../../../../CLAUDE.md). Read the current files before generating output. This overlay does not change application tokens.

## Colors

Map the diagram's semantic roles to existing project tokens. Use colors from the plan rather than copying the orange/Geist skin from a template.

| Diagram role | Light output | Dark output |
|---|---|---|
| `paper` | `--color-bg`, `#FBF6F1` | `--dark-bg`, `#1E1A16` |
| `paper-2` | `--color-rose-soft`, `#F2DFDC` | `--dark-bg`, `#1E1A16` |
| `ink`, `ink-strong` | `--color-ink`, `#2E2A26` | `--color-bg`, `#FBF6F1` |
| `muted`, `soft`, `link` (readable labels) | `--color-ink`, `#2E2A26` | `--color-bg`, `#FBF6F1` |
| `accent` (essential stroke/text) | `--color-ink`, `#2E2A26` | `--dark-gold`, `#C9A96A` |
| `accent-tint` (decorative fill) | `--color-rose-soft`, `#F2DFDC` | `--dark-bg`, `#1E1A16` |
| Decorative rose / sage fills | `--color-rose`, `--color-sage-soft` | Use existing dark tokens only |
| Essential boundaries/arrows | `--color-ink`, full opacity | `--color-bg`, full opacity |

Retain focal hierarchy through shape, stroke weight and a rose tint. The pastel rose/sage and `--color-ink-soft` are not automatically accessible small-text or essential-line colors. Keep body and technical labels in `ink`, measure their actual background contrast, and label status in words. Never rely on color alone. For a filled focal box, use `paper-2` plus `ink` text; do not use a dark full-accent fill with the same text color.

Keep upstream complexity budgets, SVG accessibility, connector spacing and the 4px geometry grid for documentation figures. Those figure dimensions are not new product UI tokens. Do not adopt terminal or default editorial skins unless the user specifically requests a different diagram style.

## Typography and offline output

Use `"Playfair Display", Georgia, serif` for headings and `Inter, system-ui, sans-serif` for labels; use `ui-monospace, monospace` for ports, commands and technical types. Preserve Cyrillic text. Locally installed project fonts may be used; otherwise disclose system fallback metrics.

Font source: `system`

Remove Google Fonts links, preconnects, CSS `@import`, remote font faces and other external resources from the copied template. Do not download or install fonts. For SVG, use `--system-fonts`; for HTML, run `self_check.py --offline`. Recheck label geometry with the actual fallback font in a browser when that environment is available. Passing the static checker does not prove browser rendering or device behavior.

## Boundaries and invocation

- Generate static HTML with inline CSS/SVG into the user's requested location. Keep fixtures and installation checks outside the tracked application tree. Retain inline motion only for an explicit motion request and verify its no-JS/reduced-motion state separately.
- Run `python3 .agents/skills/diagram-design/scripts/self_check.py --offline <output.html>` from the repository root. For another cwd, resolve the installed helper's absolute path.
- For an explicit SVG export, run `python3 .agents/skills/diagram-design/scripts/export_svg.py <input.html> <output.svg> --system-fonts` after inspecting the helper's `--help`.
- PNG export is optional and requires approved Python Playwright plus compatible Chromium. Report missing prerequisites. Never run pip, npm, browser-download commands, global installers, hooks or sandbox bypasses automatically.
- Do not use personal profile storage, modify the user's home, fetch a website for onboarding or discover/download external tools as part of ordinary generation. The project overlay is already configured.
- Upstream plugin slash commands and maintainer-only checks are not installed. Use explicit `$diagram-design` invocation and the bundled Python helpers. Leave `tili-orchestrate`, acceptance gates and publication permissions intact.

For implementation diagrams, verify actors, states, paths and transitions in the current source. Keep conceptual suggestions distinct from observed behavior. Update screen/button maps only if the authorized task also changes UI.
