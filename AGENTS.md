## What This Is

Portfolio extract of a single-process Discord agent runtime: per-user conversation queues, LLM calls, tool-call parsing, image request persistence, GPU lifecycle, ComfyUI workflow execution, Cloudflare R2 archival, cost/latency events. Discord UI adapter and eval runners are omitted. No microservices or external schedulers.

**Stack:** TypeScript + Bun, discord.js, Pi (`@earendil-works/pi-ai` / `pi-agent-core`), bun:sqlite, Cloudflare R2 (Bun S3 client + Litestream replica), SOPS+age, zod, pino, rootless Podman/systemd, Vast.ai GPU workers running ComfyUI.

## Engineering Standards

- Keep it conversational unless changes are explicitly requested; do not edit files just because a topic is being discussed.
- When changes are requested, keep them scoped to the request; avoid unrelated cleanup, refactors, renames, or policy edits.
- Default to the smallest viable implementation and minimal LoC, including concise Markdown; accept a larger footprint only for an explicitly deliberate architecture overhaul.
- Prefer one canonical path over fallbacks or parallel flows; add another only when its demonstrated value justifies the drift, testing, and decision burden. Remember, fallback paths and branching introduces pathways that need extra maintenace.
- Keep names consistent with adjacent code, especially repository methods and their SQL query fields; reuse established verbs instead of introducing synonyms.
- Use one named parameter object when a function, method, or constructor would otherwise take four or more arguments; use judgment for three.
- Treat the worktree as shared state. Do not assume existing changes came from you or this chat; inspect and preserve user or other-agent work.
- Push back on speculative edge-case fixes. If a bug is not observed in production and is not tied to active user pain, keep any change under scrutiny; if the fix starts adding real complexity, stop and ask whether the risk/complexity/LoC is worth it.
- When `null` and `undefined` both mean "missing," prefer a falsy check (for example, `!lastPendingTurn`) over checking one sentinel such as `lastPendingTurn === undefined`; distinguish falsy values only when the product semantics require it.
- Keep the automated test suite small and high-signal. Default to adding no test; add one only for important production contracts, exposed boundaries, observed regressions, or genuinely flaky behavior, and never one that restates the code under test (asserting a constant equals its literal copy, a type exists, or a mock returns what it was told to). Do not write tests for evals and for code that does not run in production.
- Keep production APIs focused on runtime needs; do not add parameters, flags, or abstractions solely for tests. Adapt tests to production code.
- Tests must not wait on real time. Mock clocks and timers in tests instead of using `Bun.sleep`, `setTimeout`, or other delays. `await Promise.resolve()` is fine to flush microtasks.
- When multiple privileged commands are needed, open one persistent elevated shell with `SUDO_ASKPASS=/usr/bin/ksshaskpass sudo -A /bin/bash -s` and reuse it.
