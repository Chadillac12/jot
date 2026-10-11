# PDF pinch-zoom / Pencil correction — separate verification report

Date: 2026-10-11. Baseline `163c9c6` (`1.1.4-ipad.15`); corrected working tree on `codex/ipad-zoom-investigation`.

## Verdict and independence

The correction closes the demonstrated event-delivery gap on source PDF pages and PDF-inserted Jot sheets. A separate real-browser WebKit experiment reproduces the failure against unchanged release source and verifies new stored ink **and actual painted canvas pixels** after the correction. Earlier strokes, normalized coordinates and bounded backing-store sizes survive.

Verification is independent of happy-dom's event/layout/canvas mocks: it uses a separately bundled browser harness, the actual production modules, the repository CSS, real WebKit layout/canvas rendering, and externally asserted stroke/pixel outcomes. **The same assistant authored implementation and verification; this is not a second-person code-review sign-off.** Desktop Playwright WebKit 26.4 on Windows is not the user's iPad WKWebView. Synthetic Pencil events with injected propagation blocking do not prove the physical device's private gesture behavior. Physical iPad acceptance remains outstanding.

The root-cause report was delivered before production edits. Its only later correction is the explicit memory-estimate arithmetic erratum (approximately 40 MB for four observed hybrid buffers).

## Correction reviewed

- `OverlayManager`: use the existing document capture listener for Pencil contacts on registered source pages and inserted ink sheets. Keep the owning binding/pointer ID through continuation regardless of subsequent target ancestry. Preserve toolbar/control and touch paths.
- `PdfPageBinding` and `JotNoteSurface`: reuse their activation/sizing and forwarding paths; suppress duplicate lifecycle handling when the same event reaches lower listeners.
- `PdfInsertedPageBinding`: expose a small delegate to its existing notebook surface.
- `PointerEventHandler`: direct and forwarded delivery share an event-identity guard. A gesture therefore commits and schedules undo/save once, even when normal event propagation continues.

No new timers, observers, periodic repair, synthetic production events, persistence migrations or settings are introduced. All event identity sets are weak; they do not retain historical Pencil events. Existing `.14` hybrid retention and `.15` layout-width behavior remain in place, keeping this correction separate from the observer and geometry mechanisms.

One existing test assumed that a native canvas target should never use document forwarding; its assertion now checks exactly one forward. Another test reused one synthetic `PointerEvent` object for several different gestures; it now creates a new event per gesture, matching real browser input identity. The new integration tests verify actual stored strokes, not those implementation assumptions.

## Historical differential verification

Exported source files for **every tag `.3` through `.15`** into isolated diagnostic directories without checking out or changing any branch. Ran the same four behavioral probes in each: normal propagation and capture-blocked post-zoom delivery, for source and inserted pages.

| Release | Normal source + inserted | Capture-blocked source + inserted |
| --- | --- | --- |
| `.3` | 2 pass | 2 fail: second stroke absent |
| `.4` | 2 pass | 2 fail: second stroke absent |
| `.5` | 2 pass | 2 fail: second stroke absent |
| `.6` | 2 pass | 2 fail: second stroke absent |
| `.7` | 2 pass | 2 fail: second stroke absent |
| `.8` | 2 pass | 2 fail: second stroke absent |
| `.9` | 2 pass | 2 fail: second stroke absent |
| `.10` | 2 pass | 2 fail: second stroke absent |
| `.11` | 2 pass | 2 fail: second stroke absent |
| `.12` | 2 pass | 2 fail: second stroke absent |
| `.13` | 2 pass | 2 fail: second stroke absent |
| `.14` | 2 pass | 2 fail: second stroke absent |
| `.15` | 2 pass | 2 fail: second stroke absent |
| corrected tree | 2 pass | 2 pass |

The first probe attempt counted missing telemetry in early releases as failures. It was corrected to omit only `onInputDecision` assertions in the historical copy, since that callback first exists in `.10`. Stored strokes, undo and save assertions remain identical. The complete corrected matrix was rerun and saved. No release source was edited. This strengthens the conclusion that this routing condition **predates the requested release window**; it does not establish that each release fails every ordinary hardware pinch gesture.

Reproduce: `python C:/ws_c/jot-diagnostics/analysis/verify_historical_routing.py`.
Raw results: `C:/ws_c/jot-diagnostics/analysis/historical-routing/results.json`, with each release's structured Vitest output in its own directory.

## Separate real WebKit verification

Used Playwright WebKit 26.4 (`webkit-2272`) with a 1200×1600 viewport and DPR 2. Bundled original `.15` source and corrected source separately. No page/canvas layout or context mocks. Each case:

1. Create a PDF-like viewer and real source/inserted bindings with repository CSS.
2. Draw a first Pencil stroke through dispatched PointerEvents and the real ink handler.
3. Apply `scale(1.5)` to the shared viewer, with or without viewer capture blocking subsequent pointerdown/move/up.
4. Draw at another normalized location, inspect shared strokes/undo/save, read canvas RGBA pixels, and compare the first stroke and backing sizes.

| Source under test | Page | Block delivery after zoom | Stored strokes | Painted nontransparent pixels before → after |
| --- | --- | --- | ---: | ---: |
| original `.15` | PDF | no | 2 | 1,698 → 3,393 |
| original `.15` | PDF | yes | **1** | **1,698 → 1,698** |
| original `.15` | inserted Jot | no | 2 | 1,765 → 3,537 |
| original `.15` | inserted Jot | yes | **1** | **1,765 → 1,765** |
| corrected | PDF | no | 2 | 1,698 → 3,393 |
| corrected | PDF | yes | **2** | **1,698 → 3,393** |
| corrected | inserted Jot | no | 2 | 1,765 → 3,537 |
| corrected | inserted Jot | yes | **2** | **1,765 → 3,537** |

All eight comparison assertions pass (baseline failure is the expected control). In every corrected case: two accepted downs, two commits, two save schedules, two undo entries; original stroke unchanged; final point `(0.7, 0.7)`; inserted ink never appears in the source-page key. Source buffers remain 1414×1768 and hybrid buffers remain 1369×1826 before/after CSS zoom. The test therefore validates both model and rendering, not merely acceptance of pointerdown.

Reproduce in PowerShell:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='C:\ws_c\jot-diagnostics\analysis\browser-runtime'
node C:\ws_c\jot-diagnostics\analysis\verify_browser_routing.mjs
```

The local browser runtime was installed only under the diagnostic analysis directory. Results: `C:/ws_c/jot-diagnostics/analysis/browser-verification.json`.

## Automated regression and release-gate checks

Node 22.19.0 / npm 11.12.1.

| Check | Result |
| --- | --- |
| Before-edit full baseline suite | 37 files, 332 tests pass |
| Before-edit new four-test reproduction | 2 pass, 2 fail; each blocked second stroke absent |
| Final full suite | **38 files, 348 tests pass** |
| New integration suite | **16 pass** across source and inserted pages |
| `npm run build` | pass: TypeScript including tests, production esbuild bundle |
| `npm run lint` | pass, 0 errors; 19 pre-existing warnings in three unchanged test files |
| `git diff --check` | pass |
| Original recordings SHA-256 recheck | all six match their initial analysis hashes |

The sixteen integration tests cover exactly-once normal routing, viewer capture blocking after a first stroke, retargeted continuation outside the sheet, cancellation preserving earlier ink, next-gesture recovery, immediate live-canvas replacement before observers/frames, normalized coordinates after zoom, blocked mutation preserving prior strokes/save/undo counts, leaf disposal, controls and finger input.

The full suite includes sidecar v1/v2/v3 compatibility, stable inserted IDs, guarded writes, rename/conflict/transaction recovery, saved rendering profiles, PDF merge and notebook tests. Persistence and schema implementation files are unchanged. No user annotation sidecar or PDF was opened for writing. Failure-injection tests intentionally emit save/merge error messages while passing.

Final structured suite results: `C:/ws_c/jot-diagnostics/analysis/final-vitest.json`.

## Architecture review and remaining limits

- Document capture now owns delivery for PDF Pencil gestures. Page/sheet owners continue to own allocation and teardown. Exactly-once event processing avoids stroke restarts, duplicate saves and repeated lifecycle activation.
- Continuations follow the pointer owner, avoiding the earlier inference that a descendant target guarantees the page listener ran. Leaf teardown clears the route; tests verify late up cannot commit after disposal.
- Retain existing 150/750/300 ms timing and bounded context retries rather than adding another overlapping recovery loop. Source offscreen/mutation tests continue to pass.
- Hybrid retention consumes up to about 20 MB RGBA per inserted page at the observed two 2.5-million-pixel buffers. Two pages are about 40 MB before compositor/PDF allocations. This is an estimate. Removing retention requires separate iPad memory/lifecycle evidence; this patch does not remove it.
- A separately identified stale persistent-canvas reference in `JotNoteSurface` remains outside the demonstrated routing fix. The recordings do not establish simultaneous external removal of both hybrid canvases. It should be tested separately if that failure is observed.
- No physical iPad test, trusted Pencil/coalesced-event replay, GPU-pressure test, sync on the user's vault, or Node 20/24 CI matrix was performed. The supplied recordings omit sample coordinates and moves, so a faithful hardware-event replay is impossible from those files alone.

Physical acceptance should use a copy of the original 53-page PDF and sidecar, preserve existing inserted-page ink, write before and after repeated zoom in/out on source and inserted pages, verify palette/scroll/cancel behavior, then background/restart Obsidian and verify retained ink. A fresh diagnostic trace should show handler entry and commit after zoom. If the physical failure persists, its recorded event path must be investigated without treating this controlled reproduction as proof of the upstream actor.

At the conclusion of the investigation, no branch `main` change, push, merge, release tag or publication had been performed. HEAD was `163c9c6`; changes were local and uncommitted on the investigation branch, with versions still `1.1.4-ipad.15`.

## Subsequent publication authorization

The user subsequently requested publication. The correction is being prepared as BRAT prerelease `1.1.4-ipad.16` on the investigation branch, with the exact versioned commit required to pass the repository's Node 20/22/24 CI gate before creating its release branch. This authorization does not change the physical-iPad verification limits above. Branch `main` remains outside the publication scope.
