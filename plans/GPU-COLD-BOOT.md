# GPU cold boot optimization

## Selected implementation — 2026-09-05

Goal: shorten time to the first delivered image and stop paying for boot-race losers.

- One thin, unsquashed image on Vast's pinned ComfyUI template base; no bundled models. Preserve upstream layer digests for registry/host reuse. The template's cached flag does not guarantee a cache hit on a particular host.
- Canonical build: `infra/comfy-worker/Containerfile` and `build.ts`. Canonical published image pin: `src/comfy/comfy-worker-images.ts`; keep digests there only.
- The rental receives the asset manifest and starts syncing alongside ComfyUI before SSH is available. Later syncs use the same per-asset locks, expected-size cache checks and atomic replacement.
- All checkpoint, LoRA, DetailPass and other manifest assets use **32 MiB chunks, 16 workers per asset, two assets concurrently, four-second attempts, at most four attempts per chunk**. Each free worker takes another chunk immediately.
- System Python/PycURL uses libcurl handles retained per worker within each asset. Successful connections are reused; failed chunks retry on a fresh connection. Ranges write directly into the destination's temporary file at their offsets.
- The first provider-`running` candidate wins the boot race. Excess acquisitions are cancelled before SSH/application readiness; retain enough workers for actual demand. If that winner fails later, acquire replacement capacity.
- Record ownership immediately after a successful rental response, before fallible instance polling. Accept Vast's `created` status. Failed acquisitions are destroyed; failed provider deletion retains tracking for retry.
- Offer policy requires CUDA 13 support and disk bandwidth of at least 3000 MB/s alongside existing price/network/reliability rules. Country diversity remains unchanged; there is no two-US preference.

## Measurements worth retaining

September 5, sequential runs on RTX 4090 rentals on Texas machine 56614. The full bundle is **9,981,672,826 bytes across 15 unique assets**. Timings exclude independent SHA256 verification; all successful full-bundle trials below passed every hash. These are repeat measurements on one host, not a fleet-wide guarantee.

At 64 MiB, two trials per deadline: four seconds averaged **21.96 s** for the bundle, six seconds **23.10 s**, eight seconds **27.06 s**. Total timeout counts were 25, 13 and 5 respectively. More retries can still mean a faster completed download.

Chunk size, four-second deadline, three complete bundle trials per size:

| Chunk size | Average bundle time | Timeouts across three trials | Discarded retry bytes |
| --- | ---: | ---: | ---: |
| 64 MiB | 24.10 s | 36 | 220.9 MiB |
| 32 MiB | 23.13 s | 60 | 237.9 MiB |
| 16 MiB | 28.16 s | 101 | 73.4 MiB |

32 versus 64 MiB timings overlap. The stronger reason for 32 MiB is the controlled slow-connection test: at **12 MiB/s per connection**, a 1 GiB prefix with 64 MiB chunks exhausted all four attempts on every chunk; 32 MiB finished in **5.58 s**, 16 MiB in **7.33 s**, both without timeouts and with matching hashes. This does not prove success on every slow host. Most timeouts in normal runs delivered zero bytes, so chunk size alone cannot fix them.

Connection reuse, 32 MiB/four seconds, three complete bundle trials per method:

| Method | Average bundle time | Timeouts across three trials | New connections across three trials |
| --- | ---: | ---: | ---: |
| Separate curl process per chunk | 23.95 s | 62 | Not counted |
| PycURL, forced fresh connections | 22.34 s | 30 | 940 |
| PycURL, reuse; fresh on retry | **19.69 s** | **13** | **284** |

Reuse was about **18% faster than CLI curl**, and **12% faster than the matched PycURL fresh-connection control**. There were 631 successful reused transfers. CLI and PycURL also differ in process overhead and TLS backend; the matched control isolates reuse more cleanly. Connections are pooled within an asset, not across assets.

Evidence from this session: `/tmp/codex-zod-audit/DOWNLOAD-BENCHMARK.md`, `/tmp/codex-chunk-size-bench/RESULTS.md`, `/tmp/codex-connection-reuse-bench/RESULTS.md`. These are local scratch artifacts; the useful results are retained above. All benchmark rentals were destroyed.

## Logging and next validation

`/var/log/agent-runtime-comfy-asset-sync.log` records each attempt's bytes, elapsed time, MiB/s, timeout/error, new/reused connections and first-byte latency. `CHUNK_SUMMARY` records successful full-chunk average/p95/max, timings including retries, retry bytes, timeout counts (including zero-byte timeouts), and effective asset speed. The successful-chunk average is censored by the deadline; evaluate it alongside failures and retry-inclusive timings.

These GPU-local logs are **not automatically collected in Grafana**. Entry-point background sync summaries need collection before longitudinal dashboard analysis is possible. App events already cover provider boot, SSH, bootstrap and asset sync; `status_msg` samples help distinguish layer cache hits, pull and extraction.

Published image tag: `pooled-32m-20260905`; remote manifest verified before pin promotion. Baked-image tests passed hashes, retry exhaustion, preservation, cache skips and 18 ranges over 16 TCP connections.

Release checks: test the baked downloader's hashes, retry exhaustion, existing-file preservation, cache skips and real TCP reuse; verify the published manifest before updating the pin; run full CI; deploy staging and production. Then measure three staging Discord cold boots: first delivered image, full asset-sync timing, and confirmed provider deletion of race losers at the winning boot. Deployment/startup checks alone do not establish that end-to-end result.

API schema audit: live Vast offers/instances/invoices and OpenRouter credit/key responses passed the audited schemas. Broader follow-ups remain: Grok device-flow optional fields/token expiry semantics, moderation responses without a video URL, Vast `recycling`, and centralized schema-failure visibility. Keep validation on required operational fields; blanket permissive parsing would hide malformed responses.

## Discarded or not useful

- **Checkpoint image bundling / one giant squashed runtime:** increases cold pull latency and removes upstream cache sharing. Removed checkpoint build/publisher paths.
- **Recompressing every upstream layer as plain tar:** rewrites blob identities and sacrifices the cache reuse this design needs. Preserve upstream compressed blobs.
- **Sixteen fixed large ranges:** long stragglers dominate completion (35 s and much worse checkpoint runs). A queue limits each connection's responsibility.
- **Blind timeout doubling to 8/16/32/64 seconds after one failure:** hides stalls; not adopted. Fixed bounded attempts plus smaller chunks are measured, while adaptation to genuinely slow hosts remains future work requiring evidence.
- **16 MiB globally:** increased requests and average bundle time. **New curl process per chunk:** replaced by measured libcurl pooling.
- **aria2, rclone, s5cmd as the current winner:** earlier checkpoint trials were slower (aria2 23.76/30.43 s; rclone best 26.42 s; s5cmd 22.96/49.17 s). These are capable downloaders, not universally rejected; aria2 already supports ranges, retries and keepalive. Its minimum split size is not a fixed request size, and its timeout is not curl's total attempt deadline. Package size alone was not a useful rejection criterion.
- **wget2 exit 8:** failed experiment, not a speed result. **Disk-write-path conclusions:** 10–199 s variance swamped curl/dd/null comparisons; those results do not establish a disk bottleneck.
- **uv as a drop-in model downloader:** its pooled HTTP, caching and streaming are useful ideas, but it solves package installation. Borrow connection reuse via libcurl instead of adding uv to this path.
- **Building the image inside a rented GPU container:** blocked by container namespace/capability restrictions. Local Podman builds and publishes the small added layers.
- Old five-arm base-image proposals and speculative cache sweeps are superseded by the measured implementation. No claim that Vast loading time is unbilled is needed for the decision.

References: [aria2 manual](https://aria2.github.io/manual/en/html/aria2c.html), [uv HTTP client](https://github.com/astral-sh/uv/blob/main/crates/uv-client/src/base_client.rs), [libcurl connection counter](https://curl.se/libcurl/c/CURLINFO_NUM_CONNECTS.html).
