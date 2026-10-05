import { Notice, Plugin, TFile } from 'obsidian';
import { DocumentSessionManager } from './document-session';
import type { InkSaveScheduler, InkSurfaceController } from './ink-surface';
import { DEFAULT_TOOL_STATE, Palette, ToolState } from './palette';
import { normalizePalettePreferences } from './palette-activation';
import { DEFAULT_SETTINGS, JotSettings, JotSettingTab } from './settings';
import { ConfirmClearModal } from './clear';
import { collectClearOperations, countStrokes, toUndoEntries } from './clear-ops';
import { FloatingPaletteButton } from './floating-palette-button';
import { PointerEventHandler } from './pointer-event-handler';
import { isSidecarPath, pdfPathFromSidecar } from './jot-file';
import { JOT_NOTE_EXTENSION, JOT_NOTE_VIEW_TYPE, createJotNote, serializeJotNote } from './jot-note-file';
import { JotNoteView } from './jot-note-view';
import { MergeService } from './merge-service';
import { NotebookSessionManager, type NotebookDocumentSession } from './notebook-session';
import { OverlayManager } from './overlay-manager';
import { SidecarStore } from './sidecar-store';
import { StrokeStore } from './stroke-store';
import { setInkRenderTuning } from './stroke-render';
import { UndoController } from './undo-controller';
import { UndoEntry, UndoHistory } from './undo';

export type { Handedness } from './palette';

const PLUGIN_LOG = '[jot]';

export default class JotPlugin extends Plugin {
	private strokes = new StrokeStore();
	private sessions = new DocumentSessionManager();
	private notebooks = new NotebookSessionManager(this.sessions);
	private lastActivePdfPath: string | null = null;
	private sidecar!: SidecarStore;
	private merge!: MergeService;
	private overlays!: OverlayManager;
	private toolState: ToolState = { ...DEFAULT_TOOL_STATE };
	private palette!: Palette;
	private floatingPaletteButton!: FloatingPaletteButton;
	settings: JotSettings = { ...DEFAULT_SETTINGS };
	private history = new UndoHistory();
	private undoController!: UndoController;

	async onload() {
		await this.loadSettings();
		this.applyInkSettings();
		this.sidecar = new SidecarStore(
			this.app.vault.adapter,
			this.strokes,
			this.sessions,
			{
				onSaveError: (path, error) => {
					new Notice(
						`Jot: save failed for ${path}. Changes remain dirty and Jot will retry: ${error instanceof Error ? error.message : String(error)}`,
						8000,
					);
				},
				onSaveRecovered: (path) => {
					new Notice(`Jot: save recovered for ${path}.`);
				},
			},
		);
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
				const nextPdf = file?.extension === 'pdf' ? file.path : null;
				if (this.lastActivePdfPath && this.lastActivePdfPath !== nextPdf) {
					await this.sidecar.flush(this.lastActivePdfPath);
				}
				this.lastActivePdfPath = nextPdf;
				if (!nextPdf) {
					this.refreshFloatingPaletteButton();
					return;
				}
				await this.ensureLoaded(nextPdf);
				window.setTimeout(() => {
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
				if (this.sidecar.hasUnsavedChanges(pdfPath)) {
					void this.resolveExternalSidecarConflict(pdfPath);
					return;
				}
				void this.reloadSidecar(pdfPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile) || file.extension !== 'pdf') return;
				void this.handlePdfRename(oldPath, file.path);
			}),
		);

		this.registerDomEvent(window, 'resize', () => this.refreshFloatingPaletteButton());

		this.app.workspace.onLayoutReady(async () => {
			const filePath = this.overlays.getActivePdfFilePath();
			this.lastActivePdfPath = filePath;
			if (!filePath) {
				this.refreshFloatingPaletteButton();
				return;
			}
			await this.ensureLoaded(filePath);
			this.overlays.attachToActivePdf();
			this.refreshFloatingPaletteButton();
		});
	}

	onunload() {
		// Obsidian's unload hook is synchronous, so this is a best-effort final
		// flush. Normal file switches, renames, merges, and notebook closes flush
		// before the lifecycle transition itself.
		void this.sidecar?.flushAll();
		this.overlays?.disconnectAll();
		this.palette?.hide();
		this.floatingPaletteButton?.hide();
	}

	private async ensureLoaded(pdfPath: string) {
		const status = await this.sidecar.load(pdfPath);
		if (status === 'dirty') return;
		if (status === 'protected') {
			new Notice(
				'Jot: the existing annotation sidecar could not be safely loaded. It is protected from overwrite and will be backed up before any new annotations are saved.',
				8000,
			);
		}
	}

	private async reloadSidecar(pdfPath: string) {
		const status = await this.sidecar.load(pdfPath);
		if (status === 'dirty') return;
		if (status === 'protected') {
			new Notice(
				'Jot: an external annotation sidecar could not be safely loaded. The file was left untouched and current annotations were kept in memory.',
				8000,
			);
		}
		this.overlays.redrawOverlaysForPdf(pdfPath);
	}

	private async handlePdfRename(oldPath: string, newPath: string): Promise<void> {
		await this.sidecar.flush(oldPath);
		this.strokes.rekeyDocumentPath(oldPath, newPath);
		this.history.rekeyPath(oldPath, newPath);
		await this.sidecar.renamePdfPath(oldPath, newPath);
		if (this.lastActivePdfPath === oldPath) this.lastActivePdfPath = newPath;
		this.overlays.attachToActivePdf();
		this.overlays.redrawOverlaysForPdf(newPath);
	}

	private async resolveExternalSidecarConflict(pdfPath: string): Promise<void> {
		const conflictPath = await this.sidecar.preserveExternalConflictAndFlushLocal(pdfPath);
		if (!conflictPath) {
			new Notice(
				'Jot: an external annotation update arrived while local ink was unsaved. Local ink was kept in memory; avoid closing the PDF until the conflict is resolved.',
			);
			return;
		}
		new Notice(
			`Jot: simultaneous annotation edits detected. The external copy was preserved at ${conflictPath}.`,
			8000,
		);
	}

	private scheduleSave(pdfPath: string): void {
		this.sidecar.scheduleSave(pdfPath);
	}

	private wirePointerEvents(canvas: HTMLCanvasElement): () => void {
		return this.wireInkCanvas(canvas, this.overlays, this.sidecar, this.undoController, this.strokes);
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
		const handler = new PointerEventHandler(canvas, ctx, {
			palette: this.palette,
			strokes,
			overlays: surface,
			sidecar: saveScheduler,
			undo,
			toolState: () => this.toolState,
			handedness: () => this.settings.handedness,
			paletteActivation: () => this.settings.paletteActivation,
		});
		handler.attach();
		return () => handler.detach();
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
		this.overlays?.redrawOverlaysForActivePdf();
		this.activeJotNoteView()?.redrawAll();
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

	getNotebookSession(path: string): NotebookDocumentSession {
		return this.notebooks.get(path);
	}

	renameNotebookSession(oldPath: string, newPath: string): NotebookDocumentSession {
		return this.notebooks.rename(oldPath, newPath);
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



