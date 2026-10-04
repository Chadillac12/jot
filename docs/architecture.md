# Jot architecture and persistence invariants

This document defines the architectural rules that protect handwritten data. Changes that violate these rules require an explicit design update and regression coverage.

## 1. Authoritative document state

`DocumentSessionManager` owns one authoritative `DocumentSession` per open document path.

A view is never the authority for ink. PDF surfaces and `.jot` views render and edit the shared session model.

Each session owns, through the manager:

- stroke state,
- undo/redo history,
- revision and persisted revision,
- persistence state,
- conflict/error state.

Notebook views for the same path must share one `NotebookDocumentSession`.

## 2. Session state machine

Allowed states are:

`unloaded -> loading -> clean -> dirty -> saving -> clean`

Additional failure states are:

- `load-error`
- `save-error`
- `conflict`

Required invariants:

1. Disk reload must not replace a dirty, saving, save-error, or conflicting local model.
2. Every edit increments the session revision.
3. A save snapshots one revision.
4. If a newer edit arrives during that save, save completion must leave the session dirty.
5. A failed save must leave the session dirty and retryable.
6. A clean external reload establishes a new undo-history boundary.
7. Invalid/future data must never be silently converted or overwritten.

## 3. Persistence

### PDF sidecars

Sidecar saves use a debounced request for latency, but lifecycle transitions flush dirty sessions rather than discarding pending work.

Save failures are observable and retryable. Automatic retries are bounded; manual retry remains available.

### Standalone notebooks

All views serialize the shared notebook session. Multiple views must not maintain independent authoritative copies.

Rename events are serialized/coalesced so duplicate Obsidian rename notifications cannot run competing migrations.

## 4. Transaction protocol

Authoritative writes use:

1. write temporary file,
2. read it back,
3. verify exact content/bytes,
4. validate semantic format,
5. move existing authoritative file to a unique backup,
6. promote temporary file,
7. read back authoritative file,
8. verify exact content/bytes again,
9. validate semantic format again,
10. remove backup only after successful verification.

On failure, an unverified promoted file is removed and the original backup is restored.

Cleanup failure after a verified commit may leave a verified backup; this is preferable to deleting recovery data.

## 5. PDF overwrite/merge

PDF overwrite is a compound destructive operation.

The original PDF backup is retained until:

1. merged PDF generation succeeds,
2. the committed PDF is byte-verified,
3. the committed PDF parses successfully,
4. page count matches the source,
5. annotation sidecar cleanup succeeds.

If annotation cleanup fails, the original PDF is restored so a retry cannot bake the same strokes twice.

## 6. Deterministic rendering

New pen strokes persist a render profile containing a renderer version and tuning values.

Changing current smoothing or pressure settings must not alter a previously versioned stroke.

Legacy strokes without a render profile use one fixed compatibility profile.

Any future change to persisted stroke geometry semantics must introduce a new renderer version rather than silently changing an existing version.

## 7. PDF surface lifecycle

Every PDF page is owned by one disposable `PdfPageBinding`.

A binding owns:

- persistent canvas,
- live canvas,
- pointer handler/disposer,
- mutation observer,
- resize observer,
- pending resize frame,
- Jot-owned DOM classes.

Disposal must remove all Jot-owned DOM and listeners/observers.

A binding is disposed when its page disappears, its leaf closes, its leaf stops being a PDF, its container changes, or the plugin unloads.

## 8. Conflict policy

When external data changes while local data is dirty:

- local state is not silently replaced,
- external content is preserved in a verified conflict/recovery file before local state wins,
- the session exposes a conflict/error state,
- destructive PDF merge is blocked while the sidecar is unresolved.

## 9. Verification policy

Persistence and concurrency behavior requires negative-path tests, including:

- write failure,
- rename failure,
- validation failure,
- post-commit verification failure,
- edit during in-flight save,
- duplicate rename notification,
- dirty reload attempt,
- external conflict,
- destructive PDF cleanup failure,
- observer/input disposal,
- repeated resize callbacks.

A release is not cut unless build, tests, and lint pass on the supported CI matrix.
