import { Notice, Plugin, TFile } from 'obsidian';
import type { InkSaveScheduler, InkSurfaceController } from './ink-surface';
import { DEFAULT_TOOL_STATE, Palette, ToolState } from './palette';
import { DocumentSessionManager } from './document-session';
import { normalizePalettePreferences } from './palette-activation';
import { DEFAULT_SETTINGS, JotSettings, JotSettingTab } from './settings';
import { ConfirmClearModal } from './clear';
import { collectClearOperations, countStrokes, toUndoEntries } from './clear-ops';
import { FloatingPaletteButton } from './floating-palette-button';
import { PointerEventHandler } from './pointer-event-handler';
import { isSidecarPath, pdfPathFromSidecar } from './jot-file';
import { JOT_NOTE_EXTENSION, JOT_NOTE_VIEW_TYPE, createJotNote, serializeJotNote } from './jot-note-file';
import { JotNoteView } from './jot-note-view';
import { NotebookSessionManager, type NotebookSession } from './notebook-session';
import { NotebookStore } from './notebook-store';
import { transactionalWriteText } from './transactional-write';
import { MergeService } from './merge-service';
import { OverlayManager } from './overlay-manager';
import { SidecarStore } from './sidecar-store';
import { StrokeStore } from './stroke-store';
import { currentInkRenderProfile, setInkRenderTuning } from './stroke-render';
import { UndoController } from './undo-controller';
import { UndoEntry, UndoHistory } from './undo';

export type { Handedness } from './palette';

const PLUGIN_LOG = '[jot]';

export default class JotPlugin extends Plugin {
	private strokes = new StrokeStore();
	private sidecar!: SidecarStore;
	private merge!: MergeService;
	private overlays!: OverlayManager;
	private toolState: ToolState = { ...DEFAULT_TOOL_STATE };
	private palette!: Palette;
	private floatingPaletteButton!: FloatingPaletteButton;
	settings: JotSettings = { ...DEFAULT_SETTINGS };
	private history = new UndoHistory();
	private undoController!: UndoController;
	private sessions = new DocumentSessionManager();
	readonly notebookSessions = new NotebookSessionManager(this.sessions);
	private notebookStore!: NotebookStore;
	private lastSaveErrorByPath = new Map<string, string>();
	private lastActivePdfPath: string | null = null;
	private lockedPdfPaths = new Set<string>();
	private deferredSidecarReloads = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.applyInkSettings();
		this.sidecar = new SidecarStore(
			this.app.vault.adapter,
			this.strokes,
			this.sessions,
			(pdfPath, error) => this.reportSaveError(pdfPath, error),
		);
		this.notebookStore = new NotebookStore(
			this.app.vault,
			this.notebookSessions,
			(path, error) => this.reportNotebookSaveError(path, error),
			(path) => {
				void this.resolveNotebookConflict(this.notebookSessions.get(path));
			},
		);
		this.overlays = new OverlayManager(this.app, this.strokes, (canvas) =>
			this.wirePointerEvents(canvas),
		);
		this.undoController = new UndoController(this.history, this.strokes, this.overlays, {
			activeDocumentPath: () => this.overlays.getActivePdfFilePath(),
			onAfterApply: (pdfPath) => this.scheduleSave(pdfPath),
			canMutate: (pdfPath) => !this.lockedPdfPaths.has(pdfPath),
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
				acquireMutationLock: (pdfPath) => this.acquirePdfMutationLock(pdfPath),
				releaseMutationLock: (pdfPath) => this.releasePdfMutationLock(pdfPath),
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
				if (!path || this.lockedPdfPaths.has(path)) return false;
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
				if (this.lastActivePdfPath && this.lastActivePdfPath !== nextPdfPath) {
					await this.sidecar.flush(this.lastActivePdfPath);
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
				if (this.lockedPdfPaths.has(pdfPath)) {
					this.deferredSidecarReloads.add(pdfPath);
					return;
				}
				if (this.sidecar.hasPendingSave(pdfPath)) {
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

		const rootWin =
			this.app.workspace.getMostRecentLeaf()?.view.containerEl.ownerDocument.defaultView ??
			activeDocument.defaultView;
		if (rootWin) {
			this.registerDomEvent(rootWin, 'resize', () => this.refreshFloatingPaletteButton());
			this.registerDomEvent(rootWin.document, 'visibilitychange', () => {
				if (rootWin.document.visibilityState === 'hidden') {
					void this.flushPersistence();
				}
			});
			this.registerDomEvent(rootWin, 'pagehide', () => {
				void this.flushPersistence();
			});
		}

		this.app.workspace.onLayoutReady(async () => {
			const filePath = this.overlays.getActivePdfFilePath();
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
		this.overlays?.disconnectAll();
		// Final persistence attempts are allowed to finish, but shutdown mode
		// prevents failed writes from leaving timers owned by an unloaded plugin.
		void Promise.all([
			this.sidecar?.shutdown() ?? Promise.resolve(true),
			this.notebookStore?.shutdown() ?? Promise.resolve(true),
		]);
		this.palette?.hide();
		this.floatingPaletteButton?.hide();
	}

	private async flushPersistence(): Promise<boolean> {
		const [sidecarsSaved, notebooksSaved] = await Promise.all([
			this.sidecar.flushAll(),
			this.notebookStore.flushAll(),
		]);
		return sidecarsSaved && notebooksSaved;
	}

	private async ensureLoaded(pdfPath: string) {
		await this.merge?.recoverInterruptedOverwrite(pdfPath);
		const status = await this.sidecar.load(pdfPath);
		if (status === 'dirty') return status;
		if (status === 'protected') {
			new Notice(
				'Jot: the existing annotation sidecar could not be safely loaded. It is protected from overwrite and will be backed up before any new annotations are saved.',
				8000,
			);
		}
		return status;
	}

	private async reloadSidecar(pdfPath: string) {
		const status = await this.sidecar.load(pdfPath);
		if (status === 'dirty') {
			await this.resolveExternalSidecarConflict(pdfPath);
			return;
		}
		if (status === 'protected') {
			new Notice(
				'Jot: an external annotation sidecar could not be safely loaded. The file was left untouched and current annotations were kept in memory.',
				8000,
			);
		}
		this.overlays.redrawOverlaysForPdf(pdfPath);
	}

	private async handlePdfRename(oldPath: string, newPath: string): Promise<void> {
		if (this.lastActivePdfPath === oldPath) this.lastActivePdfPath = newPath;
		this.strokes.rekeyDocumentPath(oldPath, newPath);
		this.history.rekeyPath(oldPath, newPath);
		await this.sidecar.renamePdfPath(oldPath, newPath);
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


	async resolveNotebookConflict(session: NotebookSession): Promise<boolean> {
		const external = session.externalConflictData;
		if (external === null) return true;
		const conflictPath = `${session.path}.conflict-${Date.now()}.json`;
		try {
			await transactionalWriteText(this.app.vault.adapter, conflictPath, external);
			session.resolveConflictKeepLocal();
			this.notebookStore.scheduleSave(session.path);
			new Notice(
				`Jot: simultaneous notebook edits detected. The external copy was preserved at ${conflictPath}.`,
				8000,
			);
			return true;
		} catch (error) {
			new Notice(
				`Jot: could not preserve the external notebook conflict, so local save remains blocked. ${error instanceof Error ? error.message : String(error)}`,
				10000,
			);
			return false;
		}
	}

	scheduleNotebookSave(path: string): void {
		this.notebookStore.scheduleSave(path);
	}

	async flushNotebook(path: string): Promise<boolean> {
		return this.notebookStore.flush(path);
	}

	async renameNotebookSession(oldPath: string, newPath: string): Promise<void> {
		await this.notebookStore.rename(oldPath, newPath);
	}

	private reportNotebookSaveError(path: string, error: Error): void {
		new Notice(
			`Jot: notebook ${path} could not be saved. The shared session remains dirty and Jot will retry. ${error.message}`,
			10000,
		);
	}

	private acquirePdfMutationLock(pdfPath: string): boolean {
		if (this.lockedPdfPaths.has(pdfPath)) return false;
		this.lockedPdfPaths.add(pdfPath);
		return true;
	}

	private releasePdfMutationLock(pdfPath: string): void {
		this.lockedPdfPaths.delete(pdfPath);
		if (!this.deferredSidecarReloads.delete(pdfPath)) return;
		void this.reloadSidecar(pdfPath);
	}

	private reportSaveError(pdfPath: string, error: Error): void {
		const message = error.message || String(error);
		if (this.lastSaveErrorByPath.get(pdfPath) === message) return;
		this.lastSaveErrorByPath.set(pdfPath, message);
		new Notice(
			`Jot: annotations for ${pdfPath} could not be saved. They remain dirty and Jot will retry. ${message}`,
			10000,
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
			canEdit: (documentPath) => !this.lockedPdfPaths.has(documentPath),
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
		if (this.lockedPdfPaths.has(pdfPath)) {
			new Notice('Jot: this PDF is busy with a protected operation.');
			return;
		}
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



