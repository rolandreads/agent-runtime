# Blackout, chaos, and stress testing

Status: proposed
Last reviewed: 2026-09-02

## Goal

Before going public, know three things about the single-process runtime:

1. What happens when the process dies, is redeployed, or a dependency we do not own (Discord, LLM API, Vast GPU, Grok, R2) fails mid-work.
2. Where the shared process stops keeping up when several bots and users are active at once.
3. That a fresh host can be rebuilt from the Litestream replica.

Monitoring, in [SERVICE-HEALTH-MONITORING.md](SERVICE-HEALTH-MONITORING.md), owns detection. This plan owns recovery evidence and capacity numbers.

## Accepted behavior

Write these down once so tests do not chase them:

- SQLite in WAL mode with `synchronous=NORMAL` survives process crashes. Host power loss may lose the last commit. Litestream is the backup. Accepted.
- A dependency that commits work and then loses the response produces one duplicate: a repeated Discord message, a regenerated image, a re-adopted Vast worker, a second Grok job. Duplicates are rare and cost cents. Accepted. No effect ledger.
- Shutdown drains running work with no deadline. A hung Comfy prompt can hold a deploy for up to ten minutes. Accepted until a staging deploy under traffic shows it hurts.
- One bad Discord token fails the whole process at startup. Accepted, because systemd restarts and the alert fires. The unit backs off restarts to a five-minute ceiling so a permanent failure neither spins every five seconds nor stops for good; a transient one heals without an operator.

## Not doing

No scenario DSL, effect ledger, report schema, protocol simulators, process supervisor, container suite, VM power-off suite, or deploy-stage kill matrix. A restart is reproduced in-process by constructing a second set of queues and dispatchers on the same database file without draining. That is what SIGKILL looks like to a WAL database.

## Tier 1. In-process recovery tests

Extend the existing harnesses. Use a temp file database via `openDatabase`, not `:memory:`, so WAL and a second connection are real.

One new file, `src/tests/restart-recovery.test.ts`, with three tests:

- **Turn dies mid-LLM call.** Gate the faux response factory on a promise, submit through `TurnQueue`, and while the gate is held construct fresh repositories, engine, and queue on the same file. Run `recoverStaleRunningTurns` and `recover(listUnassignedInboundMessages())`. Assert exactly one completed turn, one delivery, one cost row.
- **Image dies mid-generation.** Gate the fake `ImageGenerator` completion, then rebuild the dispatcher on the same file and call `recover()`. Assert one completed request, one delivery, credits reserved and settled once.
- **Repeated Discord receipt during recovery.** Save the same inbound message ID again after restart. Assert one turn.

Add LLM timeout and permanent-error paths to `turn-engine.test.ts` only if missing: user gets one failure reply, turn is terminal, no cost row.

Existing coverage already proves duplicate receipts, unassigned message recovery, stale turn recovery, processing requeue, drain, concurrency limits, fairness, worker reconciliation and adoption, and archived-delivery retry. Do not duplicate it.

## Tier 2. One stress script

`scripts/drills/stress.ts`, run with `bun run drill:stress`, real time allowed. It runs the production composition against a temp file database with real staging Discord bots and the staging R2 bucket. Secrets come from `sops exec-env secrets.env` with `APP_ENV=staging`, so no dummy environment file exists.

Fake only what we do not own and cannot drive for free, and fake it with static output, never with logic:

- LLM: pi-ai faux returning fixed text, with a prompt in a fixed fraction of replies so images flow.
- Comfy and Vast: an `ImageGenerator` that completes with one checked-in tiny JPEG after a configurable delay.
- Grok: a client stub that rejects, because animation is paid.

Everything else is real: repositories, queues, dispatchers, credits, archive, Discord clients, gateway sessions, and reply delivery.

Composition lives in one exported function in `src/index.ts` that takes only external dependencies (database, models, image generator, Grok client, GPU capacity hook, bot list, client factory) and returns the bots with their `onMessage` handlers plus the queues and dispatchers. `main()` and the script both call it. No copied wiring in the script.

Inbound is the one synthetic edge. The bots accept only human DMs and automating a user account is against Discord's terms. The script admits the Discord user IDs passed on the command line; each test account DMs each staging bot once before the run, which exercises the real intake path and creates the conversation. The script then replays synthetic messages through each bot's `onMessage` for those conversations at a paced rate, and every reply, typing indicator, and image goes out through the real client to a real DM.

Parameters: users (Discord IDs), messages per user, faux response delay, image fraction, generation delay, messages per second. Output, printed as a table:

- Throughput in turns per second of wall time.
- Processing latency p50 and p95 from `turn_completed`, and image latency from enqueue to delivered.
- Max event-loop delay from a 100 ms timer's drift.
- Database file and WAL size after the run.
- Rows in `events`.

Discord caps each DM at about one message per second, so scale comes from accounts times bots. The pure SQLite and event-loop ceiling was measured once with everything faked at roughly 350 turns per second and needs no repeat.

## Tier 3. Staging checklist

Run each once before launch and after infrastructure changes. The staging bot and `deploy:stg` already exist. Record the date and outcome next to each item.

- [ ] `systemctl stop` while a turn and an image are in flight. Journal shows the `app_shutdown_*` events. Start. Both finish.
- [ ] `podman kill --signal KILL` mid-image. Restart. Image completes, credit consumed once.
- [ ] `deploy:stg` during traffic. Note how long stop took.
- [ ] Destroy the Vast worker from the console while an image is queued. Autoscaler re-rents or the user gets a failure reply.
- [ ] Revoke one bot token. Confirm restart delays grow to the five-minute ceiling and the alert fires.
- [ ] `litestream restore` of the staging replica into an empty directory with `bun run drill:restore-staging-replica`. Record `integrity_check`, row counts against the live database, and elapsed time.

## Changes

1. `src/index.ts`: one exported composition function taking only external dependencies.
2. `src/tests/restart-recovery.test.ts`.
3. `scripts/drills/stress.ts`, `scripts/drills/stress.sh`, `scripts/drills/stress.jpg`, `scripts/drills/restore-staging-replica.sh`, with `drill:stress` and `drill:restore-staging-replica` package scripts. Two or three more staging bot applications listed as staging entries in the bot definitions.
4. `infra/app-host/podman/agent-runtime.service`: keep `StartLimitIntervalSec=0`, set `RestartSec=5`, `RestartSteps=6`, `RestartMaxDelaySec=300`. Production runs systemd 257, which supports the backoff. No start limit, so deploy never needs `reset-failed`.

Verify with `bun test src/tests/restart-recovery.test.ts`, `bun run typecheck`, `bun run lint`, and `bun run ci:validate`.

## Open questions

- Is there a global LLM and Grok spend ceiling? The autoscaler has `maxWorkers` and images have per-user rate limits. Confirm before opening the gate.
- Operator DB writes during traffic block the event loop for up to `busy_timeout`. Keep them short. Revisit only if the stress numbers show SQLite waits.
