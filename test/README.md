# Tests

A single self-contained HTML file, zero dependencies (matches the card
itself — no build chain, no npm). Loads the real `tplink-switch-card.js`
into a real browser and drives it with fake `hass` objects — same pattern
as `music-multiroom-card`'s test suite.

## Running it

Relative `<script src>` loading needs a real HTTP origin (not a bare
`file://` double-click, which some browsers/sandboxes block scripts from).
Serve the repo root with any static file server and open
`/test/tplink-switch-card.test.html`, e.g.:

```bash
python -m http.server 8000
```

Results show inline on the page (pass/fail per case + a summary), and
also log to the browser console.

## What it covers

Config normalization (`has_poe`/`font_scale`/`overview_fields`/
`port_labels` validation), `_fmtSpeed()`'s speed-string formatting, the
`_statesChanged()` dirty-check, overview rendering and language switching,
`_effectiveLabel()`'s localStorage-override-wins-over-config precedence,
HTML-escaping of a malicious port label, the PoE toggle/configure/apply
service calls, the PoE budget-limit editor's validation (including the
`max_poe_watts`-is-only-an-input-cap distinction flagged in
`CLAUDE.md`), and the editor's `_computeLabel` binding.

Deliberately NOT covered: the `_getLovelace()`/`_collectCardConfigs()`
self-config-lookup hack for inline label saving — it depends on HA's real,
undocumented internal DOM structure (`home-assistant` → `hui-root` →
`.lovelace`), which doesn't exist in this test page. `_getLovelace()`
returns `null` here the same way it would on any page without a real HA
frontend, which exercises the localStorage fallback path (see the
`_effectiveLabel` tests) — but not the storage-mode `saveConfig` path
itself. That still needs a real HA instance, per `CLAUDE.md`.

## Adding a case

Each test is `test('description', () => { ... })` (or `async` where a
service call needs awaiting) with `assertEqual`/`assertTrue`/
`assertDeepEqual` — see the existing cases for the pattern for building a
fresh card/editor instance and a fake `hass`. Add a new case whenever a
real bug is fixed, mirroring `music-multiroom-card`'s test suite.
