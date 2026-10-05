# Isolated candidate publication

This branch is an execution helper, not an application feature and not a PR for main.

The workflow runs `wp09` and `wp02` independently from exact baseline
`7c0cb5b60243e135bbc172b1b924eed4e61dd783`. It verifies the compressed payload,
source blobs, clean checkout, exact target branch and absence of a remote target.

Each candidate must pass the existing full frontend TypeScript, Vitest, ESLint
and production build commands before a product commit is created and normally
pushed to `candidate/tili-wp09-20261005` or `candidate/tili-wp02-20261005`.

It never merges, auto-merges, force pushes, resets, deploys, modifies secrets,
or changes main. Workflow evidence records candidate source hashes, actual
logs, published commit and remote readback. Any failed gate prevents that
candidate's publication. Existing candidate branches are not overwritten.

After publication the owner-facing draft PRs must run the repository's normal
CI, including backend PostgreSQL/Redis and browser checks. A passed frontend
helper is not whole-WP, production, browser or complete release acceptance.
