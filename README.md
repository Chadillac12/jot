# Jot

Jot adds Apple Pencil handwriting to Obsidian. It supports both PDF annotation and standalone multi-page `.jot` notebooks while keeping ink data inside the vault.

## Features

- Pressure-sensitive Apple Pencil ink with coalesced and predicted input samples.
- Pen, highlighter, eraser, configurable colors, and configurable widths.
- Blank, ruled, grid, and dot-paper standalone `.jot` notebooks.
- Multi-page handwritten notebooks with shared state across multiple Obsidian views.
- Undo/redo for PDF annotations and notebooks.
- Finger scrolling and zooming while Pencil remains writing-first.
- Radial palette with configurable activation, including Pencil tap-then-hold and two-finger hold.
- PDF annotations stored in a versioned `<file>.jot.json` sidecar until explicitly merged.
- Transactional sidecar persistence with dirty/error/conflict state tracking and retry.
- PDF merge to a copy or verified overwrite with recovery/rollback protection.
- Conflict preservation when external/synced edits arrive while local ink is dirty.

## Creating a handwritten notebook

Open Obsidian's command palette and run:

**Jot: Create handwritten note**

Jot creates an `Untitled Jot.jot` file in the current folder. The file opens as a handwritten notebook and syncs with the rest of the vault.

## Annotating a PDF

1. Open a PDF in Obsidian.
2. Write directly with Apple Pencil.
3. Open the radial palette using the activation configured under **Settings → Jot**.
4. Choose pen, highlighter, eraser, color, or width.
5. Run **Jot: Merge notes into PDF** when you intentionally want to bake annotations into a PDF.
6. Run **Jot: Clear annotations on this PDF** to clear sidecar ink; the action is undoable before persistence history is intentionally discarded.

Until merge is requested, Jot does not bake sidecar ink into the source PDF.

## Data integrity model

Jot treats document state and rendering state separately:

- Each open document has explicit clean, dirty, saving, error, and conflict lifecycle state.
- Dirty local state is never silently replaced by a disk reload.
- Failed saves remain dirty and are retried.
- PDF sidecars use validated transactional writes with rollback.
- Standalone notebooks use one shared document session even when the same file is visible in multiple panes.
- Notebook saves use an atomic compare-and-swap against the last known persisted text; conflicting external edits are preserved before local state can replace them.
- Persisted pen strokes store a renderer version and render profile so later settings changes do not reshape previously saved ink.
- PDF page bindings own and dispose their canvases, observers, and pointer handlers explicitly.

Recovery and conflict files are intentionally retained when Jot cannot prove that destructive cleanup is safe.

## Installing

For the published community-plugin version:

1. Open **Settings → Community plugins → Browse** in Obsidian.
2. Search for **Jot**.
3. Install and enable it.

### Beta / iPad test builds with BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add:

`https://github.com/Chadillac12/jot`

BRAT installs the latest prerelease assets: `main.js`, `manifest.json`, and `styles.css`.

For development builds, use a test vault rather than important production notes.

## Development

```bash
npm install
npm run dev
npm run build
npm test
npm run lint
```

The release workflow performs a clean build, tests, lint, and provenance attestation. Published release versions are immutable; a changed build must use a new version.

## Architecture

The major runtime boundaries are:

```text
JotPlugin
 ├─ DocumentSessionManager
 │   ├─ PDF document lifecycle
 │   └─ Notebook document lifecycle
 ├─ SidecarStore
 │   └─ transactional PDF-sidecar persistence
 ├─ NotebookSessionManager
 │   └─ one authoritative notebook model per vault path
 ├─ NotebookStore
 │   └─ retry / flush / compare-and-swap notebook persistence
 ├─ Ink Engine
 │   ├─ PointerEventHandler
 │   ├─ StrokeStore
 │   └─ deterministic stroke renderer
 └─ Surfaces
     ├─ disposable PDF page bindings
     └─ standalone notebook surfaces
```

Views render and edit document sessions; they are not the authoritative persistence owner.
