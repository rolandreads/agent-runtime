# agent-runtime

Architecture showcase of a **single-process agent runtime**: multi-bot chat, tool-calling LLM turns, durable async image/video generation, in-process GPU fleet autoscaling.

## Purpose

Build one **chat-native marketplace for generative media** — generating & editing images, video/animation, and swappable LLMs - exposed via familiar interface (product app, Discord, Telegram) and LLMs taking care of specific GenAI model syntax(i.e prompting in english vs comma separated tag syntax).

| | |
| --- | --- |
| Familiar surface | Talk in Discord. Chat is the product UI, not a separate studio app. |
| English in, model syntax out | The LLM translates intent into the right checkpoint family / adapter / motion prompt. Users should not memorize Comfy or per-model tag languages. |
| Operator-owned levers | Pick which LLMs and image stacks run so guardrails, price, speed, and quality stay tunable — not whatever a single closed API forces. |
| Composable edits | Fresh generations plus partial revision: chat can rewrite a scene; buttons remix style / camera / composition / seed and animate a still. Higher customization. |
| One runtime, many upstreams | Catalogued checkpoints and adapters on rented GPUs, object storage you control, LLMs you can swap — avoid lock-in to one host or one model family. |
| Automate workflows | Detect viral beats, meme formats, and recurring image/video trends; turn them into repeatable chat→generate→edit→post pipelines instead of one-off manual prompting. |

## Stack

TypeScript + Bun, discord.js, Pi (`@earendil-works/pi-ai` / `pi-agent-core`), local SQLite (`bun:sqlite`), Cloudflare R2 (Bun S3 client + Litestream replica), SOPS+age, zod, pino, rootless Podman/systemd, Vast.ai GPU workers running ComfyUI.

## Design philosophy

| | |
| --- | --- |
| One repo = the system | SQLite, SOPS secrets, config, infra scripts. No Secrets Manager / Vault / external pipelines. All you need is `git clone` + `age key` to decrypt secrets and run the app. |
| Single process | One Bun binary owns Discord, LLM turns, image dispatch, GPU fleet, metrics. No microservices, queues, or Redis. Prefer a function call or a SQLite table over another process. |
| Swappable upstreams | Checkpoints/adapters on rented GPUs, LLMs, and object hosts (R2 / S3 / Hugging Face) are replaceable; architecture does not hard-depend on one vendor. |
| LoC is a product cost | Weigh features by complexity + production lines (`scripts/count-production-loc.ts`); refuse bloat. |
| Avoid complexity at all costs | Do not address edge cases if there's no observed customer pain + fixing it would introduce 100+ LoC. Prefer local SQLite over sharded PostgreSQL + cache layer on top. Avoid ORMs, avoid redundant dependencies. Do not touch `lodash` with 30-foot pole. |
| One path, one owner | No dual flows, optional shapes, or “cache + DB” hybrids unless specific usecase justifies it. Avoid fallback paths, avoid optional function arguments, avoid branching. Keep it simple and straightforward by default. |
| Data over guesses | Scaling, retries, timing from measured history, not magic numbers. |
| Fast control flow | No sleep-and-poll loops; `await` real conditions; inject clocks in tests. |
| Max insight, zero identity | Rich anonymous telemetry; encrypt at rest; leaked DB should not identify a person. |

## Security

| | |
| --- | --- |
| Secrets (SOPS + age) | Access to app + infra secrets/passwords: past experiences usually involved cloud hosting like aws secrets manager or 1password. This meant bringing in extra service, managing access to that service and maintaining secrets up to date elsewhere from git. This extra touchpoint had small friction and more than once i've seen people avoiding it and sharing passwords plaintext in personal messages. I loved the decision to use SOPS + age, runtime secrets stay encrypted in-repo and decrypt only at use (`sops exec-env`). All you need is to clone the repo and have one master password handy. |
| App-level field encryption | `src/privacy.ts` uses AES-256-GCM with scoped AAD. Per-user keys (HMAC-derived from a DB master key + `userId` + scope) encrypt message text, notes, and other user content at rest in SQLite. A separate image-metadata key encrypts generation recipes embedded in archived JPEGs. Frontend user IDs are HMAC-hashed before storage so Discord snowflakes are not the primary key material on disk. Not only does this retain user privacy if DB gets leaked, but you can give your agent access to DB without worrying that you are feeding it sensitive client data. |
| User-level isolation | Encryption scopes bind ciphertext to a user; decrypting another user's rows needs their derived key. Repositories always pass `userId` into encrypt/decrypt paths rather than storing one global plaintext blob. This provides extra defense over leaking user A data to user B. |
| Host / container boundary | App host runs rootless Podman under a systemd user unit (`infra/app-host/podman/`), with slirp4netns networking (no host loopback, IPv6 off). Production hardening targets include read-only rootfs, dropped capabilities, and `no-new-privileges` (see adjacent run scripts / service unit). |
| Egress allowlisting | Host nftables rules rendered from `infra/app-host/egress-nft-*.sh` and applied via systemd path/timer units under `infra/app-host/systemd/`. Default deny outbound; allow only resolved IPs for Discord, LLM providers, Vast.ai, Cloudflare R2, and pinned DNS resolvers. Whitelised IPs are refreshed on a timer and make sure that sensitive data can't be exfiltrated to unknown addresses. |
| Backup surface | Litestream replicas land in a separate R2 bucket; field encryption still applies to sensitive columns, so a replica leak is not a plaintext transcript dump. |
| Supply chain age floor | Bun installs only package versions published at least 14 days ago (`bunfig.toml` `minimumReleaseAge`), so freshly compromised npm releases are less likely to land in the lockfile before the ecosystem has time to notice. |

## What to look at

| Area | Where |
| --- | --- |
| Process entry, env, runtime settings | `src/index.ts`, `src/environment.ts`, `src/settings/` |
| LLM tools | `src/tools/` |
| Per-conversation turn queue + agent loop | `src/turn-runtime/` |
| Frontend message boundary (Discord adapter omitted) | `src/frontends/` (`frontend-message.ts`, `OMITTED.md`) |
| Async image + animate request pipeline | `src/image-requests/` |
| Comfy client, workflows, worker image refs | `src/comfy/`, `infra/comfy-worker/` |
| In-process GPU fleet + provider client | `src/gpu/`, `plans/GPU-FLEET-AUTOSCALING.md`, `plans/GPU-COLD-BOOT.md` |
| SQLite schema/migrations, repositories, field encryption | `src/db/`, `src/repositories/`, `src/privacy.ts` |
| Shared brands, retries, event log, image archive | `src/utils/` |
| App host: Containerfile, Podman/systemd, Litestream, egress | `infra/app-host/` |
| Design notes (limits, cache, fleet stress) | `plans/` |
| Eval artifacts (model card / judge protocol; runners omitted) | `evals/` |
| CI / secret-scan / LoC / shell checks | `scripts/` |
| Secrets split (SOPS + age) | `.sops.yaml`, `secrets.env`, `bots.secrets.env`, `infra.secrets.env` |
| Design philosophy (humans-first) | `PHILOSOPHY.md` |
| Agent / contributor instructions | `AGENTS.md` (`CLAUDE.md` symlink) |
