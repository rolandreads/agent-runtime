# Eval process notes (portfolio)

Harness implementation is omitted from this showcase. Retained principles:

- Prefer plan → inspect → human review over one-off scripts.
- Keep LLM regressions short and natural; review actual replies rather than brittle phrase matchers.
- Production runtime must not import eval tooling.
- Prefer model cards and judgment protocols as durable artifacts over large generated runner code.
