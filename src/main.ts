import { Notice, Plugin, TFile } from 'obsidian';
import {
	DocumentSessionManager,
	type NotebookDocumentSession,
} from './document-session';
import type { InkSaveScheduler, InkSurfaceController } from './ink-surface';
import { DEFAULT_TOOL_STATE, Palette, type ToolState } from './palette';
import { normalizePalettePreferences } from './palette-activation';
import { DEFAULT_SETTINGS, type JotSettings, JotSettingTab } from './settings';
import { ConfirmClearModal } from './clear';
import { collectClearOperations, countStrokes, toUndoEntries } from './clear-ops';
import { FloatingPaletteButton } from './floating-palette-button';
import { PointerEventHandler } from './pointer-event-handler';
import { isSidecarPath, pdfPathFromSidecar } from './jot-file';
import {
	JOT_NOTE_EXTENSION,
	JOT_NOTE_VIEW_TYPE,
	createJotNote,
	serializeJotNote,
} from './jot-note-file';
import { JotNoteView } from './jot-note-view';
import { MergeService } from './merge-service';
import { NotebookStore } from './notebook-store';
import { OverlayManager } from './overlay-manager';
import { SidecarStore, type SidecarLoadStatus } from './sidecar-store';
import {
	currentInkRenderProfile,
	setInkRenderTuning,
} from './stroke-render';
import { UndoController } from './undo-controller';
import type { UndoEntry } from './undo';

export type { Handedness } from './palette';

const PLUGIN_LOG = '[jot]';

export default class JotPlugin extends Plugin {
	private readonly sessions = new DocumentSessionManager();
	private readonly strokes = this.sessions.strokes;
	private readonly history = this.sessions.history;
	private sidecar!: SidecarStore;
	private notebookStore!: NotebookStore;
	private merge!: MergeService;
	private overlays!: OverlayManager;
	private toolState: ToolState = { ...DEFAULT_TOOL_STATE };
	private palette!: Palette;
	private floatingPaletteButton!: FloatingPaletteButton;
	settings: JotSettings = { ...DEFAULT_SETTINGS };
	private undoController!: UndoController;
	private lastActivePdfPath: string | null = null;

	async onload() {
		await this.loadSettings();
		this.applyInkSettings();

		this.sidecar = new SidecarStore(this.app.vault.adapter, this.sessions, {
			onSaveError: (path, error, retryCount) => {
				const retrying = retryCount <= 3 ? ' Jot will retry automatically.' : '';
				new Notice(`Jot: could not save annotations for ${path}: ${error.message}.${retrying}`, 8000);
			},
			onSaveRecovered: (path) => {
				new Notice(`Jot: annotation saving recovered for ${path}.`);
			},
		});
		this.notebookStore = new NotebookStore(this.app.vault.adapter, this.sessions, {
			onSaveError: (path, error) => {
				new Notice(`Jot: could not save ${path}: ${error.message}. The notebook remains dirty.`, 8000);
			},
			onSaveRecovered: (path) => {
				new Notice(`Jot: notebook saving recovered for ${path}.`);
			},
			onConflictPreserved: (_path, conflictPath) => {
				new Notice(
					`Jot: an external notebook edit conflicted with local ink. The external copy was preserved at ${conflictPath}.`,
					8000,
				);
			},
		});

		this.overlays = new OverlayManager(this.app, this.strokes, (canvas) =>
			this.wirePointerEvents(canvas),
		);
		this.undoController = new UndoController(this.history, this.strokes, this.overlays, {
			activeDocumentPath: () => this.overlays.getActivePdfFilePath(),
			onAfterApply: (pdfPath) => this.scheduleSave(pdfPath),
		});
		this.merge = new MergeService(
			this.app,
			this.app.vault.adapter,
			this.strokes,
			this.sidecar,
			this.history,
			{
				ensureLoaded: (pdfPath) => this.ensureLoaded(pdfPath),
				redrawOverlays: () => this.overlays.redrawOverlaysForActivePdf(),
			},
		);

		this.registerView(
			JOT_NOTE_VIEW_TYPE,
			(leaf) => new JotNoteView(leaf, this),
		);
		this.registerExtensions([JOT_NOTE_EXTENSION], JOT_NOTE_VIEW_TYPE);
		this.addSettingTab(new JotSettingTab(this.app, this));

		this.addCommand({
			id: 'new-handwritten-note',
			name: 'Create handwritten note',
			callback: () => void this.createJotNoteFile(),
		});
		this.addCommand({
			id: 'retry-unsaved-data',
			name: 'Retry unsaved data',
			callback: () => void this.flushAllPersistence(true),
		});
		this.addCommand({
			id: 'merge-notes-into-pdf',
			name: 'Merge notes into PDF',
			checkCallback: (checking) => {
				const path = this.overlays.getActivePdfFilePath();
				if (!path) return false;
				if (!checking) void this.merge.start(path);
				return true;
			},
		});
		this.addCommand({
			id: 'clear-annotations',
			name: 'Clear annotations on this PDF',
			checkCallback: (checking) => {
				const path = this.overlays.getActivePdfFilePath();
				if (!path) return false;
				if (!this.strokes.hasFor(path)) return false;
				if (!checking) this.startClearFlow(path);
				return true;
			},
		});
		this.addCommand({
			id: 'open-palette',
			name: 'Open palette',
			checkCallback: (checking) => {
				if (!this.activeInkContainer()) return false;
				if (!checking) this.openPaletteForActiveSurface();
				return true;
			},
		});

		this.palette = new Palette(
			this.toolState,
			(state) => {
				this.toolState = state;
				this.settings.toolState = state;
				const mem = this.palette.getMemory();
				this.settings.penState = mem.pen;
				this.settings.highlighterState = mem.highlighter;
				void this.saveSettings();
			},
			{
				onUndo: () => this.activeUndoController()?.undo(),
				onRedo: () => this.activeUndoController()?.redo(),
				canUndo: () => this.activeUndoController()?.canUndo() ?? false,
				canRedo: () => this.activeUndoController()?.canRedo() ?? false,
				getColors: () => this.settings.colors,
			},
			{
				pen: this.settings.penState,
				highlighter: this.settings.highlighterState,
			},
		);

		this.floatingPaletteButton = new FloatingPaletteButton((doc, x, y) => {
			this.palette.show(doc.body, x, y, this.settings.handedness);
		});
		this.registerObsidianProtocolHandler('jot-palette', () => {
			this.openPaletteForActiveSurface();
		});

		this.registerEvent(
			this.app.workspace.on('file-open', async (file: TFile | null) => {
				const nextPdfPath = file?.extension === 'pdf' ? file.path : null;
				const previousPdfPath = this.lastActivePdfPath;
				if (previousPdfPath && previousPdfPath !== nextPdfPath) {
					try {
						await this.sidecar.flush(previousPdfPath);
					} catch (error) {
						console.error(`${PLUGIN_LOG} outgoing PDF flush failed:`, error);
					}
				}
				this.lastActivePdfPath = nextPdfPath;

				if (!nextPdfPath) {
					this.refreshFloatingPaletteButton();
					return;
				}

				await this.ensureLoaded(nextPdfPath);
				const win = this.app.workspace.getMostRecentLeaf()?.view.containerEl.ownerDocument.defaultView;
				win?.setTimeout(() => {
					this.overlays.attachToActivePdf();
					this.refreshFloatingPaletteButton();
				}, 300);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.overlays.pruneClosedObservers();
				this.overlays.attachToActivePdf();
				this.refreshFloatingPaletteButton();
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!isSidecarPath(file.path)) return;
				if (this.sidecar.isOwnRecentSave(file.path)) return;
				const pdfPath = pdfPathFromSidecar(file.path);
				if (!pdfPath) return;
				if (this.sidecar.hasPendingSave(pdfPath)) {
					void this.resolveExternalSidecarConflict(pdfPath);
					return;
				}
				void this.reloadSidecar(pdfPath);
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (file.extension === 'pdf') {
					void this.handlePdfRename(oldPath, file.path);
					return;
				}
				if (file.extension === JOT_NOTE_EXTENSION) {
					this.renameDocumentSession(oldPath, file.path);
				}
			}),
		);

		this.registerDomEvent(activeWindow, 'resize', () => this.refreshFloatingPaletteButton());
		this.registerDomEvent(activeWindow, 'pagehide', () => {
			void this.flushAllPersistence(false);
		});
		this.registerDomEvent(activeDocument, 'visibilitychange', () => {
			if (activeDocument.visibilityState === 'hidden') void this.flushAllPersistence(false);
		});

		this.app.workspace.onLayoutReady(async () => {
			const filePath = this.overlays.getActivePdfFilePath();
			if (!filePath) {
				this.refreshFloatingPaletteButton();
				return;
			}
			this.lastActivePdfPath = filePath;
			await this.ensureLoaded(filePath);
			this.overlays.attachToActivePdf();
			this.refreshFloatingPaletteButton();
		});
	}

	onunload() {
		void this.flushAllPersistence(false);
		this.overlays?.disconnectAll();
		this.palette?.hide();
		this.floatingPaletteButton?.hide();
	}

	getNotebookSession(path: string): NotebookDocumentSession {
		return this.sessions.notebook(path);
	}

	renameDocumentSession(oldPath: string, newPath: string): void {
		const session = this.sessions.get(oldPath);
		if (!session || session.path === newPath) return;
		this.sessions.rename(oldPath, newPath);
	}

	async saveNotebookSession(session: NotebookDocumentSession): Promise<void> {
		await this.notebookStore.save(session);
		this.forEachNotebookView(session.path, (view) => {
			view.syncSavedData(session.rawData);
		});
	}

	notifyNotebookInkChanged(path: string, source: JotNoteView): void {
		this.forEachNotebookView(path, (view) => {
			if (view !== source) view.redrawAll();
		});
	}

	notifyNotebookStructureChanged(path: string, source: JotNoteView): void {
		this.forEachNotebookView(path, (view) => {
			if (view !== source) view.refreshFromSharedSession();
		});
	}

	wireInkCanvas(
		canvas: HTMLCanvasElement,
		surface: InkSurfaceController,
		saveScheduler: InkSaveScheduler,
		undo: UndoController,
		strokes = this.strokes,
	): () => void {
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			console.error(`${PLUGIN_LOG} no 2d context`);
			return () => {};
		}
		return new PointerEventHandler(canvas, ctx, {
			palette: this.palette,
			strokes,
			overlays: surface,
			sidecar: saveScheduler,
			undo,
			toolState: () => this.toolState,
			handedness: () => this.settings.handedness,
			paletteActivation: () => this.settings.paletteActivation,
			renderProfile: () => currentInkRenderProfile(),
		}).attach();
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<JotSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(stored ?? {}),
			...normalizePalettePreferences(stored),
		};
		this.toolState = { ...this.settings.toolState };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	applyInkSettings(): void {
		setInkRenderTuning({
			smoothing: this.settings.inkSmoothing,
			pressureSensitivity: this.settings.pressureSensitivity,
		});
	}

	refreshFloatingPaletteButton(): void {
		this.floatingPaletteButton?.update(
			this.activeInkContainer(),
			this.settings.floatingPaletteButtonPosition,
		);
	}

	openPaletteForActiveSurface(): void {
		const container = this.activeInkContainer();
		if (!container) return;
		const doc = container.ownerDocument;
		const win = doc.defaultView;
		if (!win) return;
		const rect = container.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const margin = 64;
		const x = Math.min(win.innerWidth - margin, Math.max(margin, rect.left + rect.width / 2));
		const y = Math.min(win.innerHeight - margin, Math.max(margin, rect.top + rect.height / 2));
		this.palette.show(doc.body, x, y, this.settings.handedness);
	}

	private async ensureLoaded(pdfPath: string): Promise<SidecarLoadStatus> {
		const status = await this.sidecar.load(pdfPath);
		if (status === 'protected') {
			new Notice(
				'Jot: the existing annotation sidecar could not be safely loaded. It is protected from overwrite until recovered.',
				8000,
			);
		} else if (status === 'error') {
			new Notice('Jot: annotations could not be loaded. The existing in-memory state was not replaced.', 8000);
		}
		return status;
	}

	private async reloadSidecar(pdfPath: string): Promise<void> {
		const status = await this.sidecar.load(pdfPath);
		if (status === 'protected') {
			new Notice(
				'Jot: an external annotation sidecar could not be safely loaded. Current annotations were kept.',
				8000,
			);
		}
		if (status === 'loaded' || status === 'missing') {
			this.overlays.redrawOverlaysForPdf(pdfPath);
		}
	}

	private async handlePdfRename(oldPath: string, newPath: string): Promise<void> {
		try {
			await this.sidecar.renamePdfPath(oldPath, newPath);
			if (this.lastActivePdfPath === oldPath) this.lastActivePdfPath = newPath;
			this.overlays.attachToActivePdf();
			this.overlays.redrawOverlaysForPdf(newPath);
		} catch (error) {
			console.error(`${PLUGIN_LOG} PDF rename migration failed:`, error);
			new Notice(
				`Jot: PDF moved, but annotation migration failed — ${error instanceof Error ? error.message : String(error)}`,
				8000,
			);
		}
	}

	private async resolveExternalSidecarConflict(pdfPath: string): Promise<void> {
		const conflictPath = await this.sidecar.preserveExternalConflictAndFlushLocal(pdfPath);
		if (!conflictPath) {
			new Notice(
				'Jot: an external annotation update conflicted with local unsaved ink. Local ink remains dirty; run “retry unsaved data”.',
				8000,
			);
			return;
		}
		new Notice(
			`Jot: simultaneous annotation edits detected. The external copy was preserved at ${conflictPath}.`,
			8000,
		);
	}

	private async flushAllPersistence(showResult: boolean): Promise<void> {
		const [pdfFailures, notebookFailures] = await Promise.all([
			this.sidecar?.flushAll() ?? Promise.resolve([]),
			this.notebookStore?.flushAll() ?? Promise.resolve([]),
		]);
		const failures = [...pdfFailures, ...notebookFailures];
		if (failures.length > 0) {
			console.error(`${PLUGIN_LOG} persistence flush failures:`, failures);
			if (showResult) {
				new Notice(
					`Jot: ${failures.length} document${failures.length === 1 ? '' : 's'} still could not be saved. They remain dirty and retryable.`,
					8000,
				);
			}
		} else if (showResult) {
			new Notice('Jot: all pending data saved successfully.');
		}
	}

	private scheduleSave(pdfPath: string): void {
		this.sidecar.scheduleSave(pdfPath);
	}

	private wirePointerEvents(canvas: HTMLCanvasElement): () => void {
		return this.wireInkCanvas(canvas, this.overlays, this.sidecar, this.undoController, this.strokes);
	}

	private activeJotNoteView(): JotNoteView | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		return leaf?.view instanceof JotNoteView ? leaf.view : null;
	}

	private activeUndoController(): UndoController | null {
		const noteUndo = this.activeJotNoteView()?.getUndoController();
		if (noteUndo) return noteUndo;
		return this.overlays?.getActivePdfLeaf() ? this.undoController : null;
	}

	private activeInkContainer(): HTMLElement | null {
		const noteView = this.activeJotNoteView();
		if (noteView) return noteView.containerEl;
		return this.overlays?.getActivePdfLeaf()?.view.containerEl ?? null;
	}

	private forEachNotebookView(path: string, callback: (view: JotNoteView) => void): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof JotNoteView)) return;
			if (leaf.view.getSessionPath() !== path) return;
			callback(leaf.view);
		});
	}

	private async createJotNoteFile(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		const folder = activeFile?.parent?.path ?? '';
		const baseName = 'Untitled Jot';
		let index = 1;
		let path = folder ? `${folder}/${baseName}.jot` : `${baseName}.jot`;
		while (this.app.vault.getAbstractFileByPath(path)) {
			index += 1;
			const name = `${baseName} ${index}`;
			path = folder ? `${folder}/${name}.jot` : `${name}.jot`;
		}
		const file = await this.app.vault.create(path, serializeJotNote(createJotNote()));
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private pushUndo(entry: UndoEntry) {
		this.undoController.push(entry);
	}

	private startClearFlow(pdfPath: string) {
		new ConfirmClearModal(this.app, pdfPath, () => this.applyClear(pdfPath)).open();
	}

	private applyClear(pdfPath: string) {
		const operations = collectClearOperations(pdfPath, this.strokes.asMap());
		const totalStrokes = countStrokes(operations);
		if (totalStrokes === 0) return;
		for (const entry of toUndoEntries(pdfPath, operations)) {
			this.pushUndo(entry);
			this.strokes.clearKey(entry.key);
		}
		this.scheduleSave(pdfPath);
		this.overlays.redrawOverlaysForActivePdf();
		new Notice(
			`Jot: cleared ${totalStrokes} stroke${totalStrokes === 1 ? '' : 's'}. Undo to restore.`,
		);
	}
}
