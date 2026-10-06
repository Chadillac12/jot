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

## UI lifetime

Each PDF page is owned by one disposable `PdfPageBinding`. It owns its canvases, mutation
observer, resize observer, pending animation frame, and pointer-handler disposer.

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

## Release configuration management

Published release versions are immutable. The release workflow fails if a release with the same
version already exists. Build provenance covers `main.js`, `manifest.json`, and `styles.css`
when present.
