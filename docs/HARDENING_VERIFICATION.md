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
- release assets are immutable once published.

## Required release gate

A candidate is releasable only when the exact versioned commit passes:

- TypeScript production build,
- complete Vitest suite,
- ESLint,
- Node 20, 22, and 24 CI matrix,
- release workflow rebuild from the exact release SHA.
