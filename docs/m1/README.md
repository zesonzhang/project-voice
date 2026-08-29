# Milestone 1 Provider and Prompt Foundation

M1 adds a provider-neutral request/result contract and routes each suggestion
request to exactly one provider. `inferenceMode` is persisted as `cloud` or
`local`, defaults to Cloud, and malformed or legacy values migrate to Cloud.
The Local route intentionally has no Cloud fallback.

`templates/prompts/*.jinja2` remains the only prompt source. The production
esbuild commands load those files as text and bundle them directly. The browser
renderer supports the current canonical subset only: `{{ identifier }}` and
nested `{% if identifier %}...{% else %}...{% endif %}`. It mirrors the
backend's disabled autoescaping and `trim_blocks`/`lstrip_blocks` whitespace
options; unknown template IDs, referenced variables, or Jinja constructs fail
closed.

The production build runs the parity verifier first and fails if canonical
templates, bundled IDs, or prompt IDs referenced by language configuration
diverge.

Run `npm run verify:m1-prompts` to compare every canonical prompt template
against Python Jinja across English, Japanese, and Mandarin fixtures, including
empty, persona, conversation, emotion, HTML-like, and Unicode values.

`MockLocalSuggestionProvider` is the M1 CI seam. It renders both prompts,
normalizes input/output with the existing Python cleanup rules, publishes word
partials, and supports abort. It can be replaced by the LiteRT runtime adapter
in M3. Tests verify no Cloud provider invocation or network request during
Local success, cancellation, and unavailable-model errors.
Production uses a stable Local-unavailable provider until M3 connects the real
LiteRT-LM runtime, so test suggestions cannot leak into user-facing builds.
