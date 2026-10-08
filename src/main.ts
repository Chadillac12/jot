import { Notice, Plugin, TFile } from 'obsidian';
import { DocumentSessionManager } from './document-session';
import type { InkSaveScheduler, InkSurfaceController } from './ink-surface';
import { DEFAULT_TOOL_STATE, Palette, type Tool, type ToolState } from './palette';
import { DEFAULT_SETTINGS, JotSettings, JotSettingTab, normalizeJotSettings } from './settings';
import { ConfirmClearModal } from './clear';
import { collectClearOperations, countStrokes, toUndoEntries } from './clear-ops';
import { FloatingPaletteButton } from './floating-palette-button';
import { PointerEventHandler } from './pointer-event-handler';
import { PersistentDiagnostics } from './persistent-diagnostics';
import { documentPathFromKey, isSidecarPath, pdfPathFromSidecar } from './jot-file';
import { JOT_NOTE_EXTENSION, JOT_NOTE_VIEW_TYPE, createJotNote, serializeJotNote } from './jot-note-file';
import { JotNoteView } from './jot-note-view';
import { MergeService } from './merge-service';
import { NotebookExternalConflictError, NotebookSessionManager, type NotebookDocumentSession } from './notebook-session';
import { OverlayManager } from './overlay-manager';
import { PdfInsertedPageStore } from './pdf-inserted-page-store';
import { SidecarStore, type SidecarLoadStatus } from './sidecar-store';
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
	private insertedPdfPages = new PdfInsertedPageStore();
	private lastActivePdfPath: string | null = null;
	private pdfOpenGeneration = 0;
	private pdfAttachTimer: number | null = null;
	private pluginUnloading = false;
	private notebookRetryTimers = new Map<string, number>();
	private notebookConflictRecoveries = new Map<string, { revision: number; path: string }>();
	private notebookRenameChain: Promise<void> = Promise.resolve();
	private sidecar!: SidecarStore;
	private merge!: MergeService;
	private overlays!: OverlayManager;
	private toolState: ToolState = { ...DEFAULT_TOOL_STATE };
	private toolStateListeners = new Set<(state: ToolState) => void>();
	private palette!: Palette;
	private floatingPaletteButton!: FloatingPaletteButton;
	settings: JotSettings = { ...DEFAULT_SETTINGS };
	private history = new UndoHistory();
	private undoController!: UndoController;
	private diagnostics!: PersistentDiagnostics;

	async onload() {
		this.diagnostics = new PersistentDiagnostics(
			this.app.vault.adapter,
			this.manifest.dir ?? `${this.app.vault.configDir}/plugins/jot`,
			this.manifest.version,
		);
		const diagnosticInit = await this.diagnostics.initialize();
		if (diagnosticInit.recoveredCrash) {
			new Notice(
				'Jot: the previous diagnostic session ended unexpectedly. Its trace was preserved and recording resumed.',
				8000,
			);
		}
		this.diagnostics.record('plugin.load', {
			version: this.manifest.version,
			diagnosticsAutoResumed: diagnosticInit.recording,
			recoveredCrash: diagnosticInit.recoveredCrash,
		});

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
			this.insertedPdfPages,
		);
		this.overlays = new OverlayManager(
			this.app,
			this.strokes,
			(canvas) => this.wirePointerEvents(canvas),
			this.insertedPdfPages,
			{
				onInsertedPagePaperChange: (pdfPath, pageId, paper) => {
					if (!this.canMutatePdf(pdfPath)) return;
					if (!this.insertedPdfPages.updatePaper(pdfPath, pageId, paper)) return;
					this.sidecar.scheduleSave(pdfPath);
					this.overlays.refreshPdf(pdfPath);
				},
			},
			this.diagnostics,
		);
		this.undoController = new UndoController(this.history, this.strokes, this.overlays, {
			activeDocumentPath: () => this.overlays.getActivePdfFilePath(),
			onAfterApply: (pdfPath) => this.scheduleSave(pdfPath),
			canMutateDocument: (pdfPath) => this.canMutatePdf(pdfPath),
		});
		this.merge = new MergeService(
			this.app,
			this.app.vault.adapter,
			this.strokes,
			this.insertedPdfPages,
			this.sidecar,
			this.history,
			{
				prepareForMerge: async (pdfPath) => {
					if (!(await this.sidecar.flush(pdfPath))) return false;
					const status = await this.ensureLoaded(pdfPath);
					return status === 'loaded' || status === 'missing';
				},
				refreshOverlays: (pdfPath) => {
					this.overlays.refreshPdf(pdfPath);
					this.overlays.redrawOverlaysForPdf(pdfPath);
				},
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
			id: 'add-handwritten-page-after-pdf-page',
			name: 'Add handwritten page after current PDF page',
			checkCallback: (checking) => {
				if (!this.overlays.getActivePdfFilePath() || this.overlays.getActivePdfPageNumber() === null) {
					return false;
				}
				if (!checking) this.addInsertedPdfPage('after');
				return true;
			},
		});
		this.addCommand({
			id: 'add-handwritten-page-before-pdf-page',
			name: 'Add handwritten page before current PDF page',
			checkCallback: (checking) => {
				if (!this.overlays.getActivePdfFilePath() || this.overlays.getActivePdfPageNumber() === null) {
					return false;
				}
				if (!checking) this.addInsertedPdfPage('before');
				return true;
			},
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
		this.addCommand({
			id: 'start-persistent-diagnostics',
			name: 'Start persistent diagnostics',
			callback: () => void this.startPersistentDiagnostics(),
		});
		this.addCommand({
			id: 'stop-persistent-diagnostics',
			name: 'Stop persistent diagnostics',
			callback: () => void this.stopPersistentDiagnostics(),
		});
		this.addCommand({
			id: 'export-last-diagnostics',
			name: 'Export last diagnostic recording',
			callback: () => void this.exportLastDiagnostics(),
		});
		this.addCommand({
			id: 'clear-diagnostic-recordings',
			name: 'Clear diagnostic recordings',
			callback: () => void this.clearDiagnosticRecordings(),
		});
		this.palette = new Palette(
			this.toolState,
			(state) => {
				this.toolState = { ...state };
				this.settings.toolState = { ...state };
				const mem = this.palette.getMemory();
				this.settings.penState = mem.pen;
				this.settings.highlighterState = mem.highlighter;
				this.notifyToolState();
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
				const generation = ++this.pdfOpenGeneration;
				this.cancelDelayedPdfAttach();
				const nextPdf = file?.extension === 'pdf' ? file.path : null;
				this.diagnostics.record('workspace.file-open', {
					path: file?.path ?? null,
					extension: file?.extension ?? null,
					nextPdf,
					previousPdf: this.lastActivePdfPath,
				});
				if (this.lastActivePdfPath && this.lastActivePdfPath !== nextPdf) {
					await this.sidecar.flush(this.lastActivePdfPath);
				}
				if (this.pluginUnloading || generation !== this.pdfOpenGeneration) return;
				this.lastActivePdfPath = nextPdf;
				if (!nextPdf) {
					this.refreshFloatingPaletteButton();
					return;
				}
				await this.ensureLoaded(nextPdf);
				if (this.pluginUnloading || generation !== this.pdfOpenGeneration) return;
				const timerWindow = this.app.workspace.containerEl.ownerDocument.defaultView ?? window;
				this.pdfAttachTimer = timerWindow.setTimeout(() => {
					this.pdfAttachTimer = null;
					if (this.pluginUnloading || generation !== this.pdfOpenGeneration) return;
					if (this.overlays.getActivePdfFilePath() !== nextPdf) return;
					this.overlays.attachToActivePdf();
					this.refreshFloatingPaletteButton();
				}, 300);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.diagnostics.record('workspace.layout-change', {
					activePdf: this.overlays.getActivePdfFilePath(),
					activePdfPage: this.overlays.getActivePdfPageNumber(),
				});
				this.overlays.pruneClosedObservers();
				this.overlays.attachToActivePdf();
				this.refreshFloatingPaletteButton();
			}),
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.diagnostics.record('workspace.active-leaf-change', {
					activePdf: this.overlays.getActivePdfFilePath(),
					activePdfPage: this.overlays.getActivePdfPageNumber(),
				});
				this.refreshFloatingPaletteButton();
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!isSidecarPath(file.path)) return;
				void this.handleSidecarModification(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (file.extension === 'pdf') {
					void this.handlePdfRename(oldPath, file.path);
					return;
				}
				if (file.extension === JOT_NOTE_EXTENSION || oldPath.endsWith(`.${JOT_NOTE_EXTENSION}`)) {
					void this.handleNotebookRename(oldPath, file.path);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (!(file instanceof TFile) || file.extension !== JOT_NOTE_EXTENSION) return;
				this.clearNotebookRetry(file.path);
				this.notebooks.dropIfUnused(file.path);
			}),
		);

		const workspaceDocument = this.app.workspace.containerEl.ownerDocument;
		const workspaceWindow = workspaceDocument.defaultView;
		this.registerDomEvent(workspaceDocument, 'visibilitychange', () => {
			this.diagnostics.record('lifecycle.visibilitychange', {
				state: workspaceDocument.visibilityState,
			});
			if (workspaceDocument.visibilityState === 'hidden') {
				this.flushDirtyBestEffort();
				void this.diagnostics.flush();
			}
		});
		if (workspaceWindow) {
			this.registerDomEvent(workspaceWindow, 'pagehide', () => {
				this.diagnostics.record('lifecycle.pagehide');
				this.flushDirtyBestEffort();
				void this.diagnostics.flush();
			});
			this.registerDomEvent(workspaceWindow, 'resize', () => {
				this.diagnostics.record('window.resize', {
					width: workspaceWindow.innerWidth,
					height: workspaceWindow.innerHeight,
					dpr: workspaceWindow.devicePixelRatio,
				});
				this.refreshFloatingPaletteButton();
			});
		}

		this.app.workspace.onLayoutReady(async () => {
			const filePath = this.overlays.getActivePdfFilePath();
			this.diagnostics.record('workspace.layout-ready', { activePdf: filePath });
			this.lastActivePdfPath = filePath;
			if (!filePath) {
				this.refreshFloatingPaletteButton();
				return;
			}
			const generation = this.pdfOpenGeneration;
			await this.ensureLoaded(filePath);
			if (this.pluginUnloading || generation !== this.pdfOpenGeneration) return;
			this.overlays.attachToActivePdf();
			this.refreshFloatingPaletteButton();
		});
	}

	onunload() {
		this.pluginUnloading = true;
		this.pdfOpenGeneration += 1;
		this.cancelDelayedPdfAttach();
		// Obsidian's unload hook is synchronous, so this is a best-effort final
		// flush. Normal file switches, visibility loss, page hide, renames, merges,
		// and notebook closes flush before the lifecycle transition itself.
		this.diagnostics?.record('plugin.unload-begin');
		this.flushDirtyBestEffort();
		for (const timer of this.notebookRetryTimers.values()) window.clearTimeout(timer);
		this.notebookRetryTimers.clear();
		this.overlays?.disconnectAll();
		this.palette?.hide();
		this.floatingPaletteButton?.hide();
		void this.diagnostics?.markCleanShutdown();
	}

	private async startPersistentDiagnostics(): Promise<void> {
		const started = await this.diagnostics.start();
		if (!started) {
			new Notice('Jot: persistent diagnostics are already recording.');
			return;
		}
		this.diagnostics.record('diagnostics.manual-start-confirmed', {
			activePdf: this.overlays.getActivePdfFilePath(),
			activePdfPage: this.overlays.getActivePdfPageNumber(),
		});
		await this.diagnostics.flush();
		new Notice(
			'Jot: persistent diagnostics started. Recording will automatically resume after an unclean restart until you stop it.',
			8000,
		);
	}

	private async stopPersistentDiagnostics(): Promise<void> {
		const stopped = await this.diagnostics.stop();
		new Notice(
			stopped
				? 'Jot: persistent diagnostics stopped.'
				: 'Jot: persistent diagnostics were not recording.',
		);
	}

	private async exportLastDiagnostics(): Promise<void> {
		const path = await this.diagnostics.exportLast();
		if (!path) {
			new Notice('Jot: no diagnostic recording is available to export.');
			return;
		}
		new Notice(`Jot: diagnostic recording exported to ${path}.`, 8000);
	}

	private async clearDiagnosticRecordings(): Promise<void> {
		const recording = this.diagnostics.isEnabled();
		const cleared = await this.diagnostics.clearRecordings();
		if (!cleared) {
			new Notice('Jot: diagnostic recordings could not be cleared.', 8000);
			return;
		}
		new Notice(
			recording
				? 'Jot: diagnostic recordings cleared; recording continues in a fresh session.'
				: 'Jot: diagnostic recordings cleared.',
		);
	}

	private flushDirtyBestEffort(): void {
		void this.sidecar?.flushAll();
		for (const session of this.notebooks.all()) {
			if (!session.state.isDirty || session.state.state === 'conflict') continue;
			const file = this.app.vault.getAbstractFileByPath(session.path);
			if (file instanceof TFile) void this.saveNotebookSession(file, session);
		}
	}

	private cancelDelayedPdfAttach(): void {
		if (this.pdfAttachTimer === null) return;
		(this.app.workspace.containerEl.ownerDocument.defaultView ?? window).clearTimeout(this.pdfAttachTimer);
		this.pdfAttachTimer = null;
	}

	private async ensureLoaded(pdfPath: string): Promise<SidecarLoadStatus> {
		const status = await this.sidecar.load(pdfPath);
		if (status === 'protected') {
			new Notice(
				'Jot: the existing annotation sidecar could not be safely loaded. It is protected from overwrite and will be backed up before any new annotations are saved.',
				8000,
			);
		}
		if (status === 'error') {
			new Notice(
				'Jot: could not read existing PDF annotations. Saving is blocked to protect the original. Resolve the storage error and reload before annotating.',
				10000,
			);
		}
		return status;
	}

	private async handleSidecarModification(path: string): Promise<void> {
		if (this.pluginUnloading || await this.sidecar.isOwnRecentSave(path)) return;
		const pdfPath = pdfPathFromSidecar(path);
		if (!pdfPath) return;
		if (this.sidecar.hasUnsavedChanges(pdfPath)) {
			await this.resolveExternalSidecarConflict(pdfPath);
			return;
		}
		await this.reloadSidecar(pdfPath);
	}

	private async reloadSidecar(pdfPath: string) {
		const status = await this.sidecar.load(pdfPath);
		if (status === 'dirty') return;
		if (status === 'loaded' || status === 'missing') {
			// An external disk update establishes a new history boundary. Undoing
			// across it could resurrect stale pre-sync annotations.
			this.history.dropPath(pdfPath);
		}
		if (status === 'protected') {
			new Notice(
				'Jot: an external annotation sidecar could not be safely loaded. The file was left untouched and current annotations were kept in memory.',
				8000,
			);
		}
		this.overlays.refreshPdf(pdfPath);
		this.overlays.redrawOverlaysForPdf(pdfPath);
	}

	private async handlePdfRename(oldPath: string, newPath: string): Promise<void> {
		const flushed = await this.sidecar.flush(oldPath);
		if (!flushed) new Notice('Jot: PDF rename continues with unsaved ink; recovery is pending at the new path.', 8000);
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

	private canMutatePdf(pdfPath: string): boolean {
		if (!this.sidecar.isWriteBlocked(pdfPath)) return true;
		new Notice('Jot: this PDF is read-only until its annotation sidecar can be loaded safely.', 8000);
		return false;
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
			allowInput: () => {
				if (saveScheduler !== this.sidecar) return true;
				const key = canvas.getAttribute('data-jot-key');
				const pdfPath = key ? documentPathFromKey(key) : null;
				return !pdfPath || !this.sidecar.isWriteBlocked(pdfPath);
			},
		});
		handler.attach();
		return () => handler.detach();
	}

	async loadSettings() {
		this.settings = normalizeJotSettings(await this.loadData());
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

	getToolState(): ToolState {
		return { ...this.toolState };
	}

	selectTool(tool: Tool): void {
		this.palette.selectTool(tool);
	}

	subscribeToolState(listener: (state: ToolState) => void): () => void {
		this.toolStateListeners.add(listener);
		listener(this.getToolState());
		return () => this.toolStateListeners.delete(listener);
	}

	private notifyToolState(): void {
		const snapshot = this.getToolState();
		for (const listener of this.toolStateListeners) listener(snapshot);
	}

	acquireNotebookSession(path: string): NotebookDocumentSession {
		return this.notebooks.acquire(path);
	}

	releaseNotebookSession(session: NotebookDocumentSession): void {
		this.notebooks.release(session);
	}

	getNotebookSession(path: string): NotebookDocumentSession {
		return this.notebooks.get(path);
	}

	async saveNotebookSession(file: TFile, session: NotebookDocumentSession): Promise<boolean> {
		if (session.loadError) return false;
		const success = await session.save(async (expectedData, nextData) => {
			await this.app.vault.process(file, (currentData) => {
				if (currentData !== expectedData && currentData !== nextData) {
					throw new NotebookExternalConflictError(currentData);
				}
				return nextData;
			});
		});

		if (success) {
			this.clearNotebookRetry(session.path);
			this.notebookConflictRecoveries.delete(session.path);
			this.notebooks.dropIfUnused(session.path);
			return true;
		}

		if (session.state.state === 'conflict') void this.preserveNotebookConflict(session);
		if (session.state.state === 'error' && !session.resourceLimitExceeded) this.scheduleNotebookRetry(session.path);
		return false;
	}

	async preserveNotebookConflict(session: NotebookDocumentSession): Promise<string | null> {
		const revision = session.state.revision;
		const prior = this.notebookConflictRecoveries.get(session.path);
		if (prior?.revision === revision && this.app.vault.getAbstractFileByPath(prior.path)) return prior.path;
		const extension = `.${JOT_NOTE_EXTENSION}`;
		const base = session.path.endsWith(extension)
			? session.path.slice(0, -extension.length)
			: session.path;
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
		let recoveryPath = `${base}.local-conflict-${stamp}${extension}`;
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(recoveryPath)) {
			recoveryPath = `${base}.local-conflict-${stamp}-${suffix}${extension}`;
			suffix += 1;
		}
		try {
			await this.app.vault.create(recoveryPath, session.serialize());
			this.notebookConflictRecoveries.set(session.path, { revision, path: recoveryPath });
			new Notice(`Jot: preserved local conflicted ink at ${recoveryPath}.`, 8000);
			return recoveryPath;
		} catch (error) {
			new Notice(
				`Jot: could not create a local conflict recovery copy: ${error instanceof Error ? error.message : String(error)}`,
				8000,
			);
			return null;
		}
	}

	private scheduleNotebookRetry(path: string): void {
		if (this.notebookRetryTimers.has(path)) return;
		const id = window.setTimeout(() => {
			this.notebookRetryTimers.delete(path);
			const file = this.app.vault.getAbstractFileByPath(path);
			const session = this.notebooks.peek(path);
			if (!(file instanceof TFile) || !session || !session.state.isDirty || session.state.state === 'conflict' || session.resourceLimitExceeded) {
				return;
			}
			void this.saveNotebookSession(file, session);
		}, 1500);
		this.notebookRetryTimers.set(path, id);
	}

	private clearNotebookRetry(path: string): void {
		const id = this.notebookRetryTimers.get(path);
		if (id !== undefined) window.clearTimeout(id);
		this.notebookRetryTimers.delete(path);
	}

	private async handleNotebookRename(oldPath: string, newPath: string): Promise<void> {
		if (!this.notebooks.peek(oldPath)) return;
		try {
			await this.renameNotebookSession(oldPath, newPath);
		} catch (error) {
			console.error(`${PLUGIN_LOG} notebook rename recovery failed:`, error);
			new Notice('Jot: notebook rename recovery failed. Unsaved ink remains in memory; keep Obsidian open and resolve storage errors before retrying.', 10000);
		}
	}

	async renameNotebookSession(
		oldPath: string,
		newPath: string,
	): Promise<NotebookDocumentSession> {
		let result: NotebookDocumentSession | null = null;
		const operation = this.notebookRenameChain.then(async () => {
			result = await this.performNotebookRename(oldPath, newPath);
		});
		this.notebookRenameChain = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
		if (!result) throw new Error('Notebook rename completed without a session.');
		return result;
	}

	private async performNotebookRename(
		oldPath: string,
		newPath: string,
	): Promise<NotebookDocumentSession> {
		const source = this.notebooks.peek(oldPath);
		if (!source) {
			return this.notebooks.peek(newPath) ?? this.notebooks.get(newPath);
		}

		const destination = this.notebooks.peek(newPath);
		if (destination && source !== destination) {
			if (destination.state.isDirty) {
				const recoveryPath = await this.preserveNotebookConflict(destination);
				if (!recoveryPath) {
					throw new Error('Refusing to displace dirty notebook: no durable recovery copy exists.');
				}
			}
			this.clearNotebookRetry(newPath);
			const displaced = this.notebooks.displace(newPath);
			displaced?.protectFromPathReplacement(
				'Another notebook was renamed onto this vault path. This stale view is read-only; any unsaved local ink was preserved in a recovery notebook.',
			);
			this.notebookConflictRecoveries.delete(newPath);
		}

		const recoveryRevision = this.notebookConflictRecoveries.get(oldPath);
		if (recoveryRevision !== undefined) {
			this.notebookConflictRecoveries.delete(oldPath);
			this.notebookConflictRecoveries.set(newPath, recoveryRevision);
		}
		const retryTimer = this.notebookRetryTimers.get(oldPath);
		if (retryTimer !== undefined) {
			window.clearTimeout(retryTimer);
			this.notebookRetryTimers.delete(oldPath);
		}
		const session = this.notebooks.rename(oldPath, newPath);
		if (retryTimer !== undefined && session.state.isDirty) this.scheduleNotebookRetry(newPath);
		return session;
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

	private addInsertedPdfPage(position: 'before' | 'after'): void {
		const pdfPath = this.overlays.getActivePdfFilePath();
		const pageNumber = this.overlays.getActivePdfPageNumber();
		if (!pdfPath || pageNumber === null) return;
		if (!this.canMutatePdf(pdfPath)) return;
		const slot = position === 'after' ? pageNumber : Math.max(0, pageNumber - 1);
		const page = this.insertedPdfPages.add(pdfPath, slot, 'ruled');
		this.sidecar.scheduleSave(pdfPath);
		this.overlays.refreshPdf(pdfPath);
		this.overlays.scrollInsertedPageIntoView(pdfPath, page.id);
		new Notice(
			`Jot: added handwritten page ${position} PDF page ${pageNumber}.`,
		);
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
		if (!this.canMutatePdf(pdfPath)) return;
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



