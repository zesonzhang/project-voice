# M4.9 Accessibility Review

**Status: PARTIAL — automated semantics are covered; manual WCAG review is pending.**

Implemented and covered by component tests:

- Download progress exposes progressbar values and a polite live update.
- Errors use an assertive alert; lifecycle state uses a polite status.
- Removal uses a sibling `alertdialog` rather than a dialog nested inside Settings.
- The removal dialog has labelled headline/content associations and restores focus to its trigger when closed.
- The Settings body is responsive and scrollable instead of fixed-height.
- Model state is conveyed by text as well as color.

Still required before claiming WCAG 2.1 AA compliance:

- Screen-reader passes with VoiceOver and NVDA.
- Keyboard-only traversal and focus-order validation at 100% and 200% zoom.
- Measured contrast for every Material theme/state, including disabled controls and focus indicators.
- High-contrast/forced-colors verification.

No release claim should use “WCAG compliant” until those manual records are attached.
