# Jot Architecture

## Design goals

Jot treats handwritten ink as user data. The architecture therefore prioritizes:

1. no silent loss of acknowledged ink,
2. one authoritative in-memory model per document,
3. deterministic rendering from persisted data,
4. explicit dirty/save/error/conflict state,
5. transactional replacement for destructive file operations,
6. disposable UI bindings with no hidden lifetime beyond their owning view/page.

## Ownership

```text
JotPlugin
├── DocumentSessionManager
│   ├── PDF DocumentSession
│   │   ├── shared PDF StrokeStore
│   │   └── SidecarStore persistence
│   └── NotebookDocumentSession
│       ├── notebook StrokeStore
│       ├── UndoHistory
│       └── serialized Vault.process persistence
├── Ink input / renderer
└── Views and surfaces
    ├── PdfPageBinding
    ├── PdfInsertedPageBinding
    └── JotNoteSurface
```

A view is never authoritative document storage. Multiple notebook views attach to the same
`NotebookDocumentSession`.

## Document state machine

`DocumentSession` owns the persistence state:

```text
unloaded -> loading -> clean
                    -> dirty -> saving -> clean
                              -> saving -> error -> saving
                    -> conflict -> dirty -> saving
```

A revision counter and persisted revision distinguish an older save completing from the newest
edit. Disk reload is refused while local state is dirty, saving, or conflicted.

### Invariants

- A disk load must not replace dirty local ink.
- A failed write must leave the document dirty/retryable.
- A successful save of revision N must not mark revision N+1 clean.
- An external update while dirty creates a conflict; it does not overwrite local memory.
- A rename changes session identity to the new vault path even if auxiliary sidecar migration
  subsequently fails.

## PDF annotation persistence

PDF annotations remain in `<pdf>.jot.json`.

Sidecar writes use a verified transaction:

1. write a temporary file,
2. read it back,
3. parse/validate it,
4. recover/preserve any stale backup,
5. move the current authoritative file to a backup,
6. promote the verified temporary file,
7. read and verify the final file,
8. delete the backup only after successful verification.

Save failures remain dirty and are retried. External changes detected while local annotations are
dirty are preserved as conflict copies before local persistence proceeds.

### Hybrid PDF + Jot pages

Sidecar format v3 extends the existing PDF annotation sidecar without modifying the source PDF.
It stores an optional ordered `insertedPages` array. Each inserted page has a stable ID, paper
style, normalized page dimensions, and a `slot` identifying the gap between original PDF pages:

- slot 0 is before original PDF page 1,
- slot N is after original PDF page N,
- multiple inserted pages in the same slot retain array order.

Ink for an inserted page uses the same document-key model as PDF annotations:
`<pdf path>::jot:<stable page id>`. Older v1/v2 sidecars remain readable; only v3 may contain
inserted-page metadata or inserted-page ink keys.

`PdfInsertedPageStore` owns the in-memory hybrid layout. It follows PDF renames and is persisted
inside the same transactional sidecar save as the strokes. A blank inserted page therefore remains
durable even before the first stroke. Serialization only emits numeric source-page ink and ink for
currently-live inserted page IDs, preventing stale/orphan page ink from making a future sidecar
unreadable.

The PDF bytes remain untouched during normal editing. `OverlayManager` inserts lightweight Jot
page roots into gap containers between PDF.js page elements. Each hybrid page is rendered by the
same `JotNoteSurface` used for standalone notebooks, so paper rendering, Pencil input, backing
store limits, deterministic stroke rendering, and page virtualization have one implementation.
Hybrid surfaces use the PDF view as their IntersectionObserver root so offscreen inserted pages
release their canvas backing stores. While mounted, hybrid canvases use a fixed logical backing
store derived from the inserted page dimensions and a conservative memory budget; PDF zoom changes
only their CSS display size. The backing-store width/height therefore never churn during a zoom
gesture, eliminating repeated WebKit canvas allocation pressure while preserving normalized Pencil
coordinates.

PDF.js page elements remain authoritative for source page numbering; inserted pages never receive
the PDF.js `.page` class and never renumber source pages.

## Standalone notebooks

A `.jot` file is represented by exactly one authoritative `NotebookDocumentSession` per active
vault path. Views acquire and release that shared session rather than owning document state.

All open views share:

- the same `StrokeStore`,
- the same `UndoHistory`,
- the same revision/state machine,
- one serialized save chain.

Clean sessions are retired after their last view releases them. Dirty sessions remain alive with
no views until persistence succeeds or the conflict is explicitly resolved. Retry timers use
non-creating session lookup so a retry can never manufacture a new empty notebook session.

Notebook writes use `Vault.process()` as an atomic compare-and-write boundary. If current disk
bytes differ from the session's last persisted bytes, the write is blocked as a conflict. Before
the conflict UI depends on in-memory state, Jot writes a sibling local recovery notebook for the
current dirty revision. A repeated conflict render for the same revision does not create duplicate
recovery files.

Rename notifications are serialized because Obsidian may report the same rename through both the
vault and an open view. The source session always adopts the renamed vault path. If an obsolete
destination session exists, dirty local data is preserved first, the stale session is displaced
and made read-only, and only then does the renamed source session claim the path.

Ink notifications carry the changed page key and a view-source identity. The originating view
draws the committed stroke incrementally; other views redraw only the changed page. A normal pen
stroke therefore does not trigger a full-notebook repaint or a second render in its originating
view.

## Rendering

New pen strokes persist a versioned render profile containing smoothing and pressure sensitivity.
Persisted stroke geometry therefore does not depend on later user-setting changes.

Legacy strokes without a render profile migrate to the documented default profile.

Single-point pen and highlighter marks are first-class persisted strokes and must remain visible
after redraw/reopen. Plugin settings are normalized at the persistence boundary so malformed or
legacy tool/color/width values cannot disable the ink path.

## Persistent diagnostics

`PersistentDiagnostics` is an optional append-only recorder isolated behind the `DiagnosticSink`
interface. PDF/rendering components only emit primitive structured events; they do not perform
storage themselves.

Recording state is kept in the plugin's configured Obsidian directory. Starting a session persists
`enabled=true` and `cleanShutdown=false` before the trace begins. A normal plugin unload flushes
the pending batch and marks the session clean. If the next load finds an enabled, unclean active
session, that file becomes `lastCrashSession` and a fresh session starts automatically.

Trace events are JSON Lines. In-memory events are appended in batches after a short quiet period or
immediately once the batch reaches its size threshold. This bounds filesystem call frequency while
keeping the crash tail durable. Old session files are pruned, while the active, most recent clean,
and most recent crash sessions are protected.

The PDF hot path must obey an observer-effect rule: when diagnostics are disabled, diagnostic-only
DOM scans, native-canvas discovery, mutation counting, and other expensive measurements are not
performed. Diagnostics must never enumerate hybrid layout merely to report a count, because that
would violate the PDF zoom-isolation behavior being observed.

Export copies the selected internal JSONL trace to a visible `Jot Diagnostics/` folder. The
recorder never changes PDF bytes, sidecars, strokes, or notebook content.

## PDF merge / overwrite

Overwriting a PDF is transactional:

1. generate merged bytes,
2. write temporary PDF,
3. reopen and verify page count,
4. preserve/recover stale backup if present,
5. move original PDF to backup,
6. promote temporary PDF,
7. reopen and verify final PDF,
8. delete backup,
9. only then remove the annotation sidecar.

If sidecar deletion fails, annotations remain available instead of being silently discarded.

For hybrid documents, export first draws annotations onto the original PDF-page snapshot, then
inserts Jot pages from the highest slot downward so lower source-page indices cannot shift during
construction. Pages sharing a slot are inserted in reverse construction order to preserve their
stored visual order. Each exported Jot page keeps its on-screen aspect ratio, paper guides are
drawn into the PDF, and its strokes are flattened through the same deterministic stroke exporter.
The expected output page count includes every inserted page and is verified transactionally before
the sidecar can be discarded.

## UI lifetime

Each source PDF page is owned by one disposable `PdfPageBinding`, but the binding is
lightweight when its page is outside the PDF viewport. Every bound source page keeps one transparent
live Pencil hit target connected to the page, even while virtualized. In dormant state that live
canvas has only a 1x1 backing store and fills the page through CSS, so it preserves pointer/palette
input without carrying meaningful canvas memory.

An `IntersectionObserver` rooted at the PDF view promotes pages in or near the viewport to full
rendering. The expensive persistent annotation canvas and the live canvas backing store are allocated
only while the page is active. A false intersection does not immediately tear them down: deactivation
waits 750 ms, and a later true intersection cancels that timer. Pencil or mouse down on a dormant
hit target synchronously promotes the page before the normal input handler executes and pins the
page active for the duration of the pointer gesture. When deactivation finally occurs, the persistent
canvas is released and the live input canvas returns to a 1x1 backing store but remains connected.

PDF overlay backing stores use a conservative bounded area. During a PDF.js page-layer rebuild,
Jot never recreates a removed annotation canvas synchronously from the mutation callback. Detached
tracked canvases are explicitly released, then recovery is delayed until the page's direct-child
mutation stream has been quiet for 150 ms. Additional mutations restart that quiet period. This
prevents a PDF.js remove/rebuild cycle from becoming a Jot remove/recreate feedback loop.

The document-level PDF mutation observer treats descendant churn inside an existing `.page` as a
page-local concern. It rescans the full document only when source `.page` elements are actually
added or removed. This prevents a zoom gesture from repeatedly walking every PDF page simply
because PDF.js is rebuilding canvas/text/annotation children.

Each active `PdfPageBinding` owns its mounted canvases, direct-child mutation observer, resize
observer, viewport observer, pending resize/recovery work, and pointer-handler disposer.

Notebook pages keep only lightweight page/paper DOM permanently. `JotNoteSurface` uses an
`IntersectionObserver` rooted at the notebook scroll viewport to mount persistent/live canvases,
a resize observer, and Pencil handlers only for pages in or near the viewport. Unmounting a page
disposes input/observer resources and releases its canvas backing stores; the authoritative
strokes remain in `NotebookDocumentSession`. Remounting always repaints from that model.

Ruled, grid, and dot guides live on an explicit paper layer below transparent ink canvases. Paper
visibility therefore does not depend on WebKit's treatment of canvas backgrounds. Notebook page
height is established by an in-flow percentage spacer derived from the persisted page dimensions,
not CSS `aspect-ratio`; this prevents a zero-height WKWebView sheet from simultaneously removing
the paper, ink canvases, and Pencil gesture target.

If WebKit refuses a 2D canvas context, the page shows a non-destructive read-only error layer
instead of mutating or discarding notebook data. Teardown must unregister all input handlers,
observers, animation frames, and Jot-owned transient canvas resources.

## Lifecycle persistence

Dirty data is flushed on normal document transitions and best-effort flushed when the app is
hidden, page-hidden, or the plugin unloads. Obsidian's unload hook is synchronous, so protection
must not rely on unload alone.

## Hardening invariants for iPad.8

A PDF sidecar that fails to load because of a storage/I/O exception is **write-protected**,
not treated as an empty annotation document. New PDF Pencil strokes are blocked while
the unreadable-load guard is active, and every save/flush rejects without touching the
original sidecar. A successful clean reload clears the guard; protection does not
silently discard dirty in-memory strokes.

Source PDF, inserted Jot, and standalone Jot pages now follow the same input-lifetime
rule: lightweight Pencil hit targets remain connected in dormant state, while expensive
persistent render backing stores are virtualized. IntersectionObserver false events
use 750 ms hysteresis; pointer-down promotes a dormant page before the input handler
runs; pointer-up/cancel permits deactivation. Detached PDF pointer targets clear any
stranded pointer pin. Dormant surfaces reset inline dimensions so the CSS hitbox matches
the current page after zoom. Notebook input handler disposers belong to their surfaces.

The PDF merge service refuses a second operation for a source path while the first
merge is in flight, including copy operations; this protects deterministic temp/backup
paths. A dirty notebook destination may only be displaced on rename after its recovery
copy is confirmed durable.

Parsing enforces bounded JSON characters, total strokes/points, and points per stroke
before allocating render models. Oversized notebooks open read-only; oversized PDF
sidecars follow the protected-original path. Save failures remain retryable and
observable. PDF delayed attachment uses a cancellable generation token, and self-save
watcher events are matched against the actual written bytes rather than being ignored
solely because they occur within a time window.

Persistent diagnostics also record synchronous best-effort clean-unload intent to
reduce false crash recovery classification when WKWebView ends an async unload early.

## Release configuration management

Published release versions are immutable. The release workflow fails if a release with the same
version already exists. Build provenance covers `main.js`, `manifest.json`, and `styles.css`
when present.
