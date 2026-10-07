# Jot

Jot adds Apple Pencil handwriting to Obsidian for both PDFs and standalone `.jot` notebooks.

PDF annotations are stored beside the PDF in `<file>.jot.json` until you explicitly choose to merge them into a PDF. Standalone handwritten notebooks are normal vault files with the `.jot` extension.

Status: **early beta**. Back up important notes and use prerelease builds deliberately.

<img src="docs/pen-right.png" alt="Annotating a PDF with the radial palette open" width="240" />

## Features

- Pressure-sensitive Apple Pencil ink with coalesced and predicted input samples
- Pen, highlighter, and eraser
- Configurable colors, widths, smoothing, and pressure sensitivity
- Pencil **quick tap → lift → second nearby tap + hold** opens the radial palette
- Optional two-finger hold and floating palette button
- Undo/redo
- Standalone multi-page `.jot` notebooks with blank, ruled, grid, and dot paper
- Handwritten Jot pages inserted before/after PDF pages without modifying the source PDF
- PDF annotations and inserted-page layout stored together in sidecar JSON for vault sync
- Transactional, verified PDF merge/overwrite that can flatten inserted Jot pages
- Conflict protection and recovery copies for unsafe sidecar changes

<p>
  <img src="docs/color-right.png" alt="Right-handed color selection" width="240" />
  <img src="docs/color-left.png" alt="Left-handed color selection" width="240" />
  <img src="docs/thickness-right.png" alt="Thickness selection" width="240" />
</p>

## Installing beta builds

Jot's current iPad builds are distributed as GitHub prereleases for BRAT.

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian.
2. Add `Chadillac12/jot` as a beta plugin.
3. Enable **Jot** under Community plugins.
4. Use **BRAT → Check for updates** when a newer prerelease is published.

For important notes, test a new prerelease on disposable data before relying on it.

## Using Jot on PDFs

1. Open a PDF in Obsidian.
2. Write directly with Apple Pencil.
3. To open the palette with Pencil, make one quick tap, lift, then tap nearby again and hold briefly.
4. Use the palette to choose pen, highlighter, eraser, color, or width.
5. Run **Jot: Add handwritten page before current PDF page** or **Jot: Add handwritten page after current PDF page** to insert a writable blank/ruled/grid/dot page into the PDF reading flow.
6. Change an inserted page's **Paper** dropdown at any time. The source PDF is not changed; the page layout and ink stay in the `.jot.json` sidecar.
7. Run **Jot: Merge notes into PDF** to bake annotations and inserted handwritten pages into the PDF or an annotated copy.
8. Run **Jot: Clear annotations on this PDF** to remove ink while leaving inserted page structure intact.

Normal Pencil contact is writing-only; Jot does not use ordinary Pencil long-press as a palette gesture.

## Creating a handwritten notebook

Run:

**Jot: Create handwritten note**

Jot creates a `.jot` file in the vault and opens it as a handwritten notebook. The notebook supports multiple pages and blank, ruled, grid, or dot paper.

Opening the same notebook in multiple panes shares one authoritative in-memory document session rather than creating independent copies.

## Persistent crash diagnostics

For iPad/WebKit crashes that terminate Obsidian before the console can be inspected, Jot can record
a lightweight append-only PDF lifecycle trace that survives process restarts.

Use these Command Palette commands:

- **Jot: Start persistent diagnostics** — starts recording and persists that choice across restarts.
- **Jot: Stop persistent diagnostics** — flushes and stops recording.
- **Jot: Export last diagnostic recording** — copies the most recent preserved crash session (or
  current/latest session when no crash is preserved) into the visible `Jot Diagnostics/` vault folder.
- **Jot: Clear diagnostic recordings** — removes retained internal traces; if recording is active,
  it immediately continues in a fresh session.

When recording is enabled, Jot marks the active session as unclean before testing begins. If
Obsidian is killed without a normal plugin unload, the next launch preserves that session as the
latest crash trace and automatically resumes recording. A startup notice confirms recovery.

The trace intentionally records PDF/overlay lifecycle data rather than Pencil samples: PDF.js DOM
mutation counts, source page binding creation/disposal, native PDF canvas dimensions, Jot overlay
canvas dimensions, hybrid page reconciliation, and plugin/window lifecycle events. Traces remain
inside the vault/plugin storage unless **Export last diagnostic recording** is run. Exported traces
can include vault file paths and device/browser metadata, so review them before sharing.

## Data integrity

Jot treats handwritten ink as user data:

- dirty documents cannot be silently replaced by a disk reload,
- failed saves remain dirty and retry,
- sidecar replacement uses verified temporary and backup files,
- conflicting external edits are preserved instead of silently overwritten,
- destructive PDF overwrite uses a verified temporary PDF and rollback backup,
- persisted pen strokes include a versioned rendering profile so their appearance does not depend on later settings changes.
- inserted PDF Jot pages are persisted transactionally in sidecar v3 and keep stable page IDs across reloads and PDF renames,
- the source PDF is not rewritten merely because a handwritten page is inserted; only an explicit merge/export creates physical PDF pages.

See [Architecture](docs/ARCHITECTURE.md) and [Hardening verification](docs/HARDENING_VERIFICATION.md) for the current design invariants and verification mapping.

## iPad safety protections

Jot preserves small, transparent Pencil hit targets when pages are outside the
viewport instead of removing input handling during zoom. Heavy backing stores are
released independently. If a PDF annotation sidecar cannot be read because of
an I/O error, Jot blocks further ink input and writes on that PDF to protect the
existing annotations. Correct the storage problem and reopen/reload the document
rather than continuing to draw while saving is blocked.

Large synced or corrupted ink documents are validated against mobile-safe resource
budgets before rendering, and may open protected or read-only. Concurrent merges
of the same PDF are blocked. Keep a backup when upgrading a working vault and
verify PDFs/notebooks on the iPad before making this a production release.

## Development

```bash
npm install
npm run dev
npm run build
npm test
npm run lint
```

The CI release gate runs build, tests, and lint on Node 20, 22, and 24.

## Release discipline

Published versions are immutable. The release workflow refuses to replace assets on an existing release.

Prerelease flow:

1. update `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`,
2. verify the exact versioned commit in CI,
3. create `release/<version>` from that exact SHA,
4. allow the release workflow to rebuild and publish `main.js`, `manifest.json`, and `styles.css`.

Do not reuse or repoint an existing release version.
