# DeepSeek V4 Pro 0813 model card

Vendor facts, prompting strategy, and agent-runtime integration as of 2026-08-28. Vendor benchmarks and general prompting research are not agent-runtime product evidence. A strategy becomes local guidance only after a focused production-path eval shows repeatable improvement.

## Evidence labels

- **Documented:** stated by DeepSeek or implemented in the official DeepSeek Harness.
- **Research-backed:** supported outside agent-runtime; transfer to this model and product remains a hypothesis.
- **Observed:** surfaced in retained agent-runtime production-path evals or production regressions.
- **Candidate:** worth a focused experiment; not established guidance.

## Profile

| Field | Fact |
| --- | --- |
| Vendor/version | DeepSeek; `DeepSeek-V4-Pro-0813`, the official V4 Pro release that supersedes the preview |
| agent-runtime route | OpenRouter `deepseek/deepseek-v4-pro-0813` |
| Modalities | Text input and text output; this route does not accept image or audio input |
| Context | DeepSeek API: 1M tokens; OpenRouter route: 1,048,576 tokens |
| Maximum output | DeepSeek API: 384K tokens |
| Architecture | Mixture-of-Experts; V4 Pro has 1.6T total parameters and 49B activated per token; 0813 retains the preview architecture and adds DSpark speculative decoding |
| Reasoning | Thinking and non-thinking modes; `reasoning_effort` supports `low`, `high`, and `max` |
| API capabilities | JSON output, tool calls, Responses API, Anthropic API, chat-prefix completion, and non-thinking FIM; the OpenRouter route also exposes structured outputs |
| Knowledge cutoff | Not stated in the official model card, technical report, or API model table linked below |
| License | MIT |

Vision is exposed as the separate experimental `DeepSeek-V4-Flash-Vision-Exp` model, not as a capability of V4 Pro 0813.

## Current agent-runtime contract

| Setting | Value |
| --- | --- |
| Provider/model | OpenRouter `deepseek/deepseek-v4-pro-0813` |
| Thinking | Off |
| Maximum output | 2,000 tokens |
| Conversation history | 4 completed turns |
| Model rounds | At most 3 |
| Tool choice | Required |
| Terminal action | Exactly one successful `submit_response` or `animate_image` |

`update_notes` is auxiliary. `submit_response` and `animate_image` are terminal. The runtime executes tools sequentially, blocks sibling terminal calls, and permits a corrective model round after a blocked or failed action. `submit_response.prompts` is one bounded array containing the complete still-image batch.

## DeepSeek-specific prompt behavior

- **Documented:** Send ordinary OpenAI-compatible role messages and structured tool schemas. DeepSeek's encoder owns DSML serialization; do not handwrite DSML in application prompts.
- **Documented:** Arrays and objects are JSON tool parameters. One assistant message may contain multiple sibling tool invocations, and multiple tool results retain call order. The encoding does not infer plural intent or convert one array into repeated calls.
- **Documented:** The official parser expects well-formed model output and does not repair malformed output. Keep strict schemas and detail runtime recovery rather than relying on prose alone.
- **Documented:** DeepSeek Harness assembles ordered prompt sections separated by blank lines, keeps tool schemas as a separate input, and projects changing runtime context as user-role snapshots.
- **Documented:** The harness removed generic `<context>` and `<steering>` wrappers because arbitrary tags had no trained meaning and sometimes caused misinterpretation. Use plain Markdown sections unless a producer owns a demonstrated framing contract.
- **Documented:** Exact shared prefixes drive context-cache reuse. Keep stable policy and demonstrations in the static prefix; append changing conversation state afterward.
- **Documented harness pattern:** Cross-call guidance lives in a prompt section, while one argument's format guidance lives in its field description. The harness uses compact micro-examples when a field's desired form is otherwise ambiguous.
- **Documented:** DeepSeek's agentic benchmark configuration used `max` reasoning effort, `temperature = 1.0`, and `top_p = 0.95`. This does not establish that thinking mode helps agent-runtime's short conversational tool decisions; test it as a separate model-setting experiment.

## Harness references: cache and API discipline

What the agent harnesses that live on these APIs do, and what agent-runtime measured against OpenRouter on 2026-09-03 (`plans/LLM-PROMPT-CACHE-EFFICIENCY.md`).

| Harness | Rule it applies | agent-runtime status |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh`) | Ordered prompt sections; tool schemas kept as a separate input; changing runtime context projected as user-role snapshots; cache-hit rate surfaced per run (typical runs report ~96%). | Sections and snapshots adopted. Cache-hit share is on the Grafana spend row; 53% on the 2026-09-03 night before the fixes. |
| [Codex CLI](https://codex.danielvaughan.com/2026/04/21/codex-cli-prompt-caching-maximise-cache-hits-cost-reduction/) | One byte-stable prefix (instructions, tools, environment, AGENTS.md); everything dynamic is appended as messages, never edited into the prefix; deterministic tool ordering; `prompt_cache_key` per project for routing affinity, kept under ~15 requests/min per key; compaction thresholds set high because compaction resets the cache. Measured 80–90% hits on established sessions. | Static prefix stable since the B3 move. History appends only; the hysteresis window trims every 4th turn instead of every turn (the compaction trade-off in miniature). OpenRouter ignores `prompt_cache_key`; `x-session-id` plus a pinned provider is the affinity we have. |
| [OpenClaw](https://docs.openclaw.ai/reference/prompt-caching) | detail stable-prefix / volatile-suffix boundary inside the system prompt; tools sorted deterministically; whitespace and capability ordering normalized so semantically equal prompts share cache; timestamps and per-turn metadata below the boundary. | No timestamps or per-turn metadata in our system prompt. System voice sits first, so the prefix is per character; moving shared rules ahead of the system voice let a second character's first call hit 1,024 cached tokens in a probe (experiment C). |
| [xAI Grok](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits) | Server affinity via `x-grok-conv-id` (or `prompt_cache_key` on Responses); append-only history, never edit, remove, or reorder earlier messages; check `usage.prompt_tokens_details.cached_tokens`. | Same append-only rule; the same `cached_tokens` field is what pi-ai reads. Grok is only used for video here. |
| [OpenAI prompt caching](https://platform.openai.com/docs/guides/prompt-caching) | Static content first, volatile last; exact prefix match; `prompt_cache_key` is a routing hint, not a breakpoint. | Same layout. |

Provider facts that no harness doc covers and that decide the numbers here: cache units are 1,024 tokens on Alibaba and 64 on DeepSeek official; cache reads cost 10% of input on Alibaba and 3.3% on DeepSeek; OpenRouter's `order` spills to the next provider under rate limits; Fireworks garbles empty tool replies and DeepInfra drops tool calls for this schema.

## Prompt ownership

Put a rule at the narrowest surface that contains the complete behavior:

| Behavior | Owner | Example |
| --- | --- | --- |
| Assistant voice and conversational manner | System voice prompt | Tone, directness, reply style |
| When to call one tool | Tool description | When `update_notes` is appropriate |
| Meaning or format of one argument | Argument schema | A complete replacement snapshot; one prompt per image |
| Coordination across tools or results | Stable system prompt | `update_notes` result followed by `submit_response` |
| Changing facts and saved state | User-role runtime context | Current persistent notes snapshot |
| Deterministic execution and side effects | Runtime code | One terminal action; atomic image batch |
| Subjective semantic success | Codex and the user | Whether a reply or image prompt truly followed intent |

Do not repeat the same full rule across surfaces by default. If repetition is tested, each occurrence should express the part owned by that surface so the copies cannot drift into competing contracts.

## Strategy ladder

Prompt experiments should vary the strategy, not only synonyms inside one zero-shot rule.

| Strategy | Best use | Placement | Evidence and risk |
| --- | --- | --- | --- |
| Direct imperative rule | Simple, already-understood boundary | Owning system section, tool description, or field | Cheapest baseline; wording sensitivity remains |
| One positive demonstration | Desired payload shape or action sequence is hard to express abstractly | Field for one argument; system prompt for a cross-tool trajectory | Research-backed; one relevant example may be enough |
| Boundary pair | Nearby inputs require different behavior, such as singular/plural or temporary/lasting | Owning surface | Candidate; teaches the decision boundary rather than one happy path |
| Contrastive bad → good pair | A stable failure keeps surviving direct rules | Owning surface, explicitly labeled and immediately corrected | Research-backed in narrower tasks; a bad example can be imitated or add irrelevant tokens, so never include it alone |
| Full tool trajectory | Ordering, tool-result interpretation, or termination is failing | Stable system prompt | Candidate for cross-tool coordination; use actual tool names and argument shapes, but synthetic user details |
| Ordered decomposition | One output requires several dependent decisions | Owning system section or field | Candidate; state the decision order without requesting visible chain-of-thought |
| Runtime corrective feedback | The model can recover after an invalid call | Runtime tool result | Already used; feedback must identify the exact violated execution contract |
| Reasoning effort | Failure appears to require deliberation rather than a clearer contract | Model setting, never disguised as prompt prose | DeepSeek-supported but unvalidated for agent-runtime; isolate cost and latency |
| Automatic prompt search | Generate candidate instructions or demonstrations from retained failures | Offline eval workflow only | APE, OPRO, and DSPy show the idea; candidates do not judge themselves and must face held-out cases plus human review |

Self-consistency, multi-agent debate, repeated self-critique, and large tree-of-thought prompts are low-priority here. They add model calls, latency, state, or side effects before we have exhausted compact rules and demonstrations.

## Demonstration design

- Start with one minimal, representative example. More examples can interfere, bias the model toward their ordering, or teach accidental surface details.
- Use the production tool names and exact argument shapes. Do not demonstrate a protocol the model never receives.
- Keep example facts synthetic and neutral. Never place a real bot name, conversation detail, or unwanted system-voice prose into an example that the model may copy.
- A positive example should show the whole relevant behavior, not only the final payload. For cross-tool coordination, include the triggering user intent, auxiliary call, tool result, and terminal call.
- A negative example must be a near miss, explicitly marked wrong, followed immediately by the corrected output and one short statement of the violated boundary. Do not provide bad-only demonstrations.
- Prefer contrast over volume: one singular/plural pair is more diagnostic than several unrelated plural requests.
- Keep examples static when possible so DeepSeek can reuse the prompt prefix. Dynamic example retrieval is a separate architecture with cache, selection, provenance, and drift costs.
- Re-run the focused regression suite and unrelated holdouts. Demonstration choice and order are known sources of in-context-learning variance.

## Example shapes worth testing

These are experiment shapes, not approved production wording.

### Cross-tool trajectory

```text
User intent: make one lasting visual change and show it.
Correct sequence: update_notes(complete snapshot carrying forward prior facts and applying only the detail change, visualChange=true)
Tool result: updated, visualChange=true
Then: submit_response(reply, prompts=[one prompt depicting the exact change])
```

This belongs in the system prompt because neither tool schema independently owns the transition between the two calls.

### Contrastive notes boundary

```text
Wrong: fill unspecified attributes from the bot description when the user left them open.
Correct: carry forward existing user-supplied notes and apply only the user's detail change; a sparse snapshot is complete.
```

This belongs in the `notes` argument description because it defines one argument's evidence boundary. Whether `update_notes` should be called remains in the tool description.

### Image-count boundary

```text
Singular request → one prompts item.
Unnumbered plural request → a multi-item prompts batch.
```

This belongs in the `prompts` argument description. The runtime-owned array limit remains in JSON Schema rather than duplicated as a number in prose.

## Experiment method

For one confirmed regression:

1. Preserve the focused production-path suite and an unrelated holdout.
2. Retain the current prompt as the baseline and run at least three repeats.
3. Name one missing contract and its owner.
4. Try the smallest direct rule first unless the failure already survived that strategy.
5. Then compare one different strategy class: positive demonstration, boundary pair, or contrastive correction. Do not mix several new strategies in one candidate.
6. Keep the exact examples and their order in retained run evidence.
7. Use code only for objective execution facts. Codex reviews actual replies and tool payloads; the user makes the final judgment.
8. Promote only repeatable improvements that survive holdouts, remain concise, and justify their recurring token/cache cost.

Automatic prompt optimization may propose candidates from failure evidence and scores, but it must not rewrite cases, weaken expectations, grade subjective behavior, or select a production prompt without review.

## Observed experiment: visual-change coordination

On 2026-08-28, `regression-lasting-look-image-coordination-v1` compared the current direct rule with four different strategy classes and a batch-aware refinement through the production `TurnEngine`, DeepSeek V4 Pro, and five repeats.

| Strategy | Isolated result | Adjacent behavior |
| --- | --- | --- |
| Current direct rule | 15/20 returned one prompt after `visualChange: true` | Plural baseline returned the requested batch in 11/15 variation runs |
| Direct semantic bridge | 20/20 returned one prompt | One run cleared the requested persistent note |
| Singular true/false boundary | 20/20 returned one prompt | Singular wording returned one prompt for 3/9 plural requests |
| Positive tool trajectory | 20/20 returned one prompt | Repeated the demonstrated `lorem` framing in most wide-frame cases, weakening visibility |
| Singular contrastive correction | 20/20 returned one prompt | Singular wording returned one prompt for 3/9 plural requests |
| Batch-aware true/false boundary | 20/20 returned one prompt | Preserved the requested plural batch in 13/15 runs; all 15 two-turn note variations preserved prior notes, used no image after false, and one changed-trait image after true |

The retained evidence supports a boundary that treats `visualChange: true` as current still-image intent while explicitly preserving plural intent. A singular-only rule or demonstration is too restrictive. After user approval, replacing the detail `update_notes` transition with this boundary failed 0/20 isolated cases, and a concise merge passed 12/20. Retaining the detail transition and adding the boundary as a separate system section passed 20/20, followed by 9/9 two-turn note variations and 7/9 plural variations without eval injection. The promoted form therefore uses the boundary as reinforcement, not replacement.

## Current directional conclusions

- **Established architecture:** one stable Markdown system prompt; structured tool schemas; mutable notes as user-role snapshots; deterministic terminal invariants in runtime.
- **Established ownership:** one-tool invocation and argument semantics stay with that tool; cross-tool coordination belongs in the system prompt.
- **Observed coordination result:** a separate batch-aware true/false boundary reinforces the detail cross-tool transition; replacing or merging away that anchor regresses coordination.
- **Observed demonstration risk:** the full trajectory overfit an incidental `lorem` detail; singular boundary and contrastive examples weakened plural behavior.
- **Next useful strategy experiment:** keep plural quantity as a separate focused issue rather than making coordination wording increasingly restrictive.
- **Do not infer:** the existence of a general prompting paper, an official harness pattern, or one successful sample is not evidence that a strategy improves this product.

## Sources

### DeepSeek

- [Official 0813 model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813)
- [Official V4 technical report](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/DeepSeek_V4.pdf)
- [DeepSeek API models and capabilities](https://api-docs.deepseek.com/quick_start/pricing/)
- [Official V4 message and tool encoding](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813/blob/main/encoding/README.md)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [DeepSeek Harness system-prompt design](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md)
- [DeepSeek Harness prompt ownership and micro-examples](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/tool-bash/src/index.ts)
- [DeepSeek Harness removal of arbitrary context envelopes](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md)
- [DeepSeek Harness sibling tool-call execution](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)
- [OpenRouter model route](https://openrouter.ai/deepseek/deepseek-v4-pro-0813)

### General prompting research

- [The Prompt Report: A Systematic Survey of Prompting Techniques](https://arxiv.org/abs/2406.06608)
- [Rethinking the Role of Demonstrations](https://aclanthology.org/2022.emnlp-main.759/)
- [How Many Demonstrations Do You Need for In-context Learning?](https://aclanthology.org/2023.findings-emnlp.745/)
- [Debiasing In-Context Learning by Instructing LLMs How to Follow Demonstrations](https://aclanthology.org/2024.findings-acl.430/)
- [C-ICL: Contrastive In-context Learning for Information Extraction](https://aclanthology.org/2024.findings-emnlp.590/)
- [Large Language Models Are Human-Level Prompt Engineers](https://arxiv.org/abs/2211.01910)
- [Large Language Models as Optimizers](https://arxiv.org/abs/2309.03409)
- [DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines](https://arxiv.org/abs/2310.03714)
