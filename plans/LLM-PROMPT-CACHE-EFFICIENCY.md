# LLM prompt-cache efficiency

## Decision

Keep a **byte-stable system-prompt prefix** (rules + tool schemas) ahead of per-bot and per-user content so provider prompt caches can hit across conversations.

## Patterns borrowed

- Stable prefix / volatile suffix boundary inside the system prompt
- Deterministic tool schema ordering
- Bounded history window for turn context (sliding window), separate from durable notes

## What we measured

Internal experiments compared history-window sizes and placement of long static instructions. Moving stable instructions into the cached system prefix reduced uncached input tokens on multi-turn sessions without changing the tool surface.

## Non-goals of this portfolio note

Product-specific browse/remix case catalogs and transcript excerpts are omitted. The durable takeaway is the cache-boundary design, not the case content.
