# Turn, image, and animation limits

Status: superseded by the single-user simplification on 2026-09-16. Turn rate, pending-text, and per-user concurrency limits were removed. The manual app gate, provider retries/timeouts, and per-conversation ordering remain. The text below records the historical design.
Research date: 2026-09-04.

Replace the [roadmap](../backlog/roadmap.md) placeholders. Chat incurs LLM spend, already recorded per user and included in total costs. Per-user rate and payload limits pace chat; media admission checks the gate and sufficient credits. Limited OpenRouter and Vast balances cap funded exposure, but exhaustion interrupts service for everyone. The [roadmap spend-gate item](../backlog/roadmap.md) remains the planned control against scripted-account spend; it is deferred, not replaced by balance exhaustion. No new chat credit charge is part of this change.

Policy: a paid request is money handed over, and refusing it needs a non-arbitrary reason: the process falling over, unbounded spend, or a wait we would not accept. None of the media limits below met that bar, so they go. Chat limits exist to stop scripts and runaway loops, not to pace people; the proposed refill leaves headroom above the observed inbound-message pace, and metrics guide further adjustment.

## Evidence

| Source | Relevant evidence |
|---|---|
| [LibreChat configuration](https://www.librechat.ai/docs/configuration/dotenv#message-rate-limiting-per-user--ip) | Examples allow two concurrent messages and an optional 40 messages/minute per-user limiter. Useful precedent for separate controls, not our throughput target. |
| [Cache-efficiency variant table, lines 261–263](LLM-PROMPT-CACHE-EFFICIENCY.md#L261-L263) | September 3 experiments: Alibaba Pro p50 2.0 seconds; all Pro runs 2.0–2.4 seconds. |
| [Fleet cold-start section, line 159](GPU-FLEET-AUTOSCALING.md#L159) | Describes roughly two to five minutes before the first Vast contract becomes usable. Warm-image throughput remains unmeasured here. |
| Production Grafana, 30 days to 2026-09-04 (`sf_human_operation_*` histograms) | Turn avg 4.5 s, p95 17 s. Warm image avg 20 s, p95 59 s, GPU stage avg 10 s. Cold image avg 168 s, p95 286 s. Animation provider avg 18 s. Event-loop lag p99 max 32 ms, RSS max 116 MB. Volume was operator-scale: about 150 turns, 170 images, 5 clips. |
| Staging SQLite on 2026-09-04 (one operator account; 926 turns, 1,127 images, 28 clips) | Turn p50 3.0 s, p95 8.3 s, max 33 s. Busiest human minute: 14 inbound messages. Busiest human hour: 123 images, above the 120/hour refill first proposed. Warm image p50 12 s, p95 60 s; cold avg 89 s, max 68 min; enqueue-to-GPU-accept avg 23 s, max 222 s. Clip avg 23 s at $0.41. LLM cost $0.003 per turn; Vast $110 over 299 rentals. |
| [xAI limits](https://docs.x.ai/developers/rate-limits) and [Video 1.5](https://docs.x.ai/developers/models/grok-imagine-video-1.5) | Video models list Tier 0 at 10 requests/second, with no published concurrency cap. Imagine increases go through sales; our OAuth entitlement remains unconfirmed. |

## Proposed values

### Turns

[TurnQueue](../src/turn-runtime/turn-queue.ts) counts assembled turns across characters, serializes each conversation, and appends text to pending work without another rate token. Media generation is delegated. Pending work incurs no LLM charge until execution; rejected input is cancelled and requires the user to resend it.

| Setting | Value | Reason |
|---|---:|---|
| `turn.queue.maxConcurrentPerUser` | 2 | The only concurrency control. Two character conversations can answer simultaneously; it is what stops one account from occupying every provider slot. Matches LibreChat's example. Scheduling only: a third conversation waits, nothing is rejected. |
| `turn.rate.burst` | 8 | Covers a rapid exchange of short replies across two conversations from idle. |
| `turn.rate.perMinute` | 20 | Staging's busiest human minute was 14 inbound messages; 20 leaves headroom. Appended text consumes no new token, so inbound-message counts do not prove how often the assembled-turn limit would fire. One scripted account can still sustain about 28,800 turns/day plus its initial burst. LLM charges count toward recorded spend; the [roadmap spend-gate item](../backlog/roadmap.md) owns automatic protection against this exposure. |
| `turn.queue.maxPendingTextCharacters` | 10,000 | Five full standard messages; [Discord permits 2,000 characters, or 4,000 with Nitro](https://support.discord.com/hc/en-us/articles/33694251638295-Discord-Account-Caps-Server-Caps-and-More). Bounds appended text per conversation and caps the per-turn cost multiplier. Change the current 100,000 default in the same implementation. |

Chat keeps exactly three controls, each with a stated reason: the per-user bucket paces scripts, per-user concurrency keeps accounts fair, and the payload bound caps the per-turn cost multiplier.

**Removed: `turn.queue.maxRunningAndPendingTurns` with `system_busy`, `turn.queue.maxRunningAndPendingTurnsPerUser` with `user_busy`, and `turn.queue.maxConcurrent`.** None had a non-arbitrary reason:

- Pending turns incur LLM cost when executed. Text coalesces into the last pending turn and is bounded by queued characters per conversation. Uploaded images are rejected before download or queueing; generated-image actions carry metadata. The bucket limits new turns, but average throughput is not a backlog bound: a serialized conversation can receive work faster than it drains.
- The per-user backlog cap rejected humans. With seven characters, someone greeting five of them in quick succession got "I'm still working on your earlier messages" on the fifth, and that message was cancelled.
- Global concurrency removal is a beta policy choice. The [stress plan](BLACKOUT-CHAOS-STRESS-TESTING.md) reports about 350 turns/second with providers faked; operator-scale production RSS peaked at 116 MB. Neither measures many simultaneous live streams. OpenRouter routing is restricted to Alibaba/SiliconFlow. Watch failed turns with `reason="llm"`, inspect failures for throttling, and reintroduce a measured global cap if needed.

Recovery preserves previously accepted work.

### Uploaded images

Reject new image attachments and replies to external images before downloading, persisting, or queueing them: "I can’t read uploaded images yet—please describe what you want." Keep replies to our generated images and image controls, which use stored prompt/LoRA metadata. The configured DeepSeek Pro model has no image input; the installed adapter substitutes an image-omitted placeholder. No vision step is planned.

### Images and animations: no limits

Media admission keeps only the gate and the credit check. Drop `image.rate`, `image.queue.maxQueuedAndProcessing`, `image.queue.maxQueuedAndProcessingPerUser`, and `animate.rate`; add no animation caps. Every one of them denies a paid request, and none has a non-arbitrary reason:

- Successful media usage is bounded by credits; GPU rental rate is bounded by fleet size. Credits are reserved at enqueue and released on failure. `gpu.maxWorkers` caps rental at three workers times the $0.90/hour offer ceiling for those rentals; transfers, storage, and rental duration remain additional costs. Failed/refused requests release credits, so balance is not an attempt budget. A clip costs $0.41 at xAI against 250 credits charged. A queue cap or rate bucket converts a paid request into lost work plus a rejection message even when the account has credits and the system can eventually serve it.
- Fairness is in the scheduler. `claimNextQuery` in the [image repository](../src/repositories/image-request-repository.ts) picks the queued request from the user with the fewest images in flight before arrival order, so another user gets priority at the next claim; already submitted GPU work still has to finish.
- LLM-mediated requests share turn admission and tool-round bounds. Direct image edits bypass the turn queue and rely on media credits and the gate. At ten GPU seconds per image, a 1,000-image allowance represents about 2.8 GPU hours before startup/idle costs.
- The rate values would have hit real people. Staging's busiest human hour was 123 images, above the 120/hour first proposed; a browsing user clicking as each 20-second image lands produces three a minute on their own.
- xAI publishes 10 requests/second for video and no concurrent-job cap; OAuth applicability remains unconfirmed. Recovery resumes every open clip, polling persisted provider IDs instead of submitting them again. Keep provider throttling visible as beta traffic grows.

Wait time is the real cost, and its lever is `gpu.maxWorkers`, not admission. Production warm images average 20 seconds end to end with a 10-second GPU stage, so one worker serves about six images a minute and the three-worker cap about eighteen. Processing a burst of 100 images within two minutes implies roughly nine warm workers at that average throughput, which image pricing must cover; the autoscaler already targets workers from active users. Cold starts add two to five minutes before the first image; staging's worst cold delivery was 68 minutes and 34 cold requests failed. Those are fleet problems, and no admission rule fixes them. Queue depth and oldest-item age are already exported as metrics; if waits at the worker cap become unacceptable, raise `gpu.maxWorkers` or, as a last resort, reintroduce a global image cap sized from measured throughput times the accepted wait.

## Implementation

1. Apply the three turn values and `maxPendingTextCharacters = 10_000` together. Keep rationale here and concise descriptions in [defaults](../src/settings/defaults.ts). The pending-text description now correctly says the incoming message would exceed the conversation's queued-text limit.
2. Remove `turn.queue.maxRunningAndPendingTurns`, `turn.queue.maxRunningAndPendingTurnsPerUser`, `turn.queue.maxConcurrent`, `image.rate`, `image.queue`, and `animate.rate` with their checks, the `countRunningAndPendingTurns` helper (retain a direct pending count for drain logging) and the global slot check in `schedulePendingTurns`, the image and animation `TokenBucket` instances and `ImageRequestRejected`/`AnimateRequestRejected` throws, the `system_busy` and `user_busy` turn reasons, the image `rate_limited`/`user_queue_full`/`global_queue_full` and animation `rate_limited` reasons, `ImageRequestRepository.countQueuedAndProcessing`, and their tests. `SubmissionResult` rejection reasons become `rate_limited` and `conversation_busy`. Leave persisted overrides for deleted keys in history; the settings loader ignores unknown keys. Existing overrides for the four retained turn controls still need review at rollout.
3. Reject unsupported uploads in Discord content assembly before any image download; retain generated-image metadata. Remove the unused upload downloader, size settings, frontend image variant/MIME allowlist, image prompt/input builders, and received-image count. Existing LLM accounting continues to record each reported model round, including corrective rounds. No spend gate or vision step.
4. Media preflight and enqueue keep the gate check then the credit check, still synchronous through persistence. Preserve credit settlement and archived retries: delivery of an existing artifact consumes no new charge.

5. Prepare Grafana artifacts in the same change, generated by [dashboard.mjs](../infra/grafana/dashboard.mjs) and [alert-rules.json](../infra/grafana/alert-rules.json), validate through the read-only query proxy, then apply with `apply.mjs` during rollout:
   - The "Declines and failures by reason" panel is label-driven and `ServiceMetrics.zeroCounters()` seeds from `operation-types.ts`. Remove the obsolete reasons, including `user_busy`, from both that catalog and `operation-reasons.ts`, and retain uniform zero-seeding of the remaining results for every kind, including unused rate-limited series. Keep turn rate-limit and `conversation_busy` metrics. No panel changes are needed; historical failures remain visible for their query window.
   - With queue caps gone, the "Stuck warm image" (5 min), "Stuck cold image" (12 min), "Stuck turn" (3 min), and "Stuck animation" (8 min) alerts on oldest work item age become the wait-budget alerts: a legitimate deep queue at `gpu.maxWorkers` will trip "Stuck warm image". Keep the thresholds, and retitle plus update [RUNBOOK.md](../infra/grafana/RUNBOOK.md) so the operator response distinguishes a stalled worker from a full fleet, where the action is raising `gpu.maxWorkers`.
   - Add one alert on queued image count, `sum(sf_human_work_items{kind="image",state="queued",capacity_path="warm"}) > 36` for one minute: 18 images/minute × two minutes at three workers, counting only warm-path work. Cold-path queues retain the 12-minute age alert, so expected provisioning does not trigger the depth page. Revisit 36 when fleet policy or measured throughput changes. The existing "Work in flight" and "Stage duration p95" panels already show depth and queue wait; no new panels.

The turn bucket refills continuously and resets on restart; it is a pacing control, not a durable daily quota. Each rejected message attempts one Discord reply through `UserVisibleError`; Discord.js handles [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits). Accept this amplification for beta; do not add suppression.

## Validation and rollout

Local signoff (2026-09-04): 294 tests and full `ci:validate` passed after the turn-cap removal, upload-path cleanup, and review fixes. Grafana validation/dry-run passed (54 panels, 19 rules). All five changed alert expressions evaluated successfully through Grafana's read-only datasource proxy; none was firing, and the current queued-image total was zero. No live settings, dashboard provisioning, or deployment changed. Operator CLI work is out of scope in this worktree; its command grouping is separate in a separate operator-CLI branch. No automatic spend gate was added.

- Adapt existing tests for retained credit, per-user concurrency, rate, payload, and recovery contracts; remove tests for deleted checks. Adapt upload tests to prove rejection before download and preserve generated-image replies; verify corrective rounds contribute to LLM spend.
- Run focused tests and required CI checks.
- Inspect effective staging settings through the operator settings path; SQLite overrides win over defaults. Verify turn admission, rejection wording, and credits before authorized production activation.
- Apply the Grafana changes with the deployment and confirm the retitled alerts and the new queue-depth alert evaluate against live data.
- Mark the roadmap item complete only after effective production settings are verified.

| Observation | Adjustment |
|---|---|
| Normal users hit rate limits while capacity is free | Raise the relevant refill; a rate limit that reaches a human is set too low. |
| Turn queue wait grows with no provider errors | Inspect conversation serialization, per-user concurrency, provider latency, and Discord delivery before changing `maxConcurrentPerUser`. |
| Failed turns with `reason="llm"` rise as concurrent turns rise | Inspect failure details for throttling; only then size a global concurrency cap from observed capacity. |
| Long image waits with all workers occupied | Raise `gpu.maxWorkers` if pricing covers it; otherwise reintroduce a global cap from measured throughput times the accepted wait. Separate warm and cold measurements. |
| One account dominates LLM spend | Review per-user LLM costs and turn rate; the roadmap spend-gate item owns automatic protection. Exhausting OpenRouter funds interrupts every user. |
| One account dominates GPU time | Expected and paid for; the scheduler prioritizes users with less in-flight work at the next claim. Raise `gpu.maxWorkers` if others wait. |
| xAI 429s or refusals rise, especially after restart recovery | First non-arbitrary reason for an animation cap; size it from the observed limit and confirm the OAuth entitlement then. |
