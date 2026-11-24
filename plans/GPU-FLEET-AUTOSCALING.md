# GPU Fleet Autoscaling Plan

## Decision

Keep one in-process fleet controller and rent dedicated Vast workers directly through the existing `VastClient` path.

Do not adopt Vast Serverless, Kubernetes, KEDA, Ray, SkyPilot, a separate autoscaler process, or an external queue. Borrow their mature controller patterns while preserving agent-runtime's single-process architecture:

- one desired-capacity calculation;
- detail minimum and maximum bounds;
- observed state reconciled toward desired state;
- workers already provisioning counted as capacity;
- hard routing capacity kept separate from the scaling target;
- one bounded three-candidate hedge when customer demand finds zero app-ready GPUs;
- delayed, idle-only scale-down;
- one managed pool containing every discovered agent-runtime Vast rental.

Fair scheduling and fleet sizing remain separate concerns. A worker is never assigned to a user, and a user does not receive an exclusive GPU.

## Borrowed Patterns

| Project | Pattern used here | What we are not adopting |
| --- | --- | --- |
| [KEDA](https://github.com/kedacore/keda) | `min`/`max` bounds and one target-based desired replica calculation | Kubernetes, ScaledObjects, polling infrastructure |
| [Ray](https://github.com/ray-project/ray) | Count pending launches before starting more; retire only idle workers after a timeout | Ray clusters, resource bundles, workload prediction |
| [SkyPilot](https://github.com/skypilot-org/skypilot) | Reconcile nonterminal workers toward bounded desired capacity; use hysteresis on scale-down | SkyPilot's daemon, jobs API, cloud abstraction |
| [Knative Serving](https://github.com/knative/serving) | Keep hard per-instance concurrency separate from the softer scaling target | Request proxying and Kubernetes serving infrastructure |
| [Kubernetes Autoscaler](https://github.com/kubernetes/autoscaler) | Recheck minimum capacity immediately before destructive provider calls | Node groups, pods, bin packing, cluster integration |

These are architecture references, not new runtime dependencies.

## Implementation Source Map

Use this as a just-in-time reading list, not as a mandate to reproduce framework machinery. Before implementing a stage, load only that stage's listed upstream symbols and local landing points. Links are pinned to upstream commits researched on 2026-08-31 so later refactors do not silently change the reference.

### Stage 7A: Bounds and Demand

Upstream references:

- [KEDA `scaledobject_types.go` at `1be5c045`](https://github.com/kedacore/keda/blob/1be5c0455fb0fcfa88f85bee8a76f1fb010650a9/apis/keda/v1alpha1/scaledobject_types.go): read `ScaledObjectSpec`, `GetHPAMinReplicas`, and `GetHPAMaxReplicas`. Borrow detail bounds; do not adopt CRDs or Kubernetes defaults.
- [KEDA `scaledobject_controller.go` at `1be5c045`](https://github.com/kedacore/keda/blob/1be5c0455fb0fcfa88f85bee8a76f1fb010650a9/controllers/keda/scaledobject_controller.go): read only `Reconcile`. Borrow one observed-to-desired control boundary; do not copy controller-runtime structure.

Local landing points:

- `src/settings/defaults.ts` for the four operator-controlled settings.
- `src/repositories/image-request-repository.ts` for `COUNT(DISTINCT user_id)` across queued and processing requests.
- A new `src/gpu/gpu-fleet-autoscaler.ts` containing only the pure desired-capacity calculation in Stage 7A; Stage 7B adds controller state and effects to the same file.
- Existing focused settings and image-request repository tests.

### Stage 7B: Desired-State Reconciliation and In-Flight Supply

Upstream references:

- [KEDA `scale_jobs.go` at `1be5c045`](https://github.com/kedacore/keda/blob/1be5c0455fb0fcfa88f85bee8a76f1fb010650a9/pkg/scaling/executor/scale_jobs.go): read `getScalingDecision`, `accurateScalingStrategy.GetEffectiveMaxScale`, and `eagerScalingStrategy.GetEffectiveMaxScale`. Borrow the invariant that running and pending work reduce what may be launched; do not copy its multiple strategies.
- [SkyPilot `autoscalers.py` at `2f1b0b83`](https://github.com/skypilot-org/skypilot/blob/2f1b0b83a685cf60f099a1ebfb05c60724c93ad8/sky/serve/autoscalers.py): read `_clip_target_num_replicas`, `_AutoscalerWithHysteresis`, and `RequestRateAutoscaler._generate_scaling_decisions`. Borrow clamping and comparison against all nonterminal replicas so provisioning capacity is not duplicated; do not copy request-rate or version-aware logic.
- [Ray `autoscaler.py` at `167681c2`](https://github.com/ray-project/ray/blob/167681c2b2485fffc670ddd9edd40ed428854e01/python/ray/autoscaler/_private/autoscaler.py): read `pending_launches`, `launch_new_node`, and `terminate_nodes_to_enforce_config_constraints`. Borrow reserving launch count before the provider call; do not copy node types, resource scheduling, or background updater machinery.

Local landing points:

- A new small `src/gpu/gpu-fleet-autoscaler.ts` for the pure calculation, coalesced reconcile request, and acquisition reservations.
- `src/gpu/gpu-runtime.ts` for observed connected/acquiring state and direct Vast lifecycle operations; remove implicit rental from `submit` only in Stage 7B.
- `src/image-requests/image-request-dispatcher.ts` and `src/index.ts` for demand and readiness event wiring.
- `src/gpu/vast-client.ts` remains the direct provider boundary.

### Queue Capacity Versus Scaling Target

Upstream references:

- [Knative `autoscaler.yaml` at `618b0c27`](https://github.com/knative/serving/blob/618b0c275af1496bbbe8d0917614452a041cd49d/config/core/configmaps/autoscaler.yaml): read the `container-concurrency-target-percentage` and `container-concurrency-target-default` comments. Borrow the separation between a hard per-instance concurrency limit and a softer fleet target.
- [Knative `autoscaler.go` at `618b0c27`](https://github.com/knative/serving/blob/618b0c275af1496bbbe8d0917614452a041cd49d/pkg/autoscaler/scaling/autoscaler.go): read `Autoscaler.Scale`, especially desired count as `ceil(observed / target)` and the scale-down delay window. Borrow the small calculation and hysteresis concepts; do not copy stable/panic windows.

Local landing points:

- `src/settings/defaults.ts`: keep `queueDepth = 2` separate from `activeUsersPerWorker = 2` even though both initial values are two.
- `src/gpu/gpu-runtime.ts`: queue depth remains only an admission check.
- `src/repositories/image-request-repository.ts`: active-user count remains the only v1 demand input.

### Stage 7C: Three-Candidate Cold-Start Hedge

Upstream reference:

- [gRPC-Java `RetriableStream.java` at `e58489ff`](https://github.com/grpc/grpc-java/blob/e58489ffa0b1815a96e25bc058f666c1d243de5e/core/src/main/java/io/grpc/internal/RetriableStream.java): read `HedgingRunnable` and `hasPotentialHedging`. Borrow only bounded parallel attempts and cancellation of unnecessary siblings; do not copy winner state, timing, retry codes, locking, or transport abstractions.

Local landing points:

- `src/gpu/gpu-fleet-autoscaler.ts`: temporary zero-worker target, ordinary acquisition reservations, and excess-acquisition cancellation.
- `src/gpu/gpu-runtime.ts`: one normal acquisition handle containing the Vast contract ID, app-ready state, and readiness promise.
- `src/gpu/vast-client.ts`: direct rental and provider-confirmed destruction.

### Stage 8: Idle Surplus Scale-Down

Upstream references:

- [Ray `autoscaler.py` at `167681c2`](https://github.com/ray-project/ray/blob/167681c2b2485fffc670ddd9edd40ed428854e01/python/ray/autoscaler/_private/autoscaler.py): read `terminate_nodes_to_enforce_config_constraints` for idle-timeout and minimum-worker checks.
- [SkyPilot `autoscalers.py` at `2f1b0b83`](https://github.com/skypilot-org/skypilot/blob/2f1b0b83a685cf60f099a1ebfb05c60724c93ad8/sky/serve/autoscalers.py): read `_AutoscalerWithHysteresis._set_target_num_replicas_with_hysteresis` and `_select_nonterminal_replicas_to_scale_down` for delayed decisions and detail selection.
- [Kubernetes Autoscaler AWS node-group implementation at `32e4c031`](https://github.com/kubernetes/autoscaler/blob/32e4c031c64850025c0b929b49d0cb1cafac6550/cluster-autoscaler/cloudprovider/aws/aws_cloud_provider.go): read `AwsNodeGroup.DeleteNodes` for its immediate minimum-size check before destructive provider calls.

Local landing points:

- `src/gpu/gpu-fleet-autoscaler.ts`: fresh desired/surplus calculation and removal reservation.
- `src/gpu/gpu-runtime.ts`: replace unconditional idle destruction with an autoscaler event and a managed lifecycle operation.
- `src/repositories/compute-worker-repository.ts`: soft-delete only after provider confirmation.

These references define invariants, not class boundaries or line-count targets. If an upstream design conflicts with agent-runtime's single-process model or the smaller policy in this plan, this plan wins.

## Product Policy

### Demand

An **active user** is a distinct user with at least one `queued` or `processing` image request.

Backlog depth does not multiply demand. One user with 100 requests is still one active user. This prevents a single heavy user from expanding the fleet while the fair scheduler still lets that user consume otherwise-idle GPU time.

### Desired Capacity

```text
desiredWorkers = min(
  maxWorkers,
  max(minWorkers, ceil(activeUsers / activeUsersPerWorker)),
)
```

Initial product direction:

- `activeUsersPerWorker = 2`.
- `minWorkers` and `maxWorkers` are detail operator settings.
- Initial configured values are `minWorkers = 0`, `maxWorkers = 3`, `activeUsersPerWorker = 2`, and `coldStartCandidates = 3`.

Examples when `minWorkers = 0`, `activeUsersPerWorker = 2`, and the ceiling permits growth:

| Active users | Desired workers | Meaning |
| ---: | ---: | --- |
| 0 | 0 | No demand-driven worker |
| 1-2 | 1 | Alice and Bob can share one GPU |
| 3-4 | 2 | More aggregate capacity, not one GPU per user |
| 5-6 | 3 | Same ratio continues |

`maxWorkers` is the **fleet ceiling**: the largest fleet size the application is allowed to target and rent toward. All compatible live workers count toward it, including manually rented workers. Adding workers directly can make the observed fleet temporarily exceed the ceiling; the application rents nothing more, and idle reconciliation retires surplus workers after their timeout.

### Comfy Capacity Is Not the Scaling Target

`gpu.queueDepth = 2` remains a hard routing limit per worker:

- one prompt executing;
- one prompt pending behind it;
- a third prompt is not accepted by that worker.

A full two-prompt queue does not by itself rent a worker. `queueDepth` protects Comfy and keeps scheduling responsive; `activeUsersPerWorker` controls fleet size.

Consequences:

- Alice occupying both prompt slots while Bob waits still produces two active users and one desired worker.
- Alice and Bob occupying one slot each while Charlie arrives produces three active users and two desired workers.
- If the second worker is already provisioning for that demand, no third worker is rented.
- If `maxWorkers = 1`, Charlie waits fairly; the configured spending ceiling wins.

### Cold-Start Hedge

Vast provisioning has high tail latency: the first contract may become usable in roughly two minutes or may take five minutes. When customer demand finds zero app-ready GPUs, latency matters more than the cents spent on a short overlap.

When demand finds zero app-ready workers, temporarily target `coldStartCandidates = 3`:

```text
coldStartTarget = min(maxWorkers, max(desiredWorkers, coldStartCandidates))
```

- Trigger only when `activeUsers > 0` and `connectedWorkers = 0`.
- Count ordinary acquisition reservations toward the target, so repeated events cannot rent beyond `maxWorkers`.
- Start enough equal direct Vast rentals to reach `coldStartTarget`, reserving all slots before awaiting Vast.
- Keep the 3.5 Gbps download floor, reliability floor, and hourly ceiling.
- Prefer offers with `inet_down_cost <= $0.01/GB`, but retain higher-download-cost offers as an availability fallback when none are available under the soft ceiling.
- Within the preferred download-cost group, rank eligible offers by `dph_total` ascending. When hourly prices are equal, prefer higher `inet_down`; bandwidth does not justify a higher hourly price.
- Within one zero-worker cold race, prefer the cheapest offer from a country not already tried in that race. Discard the country set after selecting the candidates. If no unused country is available, fall back to the cheapest offer regardless of country. Country diversity is a Docker-registry-path experiment, not a hard availability constraint.
- Treat a worker as app-ready only after bootstrap, required asset sync, and Comfy connection complete. Vast `running` alone is not ready.
- When the first worker becomes app-ready, normal reconciliation returns the target to `desiredWorkers` and destroys excess acquisitions still provisioning.
- If multiple workers become app-ready together, they join the connected fleet normally; idle surplus cleanup removes extras after five minutes.
- A failed cold-start acquisition is not replaced while the other reservations already satisfy desired capacity. If all fail, the existing bounded delayed retry admits one normal replacement attempt.

When at least one GPU is app-ready, disable hedging. Ordinary scale-up rents only missing desired capacity and may take the full Vast provisioning time while existing GPUs continue serving work.

### Offer Policy Boundaries

Every new rental uses the same offer ordering:

- Lower total hourly price wins after the eligibility floors are satisfied.
- A soft `$0.01/GB` download-price ceiling prevents small hourly savings from selecting offers with materially larger one-time pull or asset-sync costs without making capacity fail when the market is expensive.
- Advertised bandwidth breaks exact hourly-price ties but does not justify a premium.
- Once a worker is app-ready with its required assets, advertised `inet_down` no longer affects its routing priority. It matters again only when substantial new assets must be synced.
- During ordinary scale-up, existing workers continue serving demand, so cost may matter more than shaving minutes from the new worker's startup.
- When the serving fleet already covers urgent demand, a materially cheaper worker may provision in the background even if its advertised download speed is much lower. Illustratively, waiting longer on an offer around 1 Gbps instead of 5 Gbps can be worthwhile when its actual hourly price is lower.

The 3.5 Gbps floor rejects clearly unsuitable links without pretending advertised bandwidth predicts Docker cold-start latency. Do not add CPU or disk filters until measured readiness data shows that their advertised values predict app-ready time.

Advertised `inet_down` is only a download-time proxy and may be dominated by Docker registry delivery, Vast scheduling, port readiness, SSH, bootstrap, or asset sync. Replace the theoretical proxy with measured readiness only when production history supports a better predictor.

Record each candidate's country, `inet_down`, `inet_down_cost`, `dph_total`, storage cost, downloaded asset bytes, and provider-ready, SSH-ready, bootstrap, asset-sync, and total app-ready durations. Compare country and Docker pull time without treating one race as durable evidence.

### Warm-Path Goal

Retain the goal of no more than 15 seconds of warm-path queue waiting, but treat it as an observed service-level signal rather than an input to v1 scaling. The `image_gpu_accepted` event records enqueue-to-GPU-accept time separately from worker provisioning and asset download time.

Do not add predicted prompt duration, utilization scoring, or queue-wait feedback until production evidence shows that the active-user ratio is insufficient.

### Asset-Local Routing

Prefetch continues broadcasting required assets to every connected worker. Request routing prefers workers where every required asset has finished syncing, then chooses the least-loaded such worker. If every asset-ready worker has reached `queueDepth`, fall back to a worker with a free prompt slot and sync there. Do not treat an in-progress prefetch as cached.

## Capacity Model

The controller reconciles these counts:

```text
supply = connectedWorkers + acquiringWorkers
missing = max(0, desiredWorkers - supply)
surplus = max(0, supply - desiredWorkers)
```

- `connectedWorkers` includes idle and busy compatible workers. Busy workers still exist as supply.
- `acquiringWorkers` includes in-memory acquisition reservations and known compatible Vast workers still provisioning or syncing.
- An acquisition is counted before awaiting Vast so repeated events cannot create duplicate rentals, then transitions from a reservation to a provider worker without being counted twice.
- The same acquisition reservations enforce both ordinary desired capacity and the temporary cold-start target; there is no separate race state.
- Every worker returned by the scoped agent-runtime Vast listing joins the same managed pool, including manually created and rediscovered rentals.
- Any managed worker may serve requests, satisfy desired capacity, or be selected for idle surplus destruction.

Provider status remains observed Vast state, not durable application state. SQLite stores identity, image reference, asset knowledge, and destruction history; it does not claim that a worker is currently ready or busy.

## Target Architecture

Keep the implementation inside the existing Bun process.

### `ImageRequestRepository`

- Owns the SQL definition of demand.
- Returns the distinct count of users with queued or processing requests.
- Keeps the existing fair `claimNext` ordering for choosing work.

### `ImageRequestDispatcher`

- Owns fair claiming, submission, retry, and delivery.
- Does not decide fleet size or rent workers.
- Treats `busy` as temporary backpressure and retries when runtime capacity changes.

### `GpuFleetAutoscaler`

- Owns the desired-capacity formula and one coalesced reconciliation loop.
- Reads demand, settings, connected workers, and acquisitions.
- Is the only caller allowed to initiate an automatic rental or automatic destruction.
- Reserves all missing acquisition slots before starting asynchronous direct rentals.
- Emits one decision event per reconciliation.

### `GpuRuntime`

- Owns live Comfy connections, prompt reservations, asset sync, direct Vast acquisition, and provider destruction.
- Exposes observed fleet state and lifecycle operations to the autoscaler.
- Does not infer demand or implicitly rent from `submit`.
- Continues selecting the least-loaded compatible connected runtime for each request.

This gives the process one canonical flow:

```text
request state changes
  -> autoscaler recomputes desired capacity
  -> GpuRuntime directly rents or retires agent-runtime Vast workers
  -> worker readiness wakes the fair dispatcher
  -> dispatcher fills available Comfy slots
```

## Reconciliation

Request a coalesced reconciliation when:

- an image request is enqueued, requeued, delivered, or failed;
- a worker becomes connected, becomes unavailable, or finishes acquisition;
- an acquisition fails;
- a worker's idle timeout expires;
- relevant settings change.

One reconciliation does the following:

1. Read `activeUsers` and the fleet settings.
2. Compute `desiredWorkers` with the single formula.
3. Snapshot connected workers and acquisitions.
4. If customer demand finds zero connected workers, use the bounded cold-start target; otherwise use desired capacity directly.
5. Reserve every missing acquisition slot in memory before starting direct Vast rentals.
6. When a cold-start worker connects, return to normal desired capacity and cancel excess acquisitions still provisioning.
7. If connected supply is above desired, destroy only workers whose idle timeout has expired.
8. Emit the inputs, decision, and reason.

The loop is serialized and coalesced. Events arriving while it runs request one more pass rather than running overlapping decisions.

### Scale Up

- Reuse already-discovered compatible workers before renting.
- With at least one connected worker, rent exactly `missing` dedicated workers through the current Vast offer selector and `VastClient` flow.
- With customer demand and zero connected workers, temporarily target the bounded three-worker cold-start capacity described above.
- Count each acquisition reservation immediately, including its provisioning and asset-sync phases.
- Clear its supply reservation when the worker connects or the acquisition fails.
- On failure, preserve queued work, clear the reservation, and allow one delayed retry; do not hot-loop.
- Remove the current implicit rental from `GpuRuntime.submit`. Without a connected slot, submission returns `busy`; only the autoscaler creates capacity.
- Use the same price-first offer selector for every acquisition; cold start differs only by temporarily requesting three candidates.

No rental racing occurs during ordinary scale-up. The cold-start hedge is the only speculative rental path in v1.

### Scale Down

The existing idle timeout is the hysteresis mechanism. Its timer marks a worker idle-expired and requests reconciliation instead of destroying it directly.

At reconciliation, destroy no more than `connectedWorkers - desiredWorkers` workers that:

- have no prompt reservations;
- have remained idle for `gpu.hibernateIdleMs`;
- are still idle immediately before the provider call.

Removing a selected worker from the runtime routing map synchronously reserves the removal before the Vast call. Confirm provider destruction before soft-deleting the SQLite worker record. If destruction fails, restore the runtime, restart its idle timer, and retain its active SQLite record.

No detail draining state is needed in v1: an idle worker has no accepted work to drain. Never interrupt an accepted prompt. Excess cold-start acquisitions still provisioning may be destroyed immediately because they have never entered routing.

## Restart and Drift

On startup:

1. Reconcile current Vast contracts with SQLite.
2. Reconnect compatible ready workers.
3. Count known compatible nonterminal workers as acquiring so restart does not rent duplicates.
4. Add unmatched provider workers to the managed pool.
5. Requeue interrupted `processing` requests using the existing recovery path.
6. Run one autoscaler reconciliation, then wake the dispatcher as workers become ready.

A successful Vast rental can be rediscovered through provider reconciliation after a crash. Do not build distributed leases or exactly-once rental machinery for a single-process application.

## Configuration

Add these settings under `gpu`:

- `minWorkers`: lower bound for desired capacity; zero permits a fully cold fleet.
- `maxWorkers`: upper bound for the managed agent-runtime fleet.
- `activeUsersPerWorker`: positive scaling target, initially 2.
- `coldStartCandidates`: total concurrent candidates for the zero-GPU hedge, initially 3 and capped by `maxWorkers`.
- `offer.preferredMaxDownloadCostPerGbUsd`: soft download-price ceiling, initially `$0.01/GB`.
- existing `hibernateIdleMs`: scale-down delay.

These are operator-controlled settings. Use sensible values; do not add a second cross-setting validation layer around our own configuration.

Keep `maxHourlyUsd` as the per-offer price constraint. `maxWorkers` is the independent aggregate fleet guardrail. A rough upper bound on active hourly GPU rental is therefore `maxWorkers * maxHourlyUsd`, excluding storage and download charges.

## Observability

Emit the static fleet policy once when the controller starts. Emit each structured autoscaler decision with only changing state and action context:

- trigger and decision: `none`, `acquire`, or `destroy`;
- `activeUsers`, `desiredWorkers`, `connectedWorkers`, and `acquiringWorkers`;
- connected, acquiring, busy, and idle worker counts;
- cold-start acquisition count and excess-acquisition cleanup reason when applicable;
- worker ID and reason when taking a lifecycle action.

Continue recording acquisition, asset-sync, readiness, destruction, and failure durations. For each acquisition, retain the selected offer attributes and separate provider-ready, SSH-ready, bootstrap, asset-sync, and total app-ready durations. Record warm-path enqueue-to-GPU-accept time only after the GPU accepts a request. These events should answer why a worker was or was not rented without reconstructing logs by hand.

## Current Baseline

Already implemented foundations include:

- durable compute-worker and asset records;
- provider reconciliation and startup reconnection;
- fair per-user database claiming;
- exactly two accepted Comfy prompts per worker;
- multiple connected workers and least-loaded routing;
- queued-demand asset prefetch;
- requeue and readiness wakeups;
- bounded desired capacity from distinct active users;
- one serialized direct scale-up controller with in-flight reservations;
- one bounded three-acquisition target when demand finds a cold fleet;
- fresh desired-capacity checks before destroying idle-expired surplus workers;
- enqueue-to-GPU-accept latency for accepted requests;
- existing Vast worker reuse and one delayed acquisition retry;
- detail request and worker lifecycle reconciliation triggers.
- completed-asset-aware routing with least-load and available-slot fallback.

`GpuRuntime.submit` no longer rents implicitly when no worker exists. Idle expiry now marks workers eligible for fresh desired-capacity reconciliation instead of destroying them unconditionally.

## Incremental Delivery

Implement one stage at a time and stop for review. Do not deploy, rent GPUs, destroy workers, or alter production without separate authorization for that stage.

### Stage 7A: Policy and Demand

Status: implemented locally; not deployed.

- Add the four settings.
- Add the distinct active-user count and pure desired-capacity function.
- Emit a dry-run decision event from current state so the formula can be reviewed without changing capacity.
- Stop after repository, formula, settings, and event tests.

### Stage 7B: Direct Scale-Up Controller

Status: implemented locally; not deployed.

- Add the in-process, serialized `GpuFleetAutoscaler`.
- Make it the sole automatic rental owner.
- Count acquisition reservations and known provisioning workers as supply.
- Clear failed reservations and allow one delayed retry.
- Remove implicit rental from `GpuRuntime.submit`.
- Trigger reconciliation from request and worker lifecycle events.
- Continue renting dedicated Vast workers through the current selector and client; do not add rental racing or scale-down yet.
- Stop after duplicate-event, acquisition-failure, restart, and ceiling tests.

### Stage 7C: Three-Candidate Cold-Start Hedge

Status: implemented locally; not deployed.

- When active customer demand finds zero app-ready workers, temporarily target three equal acquisitions within `maxWorkers`.
- Count reservations before calling Vast so repeated events do not exceed the target.
- Treat an acquisition as ready only after bootstrap, required asset sync, and Comfy connection.
- When one connects, return to ordinary desired capacity and destroy excess acquisitions still provisioning.
- Do not hedge ordinary scale-up.
- Stop after readiness, deduplication, ceiling, failure, desired-capacity retention, and acquisition-cleanup tests.

### Stage 8: Idle Surplus Scale-Down

Status: implemented locally; not deployed.

- Turn idle expiry into an autoscaler reconciliation trigger.
- Destroy only idle, surplus workers after `hibernateIdleMs`.
- Remove selected workers from routing before the provider call so concurrent decisions cannot cross below desired capacity.
- Restore the runtime and retain its worker record when provider destruction fails.
- Preserve busy workers.
- Stop after renewed-demand, destruction-failure, and no-interruption tests.

### Stage 9: Production Measurement Review

- Deploy only with detail authorization.
- Review active-user distribution, desired versus observed fleet, acquisition latency, warm queue wait, idle duration, and hourly cost.
- Compare advertised `inet_down` and offer price with each app-ready phase instead of assuming bandwidth caused the observed total latency.
- Adjust `minWorkers`, `maxWorkers`, or `activeUsersPerWorker` from evidence before considering another signal.

### Stage 10A: Price-First, Country-Diverse Offer Selection

Status: implemented locally; not deployed.

- Prefer offers at or below `$0.01/GB` download cost, then rank by total hourly price and use bandwidth only to break equal-price ties after the 3.5 Gbps floor.
- Prefer unused countries only while selecting the three candidates in one cold race, then fall back to the cheapest offer when country diversity is unavailable.
- Race three equal cold candidates and cancel unnecessary provisioning candidates after the first becomes app-ready.
- Prefer workers with completed required assets during request routing.
- Record country, selected offer, and measured readiness phases for later calibration; do not add CPU or disk filters yet.

### Future Stage 10B: Measured Ranking and Cheap-Worker Replacement, Only With Evidence

- Start only if Stage 9 shows a useful relationship between offer attributes, price, and app-ready latency.
- Replace theoretical download time with measured app-ready predictors when the evidence is useful.
- During nonurgent scale-up, allow a cheaper low-bandwidth offer to pull and sync in the background while existing workers continue serving queued demand.
- For replacement, keep the current worker serving until the cheaper candidate is app-ready, then route new work to the candidate and retire the expensive worker only after accepted work finishes.
- Compare the one-time download, storage, and overlap cost with the candidate's measured hourly savings; do not switch merely because its advertised bandwidth is lower.
- Keep `inet_down`, `inet_down_cost`, hourly price, storage price, and measured provisioning phases as separate inputs.
- Stop for review with current-market examples and measured production evidence before changing rental selection.

## Validation

Use injected clocks; tests must not wait on real time.

- The pure formula covers zero demand, each user boundary, `minWorkers`, and `maxWorkers`.
- One user with a deep backlog does not expand desired capacity beyond one worker when `minWorkers = 0` and the ceiling permits one.
- Two active users share one desired worker; they do not receive exclusive GPUs.
- Three active users produce two desired workers when below the ceiling.
- A full Comfy queue alone does not change desired capacity.
- Repeated events while a worker is acquiring do not rent again for the same missing capacity.
- Connected plus acquiring workers satisfy desired capacity.
- An ordinary scale-up acquisition failure clears its reservation and permits a bounded retry.
- Restart counts every known compatible nonterminal worker instead of duplicating capacity.
- Customer demand with zero connected workers starts three equal acquisitions when `maxWorkers >= 3`.
- Repeated request events do not exceed that bounded cold-start target.
- Vast `running` without completed bootstrap, assets, and Comfy connection is not app-ready.
- The first candidate that connects cancels two still-provisioning acquisitions for a desired fleet of one.
- One cold race prefers three countries when available and falls back without failing when they are not.
- A worker with completed required assets is preferred until its prompt queue is full, then routing falls back to another worker with capacity.
- A failed speculative acquisition is not replaced while existing reservations satisfy desired capacity; all-candidate failure permits one bounded delayed retry.
- Ordinary scale-up with an existing connected worker never launches hedge candidates.
- A manually created agent-runtime worker joins the managed pool and counts toward capacity.
- A worker is destroyed only when idle, past the timeout, and surplus to a fresh desired calculation.
- Renewed demand before the destructive provider call prevents destruction.
- Busy workers are never interrupted.
- Failed provider destruction does not disappear from canonical state.

## Deliberately Deferred

- Vast Serverless or another managed/serverless execution path.
- Rental racing during ordinary scale-up or beyond the single bounded cold-start hedge.
- Measured readiness prediction, dynamic repricing, or cheap-worker replacement before production supplies evidence.
- Predictive demand, queue-wait control loops, or utilization targets.
- Per-user worker affinity or exclusive GPUs.
- GPU-time-weighted fairness.
- In-progress asset-sync routing and checkpoint-specific pools.
- detail draining states beyond idle-only retirement.
- Exactly-once execution or crash-perfect rental bookkeeping.

These remain outside the initial scaler. Revisit them only when production evidence demonstrates enough value to justify the added policy.
