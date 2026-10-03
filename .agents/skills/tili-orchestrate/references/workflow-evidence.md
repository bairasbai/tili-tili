# Workflow and current evidence

Read this reference when assigning integration checks, accepting worker results, or delivering through GitHub. These are operating constraints for this variant; stricter user or repository instructions take precedence.

## Ownership and shared resources

| Role | Ownership | Evidence to return |
| --- | --- | --- |
| Root orchestrator | Full scope, integration, shared PostgreSQL/Redis/browser operations, GitHub, delivery | Current requirement mapping, integrated checks, feature scenarios, delivery state |
| Implementer | Named application files and explicitly assigned supporting files | Changed paths, behavior, commands, remaining limitations |
| Tester | Named test files or explicitly permitted isolated test commands | Observable boundary, command, exit result, what was covered |
| Fresh reviewer | Read-only inspection of the current integrated source | Findings with current file locations and a reproducible trigger, acceptance gaps |

Name the shared service or session when reserving root's next operation. Do not run two migrations, database test suites, cache resets, browser flows, or GitHub operations against the shared environment at once. A worker's isolated test must have a confirmed independent database/cache/session or avoid these resources entirely. If isolation is unverified, return the exact command to root instead of running it. Root performs shared checks after writers have finished the relevant changes.

Before dispatch, include this bounded contract in the assignment, adapted to the actual task:

```text
Objective: required behavior and its observable boundary.
Ownership: exact editable paths; read-only paths; other active owners.
Acceptance: requirements covered by this assignment and dependencies on root.
Checks: permitted commands; shared-service commands reserved for root.
Limits: no unrelated edits, delivery, production changes, or external messages.
HANDOFF: changes, current evidence, failures, uncovered requirements, next action.
```

Implementation and test ownership can move between agents only after the prior owner has stopped writing and root confirms the transfer. A fresh reviewer must be a different agent from the implementer and must inspect the actual current source. If independent review cannot run, disclose that gap instead of calling self-review independent.

## Evidence and acceptance

For each requested feature or WP, identify the authoritative proof before accepting it. Preserve named requirements, commands, invariants, artifacts, documentation stages, scenarios, and delivery gates from the request or referenced plan. Maintain that mapping in native messages or existing required project documentation.

Use evidence appropriate to each requirement:

- Source/diff proves a code change exists. Inspect what it does and whether later edits changed it.
- A test proves only the exercised behavior. Record the command, relevant configuration, result, and coverage boundary; a green suite does not prove an untested workflow.
- A UI scenario needs the actual observed states, relevant inputs, and outcome from the current build. Root owns browser execution.
- A security claim needs the specific threat, permission boundary, and meaningful check. Report untested boundaries as unverified.
- Documentation completion needs the changed document and the actual requested stage or feature it records.
- Delivery completion needs the intended commit and branch plus authoritative remote push/merge state. A local commit or successful build alone does not prove delivery.

When an assertion cannot be verified, say so explicitly; for a Russian report use «Я не могу это подтвердить». Distinguish a failing check, a check that was not run, and a requirement outside that check's coverage. Do not relabel a smaller compatible implementation as completion of the original scope.

After a material edit, refresh affected evidence. Reuse previous checks only when their source revision, configuration, and covered behavior still apply. Repair observed failures and rerun affected checks; broaden testing when new failures or unresolved integration concerns warrant it.

## Root-only GitHub operations

1. Check the repository's GitHub guard before touching GitHub. For this workspace the user specifies `node ~/.claude/hooks/github-api-guard.js --status`. Resolve `~` for the current shell; if it reports `ПАУЗА`, do not make GitHub requests. If a required guard cannot be checked, report that gap and continue local work.
2. Inspect history, status, diffs, source, and local refs through `git` and files first. Workers return local evidence and do not call GitHub or `gh`.
3. Issue GitHub requests one at a time from root. Minimize writes; space writing requests by at least one second. Bulk issue/PR/branch/repository creation needs the user's separate permission. Do not assume that a rate-limit number is a request budget.
4. Check CI once, then wait at least 2–3 minutes before a subsequent status request when still necessary. Do not use `gh run watch`, `gh pr checks --watch`, `watch`, or loops that repeatedly call `gh` and sleep. Waiting may be interrupted for user communication; it must not accelerate GitHub polling.
5. On HTTP 403/429, a rate-limit/abuse response, `submitted too quickly`, or authentication errors such as `Bad credentials`, stop GitHub actions. Do not retry or change access paths to bypass the condition; report the observed error. Local implementation and verification can continue.
6. Honor the existing authorized feature delivery contract. Commit only reviewed feature files, inspect staged changes, push the authorized branch, and merge into the authorized target only after required gates pass. An instruction to commit/push/merge does not authorize production deployment. Attach a created PR to the task when the available app contract requires it.

These guard and polling rules come from this project's user instructions; the [GitHub REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) is the external reference for GitHub's limits, not proof of this account's current status. Read current account or CI state only when needed under the rules above.
