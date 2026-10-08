# Architecture hardening verification

This matrix traces the architecture-hardening requirements to implementation and automated
verification. It is engineering traceability for Jot; it is not FAA certification evidence.

| ID | Requirement | Implementation | Verification |
| --- | --- | --- | --- |
| H-01 | Explicit document dirty/save/conflict state machine | `src/document-session.ts` | `test/document-session.test.ts` |
| H-02 | Prevent pending-save reload race | `SidecarStore.load`, `NotebookDocumentSession.load` | sidecar dirty-load and notebook conflict tests |
| H-03 | Flush pending saves on lifecycle transitions | `main.ts`, `JotNoteView.onClose`, `SidecarStore.flush/flushAll` | sidecar flush tests; lifecycle logic reviewed by CI |
| H-04 | Save failures observable and retryable | sidecar retry callbacks; notebook shared-session retry | injected sidecar/notebook write-failure tests |
| H-05 | Transactional sidecar writes | `SidecarStore.atomicWriteText` / transactional delete | temp-write and commit-rename failure injection |
| H-06 | Transactional verified PDF overwrite | `src/pdf-transaction.ts` | `test/pdf-transaction.test.ts` |
| H-07 | One notebook model across multiple views | `src/notebook-session.ts` | shared-session, concurrent-save, conflict tests |
| H-08 | Versioned deterministic stroke rendering | stroke render profile in model/parser/renderer/export | persisted-profile determinism test |
| H-09 | Disposable PDF page observers/controllers | `src/pdf-page-binding.ts`, thin `OverlayManager` | overlay recovery/disposal tests |
| H-10 | Failure injection and concurrency verification | test suite | sidecar, notebook, PDF transaction, revision-concurrency tests |

## Additional closed findings

- single-point pen marks are included in PDF flattening,
- sparse-stroke erasing checks segment geometry,
- invalid persisted eraser tools are rejected,
- 3- and 6-digit ink colors are validated and exported consistently,
- external PDF reload establishes a new undo-history boundary,
- gesture timers and palette UI use the owning document/window,
- release assets are immutable once published,
- protected/conflicted notebook state survives idempotent multi-view attach,
- notebook ink changes are page-scoped across views and are not double-rendered locally,
- ruled/grid/dot paper uses an explicit layer below transparent ink canvases,
- single-point highlighter marks remain visible,
- notebook sessions are acquired/released and stale clean sessions are retired,
- dirty notebook conflicts receive durable sibling recovery copies,
- notebook rename notifications are serialized and path ownership is explicit,
- notebook pages virtualize canvas/input resources outside the scroll viewport,
- malformed persisted ink settings are normalized to safe values,
- notebook resource validation bounds page count and pathological page geometry,
- notebook sheets use width-derived in-flow geometry so paper/canvas/Pencil targets cannot collapse with CSS aspect-ratio failures.

## Notebook stabilization verification

| ID | Requirement | Implementation | Verification |
| --- | --- | --- | --- |
| N-01 | Protected/conflicted second-view attach preserves state | `NotebookDocumentSession.load` | `test/notebook-session.test.ts` |
| N-02 | Local ink is not double-rendered; other views repaint only the changed page | keyed/source-aware notebook notifications | notebook session notification tests + surface tests |
| N-03 | Paper guides render independently of ink canvases | explicit `.jot-note-paper` layer | `test/jot-note-surface.test.ts` |
| N-04 | Single-point highlighter marks remain visible | `drawHighlighterPolyline` | `test/stroke-render.test.ts` |
| N-05 | Clean sessions retire; dirty zero-view sessions survive for persistence | `NotebookSessionManager.acquire/release/dropIfUnused` | `test/notebook-session.test.ts` |
| N-06 | Notebook canvas/input resources are viewport-scoped and disposable | `JotNoteSurface` virtualization | `test/jot-note-surface.test.ts` |
| N-07 | Malformed persisted tool settings cannot disable ink | `normalizeJotSettings` | `test/settings-normalization.test.ts` |
| N-08 | Notebook tool buttons share radial-palette memory/state | `Palette.selectTool` + tool-state subscription | `test/palette-tool-selection.test.ts` |
| N-09 | Reader resource bounds match writer behavior | notebook parser + Add page cap | `test/jot-note-file.test.ts` |
| N-10 | Rename path ownership is explicit and stale destination sessions are displaced read-only | serialized rename flow + `NotebookSessionManager.displace` | `test/notebook-session.test.ts` |
| N-11 | Conflicted local ink is durable across app termination | sibling recovery notebook | conflict tests + release/manual iPad verification |
| N-12 | Notebook page geometry cannot collapse on iPad WebKit | width-derived in-flow page spacer; no aspect-ratio dependency | `test/jot-note-surface.test.ts` + manual iPad verification |

## Hybrid PDF + Jot page verification

| ID | Requirement | Implementation | Verification |
| --- | --- | --- | --- |
| P-01 | Source PDF remains unchanged while handwritten pages are added | sidecar v3 layout + `PdfInsertedPageStore` | sidecar/store tests + manual iPad verification |
| P-02 | Existing v1/v2 PDF annotation sidecars remain readable | `parseJotText`, `isSupportedVersion` | `test/jot-file.test.ts`, `test/sidecar-compatibility.test.ts` |
| P-03 | Blank inserted pages persist before ink exists | sidecar v3 `insertedPages` | `test/sidecar-store.test.ts`, `test/jot-file.test.ts` |
| P-04 | Inserted-page ink uses stable document keys | `insertedPageKey` / `jot:<id>` | `test/jot-file.test.ts`, `test/stroke-store.test.ts` |
| P-05 | Hybrid pages render between PDF.js pages without impersonating source pages | `OverlayManager` gap containers + `PdfInsertedPageBinding` | `test/overlay-zoom-recovery.test.ts` |
| P-06 | Hybrid pages reuse notebook Pencil/paper renderer and offscreen virtualization | `PdfInsertedPageBinding` + `JotNoteSurface` | overlay/surface tests + manual iPad verification |
| P-07 | PDF rename rekeys both layout and hybrid ink bindings | inserted-page store rekey + binding recreation | `test/pdf-inserted-page-store.test.ts`, `test/overlay-zoom-recovery.test.ts` |
| P-08 | Removed/stale inserted-page ink cannot create an invalid sidecar | payload whitelist against live inserted IDs | `test/jot-file.test.ts` |
| P-09 | Paper-style changes persist transactionally | inserted-page store + SidecarStore dirty/save path | sidecar tests + manual iPad verification |
| P-10 | Flatten/export preserves inserted page order, aspect ratio, paper and ink | `MergeService`, `drawPaperOnPdfPage` | PDF transaction tests + release/manual export verification |
| P-11 | Overwrite removes sidecar/layout only after output PDF verifies | existing `PdfTransactionWriter` + SidecarStore discard | `test/pdf-transaction.test.ts` + manual overwrite verification |
| P-12 | Paper export work is bounded for pathological persisted dimensions | bounded guide density | build/test gate + code review |
| P-13 | PDF.js zoom/rebuild mutations never run hybrid layout reconciliation synchronously | source-page sync in mutation callback; 300 ms debounced hybrid repair only when hybrid pages exist | `test/overlay-zoom-recovery.test.ts` |
| P-14 | Hybrid handwritten pages never reallocate canvas backing stores during PDF zoom | fixed logical backing store + CSS-only scaling + no per-page ResizeObserver | `test/jot-note-surface.test.ts` |
| P-15 | Long PDFs do not allocate annotation backing stores for every source page | viewport-scoped `PdfPageBinding` canvases | 53-page virtualization regression in `test/overlay-zoom-recovery.test.ts` |
| P-16 | Detached PDF overlay canvases release WebKit backing stores before replacement | explicit 1x1 release before remove/drop | delayed-recovery regression in `test/overlay-zoom-recovery.test.ts` |
| P-17 | PDF.js layer rebuilds cannot cause synchronous overlay recreation storms | 150 ms quiet-period recovery with timer reset on continued churn | mutation-burst regression in `test/overlay-zoom-recovery.test.ts` |
| P-18 | PDF descendant churn does not cause whole-document source-page rescans | container observer reacts only to source `.page` topology changes | hybrid/ordinary zoom isolation regressions |
| P-19 | PDF zoom virtualization never removes the Pencil/palette hit target | one connected dormant live canvas per source page with 1x1 backing store | 53-page input-surface regression in `test/overlay-zoom-recovery.test.ts` |
| P-20 | A dormant PDF page becomes writable before its Pencil event reaches the normal handler | capture-phase input promotion | Pencil-down promotion regression in `test/overlay-zoom-recovery.test.ts` |
| P-21 | Transient IntersectionObserver false events during zoom do not immediately discard active rendering | 750 ms deactivation grace, cancelled by re-entry or active pointer | zoom-out hysteresis regression in `test/overlay-zoom-recovery.test.ts` |

## Persistent diagnostics verification

| ID | Requirement | Implementation | Verification |
| --- | --- | --- | --- |
| D-01 | Recording enablement survives an unclean process restart | persisted diagnostic state + auto-resume | `test/persistent-diagnostics.test.ts` |
| D-02 | A killed session remains identifiable after restart | clean/unclean session sentinel + `lastCrashSession` | `test/persistent-diagnostics.test.ts` |
| D-03 | Trace data survives without rewriting a growing file | append-only JSONL batched writes | recorder tests + code review |
| D-04 | Export after a crash selects the preserved crashed session | crash-priority export selection | `test/persistent-diagnostics.test.ts` |
| D-05 | Clearing traces does not silently disable active recording | clear-and-resume session rotation | `test/persistent-diagnostics.test.ts` |
| D-06 | PDF traces capture native and Jot canvas dimensions | `PdfPageBinding` diagnostics | zoom tests + manual iPad reproduction |
| D-07 | Disabled diagnostics do not enumerate hybrid layout or perform diagnostic-only PDF DOM scans | `DiagnosticSink.isEnabled` hot-path gates | `test/overlay-zoom-recovery.test.ts` + code review |
| D-08 | Traces remain local unless explicitly exported | plugin diagnostic storage + explicit copy to vault folder | recorder tests + manual verification |

## iPad.8 hardening verification

| ID | Safety invariant | Regression |
| --- | --- | --- |
| H8-01 | A failed PDF sidecar read blocks all writes until a safe reload | `test/sidecar-store.test.ts` |
| H8-02 | Protected PDF sidecars cannot accept new Pencil strokes | `test/pointer-event-handler.test.ts` |
| H8-03 | Dormant PDF input hitboxes discard stale inline dimensions | `test/overlay-zoom-recovery.test.ts` |
| H8-04 | Removing a live PDF canvas mid-pointer does not strand heavy buffers | `test/overlay-zoom-recovery.test.ts` |
| H8-05 | Hybrid and notebook Pencil hit targets survive zoom/observer false events | `test/jot-note-surface.test.ts` |
| H8-06 | Standalone notebook input disposer is returned to its surface | `src/jot-note-view.ts` ownership review |
| H8-07 | Concurrent merges on the same PDF are rejected | `test/merge-concurrency.test.ts` |
| H8-08 | Failed dirty-notebook recovery cannot lead to session displacement | `src/main.ts` guard and failure review |
| H8-09 | Huge/corrupt ink data fails safely before unbounded allocation | `test/ink-resource-budget.test.ts` |
| H8-10 | Delayed PDF observer attachment is cancelled on file transitions/unload | `src/main.ts` generation guard review |
| H8-11 | Duplicate own-save notifications are ignored, external changed bytes are not | `test/sidecar-store.test.ts` |
| H8-12 | Normal unawaited unload intent is not classified as a crash | `test/persistent-diagnostics.test.ts` |
| H8-13 | Failed notebook canvas context creation can retry input attachment | `src/jot-note-surface.ts` recovery review |

The automated checks do not replace real iPad acceptance testing of Pencil, zoom,
scroll, background/foreground, sidecar sync, PDF merge, and app restart.

## DER-01 through DER-10 corrective review (iPad.9 candidate)

| ID | Corrective control | Verification |
| --- | --- | --- |
| DER-01 | PDF rename moves dirty save/retry to destination and never flushes after stroke rekey | injected failed-write then rename/recovery in `test/sidecar-store.test.ts` |
| DER-02 | Central document mutation gate controls Pencil, inserted-page edits, clear and undo/redo | `test/undo-write-protection.test.ts`; source review of `src/main.ts` command callbacks |
| DER-03 | Previously persisted notebook recovery copy is reusable if revision/path remain valid | `test/notebook-recovery-cache.test.ts` |
| DER-04 | Oversized runtime ink never replaces last-good bytes or schedules endless retries | `test/sidecar-store.test.ts`, `test/notebook-session.test.ts` |
| DER-05 | Dormant Pencil activation sizes backing stores synchronously before target dispatch | `test/jot-note-surface.test.ts` with delayed animation frame |
| DER-06 | Pointer pinning is matched by pointerId, not unrelated late capture events | `test/jot-note-surface.test.ts`, `test/overlay-zoom-recovery.test.ts` |
| DER-07 | Duplicate sidecar modification reads queue and reconcile final disk state | `test/sidecar-store.test.ts` deferred-read failure injection |
| DER-08 | Offscreen notebook/PDF pages retain tiny hit targets, not hundreds of active contexts/handlers | 120-page lazy-context and 53-page PDF tests |
| DER-09 | Context allocation failures use capped exponential backoff; later input can retry | `test/jot-note-surface.test.ts` sustained-failure test |
| DER-10 | Async sidecar watcher callbacks recheck plugin unload after awaited work | `src/main.ts` lifecycle state code review |

A green Node matrix does not prove WKWebView behavior. Independent iPad acceptance
is required: zoom/Pencil/gesture input, 53-page memory usage, protected-read recovery,
rename during failed save, background/restart, hybrid insertion, and PDF merge.

## Required release gate

A candidate is releasable only when the exact versioned commit passes:

- TypeScript production build,
- complete Vitest suite,
- ESLint,
- Node 20, 22, and 24 CI matrix,
- release workflow rebuild from the exact release SHA.
