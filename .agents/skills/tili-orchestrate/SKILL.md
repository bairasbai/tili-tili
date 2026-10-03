---
name: tili-orchestrate
description: Coordinate user-authorized multi-agent repository work with bounded ownership, serialized shared services, and acceptance from current evidence. Use when the user asks to distribute implementation, testing, or review among agents.
---

# Tili Orchestrate

The root orchestrator owns scope, decisions, integration, verification, and delivery. Workers own bounded implementation or tests; a fresh reviewer checks the resulting behavior independently. Adapted from [harnessmachine/codex-orchestrate](https://github.com/harnessmachine/codex-orchestrate/tree/e44c06e5738a5ea9007ff01ab894df97e89217e8); provenance and installation are in [README.md](README.md).

## Start from the current task

- Delegate only with the user's authorization, including an explicit invocation of this skill. Automatic discovery alone grants no delegation permission. Respect actual tool availability and higher-priority instructions.
- Inspect the current worktree, applicable repository instructions, and referenced requirements before choosing the next action. Prior handoffs help locate evidence; they do not prove current completion.
- Keep every requirement in the user's full feature or work-package (WP) scope. A bounded worker assignment never narrows the root goal. Preserve required tests, feature scenarios, staged documentation updates, and per-feature delivery when requested.
- Preserve existing authorization for the requested scope. Already authorized commits, pushes, and merges into `main` need no repeated approval. This skill grants no production deployment authorization; obtain that separately. Do not extend authority to external messages or unrelated publication.

## Dispatch and integrate

1. Separate independent work from dependencies. Assign exact file ownership, including tests, schemas, generated assets, and shared configuration. Serialize overlapping writers; do not revert another worker's changes.
2. Use the native `collaboration` APIs when available: `spawn_agent` for a bounded assignment, `send_message` for coordination, and `followup_task` to resume an idle worker. Call these directly, outside `functions.exec`. Respect the current concurrency limit and use only as many agents as the work needs.
3. Give each assignment its objective, allowed files, acceptance criteria, required checks, non-goals, permission limits, and expected evidence. Choose roles from available agents; inherit model settings unless the user or applicable instructions specify routing. Never require a model absent from the environment.
4. Keep shared PostgreSQL, Redis, browser sessions, and GitHub operations strictly sequential through root. Workers can inspect source and run explicitly assigned isolated checks; they must not touch those shared resources. Read [references/workflow-evidence.md](references/workflow-evidence.md) before planning shared checks or delivery.
5. Receive a HANDOFF with changed files, observed outcomes, commands and results, requirement coverage, unresolved risks, and remaining work. Inspect the actual current changes and outputs. `DONE` is a claim to verify.
6. Integrate dependent work, run the required feature scenarios, and obtain a fresh read-only reviewer for material behavior, integration, or security risk. Send confirmed defects back to their owner with the failing boundary and evidence.
7. Accept each feature against its own requirements and the integrated result. Follow the user's authorized commit/push/merge order, preserve feature boundaries, and update documentation at the requested stages. Close the full goal only when every requested deliverable has current evidence.

Keep coordination in native messages. Use existing task or documentation files when the repository requires them; do not add a scheduler, state database, or coordination logs merely to manage agents. Use `list_agents` to inspect actual activity and `wait_agent` for message-driven waiting; report a live process handle before calling work a verified wait.

When TDD is requested, require a meaningful failing behavior test before implementation, then implementation and fresh review. Tests added to existing behavior are regression tests. Test results establish the covered behavior, never a guarantee that all bugs or security gaps are absent.
