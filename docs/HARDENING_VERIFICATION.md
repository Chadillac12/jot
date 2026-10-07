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

## Required release gate

A candidate is releasable only when the exact versioned commit passes:

- TypeScript production build,
- complete Vitest suite,
- ESLint,
- Node 20, 22, and 24 CI matrix,
- release workflow rebuild from the exact release SHA.
