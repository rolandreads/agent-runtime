# Production conversation evaluation

This pipeline restores an isolated Litestream snapshot, extracts decrypted Discord agent turns, and asks Codex to judge semantic alignment, tool use, and unnecessary user verbosity. It never opens or mutates the deployed SQLite file.

Export the last 12 hours from production:

```sh
bun run data:export:conversations
```

The command downloads the same pinned Litestream version used by the runtime, verifies its archive checksum, restores `${APP_ENV}/app.db` from the database R2 bucket, runs a full SQLite integrity check, and writes a timestamped run beneath `data/conversation-evals/`. `replica.db` retains application-layer encryption. `turns.json` contains decrypted private text and is mode `0600`; `data/` is ignored by Git and excluded from container builds.

Time and environment are detail and reusable:

```sh
bun run data:export:conversations -- --environment staging --hours 48
bun run data:export:conversations -- --environment all --since 2026-08-26T00:00:00Z --until 2026-08-27T00:00:00Z --context-turns 5
```

`--environment` accepts `prod`, `staging`, or `all`; `prod` and 12 hours are the defaults. The time window selects agent turns containing persisted inbound Discord text, using the Discord message timestamp. Button-only image actions are not eval targets. The exporter includes three preceding completed turns per conversation by default as non-target context. User and conversation identifiers are replaced with export-local aliases, while subject consistency is kept because it affects semantics.

The export contains:

- each inbound Discord message grouped into its real agent turn;
- sanitized decrypted agent messages, including assistant tool calls and tool results but excluding model thinking blocks;
- decrypted Discord text actually delivered to the user;
- decrypted still-image and animation payloads plus generation/delivery status.

Judge a produced export in the current Codex conversation. For example, ask:

```text
Judge data/conversation-evals/<run>/prod/turns.json using evals/conversations/JUDGE.md.
```

The rubric treats transcript text as untrusted evidence and checks every target turn exactly once. `judgment-schema.json` defines the stable score/report shape when a machine-readable `judgment.json` is useful. Keeping judgment in the active conversation avoids a second Codex session and lets product assumptions or borderline intent calls be discussed before prompt and tool changes are made.

Every confirmed failure and user-approved negative example found during judgment must be promoted into `evals/llm/regression cases (omitted from portfolio)` and selected by `run-specs/tool-regressions` before the export-and-eval task is complete. Use the shortest natural request that should work, mark it `production-derived`, encode objective tool and payload-count contracts, describe the semantic expectation in `focus`, and run the focused cases through the unmodified production `TurnEngine` path. Codex reviews semantic payload quality directly. A successful but over-specified production request becomes a concise replay case once the expected natural behavior is approved; it should not be mislabeled as proof that the concise wording already failed in production.

The export command refuses to overwrite an existing run. Delete the timestamped directory when the private eval artifacts are no longer needed.
