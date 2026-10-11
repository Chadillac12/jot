# PDF pinch-zoom / Apple Pencil investigation — before implementation

Date: 2026-10-11. Baseline: `163c9c6` (`1.1.4-ipad.15`).
Branch: `codex/ipad-zoom-investigation`. Production source remains unchanged at the time of this report. Only a new regression test has been added.

## Finding and confidence

There is a reproducible input-delivery hole in `.15`: a Pencil event seen at document capture is discarded by Jot's router if its target belongs to a registered source PDF page, or to any inserted Jot page. Jot assumes that page/sheet/canvas listeners will subsequently receive the event. If viewer capture stops propagation, they do not. The stroke never starts, so canvas recovery, resizing and persistence retries cannot repair it.

This is **confirmed in an automated integration reproduction**, using the real `OverlayManager`, `PdfInsertedPageBinding`, `JotNoteSurface`, `PointerEventHandler` and `StrokeStore`. It matches the diagnostic boundary (document contact without page-input or ink-decision events). **The exact upstream Obsidian/WKWebView behavior causing that boundary on the physical iPad is not proven**: the logs lack event paths, listener registration/removal and propagation flags. An injected viewer capture listener is a controlled reproduction, not an assertion that the recordings contain that listener.

There is also confirmed historical inserted-page render teardown following intersection exits, plus historical double application of zoom to CSS dimensions. `.14` and `.15` respectively address those mechanisms. They do not close the input-delivery hole.

## Last known working implementation

No supplied evidence establishes a release that reliably supports inserted-page handwriting **after** pinch-zoom. The user also reports that the last working release is unknown. `.3` must not be labeled a known-good hardware baseline.

The last directly recorded working interval is `.13`, recording `z4ytw2`, seq 5–154: 22 accepted Pencil downs, 21 stroke commits, 21 connected render targets, with subsequent sidecar saves. These are inserted-page strokes before the relevant intersection exits. The remaining contact opens the palette; absence of its stroke commit is not evidence of loss.

The full reachable Git log contains 1,160 commits, is not shallow, and includes multiple historical development lineages. The older design at `f9aae36` routes Pencil events from container capture; `1e5f984` deduplicates capture and target events; `bceb832` tests stopped propagation. **`f9aae36` is not an ancestor of the current checkout.** This is a useful historical design/test reference, not a bisected good predecessor or hardware proof. Current-lineage `f3f8de5`/`c0a335c` introduce canvas-local disposable PDF bindings before the requested `.3`–`.15` window.

## Architecture examined

Read `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, and `docs/HARDENING_VERIFICATION.md`; no glossary or additional ADR files were found. Inspected the complete reachable commit log and relevant evolution of page binding, routing, rendering and persistence, including changes predating `.3`. Exported the complete hash/parent/date/subject log to `C:/ws_c/jot-diagnostics/analysis/complete-git-history.txt`.

`JotPlugin` owns shared document sessions, strokes, undo, sidecar persistence and `OverlayManager`. Source pages have disposable `PdfPageBinding`s. Inserted pages have stable `jot:<id>` keys and a `PdfInsertedPageBinding` that embeds the notebook `JotNoteSurface`. Input commits normalized points to the shared store, draws the new stroke on the persistent layer, then schedules a transactional sidecar save. Rendering canvases are projections of that store, never storage authority.

Source pages use intersection activation, 750 ms deactivation hysteresis, page capture, quiet-period canvas recovery and capped context retries. Inserted pages use fixed backing stores, sheet capture, reference-page width observation and (since `.14`) eager allocation/retention. A document router added in `.13` only forwards contacts treated as outside the normal source-page path; inserted pages are explicitly excluded.

## Release comparison

Each row describes changes from the preceding release; tags and source changes were compared directly. Titles alone were not treated as validation.

| Release / SHA | Relevant implementation | Consequence / evidence |
| --- | --- | --- |
| `.3` / `07e2aff` | `ed99aa1`, `eda42ef`: defer hybrid reconciliation 300 ms, bypass it for ordinary PDFs | Reduces synchronous layout work. Source canvases still repair eagerly; hybrid pages depend on intersection mounting. No recording supplied. |
| `.4` / `d2433fe` | `6cea15d`, `aa2123c`: fixed logical hybrid backing stores; remove sheet resize observation in this mode | CSS zoom no longer reallocates hybrid backing buffers every frame. Does not change event ownership. No recording supplied. |
| `.5` / `8c8b133` | Persistent diagnostic recorder and instrumentation | Trace confirms 2,110 overlay creations in 9.456 s across 53 source pages. Hybrid buffer sizing occurs only twice; source-page recovery churn is the dominant observed allocation activity. |
| `.6` / `f77926a` | `91f6582`, `0adc9c3`: viewport-scoped source buffers, 150 ms delayed recovery, topology-only document scans | Source input canvases now disappear on deactivation; a new input-availability dependency on intersection state. Trace shows 5 hybrid mount/unmount cycles and 52 source creations/releases. Hybrid virtualization predates `.6`. |
| `.7` / `ee19abc` | `f501b8e`: source dormant 1×1 live targets, parent activation, 750 ms grace | Restores a lightweight source contact target. Does not address upstream propagation interception; no recording supplied. |
| `.8` / `8519e6c` | `17efe9f`: equivalent hybrid/notebook dormant targets and hysteresis; context recovery. Sidecar protection and lifecycle guards | Hybrid render layer still disappears after a sustained exit; `.13` later records this inherited behavior. Storage guards are intentional protection, not evidence of this regression. |
| `.9` / `a013eff` | `6a5f095`, `3d88505`, `0637065`: lazy handlers, pointer-ID pinning, immediate first-contact sizing, sheet/page capture, bounded backoff | Handler restoration now depends on capture reaching page/sheet. Trace records 1,021 recovery firings and 1,190 source overlay creations, including offscreen recovery activity. No input instrumentation yet. |
| `.10` / `22a122d` | `a27bfd0`, `4244888`, `8212a02`: page/sheet fallback for detached live canvases; real-event forwarding; reduced offscreen repair | Production `main.ts` drops `registerForwarder` through `(canvas) => this.wirePointerEvents(canvas)`. The fallback adapter cannot work despite component-level tests. Exact integration defect introduced by this release's forwarding contract and fixed in `.11`. No recording supplied. |
| `.11` / `663ed43` | `5e963a4`, `713997c`, `c31ec74`: preserve production forwarding channel; transient context retries | Recording has 5 accepted source-page downs, but lacks up/commit instrumentation. Inserted surfaces render twice, receive exit intersections and never mount during the capture. Cannot infer successful writing from accepted down alone. |
| `.12` / `fb0776c` | Pointer up/cancel/commit, render-target and sidecar-save diagnostics; suppress offscreen resize noise | Improves observability rather than closing delivery gaps. No recording supplied. |
| `.13` / `fcbe1cf` | `3f57b9c`: source overlay uses untransformed layout size. `b72ea40`: document capture fallback | Adds the decisive `normallyRouted` early return and explicit inserted-page exclusion. Registered-page and inserted-page events still rely on lower listeners. Recording confirms successful pre-exit inserted writing followed by document-only contacts. |
| `.14` / `b4c7b49` | `118fc4f`, `4a84680`: retain/eagerly mount hybrid ink across exit intersections and leaf reconstruction | Addresses hybrid observer teardown, at a cost of retaining all inserted-page buffers. Only a 3-event, 1.636 s trace supplied; no Pencil evidence. |
| `.15` / `163c9c6` | `4108a60`: inserted root follows untransformed reference width | Addresses double-scaled hybrid CSS width; preserves fixed buffers. Router is unchanged. No `.15` recording supplied; new integration tests expose remaining failure. |

No changes to normalized sampling (`ink-sampling.ts`), shared canvas geometry reader (`canvas-surface.ts`) or stroke renderer (`stroke-render.ts`) occur between `.3` and `.15`. Source backing-store rounding and hybrid aspect/border differences can affect pixel alignment slightly, but do not explain missing handler entry. Historical screen-width-as-layout-width exists from inserted-page introduction `e0021a1`; `.15` fixes that long-standing issue, rather than proving `.14` introduced it.

## Complete recording analysis

Read and parsed every line in all six original files: **32,129 records**, no JSON parse failures. A reproducible analyzer, SHA-256 hashes, complete event-frequency counts, selected lifecycle timelines and sequence audits are in `C:/ws_c/jot-diagnostics/analysis/analyze_recordings.py` and `recording-analysis.json`. Original recordings were not edited. The `.6` trace begins with sequence discontinuities `(2, 1)` and `(1, 3)`; this is recorded rather than silently normalized. An abrupt ending is not, by itself, proof of a crash or its cause.

| Recording suffix | Version | Records | Duration | Evidence and limits |
| --- | --- | ---: | ---: | --- |
| `9nz9gy` | `.5` | 5,628 | 9.456 s | Auto-resume plus previous-unclean marker; 53 source bindings, 2,110 overlay creations, 1,993 page mutations, 353 full source syncs. Strong churn evidence; no process memory/OOM measurement. |
| `x3jk8f` | `.6` | 3,883 | 85.739 s | 2,703 source resize observations, 545 document mutations, 102 reference width syncs; hybrid mounts and unmounts 5 times. Final viewport resize is 1173×486. No Pencil lifecycle events available in that version. |
| `528wyt-2` | `.9` | 12,133 | 556.656 s | 106 binding creations/disposals, 4 hybrid creations/disposals across leaf lifetimes; 1,021 recovery firings and 1,095 dormant transitions. Input outcomes cannot be reconstructed because that instrumentation did not exist yet. |
| `tmynmx` | `.11` | 3,012 | 42.800 s | 5 accepted source downs; no finish/commit diagnostics in this release. 2 hybrid renders, 2 exit observations, 0 hybrid mounts. Not proof that accepted strokes committed. |
| `z4ytw2` | `.13` | 7,470 | 456.890 s | 22 accepted hybrid downs; 21 ups and commits; 21 connected render targets; 8 successful sidecar saves. All 47 later document Pencil downs lack subsequent ink-decision entry. No rejected/cancelled ink, context errors or sidecar-save errors appear. |
| `gos7qv` | `.14` | 3 | 1.636 s | Session start, one touch down, one topology-neutral mutation. Too short to validate a repair or identify a failure. |

### `.13` transition, by sequence number

- Seq 5–154: accepted input and committed inserted-page ink; last commit at 24,472 ms, target 1369×1826 and connected.
- Seq 158: save completed with a newer revision still dirty; seq 203 at 25,400 ms completes clean. This is expected revision-aware persistence, not a failed save.
- Seq 265–266 at 25,637 ms: both inserted sheets get exit intersections.
- Seq 472/474 at 26,388 ms: both render surfaces unmount (751 ms later); their full buffers are released and lightweight live targets remain.
- Seq 481 onward: 47 document Pencil contacts, 46 within registered source pages and one unmatched viewer DIV. There are **zero** `pdf.input-pointerdown`, `ink.input-decision` or commits during this later interval. These recorded target matches are source pages, so the trace does not establish that the user was still contacting the inserted sheet.
- Seq 4352 at 66,528 ms: leaf disposed; seq 4578–4581 recreate both hybrid bindings; seq 4600–4601 only exit observations, with no hybrid mount. A later several-minute gap provides no event coverage of activity in between.

## Confirmed defects versus hypotheses

**Confirmed code defects / trace facts**

1. `.15` drops source and inserted strokes when capture downstream of document prevents target delivery. Both new tests reproduce one stored stroke instead of two; undo/save also fail to receive the second commit. The document recovery path in `b72ea40` never covers those normal DOM targets. Canvas-local dependence predates `.3`; no evidence supports naming a single newly bad release in `.3`–`.15` for this condition.
2. `.10` lost the forwarder registration at the production call site; `.11` corrected it. This can be attributed to an exact contract/caller mismatch.
3. Hybrid observer teardown is directly recorded in `.6` and `.13`; lazy mount dates to `8611f0b`, before `.3`; `.8` delays rather than eliminates unmount. `.14` addresses this behavior, but its trace does not validate hardware success.
4. Source/hybrid screen-size-to-layout-size reuse double-applies an ancestor transform. Source path corrected in `.13`; hybrid root corrected in `.15`. It is independent of the no-handler-entry failure.
5. Source eager recovery/allocation storms exist in `.5`; `.6` reduces them, `.7` reintroduces persistent offscreen targets, and `.9` exhibits repeated dormant recovery. `.10` suppresses offscreen canvas reconstruction. These are performance/lifecycle findings, not proof of the exact crash mechanism.

**Unproven explanations**

- A particular Obsidian PDF.js gesture listener stops propagation after zoom: strongly consistent with the boundary and the older stopped-propagation test, but requires physical-device inspection to identify the actor.
- WebKit hit testing, page overflow or stale transform maps cause the user to hit a source page instead of the inserted sheet: plausible, not established by target tags alone.
- iPad canvas context exhaustion, GPU resource loss or OOM: plausible historical risk; no relevant context-error/OOM evidence in the failure interval.
- A storage guard or open palette blocks ink: not supported. No rejection events appear; palette closes before the failure interval and sidecar saves complete cleanly.

## Regression signal, before implementation

Command: `npx vitest run test/pdf-pencil-routing-regression.test.ts --reporter=verbose`.

Result on unchanged `.15` production source: **2 passed, 2 failed**. Normal propagation commits once on each page type. Under a viewer capture stop after the first stroke, each page stores only one stroke instead of two. Duration: 1.28 s. This is deterministic, unattended and asserts stored strokes through the actual ink pipeline, not just a mocked forwarding call. Baseline full suite: **37 files / 332 tests passed**.

The controlled stop is needed to reproduce the diagnostic input-delivery boundary; removing it makes the test pass. It is not a literal replay of every hardware event. Recordings intentionally omit coordinates/move events and therefore cannot be replayed as a faithful Pencil gesture stream.

## Smallest supported correction to implement

Use the existing document capture path to deliver the real Pencil event for registered source pages and inserted **sheets** as well as existing outside-page recovery. Keep one owning page and pointer ID through move/up/cancel. Reuse page/sheet activation and the shared ink state machine. Deduplicate the same real event across document, page/sheet and target listeners. Preserve controls, touch gestures, write protection and disposal. Do not introduce new timers, observers, allocation recovery loops, synthetic input events or persistence migrations.

## Lifecycle / recovery review

The `.14` retention workaround keeps two bounded backing buffers for every inserted page for the leaf lifetime (roughly 40 MB RGBA for the two observed inserted pages: four 1369×1826 buffers), removing render virtualization. It does not guarantee event delivery. Removing it now would broaden the change and risk reintroducing a separately recorded problem; retain it pending iPad validation and a focused follow-up. (Memory arithmetic corrected during final verification; this is an estimate, not a measured process allocation.)

Page-local 150 ms quiet recovery, 750 ms deactivation, context backoff, document 300 ms topology repair and first-contact promotion are overlapping state transitions. Route events through their existing owners; do not create another recovery state machine. In particular, page activation must precede stroke begin, and duplicate delivery must not restart or truncate that stroke. Continuations must follow pointer ownership rather than infer delivery from the target's ancestry. Dispose the route when its leaf closes; reject late continuation into a disposed surface.

`JotNoteSurface.mountPage` also trusts a non-null persistent reference without checking its sheet membership. Simultaneous external removal of both canvases could leave a stale persistent buffer. This is a separate inspection finding, not demonstrated in these recordings; do not fold speculative canvas rebuilding into this input-routing correction.

Automated happy-dom tests cannot establish WKWebView gesture arbitration, GPU memory behavior or physical Pencil success. Final verification must state that limit explicitly; a new release is not authorized by passing these tests.

Event propagation reasoning follows the primary [DOM dispatch specification](https://dom.spec.whatwg.org/#concept-event-dispatch); capture on an ancestor can prevent downstream listener invocation. [Pointer Events](https://w3c.github.io/pointerevents/) defines pointer identity/capture and cancellation. These sources support the event model, not a claim about Obsidian's private implementation.
