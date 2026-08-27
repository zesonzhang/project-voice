# Milestone 1 Completion Audit

**Audit date:** 2026-08-27  
**Overall status:** COMPLETE — M1's provider and prompt-foundation exit
criteria pass. The production Local provider intentionally remains unavailable
until M3 connects the LiteRT-LM runtime.

| Requirement | Status | Evidence |
|---|---|---|
| M1.1 Inference-mode schema and migration | Complete | `Config` and `State` persist only `cloud` or `local`, default missing, malformed, and legacy values to `cloud`, and retain `aiConfig` for Cloud selection. `test_config-storage.ts` and `test_state.ts` cover the behavior. |
| M1.2 Provider-neutral request and result types | Complete | `src/suggestion-provider.ts` defines provider-neutral request, final/partial result, identity, error, and provider contracts. |
| M1.3 Cloud provider extraction | Complete | `CloudSuggestionProvider` preserves the existing `MacroApiClient` payload, cancellation, and result handling. Provider tests assert the exact request mapping and abort call. |
| M1.4 Strict provider routing | Complete | `SuggestionProviderRouter` selects exactly one route and creates the Cloud provider lazily. Local failure tests assert that Cloud is not instantiated or called. |
| M1.5 Bundle canonical Jinja sources | Complete | `prompt-templates.ts` imports every canonical `.jinja2` source; production builds use esbuild's text loader. The parity verifier rejects missing, extra, or unreferenced template IDs. |
| M1.6 Restricted browser prompt renderer | Complete | `prompt-renderer.ts` supports the documented variable and nested conditional subset, mirrors the Python whitespace configuration, and rejects unknown IDs, variables, and unsupported syntax. |
| M1.7 Local normalization and parsing | Complete | `local-suggestion-provider.ts` implements Japanese spacing, the `§` workaround, asterisk cleanup, Japanese half-width-space cleanup, deduplication, limits, and numbered-list parsing. |
| M1.8 Python/browser prompt goldens | Complete | `npm run verify:m1-prompts` passed for all 10 canonical templates and 21 English, Japanese, Mandarin, Unicode, HTML-like, context, persona, and empty-value fixtures per template. |
| M1.9 Mock Local provider | Complete | `MockLocalSuggestionProvider` renders both prompts, emits word partials, supports abort, normalizes output, and is used by browser tests. Production uses `UnavailableLocalSuggestionProvider` until M3. |
| M1.10 Provider- and version-aware caching | Complete | `PvAppElement.cacheKey()` includes provider mode, model identity/version, both prompt IDs, language, input, history, memory, persona, speech context, and emotion. |
| M1.11 Local network privacy regression | Complete | Browser tests spy on `window.fetch` during Local generation, cancellation, and unavailable-model errors; all assert zero requests and zero Cloud-provider instantiations. |

## Verification record

The following checks completed successfully during this audit:

```bash
npx tsc --noEmit
npm run verify:m1-prompts
npm run test:on-device-boundary
npm run pretest
npm run test:js
npm run test:py
```

`npm run test:py` passed 25 tests. `npm run lint:js` is currently not clean,
but its seven formatting errors and one unused-variable warning are confined to
pre-existing non-M1 files: `src/input-history.ts`, `src/pv-app-css.ts`,
`src/pv-functions-bar.ts`, and `src/pv-setting-panel.ts`. They do not change
the M1 exit-criteria result and should be handled as a separate repository
hygiene task.

## M1 exit decision

Cloud behavior remains backward compatible; choosing Local stays on the Local
route without Cloud fallback; browser prompts have Python parity; and CI has a
mocked end-to-end Local routing seam. M1 is accepted. M2 may begin; M3 must
replace the intentional unavailable provider with the real runtime adapter.
